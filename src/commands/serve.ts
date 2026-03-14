import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { gunzipSync } from "node:zlib";
import {
  backupFilePath,
  readCompressedBackupBuffer,
  readJsonFile,
} from "../lib/fs.js";
import type { BackupPayload, CountriesPayload, ServeOptions } from "../lib/types.js";

interface BackupIndexItem {
  file: string;
  country_code: string | null;
  level: number | null;
  rows: number;
  kind: "admin_areas" | "countries";
  updated_at: string;
}

const sendHtml = (res: http.ServerResponse, statusCode: number, html: string): void => {
  res.statusCode = statusCode;
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(html);
};

const sendJson = (res: http.ServerResponse, statusCode: number, payload: unknown): void => {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(`${JSON.stringify(payload, null, 2)}\n`);
};

const createOpenApiDocument = (baseUrl: string) => ({
  openapi: "3.0.3",
  info: {
    title: "Geo Admin Areas API",
    version: "1.0.0",
    description: "API for browsing country and admin area backup snapshots.",
  },
  servers: [
    {
      url: baseUrl,
      description: "Local server",
    },
  ],
  tags: [
    { name: "System" },
    { name: "Catalog" },
    { name: "Admin Areas" },
  ],
  paths: {
    "/health": {
      get: {
        tags: ["System"],
        summary: "Health check",
        responses: {
          "200": {
            description: "Server status",
          },
        },
      },
    },
    "/backups": {
      get: {
        tags: ["Catalog"],
        summary: "List available backup files",
        responses: {
          "200": {
            description: "Available backup entries",
          },
        },
      },
    },
    "/countries": {
      get: {
        tags: ["Catalog"],
        summary: "Return the countries catalog",
        responses: {
          "200": {
            description: "Countries dataset",
          },
          "404": {
            description: "countries.json is missing",
          },
        },
      },
    },
    "/admin-areas": {
      get: {
        tags: ["Admin Areas"],
        summary: "Lookup admin area levels or a specific backup",
        parameters: [
          {
            name: "country",
            in: "query",
            required: true,
            description: "Two-letter ISO country code, for example EE",
            schema: {
              type: "string",
              example: "EE",
            },
          },
          {
            name: "level",
            in: "query",
            required: false,
            description: "Admin level number. Omit to list available levels.",
            schema: {
              type: "integer",
              example: 2,
            },
          },
        ],
        responses: {
          "200": {
            description: "Levels list or admin area backup payload",
          },
          "400": {
            description: "Missing or invalid query params",
          },
          "404": {
            description: "No data found for the requested country or level",
          },
        },
      },
    },
    "/admin-areas/{country}/{level}": {
      get: {
        tags: ["Admin Areas"],
        summary: "Return a specific admin area backup",
        parameters: [
          {
            name: "country",
            in: "path",
            required: true,
            description: "Two-letter ISO country code",
            schema: {
              type: "string",
              example: "EE",
            },
          },
          {
            name: "level",
            in: "path",
            required: true,
            description: "Admin level number",
            schema: {
              type: "integer",
              example: 2,
            },
          },
        ],
        responses: {
          "200": {
            description: "Admin area backup payload",
          },
          "404": {
            description: "Backup file not found",
          },
        },
      },
    },
  },
});

const createSwaggerHtml = (specUrl: string) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Geo Admin Areas API Docs</title>
    <link
      rel="stylesheet"
      href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css"
    />
    <style>
      html, body {
        margin: 0;
        background: #f5f7fb;
      }

      .topbar {
        display: none;
      }
    </style>
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
    <script>
      window.ui = SwaggerUIBundle({
        url: ${JSON.stringify(specUrl)},
        dom_id: "#swagger-ui",
        deepLinking: true,
        displayRequestDuration: true,
        persistAuthorization: false
      });
    </script>
  </body>
</html>`;

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
      continue;
    }

    const matchSplitGz = name.match(/^([A-Z]{2})_L(\d+)\.json\.gz\.part-\d+$/i);
    if (matchSplitGz) {
      out.add(`${matchSplitGz[1].toUpperCase()}_L${Number(matchSplitGz[2])}.json`);
    }
  }

  return Array.from(out).sort();
};

const listCountryLevels = (dataDir: string, countryCode: string): number[] => {
  const country = countryCode.toUpperCase();
  return listBackupFiles(dataDir)
    .map((file) => file.match(/^([A-Z]{2})_L(\d+)\.json$/i))
    .filter((match): match is RegExpMatchArray => match !== null && match[1].toUpperCase() === country)
    .map((match) => Number(match[2]))
    .sort((a, b) => a - b);
};

const ensureJsonFromGzip = (jsonFilePath: string): boolean => {
  if (fs.existsSync(jsonFilePath)) return true;

  const gzBuffer = readCompressedBackupBuffer(jsonFilePath);
  if (!gzBuffer) return false;

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
  const baseUrl = `http://${options.host}:${options.port}`;
  const docsUrl = `${baseUrl}/docs`;
  const openApiUrl = `${baseUrl}/openapi.json`;

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

    if (url.pathname === "/openapi.json") {
      sendJson(res, 200, createOpenApiDocument(baseUrl));
      return;
    }

    if (url.pathname === "/docs") {
      sendHtml(res, 200, createSwaggerHtml(openApiUrl));
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
      const levelRaw = url.searchParams.get("level");

      if (!country) {
        sendJson(res, 400, {
          error: "Provide query params: country=EE or country=EE&level=2",
        });
        return;
      }

      if (levelRaw === null) {
        const levels = listCountryLevels(dataDir, country);
        if (levels.length === 0) {
          sendJson(res, 404, { error: `No backups found for ${country}` });
          return;
        }

        sendJson(res, 200, {
          country_code: country,
          levels,
          count: levels.length,
        });
        return;
      }

      const level = Number(levelRaw);
      if (!Number.isFinite(level)) {
        sendJson(res, 400, {
          error: "Invalid level. Provide query params: country=EE&level=2",
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
        "/docs",
        "/openapi.json",
        "/health",
        "/countries",
        "/backups",
        "/admin-areas?country=EE",
        "/admin-areas?country=EE&level=2",
        "/admin-areas/EE/2",
      ],
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.on("error", reject);
    server.listen(options.port, options.host, () => {
      console.log(`Server listening on ${baseUrl}`);
      console.log(`Swagger docs: ${docsUrl}`);
      console.log(`OpenAPI spec: ${openApiUrl}`);
      console.log(`Data dir: ${dataDir}`);
      resolve();
    });
  });
};
