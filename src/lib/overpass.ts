const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.openstreetmap.ru/api/interpreter",
] as const;

const envNumberOrFallback = (name: string, fallback: number): number => {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;

  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

const FETCH_TIMEOUT_MS = envNumberOrFallback("OVERPASS_TIMEOUT_MS", 120_000);
const FETCH_RETRY_ATTEMPTS = Math.max(1, envNumberOrFallback("OVERPASS_RETRY_ATTEMPTS", 10));
const FETCH_RETRY_BASE_DELAY_MS = envNumberOrFallback("OVERPASS_RETRY_BASE_DELAY_MS", 2_000);
const FETCH_RETRY_MAX_DELAY_MS = Math.max(
  FETCH_RETRY_BASE_DELAY_MS,
  envNumberOrFallback("OVERPASS_RETRY_MAX_DELAY_MS", 30_000),
);

const sleep = async (ms: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

const computeRetryDelayMs = (attempt: number): number => {
  const exponentialDelay = FETCH_RETRY_BASE_DELAY_MS * Math.pow(2, Math.max(0, attempt - 1));
  return Math.min(FETCH_RETRY_MAX_DELAY_MS, exponentialDelay);
};

const formatError = (error: unknown): string => {
  if (error instanceof Error) {
    const causeMessage =
      error.cause instanceof Error
        ? error.cause.message
        : error.cause != null
          ? String(error.cause)
          : "";

    return causeMessage
      ? `${error.message} (cause: ${causeMessage})`
      : error.message;
  }

  if (typeof error === "string") return error;

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
};

export const buildOverpassQuery = (
  countryCode: string,
  adminLevel: number,
): string => {
  if (adminLevel === 2) {
    return `
      [out:json][timeout:180];
      relation
        ["boundary"="administrative"]
        ["admin_level"="2"]
        ["ISO3166-1"="${countryCode}"];
      out body center geom;
    `;
  }

  return `
    [out:json][timeout:180];
    area["ISO3166-1"="${countryCode}"]["admin_level"="2"]->.country;
    (
      relation["boundary"="administrative"]["admin_level"="${adminLevel}"](area.country);
    );
    out body center geom;
  `;
};

export const buildAllCountriesQuery = (): string => {
  return `
    [out:json][timeout:180];
    relation["boundary"="administrative"]["admin_level"="2"]["ISO3166-1"];
    out tags;
  `;
};

export const buildCountryLevelsQuery = (countryCode: string): string => {
  return `
    [out:json][timeout:180];
    area["ISO3166-1"="${countryCode}"]["admin_level"="2"]->.country;
    relation
      ["boundary"="administrative"]
      ["admin_level"]
      (area.country);
    out tags;
  `;
};

export const buildParentRelationsQuery = (
  countryCode: string,
  parentLevel: number,
): string => {
  if (parentLevel === 2) {
    return `
      [out:json][timeout:180];
      relation
        ["boundary"="administrative"]
        ["admin_level"="2"]
        ["ISO3166-1"="${countryCode}"];
      out ids;
    `;
  }

  return `
    [out:json][timeout:180];
    area["ISO3166-1"="${countryCode}"]["admin_level"="2"]->.country;
    relation["boundary"="administrative"]["admin_level"="${parentLevel}"](area.country);
    out ids;
  `;
};

export const buildOverpassQueryForParentRelation = (
  parentRelationId: number,
  targetLevel: number,
): string => {
  return `
    [out:json][timeout:180];
    relation(${parentRelationId});
    map_to_area->.pa;
    relation["boundary"="administrative"]["admin_level"="${targetLevel}"](area.pa);
    out body center geom;
  `;
};

export const buildContainingAdminAreasQuery = (
  lat: number,
  lon: number,
): string => {
  return `
    [out:json][timeout:180];
    is_in(${lat},${lon})->.containers;
    relation(pivot.containers)["boundary"="administrative"]["admin_level"];
    out tags center;
  `;
};

export const fetchOverpass = async (
  query: string,
): Promise<{
  endpoint: string;
  data: Record<string, unknown>;
  rawText: string;
}> => {
  let lastError: unknown = null;
  let lastEndpoint = "";
  let lastAttempt = 0;

  for (const endpoint of OVERPASS_ENDPOINTS) {
    for (let attempt = 1; attempt <= FETCH_RETRY_ATTEMPTS; attempt++) {
      try {
        lastEndpoint = endpoint;
        lastAttempt = attempt;

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
          },
          body: new URLSearchParams({ data: query }),
          signal: controller.signal,
        }).finally(() => clearTimeout(timeout));

        const text = await response.text();
        const ct = String(response.headers.get("content-type") ?? "");

        if ([429, 502, 503, 504].includes(response.status)) {
          lastError = new Error(`Overpass ${response.status} ${endpoint}`);
          if (attempt < FETCH_RETRY_ATTEMPTS) {
            const delayMs = computeRetryDelayMs(attempt);
            console.warn(
              `Overpass retry scheduled endpoint=${endpoint} attempt=${attempt}/${FETCH_RETRY_ATTEMPTS} delay_ms=${delayMs} reason=status_${response.status}`,
            );
            await sleep(delayMs);
          }
          continue;
        }

        if (!response.ok) {
          throw new Error(
            `Overpass ${response.status} ${endpoint}: ${text.slice(0, 240)}`,
          );
        }

        const startsLikeXml = /^\s*</.test(text);
        if (startsLikeXml || ct.includes("xml") || ct.includes("html")) {
          throw new Error(
            `Overpass non-JSON response from ${endpoint}: ${text.slice(0, 240)}`,
          );
        }

        const parsed = JSON.parse(text) as Record<string, unknown>;
        return { endpoint, data: parsed, rawText: text };
      } catch (error) {
        lastError = error;
        const msg = formatError(error);
        console.warn(
          `Overpass request failed endpoint=${endpoint} attempt=${attempt}/${FETCH_RETRY_ATTEMPTS} timeout_ms=${FETCH_TIMEOUT_MS} error=${msg}`,
        );
        if (attempt < FETCH_RETRY_ATTEMPTS) {
          const delayMs = computeRetryDelayMs(attempt);
          console.warn(
            `Overpass retry scheduled endpoint=${endpoint} attempt=${attempt}/${FETCH_RETRY_ATTEMPTS} delay_ms=${delayMs}`,
          );
          await sleep(delayMs);
        }
      }
    }
  }

  const lastMessage = formatError(lastError);
  throw new Error(
    `Overpass request failed after all endpoints. Last endpoint=${lastEndpoint} attempt=${lastAttempt}/${FETCH_RETRY_ATTEMPTS} error=${lastMessage}`,
  );
};

export const extractCountryCodes = (
  payload: Record<string, unknown>,
): string[] => {
  const elements = Array.isArray(payload.elements)
    ? (payload.elements as Array<Record<string, unknown>>)
    : [];
  const countryCodes = new Set<string>();

  for (const element of elements) {
    const tags =
      element.tags && typeof element.tags === "object"
        ? (element.tags as Record<string, unknown>)
        : null;
    if (!tags) continue;

    const iso2 = String(tags["ISO3166-1"] ?? "")
      .trim()
      .toUpperCase();
    if (/^[A-Z]{2}$/.test(iso2)) {
      countryCodes.add(iso2);
    }
  }

  return Array.from(countryCodes).sort();
};

export const extractCountries = (
  payload: Record<string, unknown>,
): Array<{
  country_code: string;
  name: string | null;
  name_en: string | null;
  int_name: string | null;
  official_name: string | null;
  tags: Record<string, unknown>;
}> => {
  const elements = Array.isArray(payload.elements)
    ? (payload.elements as Array<Record<string, unknown>>)
    : [];
  const byCode = new Map<
    string,
    {
      country_code: string;
      name: string | null;
      name_en: string | null;
      int_name: string | null;
      official_name: string | null;
      tags: Record<string, unknown>;
    }
  >();

  for (const element of elements) {
    const tags =
      element.tags && typeof element.tags === "object"
        ? (element.tags as Record<string, unknown>)
        : null;
    if (!tags) continue;

    const iso2 = String(tags["ISO3166-1"] ?? "")
      .trim()
      .toUpperCase();
    if (!/^[A-Z]{2}$/.test(iso2)) continue;

    const toName = (value: unknown): string | null => {
      const s = String(value ?? "").trim();
      return s ? s : null;
    };

    byCode.set(iso2, {
      country_code: iso2,
      name: toName(tags.name),
      name_en: toName(tags["name:en"]),
      int_name: toName(tags.int_name),
      official_name: toName(tags.official_name),
      tags,
    });
  }

  return Array.from(byCode.values()).sort((a, b) =>
    a.country_code.localeCompare(b.country_code),
  );
};

export const extractAdminLevels = (
  payload: Record<string, unknown>,
): number[] => {
  const elements = Array.isArray(payload.elements)
    ? (payload.elements as Array<Record<string, unknown>>)
    : [];
  const levels = new Set<number>();

  for (const element of elements) {
    const tags =
      element.tags && typeof element.tags === "object"
        ? (element.tags as Record<string, unknown>)
        : null;
    if (!tags) continue;

    const levelRaw = String(tags.admin_level ?? "").trim();
    const level = Number(levelRaw);

    if (Number.isInteger(level) && level > 0) {
      levels.add(level);
    }
  }

  return Array.from(levels).sort((a, b) => a - b);
};

export const extractRelationIds = (
  payload: Record<string, unknown>,
): number[] => {
  const elements = Array.isArray(payload.elements)
    ? (payload.elements as Array<Record<string, unknown>>)
    : [];
  const ids = new Set<number>();

  for (const element of elements) {
    if (String(element.type ?? "") !== "relation") continue;
    const id = Number(element.id);
    if (Number.isInteger(id) && id > 0) ids.add(id);
  }

  return Array.from(ids).sort((a, b) => a - b);
};

export const extractContainingAdminAreas = (
  payload: Record<string, unknown>,
): Array<{
  osm_type: "relation";
  osm_id: number;
  admin_level: number | null;
  tags: Record<string, unknown>;
}> => {
  const elements = Array.isArray(payload.elements)
    ? (payload.elements as Array<Record<string, unknown>>)
    : [];
  const out = new Map<number, {
    osm_type: "relation";
    osm_id: number;
    admin_level: number | null;
    tags: Record<string, unknown>;
  }>();

  for (const element of elements) {
    if (String(element.type ?? "") !== "relation") continue;
    const osmId = Number(element.id);
    if (!Number.isInteger(osmId) || osmId <= 0) continue;

    const tags =
      element.tags && typeof element.tags === "object"
        ? (element.tags as Record<string, unknown>)
        : {};
    const adminLevelRaw = Number(String(tags.admin_level ?? "").trim());

    out.set(osmId, {
      osm_type: "relation",
      osm_id: osmId,
      admin_level: Number.isInteger(adminLevelRaw) && adminLevelRaw > 0 ? adminLevelRaw : null,
      tags,
    });
  }

  return Array.from(out.values()).sort((a, b) => {
    const aLevel = a.admin_level ?? Number.MAX_SAFE_INTEGER;
    const bLevel = b.admin_level ?? Number.MAX_SAFE_INTEGER;
    if (aLevel !== bLevel) return aLevel - bLevel;
    return a.osm_id - b.osm_id;
  });
};
