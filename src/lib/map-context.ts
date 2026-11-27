export const GB_BOUNDS: [[number, number], [number, number]] = [
  [-8.7, 49.8],
  [2.1, 60.9],
];
export const MAX_MAP_ZOOM = 16;
export const LOCATION_ZOOM = 12;

export type SearchParams = Record<string, string | string[] | undefined> | URLSearchParams;

export function singleParam(params: SearchParams, name: string) {
  if (!(params instanceof URLSearchParams)) return params[name];
  const values = params.getAll(name);
  return values.length > 1 ? values : values[0];
}

export type MapContext = {
  station?: string;
  inventory?: string;
  showStations?: boolean;
  view?: { center: [number, number]; zoom: number };
  trace?: {
    point: [number, number];
    direction: "upstream" | "downstream";
    showCatchment?: boolean;
    bothDirections?: boolean;
    hiddenRoutes?: Partial<Record<"upstream" | "downstream", boolean>>;
  };
};

export function readMapContext(params: SearchParams): MapContext {
  const get = (name: string) => singleParam(params, name);
  const decimal = (value: unknown, min: number, max: number) => {
    if (typeof value !== "string" || !/^-?\d{1,3}(?:\.\d{1,12})?$/.test(value)) return;
    const number = Number(value);
    if (number >= min && number <= max) return number;
  };
  const toggle = (value: unknown) =>
    value === "show" ? true : value === "hide" ? false : undefined;
  const lon = decimal(get("lon"), -180, 180);
  const lat = decimal(get("lat"), -85, 85);
  const zoom = decimal(get("zoom"), 0, MAX_MAP_ZOOM);
  const station = get("station");
  const inventory = get("inventory");
  const traceLon = decimal(get("traceLon"), -180, 180);
  const traceLat = decimal(get("traceLat"), -90, 90);
  const direction = get("direction");
  const hidden = get("hide");

  return {
    station: typeof station === "string" && /^[\w.:-]{1,128}$/.test(station) ? station : undefined,
    inventory:
      typeof inventory === "string" &&
      /^[\w-]+:[\w.:-]+$/.test(inventory) &&
      inventory.length <= 160
        ? inventory
        : undefined,
    showStations: toggle(get("stations")),
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
            showCatchment: toggle(get("catchment")),
            bothDirections: get("routes") === "both" || undefined,
            hiddenRoutes:
              hidden === "upstream" || hidden === "downstream" || hidden === "both"
                ? { upstream: hidden !== "downstream", downstream: hidden !== "upstream" }
                : undefined,
          }
        : undefined,
  };
}

export function mapViewParams(view?: MapContext["view"]) {
  return {
    lon: view?.center[0].toFixed(6),
    lat: view?.center[1].toFixed(6),
    zoom: view?.zoom.toFixed(3),
  };
}

export function mapSelectionParams({ station, inventory, showStations, trace }: MapContext) {
  const hidden = trace?.hiddenRoutes;
  return {
    station,
    inventory,
    stations: showStations === undefined ? undefined : showStations ? "show" : "hide",
    tracing: undefined, // Drop the legacy mode parameter when writing Explorer state.
    traceLon: trace?.point[0].toFixed(8),
    traceLat: trace?.point[1].toFixed(8),
    direction: trace?.direction,
    catchment:
      trace?.showCatchment === undefined ? undefined : trace.showCatchment ? "show" : "hide",
    routes: trace?.bothDirections ? "both" : undefined,
    hide: hidden?.upstream
      ? hidden.downstream
        ? "both"
        : "upstream"
      : hidden?.downstream
        ? "downstream"
        : undefined,
  };
}
