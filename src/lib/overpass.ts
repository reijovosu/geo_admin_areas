const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.openstreetmap.ru/api/interpreter",
] as const;

const FETCH_TIMEOUT_MS = 120_000;

const sleep = async (ms: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

export const buildOverpassQuery = (countryCode: string, adminLevel: number): string => {
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
(
  relation["boundary"="administrative"]["admin_level"](area.country);
);
out tags;
`;
};

export const fetchOverpass = async (
  query: string,
): Promise<{ endpoint: string; data: Record<string, unknown>; rawText: string }> => {
  let lastError: unknown = null;

  for (const endpoint of OVERPASS_ENDPOINTS) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
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
          await sleep(800 * Math.pow(2, attempt - 1));
          continue;
        }

        if (!response.ok) {
          throw new Error(`Overpass ${response.status} ${endpoint}: ${text.slice(0, 240)}`);
        }

        const startsLikeXml = /^\s*</.test(text);
        if (startsLikeXml || (!ct.includes("json") && !text.trim().startsWith("{"))) {
          throw new Error(
            `Overpass non-JSON response (${endpoint}): ${text.slice(0, 200)}`,
          );
        }

        const parsed = JSON.parse(text) as Record<string, unknown>;
        return { endpoint, data: parsed, rawText: text };
      } catch (error) {
        lastError = error;
        await sleep(800 * Math.pow(2, attempt - 1));
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Overpass request failed");
};

export const extractCountryCodes = (payload: Record<string, unknown>): string[] => {
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

    const iso2 = String(tags["ISO3166-1"] ?? "").trim().toUpperCase();
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

    const iso2 = String(tags["ISO3166-1"] ?? "").trim().toUpperCase();
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

  return Array.from(byCode.values()).sort((a, b) => a.country_code.localeCompare(b.country_code));
};

export const extractAdminLevels = (payload: Record<string, unknown>): number[] => {
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
