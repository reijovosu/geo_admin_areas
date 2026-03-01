import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { gunzipSync } from "node:zlib";
import { backupFilePath, readJsonFile } from "../lib/fs.js";
import type { BackupPayload, CountriesPayload, ServeOptions } from "../lib/types.js";

interface BackupIndexItem {
  file: string;
  country_code: string | null;
  level: number | null;
  rows: number;
  kind: "admin_areas" | "countries";
  updated_at: string;
}

const sendJson = (res: http.ServerResponse, statusCode: number, payload: unknown): void => {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(`${JSON.stringify(payload, null, 2)}\n`);
};

const listBackupFiles = (dataDir: string): string[] => {
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
    }
  }

  return Array.from(out).sort();
};

const ensureJsonFromGzip = (jsonFilePath: string): boolean => {
  if (fs.existsSync(jsonFilePath)) return true;

  const gzFilePath = `${jsonFilePath}.gz`;
  if (!fs.existsSync(gzFilePath)) return false;

  const gzBuffer = fs.readFileSync(gzFilePath);
  const jsonText = gunzipSync(gzBuffer).toString("utf-8");
  fs.writeFileSync(jsonFilePath, jsonText, "utf-8");
  return true;
};

const toIndexItem = (dataDir: string, file: string): BackupIndexItem | null => {
  if (file === "countries.json") {
    const parsed = readJsonFile<CountriesPayload>(path.join(dataDir, file));
    const stat = fs.statSync(path.join(dataDir, file));
    return {
      file,
      country_code: null,
      level: null,
      rows: Array.isArray(parsed.countries) ? parsed.countries.length : 0,
      kind: "countries",
      updated_at: stat.mtime.toISOString(),
    };
  }

  const match = file.match(/^([A-Z]{2})_L(\d+)\.json$/i);
  if (!match) return null;

  const jsonPath = path.join(dataDir, file);
  if (!ensureJsonFromGzip(jsonPath)) return null;

  const parsed = readJsonFile<BackupPayload>(jsonPath);
  const stat = fs.statSync(jsonPath);

  return {
    file,
    country_code: match[1].toUpperCase(),
    level: Number(match[2]),
    rows: Array.isArray(parsed.rows) ? parsed.rows.length : 0,
    kind: "admin_areas",
    updated_at: stat.mtime.toISOString(),
  };
};

export const runServer = async (options: ServeOptions): Promise<void> => {
  const dataDir = path.resolve(process.cwd(), options.dataDir);

  const server = http.createServer((req, res) => {
    if (!req.url) {
      sendJson(res, 400, { error: "Missing URL" });
      return;
    }

    const url = new URL(req.url, `http://${options.host}:${options.port}`);

    if (url.pathname === "/health") {
      sendJson(res, 200, {
        ok: true,
        data_dir: dataDir,
      });
      return;
    }

    if (url.pathname === "/backups") {
      const items = listBackupFiles(dataDir)
        .concat(fs.existsSync(path.join(dataDir, "countries.json")) ? ["countries.json"] : [])
        .map((file) => toIndexItem(dataDir, file))
        .filter((item): item is BackupIndexItem => item !== null);
      sendJson(res, 200, {
        count: items.length,
        items,
      });
      return;
    }

    if (url.pathname === "/countries") {
      const filePath = path.join(dataDir, "countries.json");
      if (!fs.existsSync(filePath)) {
        sendJson(res, 404, {
          error: "countries.json not found. Run backup with --all-countries=1 first.",
        });
        return;
      }
      sendJson(res, 200, readJsonFile<CountriesPayload>(filePath));
      return;
    }

    if (url.pathname === "/admin-areas") {
      const country = String(url.searchParams.get("country") ?? "").toUpperCase();
      const level = Number(url.searchParams.get("level") ?? NaN);

      if (!country || !Number.isFinite(level)) {
        sendJson(res, 400, {
          error: "Provide query params: country=EE&level=2",
        });
        return;
      }

      const filePath = backupFilePath(dataDir, country, level);
      if (!ensureJsonFromGzip(filePath)) {
        sendJson(res, 404, { error: `Backup not found for ${country} L${level}` });
        return;
      }

      sendJson(res, 200, readJsonFile<BackupPayload>(filePath));
      return;
    }

    const routeMatch = url.pathname.match(/^\/admin-areas\/([A-Za-z]{2})\/(\d+)$/);
    if (routeMatch) {
      const country = routeMatch[1].toUpperCase();
      const level = Number(routeMatch[2]);
      const filePath = backupFilePath(dataDir, country, level);

      if (!ensureJsonFromGzip(filePath)) {
        sendJson(res, 404, { error: `Backup not found for ${country} L${level}` });
        return;
      }

      sendJson(res, 200, readJsonFile<BackupPayload>(filePath));
      return;
    }

    sendJson(res, 404, {
      error: "Not found",
      routes: [
        "/health",
        "/countries",
        "/backups",
        "/admin-areas?country=EE&level=2",
        "/admin-areas/EE/2",
      ],
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.on("error", reject);
    server.listen(options.port, options.host, () => {
      console.log(`Server listening on http://${options.host}:${options.port}`);
      console.log(`Data dir: ${dataDir}`);
      resolve();
    });
  });
};
