import type { FeatureCollection, LineString, MultiLineString } from "geojson";
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
};

export function traceGeometry(result?: TraceResult) {
  const geometry = result?.matchStatus === "Matched" ? result.geometry : null;
  return geometry?.coordinates.length ? geometry : null;
}

const sourceId = "river-trace";

// Keep the layers for the lifetime of the map. Changing a trace only updates this source.
export function drawRiverTrace(map: MapLibreMap, point?: TracePoint, result?: TraceResult) {
  const data: FeatureCollection = { type: "FeatureCollection", features: [] };
  const geometry = traceGeometry(result);
  if (point) {
    data.features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: point },
      properties: { kind: "selected" },
    });
  }
  const snapped = result?.matchStatus === "Matched" ? result.snappedSample?.position : null;
  if (snapped) {
    data.features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: snapped },
      properties: { kind: "snapped" },
    });
  }
  if (geometry) data.features.push({ type: "Feature", geometry, properties: {} });

  const source = map.getSource<import("maplibre-gl").GeoJSONSource>(sourceId);
  if (source) {
    source.setData(data);
    return;
  }
  if (!point) return;

  const style = getComputedStyle(map.getContainer());
  const blue = style.getPropertyValue("--color-compare-secondary").trim();
  const ink = style.getPropertyValue("--color-ink").trim();
  const surface = style.getPropertyValue("--color-surface").trim();
  map.addSource(sourceId, { type: "geojson", data });
  map.addLayer({
    id: sourceId,
    source: sourceId,
    type: "line",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": blue, "line-width": 4 },
  });
  map.addLayer({
    id: "river-trace-snapped",
    source: sourceId,
    type: "circle",
    filter: ["==", ["get", "kind"], "snapped"],
    paint: {
      "circle-radius": 5,
      "circle-color": blue,
      "circle-stroke-width": 1,
      "circle-stroke-color": surface,
    },
  });
  map.addLayer({
    id: "river-trace-selected",
    source: sourceId,
    type: "circle",
    filter: ["==", ["get", "kind"], "selected"],
    paint: {
      "circle-radius": 12,
      "circle-opacity": 0,
      "circle-stroke-width": 2,
      "circle-stroke-color": ink,
    },
  });
}
