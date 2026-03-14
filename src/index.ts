import { parseCSVArg, parseIntList, parseList, parseNumber, parseString } from "./lib/cli.js";
import { runBackup } from "./commands/backup.js";
import { runServer } from "./commands/serve.js";

const envOrFallback = (name: string, fallback: string): string => {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : fallback;
};

const envNumberOrFallback = (name: string, fallback: number): number => {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const main = async (): Promise<void> => {
  const [, , command = "help", ...args] = process.argv;

  if (command === "backup") {
    const countries = parseList(parseCSVArg(args, "countries"), ["EE"]);
    const levels = parseIntList(parseCSVArg(args, "levels"), [2, 6, 7, 8, 9, 10]);
    const outDir = parseString(args, "out-dir", "./data");
    const delayMs = parseNumber(args, "delay-ms", 300);
    const allCountriesRaw = parseString(args, "all-countries", "0").toLowerCase();
    const allLevelsRaw = parseString(args, "all-levels", "0").toLowerCase();
    const saveRawRaw = parseString(args, "save-raw", "0").toLowerCase();
    const allCountries =
      allCountriesRaw === "1" || allCountriesRaw === "true" || allCountriesRaw === "yes";
    const allLevels =
      allLevelsRaw === "1" || allLevelsRaw === "true" || allLevelsRaw === "yes";
    const saveRaw = saveRawRaw === "1" || saveRawRaw === "true" || saveRawRaw === "yes";

    await runBackup({
      countries,
      allCountries,
      levels,
      allLevels,
      saveRaw,
      outDir,
      delayMs,
    });
    return;
  }

  if (command === "serve") {
    const dataDir = parseString(args, "data-dir", envOrFallback("DATA_DIR", "./data"));
    const host = parseString(args, "host", envOrFallback("HOST", "127.0.0.1"));
    const port = parseNumber(args, "port", envNumberOrFallback("PORT", 8787));

    await runServer({
      dataDir,
      host,
      port,
    });
    return;
  }

  console.log(`Usage:
  npm run backup -- --countries=EE,LV,LT --levels=2,4,6,8,10 --out-dir=./data --delay-ms=300 --save-raw=0
  npm run backup -- --all-countries=1 --all-levels=1 --out-dir=./data --delay-ms=400 --save-raw=0
  npm run serve -- --data-dir=./data --host=127.0.0.1 --port=8787
`);
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
