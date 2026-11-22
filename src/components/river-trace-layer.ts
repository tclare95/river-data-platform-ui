import type {
  FeatureCollection,
  LineString,
  MultiLineString,
  MultiPolygon,
  Polygon,
} from "geojson";
import type { Map as MapLibreMap } from "maplibre-gl";
import type { RiverDirection } from "@/lib/rdp/river-tracer";

export type TracePoint = [longitude: number, latitude: number];

export type TraceResult = {
  matchStatus: "Matched" | "Ambiguous" | "NoMatch" | "OutOfCoverage";
  release: { releaseId: string; version: string };
  snappedSample: { snapOffsetM: number; position: TracePoint | null } | null;
  route: { direction: RiverDirection; completeness: "complete" | "incomplete" } | null;
  attribution: string | null;
  geometry: LineString | MultiLineString | null;
  catchment?: {
    status: "published" | "unavailable" | "not-loaded";
    areaKm2: number | null;
    pourPointOffsetM: number | null;
    sourceNetworkRelease: string | null;
    geometry: Polygon | MultiPolygon | null;
  } | null;
};

export function traceGeometry(result?: TraceResult) {
  const geometry = result?.matchStatus === "Matched" ? result.geometry : null;
  return geometry?.coordinates.length ? geometry : null;
}

export function traceCatchment(result?: TraceResult) {
  const catchment = result?.catchment;
  if (
    result?.matchStatus !== "Matched" ||
    result.route?.direction !== "upstream" ||
    catchment?.status !== "published"
  )
    return null;

  // The application endpoint validates the rings, source approval and response size.
  const { geometry, areaKm2, pourPointOffsetM, sourceNetworkRelease } = catchment;
  return geometry && areaKm2 !== null && pourPointOffsetM !== null && sourceNetworkRelease
    ? { geometry, areaKm2, pourPointOffsetM, sourceNetworkRelease }
    : null;
}

const sourceId = "river-trace";
const kind = (value: string): ["==", ["get", "kind"], string] => ["==", ["get", "kind"], value];

// Keep the layers for the lifetime of the map. Changing a trace only updates this source.
export function drawRiverTrace(
  map: MapLibreMap,
  {
    point,
    snapped,
    upstream,
    downstream,
    catchment,
  }: {
    point?: TracePoint;
    snapped?: TracePoint | null;
    upstream?: TraceResult["geometry"];
    downstream?: TraceResult["geometry"];
    catchment?: ReturnType<typeof traceCatchment>;
  },
) {
  const data: FeatureCollection = { type: "FeatureCollection", features: [] };
  if (point) {
    data.features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: point },
      properties: { kind: "selected" },
    });
  }
  if (snapped) {
    data.features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: snapped },
      properties: { kind: "snapped" },
    });
    if (catchment?.pourPointOffsetM === 0) {
      data.features.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: snapped },
        properties: { kind: "pour-point" },
      });
    }
  }
  if (upstream)
    data.features.push({ type: "Feature", geometry: upstream, properties: { kind: "upstream" } });
  if (downstream)
    data.features.push({
      type: "Feature",
      geometry: downstream,
      properties: { kind: "downstream" },
    });
  if (catchment)
    data.features.push({
      type: "Feature",
      geometry: catchment.geometry,
      properties: { kind: "catchment" },
    });

  const source = map.getSource<import("maplibre-gl").GeoJSONSource>(sourceId);
  if (source) {
    source.setData(data);
    return;
  }
  if (!point) return;

  const style = getComputedStyle(map.getContainer());
  const blue = style.getPropertyValue("--color-compare-secondary").trim();
  const amber = style.getPropertyValue("--color-compare-tertiary").trim();
  const green = style.getPropertyValue("--color-accent").trim();
  const ink = style.getPropertyValue("--color-ink").trim();
  const surface = style.getPropertyValue("--color-surface").trim();
  map.addSource(sourceId, { type: "geojson", data });
  map.addLayer({
    id: "river-trace-catchment-fill",
    source: sourceId,
    type: "fill",
    filter: kind("catchment"),
    paint: { "fill-color": green, "fill-opacity": 0.15, "fill-antialias": false },
  });
  map.addLayer({
    id: "river-trace-catchment-boundary",
    source: sourceId,
    type: "line",
    filter: kind("catchment"),
    paint: { "line-color": green, "line-width": 1.5, "line-dasharray": [3, 2] },
  });
  map.addLayer({
    id: sourceId,
    source: sourceId,
    type: "line",
    filter: ["in", ["get", "kind"], ["literal", ["upstream", "downstream"]]],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": ["case", kind("upstream"), amber, blue], "line-width": 4 },
  });
  map.addLayer({
    id: "river-trace-snapped",
    source: sourceId,
    type: "circle",
    filter: kind("snapped"),
    paint: {
      "circle-radius": 5,
      "circle-color": blue,
      "circle-stroke-width": 1,
      "circle-stroke-color": surface,
    },
  });
  map.addLayer({
    id: "river-trace-pour-point",
    source: sourceId,
    type: "circle",
    filter: kind("pour-point"),
    paint: {
      "circle-radius": 8,
      "circle-opacity": 0,
      "circle-stroke-width": 2,
      "circle-stroke-color": green,
    },
  });
  map.addLayer({
    id: "river-trace-selected",
    source: sourceId,
    type: "circle",
    filter: kind("selected"),
    paint: {
      "circle-radius": 12,
      "circle-opacity": 0,
      "circle-stroke-width": 2,
      "circle-stroke-color": ink,
    },
  });
}
