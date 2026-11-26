import { COMPARE_SLOTS } from "@/lib/compare";
import { MAX_COMPARISON_OFFSET } from "@/lib/compare-time";
import { readQuery, type DiscoveryQuery } from "@/lib/discovery";
import { RAINFALL_MODES, type RainfallMode } from "@/lib/history/rainfall-totals";
import { DEFAULT_RANGE, parseRange, type HistoryRange } from "@/lib/history/range";
import {
  mapSelectionParams,
  mapViewParams,
  readMapContext,
  singleParam,
  type MapContext,
  type SearchParams,
} from "@/lib/map-context";
import { isMeasurementId } from "@/lib/rdp/contract";

export const DEFAULT_RAINFALL_MODE: RainfallMode = "24h";

export type ComparisonPresentation = {
  mode: RainfallMode;
  offsets: Record<string, number>;
};

export type ExplorerState = {
  query: DiscoveryQuery;
  map: MapContext;
  ids: string[];
  range: HistoryRange;
  presentation: ComparisonPresentation;
  invalidSelection: boolean;
};

export function readExplorerState(params: SearchParams): ExplorerState {
  const get = (name: string) => singleParam(params, name);
  const ids: string[] = [];
  const offsets: Record<string, number> = {};
  let invalidSelection = false;
  for (const slot of COMPARE_SLOTS) {
    const id = get(slot);
    if (id === undefined) continue;
    if (!isMeasurementId(id) || ids.includes(id)) {
      invalidSelection = true;
      continue;
    }
    ids.push(id);
    const offset = get(`o${slot}`);
    if (typeof offset === "string" && /^-?\d{1,4}$/.test(offset)) {
      const minutes = Number(offset);
      if (minutes && Math.abs(minutes) <= MAX_COMPARISON_OFFSET) offsets[id] = minutes;
    }
  }

  const mode = get("rain");
  const type = get("type");
  return {
    query: readQuery({
      q: get("q"),
      type: typeof type === "string" && /^[\w-]{1,80}$/.test(type) ? type : undefined,
    }),
    map: readMapContext(params),
    ids,
    range: parseRange(get("range")),
    presentation: {
      mode:
        typeof mode === "string" && Object.hasOwn(RAINFALL_MODES, mode)
          ? (mode as RainfallMode)
          : DEFAULT_RAINFALL_MODE,
      offsets,
    },
    invalidSelection,
  };
}

export function explorerComparisonParams({
  ids,
  range,
  presentation,
}: Pick<ExplorerState, "ids" | "range" | "presentation">) {
  const params: Record<string, string | undefined> = {
    range: range === DEFAULT_RANGE ? undefined : range,
    rain: presentation.mode === DEFAULT_RAINFALL_MODE ? undefined : presentation.mode,
  };
  COMPARE_SLOTS.forEach((slot, index) => {
    const id = ids[index];
    const offset = id && Object.hasOwn(presentation.offsets, id) ? presentation.offsets[id] : 0;
    params[slot] = id;
    params[`o${slot}`] = offset ? String(offset) : undefined;
  });
  return params;
}

export function explorerMapParams(map: MapContext) {
  return { ...mapViewParams(map.view), ...mapSelectionParams(map) };
}

export function explorerSharePath(state: ExplorerState) {
  const params = new URLSearchParams();
  const values = {
    type: state.query.type ?? undefined,
    ...explorerMapParams(state.map),
    ...explorerComparisonParams(state),
  };
  for (const [name, value] of Object.entries(values)) {
    if (value !== undefined) params.set(name, value);
  }
  const query = params.toString();
  return query ? `/?${query}` : "/";
}

export function writeExplorerParams(values: Record<string, string | undefined>, push = false) {
  const url = new URL(window.location.href);
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) url.searchParams.delete(name);
    else url.searchParams.set(name, value);
  }
  // Next integrates native history without requesting a server render.
  if (url.href !== window.location.href) {
    window.history[push ? "pushState" : "replaceState"](null, "", url);
  }
}
