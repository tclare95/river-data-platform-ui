"use client";

import "maplibre-gl/dist/maplibre-gl.css";
import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { Map as MapLibreMap, MapMouseEvent } from "maplibre-gl";
import { Button } from "@/components/button";
import {
  drawRiverTrace,
  traceGeometry,
  type TracePoint,
  type TraceResult,
} from "./river-trace-layer";
import { ErrorState } from "@/components/states";
import type { StationGroup } from "@/lib/discovery";
import { measurementPath, parameterLabel } from "@/lib/labels";
import type { PublicMeasurement } from "@/lib/rdp/public";
import type { RiverDirection } from "@/lib/rdp/river-tracer";

const matchLabels = {
  Matched: "River matched",
  Ambiguous: "Several rivers could match. Try a point closer to the river.",
  NoMatch: "No river matched this point.",
  OutOfCoverage: "Point is outside the river network coverage.",
};

const traceErrors: Record<number, string> = {
  404: "River trace result unavailable",
  410: "River network updated. Select the point again.",
  413: "River trace is too large to display",
  504: "River trace timed out",
};

type Trace = { point: TracePoint; result?: TraceResult; error?: string };

type LocatedStation = StationGroup &
  Pick<PublicMeasurement, "locationEvidence" | "source"> & {
    position: NonNullable<PublicMeasurement["position"]>;
  };

export function StationMap({ stations }: { stations: readonly LocatedStation[] }) {
  const container = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const detailsId = useId();
  const [styleReady, setStyleReady] = useState(false);
  const [renderer, setRenderer] = useState<{
    map: MapLibreMap;
    library: typeof import("maplibre-gl");
  }>();
  const [status, setStatus] = useState<"loading" | "ready" | "tiles" | "unavailable">("loading");
  const [selectedId, select] = useState<string>();
  const selected = stations.find((station) => station.stationId === selectedId);
  const [tracing, setTracing] = useState(false);
  const [direction, setDirection] = useState<RiverDirection>("downstream");
  const [trace, setTrace] = useState<Trace>();
  const request = useRef<AbortController>(null);

  const clearTrace = () => {
    request.current?.abort();
    setTrace(undefined);
  };

  const traceFrom = useCallback(async (point: TracePoint, direction: RiverDirection) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setTrace({ point });
    const query = new URLSearchParams({
      lon: point[0].toFixed(8),
      lat: point[1].toFixed(8),
      direction,
    });
    try {
      const response = await fetch(`/api/river/trace?${query}`, { signal: controller.signal });
      const result = response.ok ? ((await response.json()) as { data: TraceResult }).data : null;
      const next = result
        ? { result }
        : { error: traceErrors[response.status] ?? "River trace unavailable" };
      if (!controller.signal.aborted) setTrace({ point, ...next });
    } catch {
      if (!controller.signal.aborted) setTrace({ point, error: "River trace unavailable" });
    }
  }, []);

  // Keep the selection only while the station still matches the filters.
  if (selectedId && !selected) select(undefined);

  useEffect(() => {
    let active = true;
    let map: MapLibreMap | undefined;
    const element = container.current!;

    import("maplibre-gl")
      .then((library) => {
        if (!active) return;
        library.setWorkerUrl(
          new URL("maplibre-gl/dist/maplibre-gl-worker.mjs", import.meta.url).toString(),
        );
        map = new library.Map({
          container: element,
          style: "https://tiles.openfreemap.org/styles/positron",
          attributionControl: { compact: false },
          cooperativeGestures: true,
          dragRotate: false,
          pitchWithRotate: false,
          renderWorldCopies: false,
          scrollZoom: false,
          maxZoom: 16,
        });
        map.touchZoomRotate.disableRotation();
        map.addControl(new library.NavigationControl({ showCompass: false }));
        map.once("load", () => {
          if (active) {
            setStyleReady(true);
            setStatus((current) => (current === "loading" ? "ready" : current));
          }
        });
        map.on("error", () => {
          if (active) setStatus((current) => (current === "unavailable" ? current : "tiles"));
        });
        map.on("webglcontextlost", () => {
          if (active) setStatus("unavailable");
        });
        setRenderer({ map, library });
      })
      .catch(() => {
        if (active) setStatus("unavailable");
      });

    return () => {
      active = false;
      request.current?.abort();
      map?.remove();
    };
  }, []);

  const unavailable = status === "unavailable";
  const map = renderer?.map;
  useEffect(() => {
    if (!map || !tracing || unavailable) return;
    const onClick = ({ originalEvent, lngLat }: MapMouseEvent) => {
      if ((originalEvent.target as Element | null)?.closest(".maplibregl-marker")) return;
      const { lng, lat } = lngLat.wrap();
      void traceFrom([lng, lat], direction);
    };
    map.on("click", onClick);
    return () => {
      map.off("click", onClick);
    };
  }, [map, tracing, direction, unavailable, traceFrom]);

  const point = trace?.point;
  const result = trace?.result;
  useEffect(() => {
    if (map && styleReady && !unavailable) drawRiverTrace(map, point, result);
  }, [map, styleReady, unavailable, point, result]);

  useEffect(() => {
    if (!renderer || unavailable) return;
    const { map, library } = renderer;
    const bounds = new library.LngLatBounds();
    const markers = stations.map(({ stationId, name, position }) => {
      const point: [number, number] = [position.longitude, position.latitude];
      const button = document.createElement("button");
      button.type = "button";
      button.className =
        "grid size-11 cursor-pointer place-items-center rounded-full focus-visible:bg-accent-soft after:size-4 after:rounded-full after:border-2 after:border-surface after:bg-accent-strong after:shadow-md";
      button.setAttribute("aria-label", name);
      button.setAttribute("aria-controls", detailsId);
      button.title = name;
      button.onclick = () => {
        if (heading.current?.dataset.stationId === stationId) heading.current.focus();
        select(stationId);
      };
      bounds.extend(point);
      return new library.Marker({ element: button }).setLngLat(point).addTo(map);
    });
    map.fitBounds(bounds, { padding: 36, maxZoom: 12, duration: 0 });
    return () => markers.forEach((marker) => marker.remove());
  }, [detailsId, renderer, stations, unavailable]);

  const selectedStationId = selected?.stationId;
  useEffect(() => {
    if (selectedStationId) heading.current?.focus();
  }, [selectedStationId]);

  return (
    <>
      {map && !unavailable ? (
        <div className="space-y-2 border-t border-line px-5 py-3 sm:px-6">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              aria-pressed={tracing}
              className="aria-pressed:border-accent aria-pressed:bg-accent-soft"
              onClick={() => {
                if (tracing) clearTrace();
                setTracing(!tracing);
              }}
            >
              Trace river
            </Button>
            {tracing ? (
              <>
                <label className="flex items-center gap-2 text-sm">
                  Direction
                  <select
                    className="min-h-10 rounded-md border border-line-input bg-surface px-2"
                    value={direction}
                    onChange={(event) => {
                      const next = event.target.value as RiverDirection;
                      setDirection(next);
                      if (point) void traceFrom(point, next);
                    }}
                  >
                    <option value="downstream">Downstream</option>
                    <option value="upstream">Upstream</option>
                  </select>
                </label>
                <Button
                  onClick={() => {
                    const { lng, lat } = map.getCenter().wrap();
                    void traceFrom([lng, lat], direction);
                  }}
                >
                  Trace map centre
                </Button>
                <Button aria-disabled={!point} onClick={clearTrace}>
                  Clear trace
                </Button>
              </>
            ) : null}
          </div>
          {tracing ? (
            <p className="text-sm text-ink-muted">
              Click the map or select a station to trace from.
            </p>
          ) : null}
        </div>
      ) : null}
      <div
        ref={container}
        role="region"
        aria-label="Station locations"
        hidden={unavailable}
        className={`h-64 border-t border-line bg-canvas sm:h-80 ${tracing ? "[&_.maplibregl-canvas]:cursor-crosshair" : ""}`}
      />
      {unavailable ? (
        <ErrorState title="Station map unavailable">Browse the measurements below.</ErrorState>
      ) : status === "tiles" || status === "loading" ? (
        <p role="status" className="px-5 py-2 text-sm text-ink-muted sm:px-6">
          {status === "loading" ? "Loading map…" : "Some basemap details could not load."}
        </p>
      ) : null}
      {tracing && !unavailable ? (
        <div
          role="status"
          className={trace ? "space-y-1 border-t border-line px-5 py-3 text-sm sm:px-6" : undefined}
        >
          {trace ? (
            <>
              <p className="flex flex-wrap gap-x-4 gap-y-1 text-ink-muted">
                <span className="inline-flex items-center gap-1.5">
                  <span aria-hidden="true" className="size-3 rounded-full border-2 border-ink" />
                  Selected point
                </span>
                {result?.snappedSample?.position ? (
                  <span className="inline-flex items-center gap-1.5">
                    <span aria-hidden="true" className="size-2 rounded-full bg-compare-secondary" />
                    Snapped sample · {Math.round(result.snappedSample.snapOffsetM)} m away
                  </span>
                ) : null}
              </p>
              {result ? (
                <>
                  <p>
                    {matchLabels[result.matchStatus]}
                    {result.route
                      ? ` · ${result.route.direction} route ${result.route.completeness}`
                      : null}
                    {result.matchStatus === "Matched" && !traceGeometry(result)
                      ? " · No route geometry to display"
                      : null}
                  </p>
                  <p className="break-words text-ink-muted">
                    Release {result.release.releaseId} · {result.release.version.slice(0, 12)}
                    {result.attribution ? ` · ${result.attribution}` : null}
                  </p>
                </>
              ) : (
                <p>{trace.error ?? "Tracing river…"}</p>
              )}
            </>
          ) : null}
        </div>
      ) : null}
      <div id={detailsId}>
        {selected && !unavailable ? (
          <div className="space-y-2 border-t border-line px-5 py-4 sm:px-6">
            <h2
              ref={heading}
              tabIndex={-1}
              data-station-id={selected.stationId}
              className="text-lg font-semibold"
            >
              {selected.name}
            </h2>
            {selected.watercourseName ? (
              <p className="text-sm text-ink-muted">{selected.watercourseName}</p>
            ) : null}
            <ul className="flex flex-wrap gap-x-5">
              {selected.items.map(({ measurement }) => (
                <li key={measurement.measurementId}>
                  <Link className="link" href={measurementPath(measurement.measurementId)}>
                    {parameterLabel(measurement.parameter)}
                  </Link>
                </li>
              ))}
            </ul>
            <p className="text-sm text-ink-muted">
              Station reference position · {selected.position.precisionMetres} m resolution
              {selected.locationEvidence ? (
                <>
                  {" · "}
                  <a className="link" href={selected.locationEvidence}>
                    {selected.source.label} station record
                  </a>
                </>
              ) : null}
            </p>
            {tracing ? (
              <Button
                onClick={() =>
                  void traceFrom(
                    [selected.position.longitude, selected.position.latitude],
                    direction,
                  )
                }
              >
                Trace from {selected.name}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </>
  );
}
