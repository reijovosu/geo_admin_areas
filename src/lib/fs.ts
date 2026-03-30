import fs from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";

const COMPRESSED_BACKUP_PART_SIZE_BYTES = 50_000_000;

export const ensureDir = (dirPath: string): void => {
  fs.mkdirSync(dirPath, { recursive: true });
};

export const backupFilePath = (outDir: string, countryCode: string, level: number): string => {
  return path.join(outDir, `${countryCode}_L${level}.json`);
};

export const compressedBackupFilePath = (filePath: string): string => `${filePath}.gz`;

const compressedBackupPartPath = (filePath: string, index: number): string => {
  return `${compressedBackupFilePath(filePath)}.part-${String(index).padStart(4, "0")}`;
};

export const listCompressedBackupPartPaths = (filePath: string): string[] => {
  const dirPath = path.dirname(filePath);
  const gzBaseName = path.basename(compressedBackupFilePath(filePath));
  if (!fs.existsSync(dirPath)) return [];

  return fs
    .readdirSync(dirPath)
    .filter((name) => name.startsWith(`${gzBaseName}.part-`))
    .sort()
    .map((name) => path.join(dirPath, name));
};

export const compressedBackupExists = (filePath: string): boolean => {
  return fs.existsSync(compressedBackupFilePath(filePath)) || listCompressedBackupPartPaths(filePath).length > 0;
};

export const latestBackupArtifactMtimeMs = (filePath: string): number | null => {
  const candidatePaths = [
    filePath,
    compressedBackupFilePath(filePath),
    ...listCompressedBackupPartPaths(filePath),
  ].filter((candidatePath, index, allPaths) =>
    allPaths.indexOf(candidatePath) === index && fs.existsSync(candidatePath),
  );

  if (candidatePaths.length === 0) return null;

  return Math.max(...candidatePaths.map((candidatePath) => fs.statSync(candidatePath).mtimeMs));
};

export const isFileOlderThanDays = (filePath: string, days: number): boolean => {
  if (!fs.existsSync(filePath)) return true;
  if (days <= 0) return false;

  const maxAgeMs = days * 24 * 60 * 60 * 1000;
  return (Date.now() - fs.statSync(filePath).mtimeMs) > maxAgeMs;
};

export const cleanupCompressedBackupArtifacts = (filePath: string): void => {
  const gzFilePath = compressedBackupFilePath(filePath);
  if (fs.existsSync(gzFilePath)) fs.unlinkSync(gzFilePath);

  for (const partPath of listCompressedBackupPartPaths(filePath)) {
    fs.unlinkSync(partPath);
  }
};

export const writeCompressedBackupArtifacts = (
  filePath: string,
  gzBuffer: Buffer,
): string[] => {
  cleanupCompressedBackupArtifacts(filePath);

  if (gzBuffer.length <= COMPRESSED_BACKUP_PART_SIZE_BYTES) {
    const gzFilePath = compressedBackupFilePath(filePath);
    fs.writeFileSync(gzFilePath, gzBuffer);
    return [gzFilePath];
  }

  const writtenFiles: string[] = [];
  let index = 0;
  for (let offset = 0; offset < gzBuffer.length; offset += COMPRESSED_BACKUP_PART_SIZE_BYTES) {
    const partPath = compressedBackupPartPath(filePath, index);
    fs.writeFileSync(
      partPath,
      gzBuffer.subarray(offset, offset + COMPRESSED_BACKUP_PART_SIZE_BYTES),
    );
    writtenFiles.push(partPath);
    index += 1;
  }

  return writtenFiles;
};

export const readCompressedBackupBuffer = (filePath: string): Buffer | null => {
  const gzFilePath = compressedBackupFilePath(filePath);
  if (fs.existsSync(gzFilePath)) {
    return fs.readFileSync(gzFilePath);
  }

  const partPaths = listCompressedBackupPartPaths(filePath);
  if (partPaths.length === 0) return null;

  return Buffer.concat(partPaths.map((partPath) => fs.readFileSync(partPath)));
};

export const ensureJsonFromCompressedBackup = (jsonFilePath: string): boolean => {
  if (fs.existsSync(jsonFilePath)) return true;

  const gzBuffer = readCompressedBackupBuffer(jsonFilePath);
  if (!gzBuffer) return false;

  const jsonText = gunzipSync(gzBuffer).toString("utf-8");
  fs.writeFileSync(jsonFilePath, jsonText, "utf-8");
  return true;
};

export const listBackupJsonFiles = (dataDir: string): string[] => {
  if (!fs.existsSync(dataDir)) return [];
  const out = new Set<string>();

  for (const name of fs.readdirSync(dataDir)) {
    const matchJson = name.match(/^([A-Z]{2})_L(\d+)\.json$/i);
    if (matchJson) {
      out.add(`${matchJson[1].toUpperCase()}_L${Number(matchJson[2])}.json`);
      continue;
    }

    const matchGz = name.match(/^([A-Z]{2})_L(\d+)\.json\.gz$/i);
    if (matchGz) {
      out.add(`${matchGz[1].toUpperCase()}_L${Number(matchGz[2])}.json`);
      continue;
    }

    const matchSplitGz = name.match(/^([A-Z]{2})_L(\d+)\.json\.gz\.part-\d+$/i);
    if (matchSplitGz) {
      out.add(`${matchSplitGz[1].toUpperCase()}_L${Number(matchSplitGz[2])}.json`);
    }
  }

  return Array.from(out).sort();
};

export const readJsonFile = <T>(filePath: string): T => {
  const raw = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(raw) as T;
};
