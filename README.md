# Geo Admin Area Backup (TypeScript)

TypeScript project for creating OSM admin-area backups and serving them as JSON.

## Data source

Backups are fetched from OpenStreetMap administrative boundary data through Overpass API:

- OpenStreetMap: [https://www.openstreetmap.org](https://www.openstreetmap.org)
- Overpass API main: [https://overpass-api.de](https://overpass-api.de)
- Mirror: [https://overpass.kumi.systems](https://overpass.kumi.systems)
- Mirror: [https://overpass.openstreetmap.ru](https://overpass.openstreetmap.ru)

## Why this backup exists

Overpass is very useful, but for bulk/global admin-area pulls it can be slow and occasionally unreliable (timeouts, rate limits, temporary outages).

This project keeps local JSON backups so you can:

- run tests without depending on live Overpass availability
- serve stable snapshot data for low-risk / lower-critical applications
- avoid repeated heavy requests against public Overpass endpoints

It saves files in this format:

- `EE_L2.json`
- `EE_L6.json`
- `US_L4.json`
- `EE_L2.json.gz` (compressed admin backups)
- `countries.json`

Each backup file keeps all source API fields:

- optional full Overpass response in a separate `*.raw.json` file, referenced by `raw_api_response_file`
- matched raw element reference per row in `raw_api_ref` (for example `relation/79510`)
- transformed row fields (`name`, `tags`, `geom_geojson`, `center_geojson`, etc.)

Import guard:

- for admin levels above 2, a row is kept only when its center point falls inside the target country's level-2 geometry
- this blocks cross-border relations from being duplicated into neighboring country snapshots

Admin area backups are stored compressed as `CC_L{level}.json.gz`.

For very large levels (for example large countries at deep admin levels), backup automatically falls back to chunked parent-area downloads.

By default (`--save-raw=0`), raw files are not kept and temporary chunk part files are deleted after successful merge.

## Install

```bash
npm install
```

## Docker image

GitHub Actions publishes a multi-arch image to GHCR for:

- `linux/amd64`
- `linux/arm64`

Image name:

```bash
ghcr.io/reijovosu/geo_admin_areas
```

Published tags:

- `:latest` points to the newest successful `main` build
- `:<commit_sha>` points to the exact source commit that built the image

Pull the newest published image:

```bash
docker pull ghcr.io/reijovosu/geo_admin_areas:latest
```

Run the API container:

```bash
docker run -d \
  --name geo-admin-areas \
  --pull always \
  -p 8787:8787 \
  ghcr.io/reijovosu/geo_admin_areas:latest
```

Use an exact immutable image version:

```bash
docker run -d \
  --name geo-admin-areas \
  -p 8787:8787 \
  ghcr.io/reijovosu/geo_admin_areas:<commit_sha>
```

Container environment variables:

- `HOST` default: `0.0.0.0`
- `PORT` default: `8787`
- `DATA_DIR` default: `/app/data`
- `NODE_OPTIONS` default: `--max-old-space-size=8192`

The server bootstrap can parse very large backup files when unpacking data and building `runtime/parent_osm_ids.sqlite`, so container memory matters. If you run into heap failures during startup, raise the Node heap explicitly:

```bash
docker run -d \
  --name geo-admin-areas \
  --pull always \
  -e NODE_OPTIONS=--max-old-space-size=12288 \
  -p 8787:8787 \
  ghcr.io/reijovosu/geo_admin_areas:latest
```

Example with a custom port:

```bash
docker run -d \
  --name geo-admin-areas \
  --pull always \
  -e PORT=8080 \
  -p 8080:8080 \
  ghcr.io/reijovosu/geo_admin_areas:latest
```

If you want Docker to check for a newer `:latest` image every time you start the container manually, use `--pull always` with `docker run`.

If you use Docker Compose, the equivalent is:

```yaml
services:
  geo-admin-areas:
    image: ghcr.io/reijovosu/geo_admin_areas:latest
    pull_policy: always
    ports:
      - "8787:8787"
```

Then start it with:

```bash
docker compose up -d
```

## Run Backups

Selected countries and levels:

```bash
npm run backup -- --countries=EE,LV,LT --levels=2,6,7,8,9,10 --out-dir=./data
```

All countries, selected levels:

```bash
npm run backup -- --all-countries=1 --levels=2,4,6 --out-dir=./data --delay-ms=400
```

When `--all-countries=1` is used, it also updates `data/countries.json` with country codes + names.

All countries and all discovered levels:

```bash
npm run backup -- --all-countries=1 --all-levels=1 --out-dir=./data --delay-ms=400
```

In this full-global mode, existing `data/[COUNTRY]_L[level].json` files are skipped.  
Only missing files are downloaded.
Skip check also accepts existing `data/[COUNTRY]_L[level].json.gz`.

To avoid repeated slow level-discovery calls, full-global missing-only mode caches discovered levels in `data/country-levels.json` and reuses that on next runs.

Equivalent script:

```bash
npm run backup:global
```

Refresh only missing files or files older than 7 days:

```bash
npm run backup:global:stale
```

Force a full refresh of all existing country/level files:

```bash
npm run backup:global:refresh
```

Compress existing legacy plain JSON backups:

```bash
npm run backups:zip
```

Memory tuning:

- default Node heap for backup scripts is `12288` MB
- override with `GEO_BACKUP_NODE_MB`

Example:

```bash
GEO_BACKUP_NODE_MB=16384 npm run backup:global
```

Backup + commit + push:

```bash
npm run backup:global:push
```

Refresh only missing/stale files + commit + push:

```bash
npm run backup:global:stale:push
```

Forced full refresh + commit + push:

```bash
npm run backup:global:refresh:push
```

## Parent Calculation

Build a local-only SQLite cache of straight parent mappings from the JSON backup files:

```bash
npm run parents -- --data-dir=./data --db-path=./data/runtime/parent_osm_ids.sqlite
```

Optional verification run:

```bash
npm run parents -- --data-dir=./data --db-path=./data/runtime/parent_osm_ids.sqlite --countries=EE --verify=1 --verify-sample-size=25
```

How it works:

- files are grouped by `country_code`
- for each child file `CC_L{level}.json`, candidate parent levels are the lower levels that exist for that same country
- parent lookup tries the closest lower level first, using child `center_geojson`
- each parent level uses a bbox prefilter before exact point-in-multipolygon checks against `geom_geojson`
- if multiple parents on the same level contain the child point, the smaller polygon area wins; ties fall back to smaller `osm_id`
- if local country snapshots cannot resolve a child, the calculator falls back to live OSM containment lookup for that child center only

`source_level` means:

- the parent level pass that produced the stored match
- if a child stays unresolved, `source_level` is the child file level that was processed

Unresolved rows:

- are still written to `parent_osm_ids`
- keep `parent_osm_type`, `parent_osm_id`, and `parent_admin_level` as `NULL`
- keep `child_center_geojson` so unresolved and live-fallback cases can be inspected later
- if live Overpass fallback fails for a specific row, that row is still stored and marked with `live_fallback_failed = 1` plus `live_fallback_error`

Version tracking:

- `parent_osm_ids_versions.refreshed_at` is copied from each JSON file's `meta.refreshed_at`
- repeated runs reuse existing SQLite rows when the per-country source versions have not changed

This script skips if `data/countries.json` already has `meta.refreshed_at` for the current UTC date.
Override that guard with:

```bash
FORCE_REFRESH_TODAY=1 npm run backup:global:refresh:push
```

### Backup arguments

- `--countries`: comma-separated ISO country codes (default `EE`)
- `--all-countries`: `1|true|yes` to auto-discover all country ISO codes from Overpass
- `--levels`: comma-separated admin levels (default `2,6,7,8,9,10`)
- `--all-levels`: `1|true|yes` to auto-discover all admin levels for each country
- `--force`: `1|true|yes` to refresh existing files instead of skipping them in full-global mode
- `--stale-days`: refresh only missing files or files older than this many days
- `--out-dir`: output directory (default `./data`)
- `--delay-ms`: delay between requests in milliseconds (default `300`)
- `--save-raw`: `1|true|yes` to keep `*.raw.json` files (default `0`)

## Serve Backups as JSON API

```bash
npm run serve -- --data-dir=./data --host=127.0.0.1 --port=8787
```

If a backup exists only as `*.json.gz`, server automatically extracts `*.json` on demand and serves it.

When the server starts, it prints:

- Swagger UI: `http://127.0.0.1:8787/docs`
- OpenAPI JSON: `http://127.0.0.1:8787/openapi.json`

API routes:

- `GET /docs`
- `GET /openapi.json`
- `GET /health`
- `GET /countries`
- `GET /backups`
- `GET /admin-areas?country=EE`
- `GET /admin-areas?country=EE&level=2`
- `GET /admin-areas/EE/2`
- `GET /relation/79510`
- `GET /osm/relation/79510`

## Timestamp behavior

Each backup JSON includes:

- `meta.created_at`: first time this backup file was created
- `meta.refreshed_at`: timestamp when this specific country+level file was refreshed

`refreshed_at` is updated on every write, even when the data did not change.

Note: in full-global missing-only mode (`--all-countries=1 --all-levels=1`), existing files are not rewritten, so their timestamps stay unchanged until you run a targeted refresh.

## Local automation (backup + commit + push)

Script file:

- `scripts/backup-and-push.sh`

Run it directly:

```bash
bash ./scripts/backup-and-push.sh
```

Or via npm:

```bash
npm run backup:global:push
```

What it does:

1. Runs full backup (`npm run backup:global`)
2. Compresses any plain admin backup JSON files (`npm run backups:zip`)
3. Stages `data/`
4. Commits only if there are changes
5. Pushes to your current branch remote

## Example backup file

```json
{
  "meta": {
    "created_at": "2026-02-28T10:00:00Z",
    "refreshed_at": "2026-02-28T11:45:00Z",
    "country_code": "EE",
    "level": 2,
    "source": "overpass",
    "format": 2,
    "endpoint": "https://overpass-api.de/api/interpreter"
  },
  "rows": [
    {
      "country_code": "EE",
      "admin_level": 2,
      "osm_type": "relation",
      "osm_id": 79510,
      "name": "Eesti",
      "tags": {},
      "center_geojson": "{...}",
      "geom_geojson": "{...}",
      "feature_properties": {},
      "raw_api_ref": "relation/79510"
    }
  ],
  "raw_api_response_file": null
}
```
