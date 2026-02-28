import osmtogeojson from "osmtogeojson";
import type { BackupRow } from "./types.js";

interface OverpassElement {
  type?: unknown;
  id?: unknown;
  tags?: unknown;
  center?: unknown;
  geometry?: unknown;
  [key: string]: unknown;
}

interface GeoJSONFeature {
  geometry?: {
    type?: string;
    coordinates?: unknown;
  } | null;
  properties?: Record<string, unknown> | null;
}

interface GeoJSONFeatureCollection {
  features?: GeoJSONFeature[];
}

const normalizeMultiPolygon = (
  geometry: GeoJSONFeature["geometry"],
): { type: "MultiPolygon"; coordinates: unknown } | null => {
  if (!geometry?.type) return null;

  if (geometry.type === "MultiPolygon") {
    return {
      type: "MultiPolygon",
      coordinates: geometry.coordinates,
    };
  }

  if (geometry.type === "Polygon") {
    return {
      type: "MultiPolygon",
      coordinates: [geometry.coordinates],
    };
  }

  return null;
};

const parseOsmId = (properties: Record<string, unknown>): number | null => {
  const raw = properties.id ?? properties["@id"] ?? properties.osm_id;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;

  if (typeof raw === "string") {
    const match = raw.match(/(\d+)/);
    if (match) return Number(match[1]);
  }

  return null;
};

const parseOsmType = (properties: Record<string, unknown>): "relation" | "way" => {
  const t = String(properties.type ?? "").toLowerCase();
  return t === "way" ? "way" : "relation";
};

const deriveCenterFromGeom = (
  geom: { type: "MultiPolygon"; coordinates: unknown },
): { type: "Point"; coordinates: [number, number] } | null => {
  if (!Array.isArray(geom.coordinates) || geom.coordinates.length === 0) return null;

  const poly0 = geom.coordinates[0];
  if (!Array.isArray(poly0) || poly0.length === 0) return null;

  const ring0 = poly0[0];
  if (!Array.isArray(ring0) || ring0.length === 0) return null;

  let sumLon = 0;
  let sumLat = 0;
  let n = 0;

  for (const point of ring0) {
    if (!Array.isArray(point) || point.length < 2) continue;
    const lon = point[0];
    const lat = point[1];
    if (typeof lon === "number" && typeof lat === "number") {
      sumLon += lon;
      sumLat += lat;
      n += 1;
    }
  }

  if (n === 0) return null;
  return { type: "Point", coordinates: [sumLon / n, sumLat / n] };
};

const pickCenter = (
  properties: Record<string, unknown>,
  geom: { type: "MultiPolygon"; coordinates: unknown },
): { type: "Point"; coordinates: [number, number] } | null => {
  const center = properties.center;
  if (
    center &&
    typeof center === "object" &&
    (center as { type?: unknown }).type === "Point" &&
    Array.isArray((center as { coordinates?: unknown }).coordinates)
  ) {
    return center as { type: "Point"; coordinates: [number, number] };
  }

  const lon = properties.center_lon;
  const lat = properties.center_lat;
  if (typeof lon === "number" && typeof lat === "number") {
    return { type: "Point", coordinates: [lon, lat] };
  }

  return deriveCenterFromGeom(geom);
};

const buildElementIndex = (elements: OverpassElement[]): Map<string, OverpassElement> => {
  const index = new Map<string, OverpassElement>();

  for (const element of elements) {
    const type = typeof element.type === "string" ? element.type.toLowerCase() : "";
    const id = typeof element.id === "number" ? element.id : Number(element.id);
    if (!type || !Number.isFinite(id)) continue;
    index.set(`${type}/${id}`, element);
  }

  return index;
};

export const overpassToRows = (
  countryCode: string,
  level: number,
  overpassPayload: Record<string, unknown>,
): BackupRow[] => {
  const fc = osmtogeojson(overpassPayload) as GeoJSONFeatureCollection;
  const features = Array.isArray(fc.features) ? fc.features : [];
  const elements = Array.isArray(overpassPayload.elements)
    ? (overpassPayload.elements as OverpassElement[])
    : [];
  const elementIndex = buildElementIndex(elements);

  const rows: BackupRow[] = [];

  for (const feature of features) {
    const properties = feature.properties ?? {};
    const name = String(properties.name ?? "").trim();
    if (!name) continue;

    if (properties.boundary && properties.boundary !== "administrative") continue;

    const geom = normalizeMultiPolygon(feature.geometry);
    if (!geom) continue;

    const osmId = parseOsmId(properties);
    if (osmId == null) continue;

    const osmType = parseOsmType(properties);
    const center = pickCenter(properties, geom);
    if (!center) continue;

    const adminLevelCandidate = Number(properties.admin_level);
    const adminLevel = Number.isFinite(adminLevelCandidate) ? adminLevelCandidate : level;

    const rawApiElement = elementIndex.get(`${osmType}/${osmId}`) ?? null;

    rows.push({
      country_code: countryCode,
      admin_level: Number.isFinite(adminLevel) ? adminLevel : null,
      osm_type: osmType,
      osm_id: osmId,
      name,
      tags: (properties as Record<string, unknown>) ?? {},
      center_geojson: JSON.stringify(center),
      geom_geojson: JSON.stringify(geom),
      feature_properties: properties,
      raw_api_element: rawApiElement,
    });
  }

  return rows;
};
