# Geo Admin Area Backup (TypeScript)

TypeScript project for creating OSM admin-area backups and serving them as JSON.

It saves files in this format:

- `EE_L2.json`
- `EE_L6.json`
- `US_L4.json`

Each backup file keeps all source API fields:

- full Overpass response in `raw_api_response`
- matched raw element per row in `raw_api_element`
- transformed row fields (`name`, `tags`, `geom_geojson`, `center_geojson`, etc.)

## Install

```bash
npm install
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

All countries and all discovered levels:

```bash
npm run backup -- --all-countries=1 --all-levels=1 --out-dir=./data --delay-ms=400
```

Equivalent script:

```bash
npm run backup:global
```

Backup + commit + push:

```bash
npm run backup:push
```

### Backup arguments

- `--countries`: comma-separated ISO country codes (default `EE`)
- `--all-countries`: `1|true|yes` to auto-discover all country ISO codes from Overpass
- `--levels`: comma-separated admin levels (default `2,6,7,8,9,10`)
- `--all-levels`: `1|true|yes` to auto-discover all admin levels for each country
- `--out-dir`: output directory (default `./data`)
- `--delay-ms`: delay between requests in milliseconds (default `300`)

## Serve Backups as JSON API

```bash
npm run serve -- --data-dir=./data --host=127.0.0.1 --port=8787
```

API routes:

- `GET /health`
- `GET /backups`
- `GET /admin-areas?country=EE&level=2`
- `GET /admin-areas/EE/2`

## Timestamp behavior

Each backup JSON includes:

- `meta.created_at`: first time this backup file was created
- `meta.refreshed_at`: timestamp when this specific country+level file was refreshed

`refreshed_at` is updated on every write, even when the data did not change.

## Local automation (backup + commit + push)

Script file:

- `scripts/backup-and-push.sh`

Run it directly:

```bash
bash ./scripts/backup-and-push.sh
```

Or via npm:

```bash
npm run backup:push
```

What it does:

1. Runs full backup (`npm run backup:global`)
2. Stages `data/`
3. Commits only if there are changes
4. Pushes to your current branch remote

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
      "raw_api_element": {}
    }
  ],
  "raw_api_response": {}
}
```
