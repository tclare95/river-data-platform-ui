export const GB_BOUNDS: [[number, number], [number, number]] = [
  [-8.7, 49.8],
  [2.1, 60.9],
];
export const MAX_MAP_ZOOM = 16;
export const LOCATION_ZOOM = 12;

export function readMapContext(params: Record<string, string | string[] | undefined>) {
  const decimal = (value: string | string[] | undefined, min: number, max: number) => {
    if (typeof value !== "string" || !/^-?\d+(?:\.\d+)?$/.test(value)) return;
    const number = Number(value);
    if (number >= min && number <= max) return number;
  };
  const lon = decimal(params.lon, -180, 180);
  const lat = decimal(params.lat, -85, 85);
  const zoom = decimal(params.zoom, 0, MAX_MAP_ZOOM);
  const station = typeof params.station === "string" ? params.station : undefined;

  return {
    station,
    view:
      lon !== undefined && lat !== undefined && (params.zoom === undefined || zoom !== undefined)
        ? { center: [lon, lat] as [number, number], zoom: zoom ?? LOCATION_ZOOM }
        : undefined,
  };
}
