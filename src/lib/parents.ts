import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { backupFilePath, ensureDir, ensureJsonFromCompressedBackup, listBackupJsonFiles, readJsonFile } from "./fs.js";
import {
  calculateMultiPolygonArea,
  getMultiPolygonBoundingBox,
  parseMultiPolygonGeometry,
  pointInBoundingBox,
  pointInMultiPolygon,
  type BoundingBox,
  type MultiPolygonGeometry,
} from "./geo.js";
import {
  buildContainingAdminAreasQuery,
  extractContainingAdminAreas,
  fetchOverpass,
} from "./overpass.js";
import type { BackupPayload, BackupRow } from "./types.js";

interface ParentCandidate {
  country_code: string;
  osm_type: "relation" | "way";
  osm_id: number;
  admin_level: number | null;
  geometry: MultiPolygonGeometry;
  bbox: BoundingBox;
  area: number | null;
}

interface ResolvedParentRef {
  osm_type: "relation" | "way";
  osm_id: number;
  admin_level: number | null;
}

interface ChildCandidate {
  country_code: string;
  osm_type: "relation" | "way";
  osm_id: number;
  admin_level: number | null;
  center: [number, number] | null;
  center_geojson: string;
}

interface CountryLevelFile {
  countryCode: string;
  level: number;
  fileName: string;
}

interface CountryContext {
  countryCode: string;
  files: CountryLevelFile[];
  payloadsByLevel: Map<number, BackupPayload>;
  parentsByLevel: Map<number, ParentCandidate[]>;
  rowsByChildKey: Map<string, BackupRow>;
  sourceFileLevelByChildKey: Map<string, number>;
}

interface VerificationSample {
  child_osm_type: string;
  child_osm_id: number;
  child_admin_level: number | null;
  parent_osm_type: string | null;
  parent_osm_id: number | null;
  parent_admin_level: number | null;
  source_level: number;
}

export interface ParentLevelStats {
  level: number;
  file_name: string;
  refreshed_at: string;
  total_children: number;
  matched: number;
  unmatched: number;
  live_fallback_failed: number;
  matches_by_parent_level: Record<string, number>;
}

export interface ParentVerificationSummary {
  country_code: string;
  sampled: number;
  passed: number;
  failed: number;
}

export interface ParentCalculationSummary {
  db_path: string;
  countries_processed: number;
  skipped_countries: number;
  levels_processed: number;
  stats: ParentLevelStats[];
  verification: ParentVerificationSummary[];
}

export interface ParentCalculationOptions {
  dataDir: string;
  dbPath: string;
  countries?: string[];
  levels?: number[];
  unpackIfNeeded?: boolean;
  liveFallback?: boolean;
  verify?: boolean;
  verifySampleSize?: number;
  logger?: (message: string) => void;
  onProgress?: (progress: {
    phase:
      | "discovering"
      | "unpacking"
      | "preparing_database"
      | "loading_country"
      | "processing_level"
      | "resolving_live"
      | "verifying_country"
      | "complete";
    countryCode?: string;
    level?: number;
    fileName?: string;
    message: string;
  }) => void;
}

const DEFAULT_VERIFY_SAMPLE_SIZE = 25;

const childKey = (osmType: string, osmId: number): string => `${osmType}/${osmId}`;

const parseCenterPoint = (raw: string): [number, number] | null => {
  try {
    const parsed = JSON.parse(raw) as {
      type?: string;
      coordinates?: unknown;
    };
    if (
      parsed?.type !== "Point" ||
      !Array.isArray(parsed.coordinates) ||
      parsed.coordinates.length < 2 ||
      typeof parsed.coordinates[0] !== "number" ||
      typeof parsed.coordinates[1] !== "number"
    ) {
      return null;
    }

    return [parsed.coordinates[0], parsed.coordinates[1]];
  } catch {
    return null;
  }
};

const utcNow = (): string => new Date().toISOString();

const normalizeCountryFilter = (countries?: string[]): Set<string> | null => {
  if (!countries || countries.length === 0) return null;
  return new Set(countries.map((country) => country.toUpperCase()));
};

const normalizeLevelFilter = (levels?: number[]): Set<number> | null => {
  if (!levels || levels.length === 0) return null;
  return new Set(levels);
};

const reportProgress = (
  options: ParentCalculationOptions,
  progress: Parameters<NonNullable<ParentCalculationOptions["onProgress"]>>[0],
): void => {
  options.onProgress?.(progress);
  options.logger?.(progress.message);
};

const initializeDatabase = (dbPath: string): DatabaseSync => {
  const db = new DatabaseSync(dbPath);

  db.exec(`
    PRAGMA journal_mode = DELETE;
    PRAGMA synchronous = NORMAL;

    CREATE TABLE IF NOT EXISTS parent_osm_ids (
      country_code TEXT NOT NULL,
      child_osm_type TEXT NOT NULL,
      child_osm_id INTEGER NOT NULL,
      child_admin_level INTEGER,
      child_center_geojson TEXT,
      parent_osm_type TEXT,
      parent_osm_id INTEGER,
      parent_admin_level INTEGER,
      live_fallback_failed INTEGER NOT NULL DEFAULT 0,
      live_fallback_error TEXT,
      source_level INTEGER NOT NULL,
      PRIMARY KEY (child_osm_type, child_osm_id)
    );

    CREATE INDEX IF NOT EXISTS idx_parent_osm_ids_country_level
      ON parent_osm_ids(country_code, child_admin_level);

    CREATE INDEX IF NOT EXISTS idx_parent_osm_ids_parent
      ON parent_osm_ids(parent_osm_type, parent_osm_id);

    CREATE INDEX IF NOT EXISTS idx_parent_osm_ids_source_level
      ON parent_osm_ids(country_code, source_level);

    CREATE TABLE IF NOT EXISTS parent_osm_ids_versions (
      country_code TEXT NOT NULL,
      level INTEGER NOT NULL,
      refreshed_at TEXT NOT NULL,
      file_name TEXT NOT NULL,
      PRIMARY KEY (country_code, level)
    );
  `);

  const columns = db.prepare("PRAGMA table_info(parent_osm_ids)").all() as Array<Record<string, unknown>>;
  const hasChildCenter = columns.some((column) => String(column.name ?? "") === "child_center_geojson");
  if (!hasChildCenter) {
    db.exec("ALTER TABLE parent_osm_ids ADD COLUMN child_center_geojson TEXT");
  }
  const hasLiveFallbackFailed = columns.some((column) => String(column.name ?? "") === "live_fallback_failed");
  if (!hasLiveFallbackFailed) {
    db.exec("ALTER TABLE parent_osm_ids ADD COLUMN live_fallback_failed INTEGER NOT NULL DEFAULT 0");
  }
  const hasLiveFallbackError = columns.some((column) => String(column.name ?? "") === "live_fallback_error");
  if (!hasLiveFallbackError) {
    db.exec("ALTER TABLE parent_osm_ids ADD COLUMN live_fallback_error TEXT");
  }

  return db;
};

const loadPayload = (dataDir: string, fileName: string): BackupPayload => {
  return readJsonFile<BackupPayload>(path.join(dataDir, fileName));
};

const getCountryFiles = (dataDir: string, countries?: string[], levels?: number[]): Map<string, CountryLevelFile[]> => {
  const countryFilter = normalizeCountryFilter(countries);
  const levelFilter = normalizeLevelFilter(levels);
  const grouped = new Map<string, CountryLevelFile[]>();

  for (const fileName of listBackupJsonFiles(dataDir)) {
    const match = fileName.match(/^([A-Z]{2})_L(\d+)\.json$/i);
    if (!match) continue;

    const countryCode = match[1].toUpperCase();
    const level = Number(match[2]);
    if (countryFilter && !countryFilter.has(countryCode)) continue;
    if (levelFilter && !levelFilter.has(level)) continue;

    const file: CountryLevelFile = { countryCode, level, fileName };
    const list = grouped.get(countryCode) ?? [];
    list.push(file);
    grouped.set(countryCode, list);
  }

  for (const files of grouped.values()) {
    files.sort((a, b) => a.level - b.level || a.fileName.localeCompare(b.fileName));
  }

  return new Map(Array.from(grouped.entries()).sort((a, b) => a[0].localeCompare(b[0])));
};

const maybeUnpackFiles = (dataDir: string, filesByCountry: Map<string, CountryLevelFile[]>, options: ParentCalculationOptions): void => {
  if (!options.unpackIfNeeded) return;

  for (const files of filesByCountry.values()) {
    for (const file of files) {
      reportProgress(options, {
        phase: "unpacking",
        countryCode: file.countryCode,
        level: file.level,
        fileName: file.fileName,
        message: `Ensuring ${file.fileName} is unpacked locally.`,
      });

      const jsonPath = backupFilePath(dataDir, file.countryCode, file.level);
      if (!ensureJsonFromCompressedBackup(jsonPath)) {
        throw new Error(`Backup file missing for ${file.countryCode} L${file.level}`);
      }
    }
  }
};

const buildParentCandidates = (rows: BackupRow[]): ParentCandidate[] => {
  const out: ParentCandidate[] = [];

  for (const row of rows) {
    const geometry = parseMultiPolygonGeometry(row.geom_geojson);
    if (!geometry) continue;
    const bbox = getMultiPolygonBoundingBox(geometry);
    if (!bbox) continue;

    out.push({
      country_code: row.country_code,
      osm_type: row.osm_type,
      osm_id: row.osm_id,
      admin_level: row.admin_level,
      geometry,
      bbox,
      area: calculateMultiPolygonArea(geometry),
    });
  }

  out.sort((a, b) => {
    const areaA = a.area ?? Number.POSITIVE_INFINITY;
    const areaB = b.area ?? Number.POSITIVE_INFINITY;
    if (areaA !== areaB) return areaA - areaB;
    if (a.osm_id !== b.osm_id) return a.osm_id - b.osm_id;
    return a.osm_type.localeCompare(b.osm_type);
  });

  return out;
};

const buildChildIndexes = (
  payloadsByLevel: Map<number, BackupPayload>,
): {
  rowsByChildKey: Map<string, BackupRow>;
  sourceFileLevelByChildKey: Map<string, number>;
} => {
  const rowsByChildKey = new Map<string, BackupRow>();
  const sourceFileLevelByChildKey = new Map<string, number>();

  for (const [level, payload] of Array.from(payloadsByLevel.entries()).sort((a, b) => a[0] - b[0])) {
    for (const row of payload.rows) {
      const key = childKey(row.osm_type, row.osm_id);
      rowsByChildKey.set(key, row);
      sourceFileLevelByChildKey.set(key, level);
    }
  }

  return {
    rowsByChildKey,
    sourceFileLevelByChildKey,
  };
};

const loadCountryContext = (
  dataDir: string,
  countryCode: string,
  files: CountryLevelFile[],
): CountryContext => {
  const payloadsByLevel = new Map<number, BackupPayload>();
  const parentsByLevel = new Map<number, ParentCandidate[]>();

  for (const file of files) {
    const payload = loadPayload(dataDir, file.fileName);
    payloadsByLevel.set(file.level, payload);
    parentsByLevel.set(file.level, buildParentCandidates(payload.rows));
  }

  const indexes = buildChildIndexes(payloadsByLevel);

  return {
    countryCode,
    files,
    payloadsByLevel,
    parentsByLevel,
    rowsByChildKey: indexes.rowsByChildKey,
    sourceFileLevelByChildKey: indexes.sourceFileLevelByChildKey,
  };
};

const resolveParentForChild = (
  child: ChildCandidate,
  childLevel: number,
  parentsByLevel: Map<number, ParentCandidate[]>,
): {
  parent: ResolvedParentRef | null;
  sourceLevel: number;
} => {
  if (child.center == null) {
    return {
      parent: null,
      sourceLevel: childLevel,
    };
  }

  const candidateLevels = Array.from(parentsByLevel.keys())
    .filter((level) => level < childLevel)
    .sort((a, b) => b - a);

  for (const level of candidateLevels) {
    const parents = parentsByLevel.get(level) ?? [];
    const matches = parents.filter((parent) => {
      if (parent.country_code !== child.country_code) return false;
      if (child.osm_type === parent.osm_type && child.osm_id === parent.osm_id) return false;
      if (!pointInBoundingBox(child.center as [number, number], parent.bbox)) return false;
      return pointInMultiPolygon(child.center as [number, number], parent.geometry);
    });

    if (matches.length > 0) {
      return {
        parent: matches[0],
        sourceLevel: level,
      };
    }
  }

  return {
    parent: null,
    sourceLevel: childLevel,
  };
};

const resolveParentFromLiveOsm = async (
  child: ChildCandidate,
  childLevel: number,
  options: ParentCalculationOptions,
): Promise<{
  parent: ResolvedParentRef | null;
  sourceLevel: number;
}> => {
  if (!options.liveFallback || child.center == null) {
    return {
      parent: null,
      sourceLevel: childLevel,
    };
  }

  reportProgress(options, {
    phase: "resolving_live",
    countryCode: child.country_code,
    level: childLevel,
    message: `Resolving ${child.osm_type}/${child.osm_id} from live OSM.`,
  });

  const [lon, lat] = child.center;
  const result = await fetchOverpass(buildContainingAdminAreasQuery(lat, lon));
  const candidates = extractContainingAdminAreas(result.data)
    .filter((candidate) => {
      if (candidate.admin_level == null || candidate.admin_level >= childLevel) return false;
      const iso = String(candidate.tags["ISO3166-1"] ?? "").trim().toUpperCase();
      if (iso && iso !== child.country_code) return false;
      return true;
    })
    .sort((a, b) => {
      const levelGapA = childLevel - (a.admin_level ?? 0);
      const levelGapB = childLevel - (b.admin_level ?? 0);
      if (levelGapA !== levelGapB) return levelGapA - levelGapB;
      return a.osm_id - b.osm_id;
    });

  const match = candidates[0] ?? null;
  return {
    parent: match
      ? {
          osm_type: match.osm_type,
          osm_id: match.osm_id,
          admin_level: match.admin_level,
        }
      : null,
    sourceLevel: match?.admin_level ?? childLevel,
  };
};

const upsertParentRow = (db: DatabaseSync, row: {
  country_code: string;
  child_osm_type: "relation" | "way";
  child_osm_id: number;
  child_admin_level: number | null;
  child_center_geojson: string | null;
  parent_osm_type: "relation" | "way" | null;
  parent_osm_id: number | null;
  parent_admin_level: number | null;
  live_fallback_failed: number;
  live_fallback_error: string | null;
  source_level: number;
}): void => {
  db.prepare(`
    INSERT INTO parent_osm_ids (
      country_code,
      child_osm_type,
      child_osm_id,
      child_admin_level,
      child_center_geojson,
      parent_osm_type,
      parent_osm_id,
      parent_admin_level,
      live_fallback_failed,
      live_fallback_error,
      source_level
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(child_osm_type, child_osm_id) DO UPDATE SET
      country_code = excluded.country_code,
      child_admin_level = excluded.child_admin_level,
      child_center_geojson = excluded.child_center_geojson,
      parent_osm_type = excluded.parent_osm_type,
      parent_osm_id = excluded.parent_osm_id,
      parent_admin_level = excluded.parent_admin_level,
      live_fallback_failed = excluded.live_fallback_failed,
      live_fallback_error = excluded.live_fallback_error,
      source_level = excluded.source_level
  `).run(
    row.country_code,
    row.child_osm_type,
    row.child_osm_id,
    row.child_admin_level,
    row.child_center_geojson,
    row.parent_osm_type,
    row.parent_osm_id,
    row.parent_admin_level,
    row.live_fallback_failed,
    row.live_fallback_error,
    row.source_level,
  );
};

const upsertVersionRow = (
  db: DatabaseSync,
  countryCode: string,
  level: number,
  refreshedAt: string,
  fileName: string,
): void => {
  db.prepare(`
    INSERT INTO parent_osm_ids_versions (
      country_code,
      level,
      refreshed_at,
      file_name
    ) VALUES (?, ?, ?, ?)
    ON CONFLICT(country_code, level) DO UPDATE SET
      refreshed_at = excluded.refreshed_at,
      file_name = excluded.file_name
  `).run(countryCode, level, refreshedAt, fileName);
};

const readVersionMap = (db: DatabaseSync, countryCode: string): Map<number, { refreshed_at: string; file_name: string }> => {
  const rows = db.prepare(`
    SELECT level, refreshed_at, file_name
    FROM parent_osm_ids_versions
    WHERE country_code = ?
  `).all(countryCode) as Array<Record<string, unknown>>;

  const out = new Map<number, { refreshed_at: string; file_name: string }>();
  for (const row of rows) {
    const level = Number(row.level);
    out.set(level, {
      refreshed_at: String(row.refreshed_at ?? ""),
      file_name: String(row.file_name ?? ""),
    });
  }
  return out;
};

const shouldRebuildCountry = (
  db: DatabaseSync,
  context: CountryContext,
): boolean => {
  const existing = readVersionMap(db, context.countryCode);
  if (existing.size !== context.files.length) return true;

  for (const file of context.files) {
    const payload = context.payloadsByLevel.get(file.level);
    const existingRow = existing.get(file.level);
    const refreshedAt = payload?.meta.refreshed_at || "";
    if (!existingRow) return true;
    if (existingRow.refreshed_at !== refreshedAt) return true;
    if (existingRow.file_name !== file.fileName) return true;
  }

  const rowCount = db.prepare(`
    SELECT COUNT(*) AS count
    FROM parent_osm_ids
    WHERE country_code = ?
  `).get(context.countryCode) as Record<string, unknown>;

  return Number(rowCount.count ?? 0) === 0;
};

const processCountry = async (
  db: DatabaseSync,
  context: CountryContext,
  options: ParentCalculationOptions,
): Promise<ParentLevelStats[]> => {
  const stats: ParentLevelStats[] = [];

  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM parent_osm_ids WHERE country_code = ?").run(context.countryCode);
    db.prepare("DELETE FROM parent_osm_ids_versions WHERE country_code = ?").run(context.countryCode);

    for (const file of context.files) {
      reportProgress(options, {
        phase: "processing_level",
        countryCode: context.countryCode,
        level: file.level,
        fileName: file.fileName,
        message: `Calculating parents for ${file.fileName}.`,
      });

      const payload = context.payloadsByLevel.get(file.level);
      if (!payload) continue;

      const refreshedAt = payload.meta.refreshed_at || utcNow();
      const levelStats: ParentLevelStats = {
        level: file.level,
        file_name: file.fileName,
        refreshed_at: refreshedAt,
        total_children: payload.rows.length,
        matched: 0,
        unmatched: 0,
        live_fallback_failed: 0,
        matches_by_parent_level: {},
      };

      for (const row of payload.rows) {
        const child: ChildCandidate = {
          country_code: row.country_code,
          osm_type: row.osm_type,
          osm_id: row.osm_id,
          admin_level: row.admin_level,
          center: parseCenterPoint(row.center_geojson),
          center_geojson: row.center_geojson,
        };

        const fallbackSourceLevel = file.level;
        const localResolution = resolveParentForChild(child, file.level, context.parentsByLevel);
        let finalResolution = localResolution;
        let liveFallbackFailed = 0;
        let liveFallbackError: string | null = null;

        if (!localResolution.parent) {
          try {
            finalResolution = await resolveParentFromLiveOsm(child, file.level, options);
          } catch (error) {
            liveFallbackFailed = 1;
            liveFallbackError = error instanceof Error ? error.message : String(error);
            finalResolution = {
              parent: null,
              sourceLevel: fallbackSourceLevel,
            };
            levelStats.live_fallback_failed += 1;
            options.logger?.(
              `Live fallback failed for ${context.countryCode} ${row.osm_type}/${row.osm_id}: ${liveFallbackError}`,
            );
          }
        }
        const sourceLevel = finalResolution.parent
          ? finalResolution.sourceLevel
          : fallbackSourceLevel;

        upsertParentRow(db, {
          country_code: context.countryCode,
          child_osm_type: row.osm_type,
          child_osm_id: row.osm_id,
          child_admin_level: row.admin_level,
          child_center_geojson: row.center_geojson || null,
          parent_osm_type: finalResolution.parent?.osm_type ?? null,
          parent_osm_id: finalResolution.parent?.osm_id ?? null,
          parent_admin_level: finalResolution.parent?.admin_level ?? null,
          live_fallback_failed: liveFallbackFailed,
          live_fallback_error: liveFallbackError,
          source_level: sourceLevel,
        });

        if (finalResolution.parent) {
          levelStats.matched += 1;
          const statKey = String(finalResolution.sourceLevel);
          levelStats.matches_by_parent_level[statKey] =
            (levelStats.matches_by_parent_level[statKey] ?? 0) + 1;
        } else {
          levelStats.unmatched += 1;
        }
      }

      upsertVersionRow(db, context.countryCode, file.level, refreshedAt, file.fileName);
      stats.push(levelStats);
    }

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  return stats;
};

const chooseSampleRows = (
  rows: VerificationSample[],
  sampleSize: number,
): VerificationSample[] => {
  if (rows.length <= sampleSize) return rows;

  const chosen: VerificationSample[] = [];
  const step = rows.length / sampleSize;
  const seen = new Set<string>();

  for (let i = 0; i < sampleSize; i += 1) {
    const index = Math.min(rows.length - 1, Math.floor(i * step));
    const row = rows[index];
    const key = childKey(row.child_osm_type, row.child_osm_id);
    if (seen.has(key)) continue;
    chosen.push(row);
    seen.add(key);
  }

  if (chosen.length < sampleSize) {
    for (const row of rows) {
      const key = childKey(row.child_osm_type, row.child_osm_id);
      if (seen.has(key)) continue;
      chosen.push(row);
      seen.add(key);
      if (chosen.length >= sampleSize) break;
    }
  }

  return chosen;
};

const verifyCountry = (
  db: DatabaseSync,
  context: CountryContext,
  options: ParentCalculationOptions,
): ParentVerificationSummary => {
  reportProgress(options, {
    phase: "verifying_country",
    countryCode: context.countryCode,
    message: `Verifying stored parent mappings for ${context.countryCode}.`,
  });

  const rows = db.prepare(`
    SELECT
      child_osm_type,
      child_osm_id,
      child_admin_level,
      parent_osm_type,
      parent_osm_id,
      parent_admin_level,
      source_level
    FROM parent_osm_ids
    WHERE country_code = ?
    ORDER BY child_osm_type ASC, child_osm_id ASC
  `).all(context.countryCode) as Array<Record<string, unknown>>;

  const samples = chooseSampleRows(
    rows.map((row) => ({
      child_osm_type: String(row.child_osm_type),
      child_osm_id: Number(row.child_osm_id),
      child_admin_level: row.child_admin_level == null ? null : Number(row.child_admin_level),
      parent_osm_type: row.parent_osm_type == null ? null : String(row.parent_osm_type),
      parent_osm_id: row.parent_osm_id == null ? null : Number(row.parent_osm_id),
      parent_admin_level: row.parent_admin_level == null ? null : Number(row.parent_admin_level),
      source_level: Number(row.source_level),
    })),
    Math.max(1, options.verifySampleSize ?? DEFAULT_VERIFY_SAMPLE_SIZE),
  );

  let passed = 0;
  let failed = 0;

  for (const sample of samples) {
    const row = context.rowsByChildKey.get(childKey(sample.child_osm_type, sample.child_osm_id));
    if (!row) {
      failed += 1;
      continue;
    }

    const resolved = resolveParentForChild(
      {
        country_code: row.country_code,
        osm_type: row.osm_type,
        osm_id: row.osm_id,
        admin_level: row.admin_level,
        center: parseCenterPoint(row.center_geojson),
        center_geojson: row.center_geojson,
      },
      context.sourceFileLevelByChildKey.get(childKey(sample.child_osm_type, sample.child_osm_id)) ?? row.admin_level ?? 0,
      context.parentsByLevel,
    );

    const expectedSourceLevel = resolved.sourceLevel;
    const sameParent =
      (resolved.parent?.osm_type ?? null) === sample.parent_osm_type &&
      (resolved.parent?.osm_id ?? null) === sample.parent_osm_id &&
      (resolved.parent?.admin_level ?? null) === sample.parent_admin_level &&
      expectedSourceLevel === sample.source_level;

    if (sameParent) passed += 1;
    else failed += 1;
  }

  return {
    country_code: context.countryCode,
    sampled: samples.length,
    passed,
    failed,
  };
};

export const calculateParentOsmIds = async (
  options: ParentCalculationOptions,
): Promise<ParentCalculationSummary> => {
  const dataDir = path.resolve(process.cwd(), options.dataDir);
  const dbPath = path.resolve(process.cwd(), options.dbPath);

  if (!fs.existsSync(dataDir)) {
    throw new Error(`Data dir not found: ${dataDir}`);
  }

  reportProgress(options, {
    phase: "discovering",
    message: `Discovering backup files in ${dataDir}.`,
  });

  const filesByCountry = getCountryFiles(dataDir, options.countries, options.levels);
  maybeUnpackFiles(dataDir, filesByCountry, options);

  reportProgress(options, {
    phase: "preparing_database",
    message: `Preparing parent SQLite database at ${dbPath}.`,
  });

  ensureDir(path.dirname(dbPath));
  const db = initializeDatabase(dbPath);

  try {
    const allStats: ParentLevelStats[] = [];
    const verification: ParentVerificationSummary[] = [];
    let countriesProcessed = 0;
    let skippedCountries = 0;

    for (const [countryCode, files] of filesByCountry) {
      reportProgress(options, {
        phase: "loading_country",
        countryCode,
        message: `Loading country ${countryCode}.`,
      });

      const context = loadCountryContext(dataDir, countryCode, files);
      const rebuild = shouldRebuildCountry(db, context);
      if (rebuild) {
      const countryStats = await processCountry(db, context, options);
        allStats.push(...countryStats);
        countriesProcessed += 1;
      } else {
        skippedCountries += 1;
      }

      if (options.verify) {
        verification.push(verifyCountry(db, context, options));
      }
    }

    reportProgress(options, {
      phase: "complete",
      message: `Parent calculation complete for ${countriesProcessed} countries.`,
    });

    return {
      db_path: dbPath,
      countries_processed: countriesProcessed,
      skipped_countries: skippedCountries,
      levels_processed: allStats.length,
      stats: allStats,
      verification,
    };
  } finally {
    db.close();
  }
};
