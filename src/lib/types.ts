export interface BackupMeta {
  created_at: string;
  refreshed_at: string;
  country_code: string;
  level: number;
  source: "overpass";
  format: 2;
  endpoint: string;
}

export interface BackupRow {
  country_code: string;
  admin_level: number | null;
  osm_type: "relation" | "way";
  osm_id: number;
  name: string;
  tags: Record<string, unknown>;
  center_geojson: string;
  geom_geojson: string;
  feature_properties: Record<string, unknown>;
  raw_api_ref: string | null;
}

export interface BackupPayload {
  meta: BackupMeta;
  rows: BackupRow[];
  raw_api_response_file: string | null;
}

export interface CountriesMeta {
  created_at: string;
  refreshed_at: string;
  source: "overpass";
  format: 1;
  endpoint: string;
}

export interface CountryItem {
  country_code: string;
  name: string | null;
  name_en: string | null;
  int_name: string | null;
  official_name: string | null;
  tags: Record<string, unknown>;
}

export interface CountriesPayload {
  meta: CountriesMeta;
  countries: CountryItem[];
  raw_api_response_file: string | null;
}

export interface BackupOptions {
  countries: string[];
  allCountries: boolean;
  levels: number[];
  allLevels: boolean;
  force: boolean;
  staleDays: number;
  saveRaw: boolean;
  outDir: string;
  delayMs: number;
}

export interface ServeOptions {
  dataDir: string;
  host: string;
  port: number;
}

export interface StartupStatus {
  state: "pending" | "running" | "ready" | "failed";
  phase:
    | "idle"
    | "discovering"
    | "unpacking"
    | "preparing_database"
    | "loading_country"
    | "processing_level"
    | "resolving_live"
    | "verifying_country"
    | "complete"
    | "failed";
  db_path: string;
  started_at: string | null;
  finished_at: string | null;
  total_backup_files: number;
  unpacked_backup_files: number;
  countries_total: number;
  countries_completed: number;
  current_file: string | null;
  current_country: string | null;
  message: string;
  error: string | null;
}
