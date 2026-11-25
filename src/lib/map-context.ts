export const GB_BOUNDS: [[number, number], [number, number]] = [
  [-8.7, 49.8],
  [2.1, 60.9],
];
export const MAX_MAP_ZOOM = 16;
export const LOCATION_ZOOM = 12;

type MapContext = {
  station?: string;
  view?: { center: [number, number]; zoom: number };
  trace?: {
    point: [number, number];
    direction: "upstream" | "downstream";
    showCatchment?: boolean;
  };
};

export function readMapContext(
  params: Record<string, string | string[] | undefined> | URLSearchParams,
): MapContext {
  const get = (name: string) => {
    if (!(params instanceof URLSearchParams)) return params[name];
    const values = params.getAll(name);
    return values.length > 1 ? values : values[0];
  };
  const decimal = (value: unknown, min: number, max: number) => {
    if (typeof value !== "string" || !/^-?\d+(?:\.\d+)?$/.test(value)) return;
    const number = Number(value);
    if (number >= min && number <= max) return number;
  };
  const lon = decimal(get("lon"), -180, 180);
  const lat = decimal(get("lat"), -85, 85);
  const zoom = decimal(get("zoom"), 0, MAX_MAP_ZOOM);
  const station = get("station");
  const traceLon = decimal(get("traceLon"), -180, 180);
  const traceLat = decimal(get("traceLat"), -90, 90);
  const direction = get("direction");
  const catchment = get("catchment");

  return {
    station: typeof station === "string" ? station : undefined,
    view:
      lon !== undefined && lat !== undefined && (get("zoom") === undefined || zoom !== undefined)
        ? { center: [lon, lat], zoom: zoom ?? LOCATION_ZOOM }
        : undefined,
    trace:
      traceLon !== undefined &&
      traceLat !== undefined &&
      (direction === "upstream" || direction === "downstream")
        ? {
            point: [traceLon, traceLat],
            direction,
            showCatchment: catchment === "show" ? true : catchment === "hide" ? false : undefined,
          }
        : undefined,
  };
}

/** Merge only parameters owned by this part of the explorer and keep the fragment. */
export function replaceExplorerParams(values: Record<string, string | undefined>) {
  const url = new URL(window.location.href);
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) url.searchParams.delete(name);
    else url.searchParams.set(name, value);
  }
  // Next's native history integration keeps the current URL in its router state.
  if (url.href !== window.location.href) window.history.replaceState(null, "", url);
}
