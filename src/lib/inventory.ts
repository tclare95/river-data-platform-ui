const INVENTORY_BOUNDS = [-8.8, 49.8, 2, 61] as const;
const MAX_SPAN = 2.5;

export type InventoryBounds = [west: number, south: number, east: number, north: number];

export function readInventoryBounds(bbox: string | null): InventoryBounds | undefined {
  if (!bbox || !/^-?\d{1,3}(?:\.\d{1,6})?(?:,-?\d{1,3}(?:\.\d{1,6})?){3}$/.test(bbox)) return;
  const bounds = bbox.split(",").map(Number) as InventoryBounds;
  const [west, south, east, north] = bounds;
  const [minLon, minLat, maxLon, maxLat] = INVENTORY_BOUNDS;
  if (
    west < minLon ||
    south < minLat ||
    east > maxLon ||
    north > maxLat ||
    west >= east ||
    south >= north ||
    east - west > MAX_SPAN ||
    north - south > MAX_SPAN
  )
    return;
  return bounds;
}

export function inventoryViewport([west, south, east, north]: InventoryBounds) {
  const [minLon, minLat, maxLon, maxLat] = INVENTORY_BOUNDS;
  const clipped: InventoryBounds = [
    Math.max(west, minLon),
    Math.max(south, minLat),
    Math.min(east, maxLon),
    Math.min(north, maxLat),
  ];
  if (clipped[0] >= clipped[2] || clipped[1] >= clipped[3]) return { status: "outside" } as const;
  const bbox = clipped.map((value) => value.toFixed(6)).join(",");
  return readInventoryBounds(bbox)
    ? ({ status: "area", bbox } as const)
    : ({ status: "zoom" } as const);
}

export type InventoryStation = {
  key: string;
  name: string;
  watercourse?: string;
  position: { longitude: number; latitude: number; precisionMetres: number };
  measures: {
    parameter: string | null;
    qualifier: string | null;
    measurementId: string | null;
    status: "published" | "not_published" | "unknown";
  }[];
};

export type InventoryCoverage = {
  providerId: string;
  label: string;
  status: "fresh" | "stale" | "expired" | "unavailable" | "failed" | "not_integrated" | "unknown";
  lastVerifiedAt: string | null;
  unpositioned: number | null;
  measureDetailPartial: boolean;
  attribution?: string;
};

export type InventoryArea = {
  stations: InventoryStation[];
  coverage: InventoryCoverage[];
  truncated: boolean;
};
