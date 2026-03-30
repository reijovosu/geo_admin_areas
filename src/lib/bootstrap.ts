import { listBackupJsonFiles } from "./fs.js";
import { calculateParentOsmIds } from "./parents.js";
import type { StartupStatus } from "./types.js";

const createInitialStatus = (dbPath: string): StartupStatus => ({
  state: "pending",
  phase: "idle",
  db_path: dbPath,
  started_at: null,
  finished_at: null,
  total_backup_files: 0,
  unpacked_backup_files: 0,
  countries_total: 0,
  countries_completed: 0,
  current_file: null,
  current_country: null,
  message: "Startup bootstrap has not started yet.",
  error: null,
});
export const createStartupStatus = (dbPath: string): StartupStatus => {
  return createInitialStatus(dbPath);
};

export const bootstrapLocalData = async (
  dataDir: string,
  status: StartupStatus,
): Promise<void> => {
  const dbPath = status.db_path;
  status.state = "running";
  status.phase = "discovering";
  status.started_at = new Date().toISOString();
  status.finished_at = null;
  status.error = null;
  status.message = "Discovering backup files.";

  const backupFiles = listBackupJsonFiles(dataDir);
  status.total_backup_files = backupFiles.length;
  status.unpacked_backup_files = 0;
  status.countries_total = new Set(
    backupFiles.map((fileName) => fileName.match(/^([A-Z]{2})_L\d+\.json$/i)?.[1]).filter(Boolean),
  ).size;
  status.countries_completed = 0;
  const processedCountries = new Set<string>();

  await calculateParentOsmIds({
    dataDir,
    dbPath: status.db_path,
    unpackIfNeeded: true,
    liveFallback: true,
    onProgress: (progress) => {
      status.phase = progress.phase;
      status.message = progress.message;
      status.current_country = progress.countryCode ?? null;
      status.current_file = progress.fileName ?? null;
      if (progress.phase === "unpacking") {
        status.unpacked_backup_files = Math.min(status.total_backup_files, status.unpacked_backup_files + 1);
      }
      if (progress.phase === "processing_level" && progress.countryCode) {
        if (!processedCountries.has(progress.countryCode)) {
          processedCountries.add(progress.countryCode);
          status.countries_completed += 1;
        }
      }
    },
  });

  status.state = "ready";
  status.phase = "complete";
  status.current_country = null;
  status.current_file = null;
  status.countries_completed = status.countries_total;
  status.unpacked_backup_files = status.total_backup_files;
  status.finished_at = new Date().toISOString();
  status.message = `Bootstrap complete. SQLite ready at ${dbPath}.`;
};

export const markStartupFailure = (status: StartupStatus, error: unknown): void => {
  const message = error instanceof Error ? error.message : String(error);
  status.state = "failed";
  status.phase = "failed";
  status.error = message;
  status.finished_at = new Date().toISOString();
  status.message = `Bootstrap failed: ${message}`;
  status.current_country = null;
  status.current_file = null;
};

export const getBootstrapSummary = (status: StartupStatus): Record<string, unknown> => ({
  state: status.state,
  phase: status.phase,
  db_path: status.db_path,
  started_at: status.started_at,
  finished_at: status.finished_at,
  total_backup_files: status.total_backup_files,
  unpacked_backup_files: status.unpacked_backup_files,
  countries_total: status.countries_total,
  countries_completed: status.countries_completed,
  current_file: status.current_file,
  current_country: status.current_country,
  message: status.message,
  error: status.error,
});
