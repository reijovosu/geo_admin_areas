import { calculateParentOsmIds } from "../lib/parents.js";

export interface ParentsCommandOptions {
  dataDir: string;
  dbPath: string;
  countries: string[];
  levels: number[];
  verify: boolean;
  verifySampleSize: number;
}

const formatMatchesByLevel = (matchesByLevel: Record<string, number>): string => {
  const entries = Object.entries(matchesByLevel).sort((a, b) => Number(a[0]) - Number(b[0]));
  if (entries.length === 0) return "-";
  return entries.map(([level, count]) => `${level}:${count}`).join(", ");
};

export const runParents = async (options: ParentsCommandOptions): Promise<void> => {
  const summary = await calculateParentOsmIds({
    dataDir: options.dataDir,
    dbPath: options.dbPath,
    countries: options.countries,
    levels: options.levels,
    unpackIfNeeded: true,
    liveFallback: true,
    verify: options.verify,
    verifySampleSize: options.verifySampleSize,
    logger: (message) => {
      console.log(message);
    },
  });

  console.log(`Parent SQLite DB: ${summary.db_path}`);
  console.log(`Countries processed: ${summary.countries_processed}`);
  console.log(`Countries skipped: ${summary.skipped_countries}`);
  console.log(`Levels processed: ${summary.levels_processed}`);

  for (const stat of summary.stats) {
    console.log(
      [
        `country_level=${stat.file_name}`,
        `total=${stat.total_children}`,
        `matched=${stat.matched}`,
        `unmatched=${stat.unmatched}`,
        `live_fallback_failed=${stat.live_fallback_failed}`,
        `matches_by_parent_level=${formatMatchesByLevel(stat.matches_by_parent_level)}`,
      ].join(" "),
    );
  }

  for (const verification of summary.verification) {
    console.log(
      [
        `verify_country=${verification.country_code}`,
        `sampled=${verification.sampled}`,
        `passed=${verification.passed}`,
        `failed=${verification.failed}`,
      ].join(" "),
    );
  }
};
