import fs from "node:fs";
import path from "node:path";
import { ensureDir, backupFilePath } from "../lib/fs.js";
import {
  buildAllCountriesQuery,
  buildCountryLevelsQuery,
  buildOverpassQuery,
  extractAdminLevels,
  extractCountries,
  extractCountryCodes,
  fetchOverpass,
} from "../lib/overpass.js";
import { isoUtcNow } from "../lib/time.js";
import { overpassToRows } from "../lib/transform.js";
import type { BackupOptions, BackupPayload, CountriesPayload } from "../lib/types.js";

const sleep = async (ms: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms));
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

  const allCountriesResult = options.allCountries
    ? await fetchOverpass(buildAllCountriesQuery())
    : null;

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

  const countryCodes = allCountriesResult
    ? extractCountryCodes(allCountriesResult.data)
    : options.countries.map((countryCodeRaw) => countryCodeRaw.toUpperCase());

  if (countryCodes.length === 0) {
    throw new Error("Could not resolve country codes from Overpass.");
  }

  console.log(`Countries to backup: ${countryCodes.length}`);

  for (const countryCode of countryCodes) {
    const levelsForCountry = options.allLevels
      ? extractAdminLevels((await fetchOverpass(buildCountryLevelsQuery(countryCode))).data)
      : options.levels;

    if (levelsForCountry.length === 0) {
      console.warn(`Skipping ${countryCode}: no admin levels discovered.`);
      continue;
    }

    console.log(`Levels for ${countryCode}: ${levelsForCountry.join(",")}`);

    for (const level of levelsForCountry) {
      const filePath = backupFilePath(outDirAbs, countryCode, level);
      if (missingOnlyMode && fs.existsSync(filePath)) {
        console.log(`Skipping existing file ${filePath}`);
        continue;
      }

      console.log(`Fetching country=${countryCode} level=${level} ...`);

      const query = buildOverpassQuery(countryCode, level);
      const { endpoint, data, rawText } = await fetchOverpass(query);
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

      fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
      fs.writeFileSync(rawResponseFilePath(outDirAbs, countryCode, level), rawText, "utf-8");

      console.log(`Saved ${filePath} rows=${rows.length}`);
      if (options.delayMs > 0) {
        await sleep(options.delayMs);
      }
    }
  }
};
