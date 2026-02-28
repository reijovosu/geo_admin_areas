import fs from "node:fs";
import path from "node:path";

export const ensureDir = (dirPath: string): void => {
  fs.mkdirSync(dirPath, { recursive: true });
};

export const backupFilePath = (outDir: string, countryCode: string, level: number): string => {
  return path.join(outDir, `${countryCode}_L${level}.json`);
};

export const readJsonFile = <T>(filePath: string): T => {
  const raw = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(raw) as T;
};
