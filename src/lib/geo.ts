export interface MultiPolygonGeometry {
  type: "MultiPolygon";
  coordinates: unknown;
}

export interface BoundingBox {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

type LinearRing = Array<[number, number]>;
type PolygonCoordinates = Array<LinearRing>;

const isLinearRing = (value: unknown): value is LinearRing => {
  return (
    Array.isArray(value) &&
    value.every(
      (point) =>
        Array.isArray(point) &&
        point.length >= 2 &&
        typeof point[0] === "number" &&
        Number.isFinite(point[0]) &&
        typeof point[1] === "number" &&
        Number.isFinite(point[1]),
    )
  );
};

const isPolygonCoordinates = (value: unknown): value is PolygonCoordinates => {
  return Array.isArray(value) && value.every((ring) => isLinearRing(ring));
};

const signedRingArea = (ring: LinearRing): number => {
  if (ring.length < 3) return 0;

  let area = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    area += x1 * y2 - x2 * y1;
  }

  return area / 2;
};

export const parseMultiPolygonGeometry = (raw: string): MultiPolygonGeometry | null => {
  try {
    const parsed = JSON.parse(raw) as MultiPolygonGeometry;
    if (parsed?.type !== "MultiPolygon" || !Array.isArray(parsed.coordinates)) {
      return null;
    }
    if (!parsed.coordinates.every((polygon) => isPolygonCoordinates(polygon))) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
};

export const getMultiPolygonBoundingBox = (
  geometry: MultiPolygonGeometry,
): BoundingBox | null => {
  if (!Array.isArray(geometry.coordinates)) return null;

  let minLon = Number.POSITIVE_INFINITY;
  let minLat = Number.POSITIVE_INFINITY;
  let maxLon = Number.NEGATIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;
  let foundPoint = false;

  for (const polygon of geometry.coordinates) {
    if (!isPolygonCoordinates(polygon)) continue;

    for (const ring of polygon) {
      for (const [lon, lat] of ring) {
        foundPoint = true;
        if (lon < minLon) minLon = lon;
        if (lat < minLat) minLat = lat;
        if (lon > maxLon) maxLon = lon;
        if (lat > maxLat) maxLat = lat;
      }
    }
  }

  if (!foundPoint) return null;

  return { minLon, minLat, maxLon, maxLat };
};

export const pointInBoundingBox = (
  point: [number, number],
  bbox: BoundingBox,
): boolean => {
  const [lon, lat] = point;
  return (
    lon >= bbox.minLon &&
    lon <= bbox.maxLon &&
    lat >= bbox.minLat &&
    lat <= bbox.maxLat
  );
};

export const calculateMultiPolygonArea = (
  geometry: MultiPolygonGeometry,
): number | null => {
  if (!Array.isArray(geometry.coordinates)) return null;

  let area = 0;
  let seenPolygon = false;

  for (const polygon of geometry.coordinates) {
    if (!isPolygonCoordinates(polygon) || polygon.length === 0) continue;
    seenPolygon = true;

    const outer = Math.abs(signedRingArea(polygon[0]));
    const holes = polygon
      .slice(1)
      .reduce((sum, ring) => sum + Math.abs(signedRingArea(ring)), 0);
    area += Math.max(0, outer - holes);
  }

  return seenPolygon ? area : null;
};

const pointInRing = (point: [number, number], ring: Array<[number, number]>): boolean => {
  const [x, y] = point;
  let inside = false;

  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const yCrosses = yi > y !== yj > y;
    const boundaryY = (yj - yi) || Number.EPSILON;
    const boundaryX = ((xj - xi) * (y - yi)) / boundaryY + xi;

    if (yCrosses && x < boundaryX) inside = !inside;
  }

  return inside;
};

export const pointInMultiPolygon = (
  point: [number, number],
  geometry: MultiPolygonGeometry,
): boolean => {
  if (!Array.isArray(geometry.coordinates)) return false;

  for (const polygon of geometry.coordinates) {
    if (!isPolygonCoordinates(polygon) || polygon.length === 0) continue;
    if (!pointInRing(point, polygon[0])) continue;

    let insideHole = false;
    for (let i = 1; i < polygon.length; i++) {
      if (pointInRing(point, polygon[i])) {
        insideHole = true;
        break;
      }
    }

    if (!insideHole) return true;
  }

  return false;
};
