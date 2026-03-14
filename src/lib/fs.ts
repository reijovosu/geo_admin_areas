import fs from "node:fs";
import path from "node:path";

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

export const readJsonFile = <T>(filePath: string): T => {
  const raw = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(raw) as T;
};
