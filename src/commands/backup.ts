import fs from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { ensureDir, backupFilePath } from "../lib/fs.js";
import {
  buildAllCountriesQuery,
  buildCountryLevelsQuery,
  buildOverpassQuery,
  buildOverpassQueryForParentRelation,
  buildParentRelationsQuery,
  extractAdminLevels,
  extractCountries,
  extractCountryCodes,
  extractRelationIds,
  fetchOverpass,
} from "../lib/overpass.js";
import { isoUtcNow } from "../lib/time.js";
import { overpassToRows } from "../lib/transform.js";
import type { BackupOptions, BackupPayload, CountriesPayload } from "../lib/types.js";

interface CountryLevelsCatalogPayload {
  meta: {
    created_at: string;
    refreshed_at: string;
    source: "overpass";
    format: 1;
  };
  levels_by_country: Record<string, number[]>;
}

const sleep = async (ms: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

const formatError = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
};

const isPayloadTooLargeError = (error: unknown): boolean => {
  const msg = formatError(error);
  return (
    msg.includes("Cannot create a string longer than") ||
    msg.includes("Invalid string length") ||
    msg.includes("heap out of memory")
  );
};

const shouldUseChunkFallback = (level: number, error: unknown): boolean => {
  if (level <= 2) return false;
  if (isPayloadTooLargeError(error)) return true;

  // Deep admin levels often fail with transport-level issues before explicit size errors.
  // For these, try chunked fallback proactively.
  if (level >= 8) return true;

  return false;
};

const resolveCreatedAt = (filePath: string, fallback: string): string => {
  if (!fs.existsSync(filePath)) return fallback;

  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as { meta?: { created_at?: unknown } };
    if (typeof parsed?.meta?.created_at === "string" && parsed.meta.created_at.trim()) {
      return parsed.meta.created_at;
    }
  } catch {
    return fallback;
  }

  return fallback;
};

const rawResponseFilePath = (outDirAbs: string, countryCode: string, level: number): string => {
  return path.join(outDirAbs, `${countryCode}_L${level}.raw.json`);
};

const compressedBackupFilePath = (filePath: string): string => `${filePath}.gz`;

const writeCompressedBackupJson = (filePath: string, content: string): void => {
  fs.writeFileSync(filePath, content, "utf-8");
  fs.writeFileSync(compressedBackupFilePath(filePath), gzipSync(content, { level: 9 }));
  fs.unlinkSync(filePath);
};

const parseCountryCodesFromCountriesBackup = (filePath: string): string[] => {
  if (!fs.existsSync(filePath)) return [];

  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as CountriesPayload;
    const countries = Array.isArray(parsed?.countries) ? parsed.countries : [];
    return countries
      .map((item) => String(item?.country_code ?? "").toUpperCase().trim())
      .filter((code) => /^[A-Z]{2}$/.test(code));
  } catch {
    return [];
  }
};

const loadCountryLevelsCatalog = (filePath: string): Record<string, number[]> => {
  if (!fs.existsSync(filePath)) return {};

  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as CountryLevelsCatalogPayload;
    const entries = parsed?.levels_by_country ?? {};
    const out: Record<string, number[]> = {};

    for (const [countryCode, levelsRaw] of Object.entries(entries)) {
      const country = String(countryCode).toUpperCase().trim();
      if (!/^[A-Z]{2}$/.test(country) || !Array.isArray(levelsRaw)) continue;

      const levels = Array.from(
        new Set(
          levelsRaw
            .map((v) => Number(v))
            .filter((v) => Number.isInteger(v) && v > 0),
        ),
      ).sort((a, b) => a - b);

      if (levels.length > 0) out[country] = levels;
    }

    return out;
  } catch {
    return {};
  }
};

const saveCountryLevelsCatalog = (
  filePath: string,
  levelsByCountry: Record<string, number[]>,
  fallbackCreatedAt: string,
): void => {
  const payload: CountryLevelsCatalogPayload = {
    meta: {
      created_at: resolveCreatedAt(filePath, fallbackCreatedAt),
      refreshed_at: isoUtcNow(),
      source: "overpass",
      format: 1,
    },
    levels_by_country: levelsByCountry,
  };

  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
};

export const runBackup = async (options: BackupOptions): Promise<void> => {
  if (!options.allCountries && options.countries.length === 0) {
    throw new Error("No countries provided. Use --countries=EE,LV,LT");
  }
  if (!options.allLevels && options.levels.length === 0) {
    throw new Error("No levels provided. Use --levels=2,4,6,8,10");
  }

  const outDirAbs = path.resolve(process.cwd(), options.outDir);
  ensureDir(outDirAbs);
  const runTimestamp = isoUtcNow();
  const missingOnlyMode = options.allCountries && options.allLevels;
  const countriesFilePath = path.join(outDirAbs, "countries.json");
  const levelsCatalogPath = path.join(outDirAbs, "country-levels.json");
  const levelsByCountry = missingOnlyMode ? loadCountryLevelsCatalog(levelsCatalogPath) : {};
  let levelsCatalogChanged = false;

  const shouldUseLocalCountriesOnly = missingOnlyMode && fs.existsSync(countriesFilePath);
  let allCountriesResult: Awaited<ReturnType<typeof fetchOverpass>> | null = null;

  if (options.allCountries && !shouldUseLocalCountriesOnly) {
    allCountriesResult = await fetchOverpass(buildAllCountriesQuery());
  }

  if (allCountriesResult) {
    if (missingOnlyMode && fs.existsSync(countriesFilePath)) {
      console.log(`Skipping existing file ${countriesFilePath}`);
    } else {
      const createdAt = resolveCreatedAt(countriesFilePath, runTimestamp);
      const countriesPayload: CountriesPayload = {
        meta: {
          created_at: createdAt,
          refreshed_at: isoUtcNow(),
          source: "overpass",
          format: 1,
          endpoint: allCountriesResult.endpoint,
        },
        countries: extractCountries(allCountriesResult.data),
        raw_api_response_file: "countries.raw.json",
      };

      fs.writeFileSync(path.join(outDirAbs, "countries.raw.json"), allCountriesResult.rawText, "utf-8");

      fs.writeFileSync(
        countriesFilePath,
        `${JSON.stringify(countriesPayload, null, 2)}\n`,
        "utf-8",
      );
      console.log(`Saved ${countriesFilePath} countries=${countriesPayload.countries.length}`);
    }
  }

  let countryCodes = options.allCountries
    ? allCountriesResult
      ? extractCountryCodes(allCountriesResult.data)
      : parseCountryCodesFromCountriesBackup(countriesFilePath)
    : options.countries.map((countryCodeRaw) => countryCodeRaw.toUpperCase());

  if (options.allCountries && countryCodes.length === 0) {
    const fallbackAllCountries = await fetchOverpass(buildAllCountriesQuery());
    countryCodes = extractCountryCodes(fallbackAllCountries.data);
  }

  if (countryCodes.length === 0) {
    throw new Error("Could not resolve country codes from Overpass.");
  }

  console.log(`Countries to backup: ${countryCodes.length}`);

  for (const countryCode of countryCodes) {
    let levelsForCountry = options.levels;

    if (options.allLevels) {
      if (missingOnlyMode && Array.isArray(levelsByCountry[countryCode])) {
        levelsForCountry = levelsByCountry[countryCode];
      } else {
        levelsForCountry = extractAdminLevels(
          (await fetchOverpass(buildCountryLevelsQuery(countryCode))).data,
        );

        if (missingOnlyMode) {
          levelsByCountry[countryCode] = levelsForCountry;
          levelsCatalogChanged = true;
        }
      }
    }

    if (levelsForCountry.length === 0) {
      console.warn(`Skipping ${countryCode}: no admin levels discovered.`);
      continue;
    }

    console.log(`Levels for ${countryCode}: ${levelsForCountry.join(",")}`);

    for (const level of levelsForCountry) {
      const filePath = backupFilePath(outDirAbs, countryCode, level);
      const compressedFilePath = compressedBackupFilePath(filePath);
      if (missingOnlyMode && (fs.existsSync(filePath) || fs.existsSync(compressedFilePath))) {
        if (fs.existsSync(filePath) && !fs.existsSync(compressedFilePath)) {
          const content = fs.readFileSync(filePath, "utf-8");
          writeCompressedBackupJson(filePath, content);
          console.log(`Compressed existing file ${compressedFilePath}`);
        }
        console.log(`Skipping existing file ${filePath}`);
        continue;
      }

      console.log(`Fetching country=${countryCode} level=${level} ...`);

      const query = buildOverpassQuery(countryCode, level);
      let endpoint: string;
      let data: Record<string, unknown>;
      let rawText: string;
      try {
        const result = await fetchOverpass(query);
        endpoint = result.endpoint;
        data = result.data;
        rawText = result.rawText;
      } catch (error) {
        if (!shouldUseChunkFallback(level, error)) {
          throw new Error(
            `Failed country=${countryCode} level=${level}: ${formatError(error)}`,
          );
        }

        // Fallback for very large payloads: split by parent admin areas (level-2).
        const parentLevel = Math.max(2, level - 2);
        console.warn(
          `Large payload for country=${countryCode} level=${level}; switching to chunked mode by parent level=${parentLevel}`,
        );

        const parents = await fetchOverpass(buildParentRelationsQuery(countryCode, parentLevel));
        const parentRelationIds = extractRelationIds(parents.data);
        if (parentRelationIds.length === 0) {
          throw new Error(
            `Failed country=${countryCode} level=${level}: no parent relations found for parent level ${parentLevel}`,
          );
        }

        const rowsByKey = new Map<string, BackupPayload["rows"][number]>();
        const chunkFiles: string[] = [];
        let firstEndpoint = parents.endpoint;

        for (let i = 0; i < parentRelationIds.length; i++) {
          const parentId = parentRelationIds[i];
          const chunkIndex = i + 1;
          const chunkStartedAt = Date.now();
          console.log(
            `Chunk ${chunkIndex}/${parentRelationIds.length} START country=${countryCode} level=${level} parent_relation=${parentId}`,
          );
          const chunk = await fetchOverpass(
            buildOverpassQueryForParentRelation(parentId, level),
          );
          if (i === 0) firstEndpoint = chunk.endpoint;

          const partRows = overpassToRows(countryCode, level, chunk.data);
          const beforeCount = rowsByKey.size;
          for (const row of partRows) {
            rowsByKey.set(`${row.osm_type}/${row.osm_id}`, row);
          }
          const afterCount = rowsByKey.size;
          const addedCount = Math.max(0, afterCount - beforeCount);

          const partFile = `${countryCode}_L${level}.raw.part${chunkIndex}.json`;
          fs.writeFileSync(path.join(outDirAbs, partFile), chunk.rawText, "utf-8");
          chunkFiles.push(partFile);
          const chunkDurationSec = ((Date.now() - chunkStartedAt) / 1000).toFixed(1);
          console.log(
            `Chunk ${chunkIndex}/${parentRelationIds.length} DONE duration=${chunkDurationSec}s rows_fetched=${partRows.length} rows_added=${addedCount} rows_total=${afterCount}`,
          );
        }

        endpoint = `${firstEndpoint} (chunked:parent_level=${parentLevel})`;
        data = { chunked: true };
        rawText = JSON.stringify(
          {
            chunked: true,
            country_code: countryCode,
            level,
            parent_level: parentLevel,
            chunks: chunkFiles,
          },
          null,
          2,
        );

        const rows = Array.from(rowsByKey.values());
        const createdAt = resolveCreatedAt(filePath, runTimestamp);
        const refreshedAt = isoUtcNow();
        const rawFileName = `${countryCode}_L${level}.raw.json`;

        const payload: BackupPayload = {
          meta: {
            created_at: createdAt,
            refreshed_at: refreshedAt,
            country_code: countryCode,
            level,
            source: "overpass",
            format: 2,
            endpoint,
          },
          rows,
          raw_api_response_file: rawFileName,
        };

        writeCompressedBackupJson(filePath, `${JSON.stringify(payload, null, 2)}\n`);
        fs.writeFileSync(rawResponseFilePath(outDirAbs, countryCode, level), rawText, "utf-8");

        console.log(`Saved ${filePath}.gz rows=${rows.length}`);
        if (options.delayMs > 0) await sleep(options.delayMs);
        continue;
      }
      const rows = overpassToRows(countryCode, level, data);
      const createdAt = resolveCreatedAt(filePath, runTimestamp);
      const refreshedAt = isoUtcNow();
      const rawFileName = `${countryCode}_L${level}.raw.json`;

      const payload: BackupPayload = {
        meta: {
          created_at: createdAt,
          refreshed_at: refreshedAt,
          country_code: countryCode,
          level,
          source: "overpass",
          format: 2,
          endpoint,
        },
        rows,
        raw_api_response_file: rawFileName,
      };

      writeCompressedBackupJson(filePath, `${JSON.stringify(payload, null, 2)}\n`);
      fs.writeFileSync(rawResponseFilePath(outDirAbs, countryCode, level), rawText, "utf-8");

      console.log(`Saved ${filePath}.gz rows=${rows.length}`);
      if (options.delayMs > 0) {
        await sleep(options.delayMs);
      }
    }
  }

  if (missingOnlyMode && levelsCatalogChanged) {
    saveCountryLevelsCatalog(levelsCatalogPath, levelsByCountry, runTimestamp);
    console.log(`Saved ${levelsCatalogPath} countries=${Object.keys(levelsByCountry).length}`);
  }
};
