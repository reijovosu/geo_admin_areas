export interface MultiPolygonGeometry {
  type: "MultiPolygon";
  coordinates: unknown;
}

const isLinearRing = (value: unknown): value is Array<[number, number]> => {
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

const isPolygonCoordinates = (value: unknown): value is Array<Array<[number, number]>> => {
  return Array.isArray(value) && value.every((ring) => isLinearRing(ring));
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
