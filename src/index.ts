import { parseCSVArg, parseIntList, parseList, parseNumber, parseString } from "./lib/cli.js";
import { runBackup } from "./commands/backup.js";
import { runServer } from "./commands/serve.js";

const main = async (): Promise<void> => {
  const [, , command = "help", ...args] = process.argv;

  if (command === "backup") {
    const countries = parseList(parseCSVArg(args, "countries"), ["EE"]);
    const levels = parseIntList(parseCSVArg(args, "levels"), [2, 6, 7, 8, 9, 10]);
    const outDir = parseString(args, "out-dir", "./data");
    const delayMs = parseNumber(args, "delay-ms", 300);
    const allCountriesRaw = parseString(args, "all-countries", "0").toLowerCase();
    const allLevelsRaw = parseString(args, "all-levels", "0").toLowerCase();
    const allCountries =
      allCountriesRaw === "1" || allCountriesRaw === "true" || allCountriesRaw === "yes";
    const allLevels =
      allLevelsRaw === "1" || allLevelsRaw === "true" || allLevelsRaw === "yes";

    await runBackup({
      countries,
      allCountries,
      levels,
      allLevels,
      outDir,
      delayMs,
    });
    return;
  }

  if (command === "serve") {
    const dataDir = parseString(args, "data-dir", "./data");
    const host = parseString(args, "host", "127.0.0.1");
    const port = parseNumber(args, "port", 8787);

    await runServer({
      dataDir,
      host,
      port,
    });
    return;
  }

  console.log(`Usage:
  npm run backup -- --countries=EE,LV,LT --levels=2,4,6,8,10 --out-dir=./data --delay-ms=300
  npm run backup -- --all-countries=1 --all-levels=1 --out-dir=./data --delay-ms=400
  npm run serve -- --data-dir=./data --host=127.0.0.1 --port=8787
`);
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
