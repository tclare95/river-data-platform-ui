"use client";

import "maplibre-gl/dist/maplibre-gl.css";
import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { Map as MapLibreMap, MapMouseEvent } from "maplibre-gl";
import { Button } from "@/components/button";
import {
  drawRiverTrace,
  traceCatchment,
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

type Trace = {
  point: TracePoint;
  upstream?: TraceResult;
  downstream?: TraceResult;
  hiddenRoutes?: Partial<Record<RiverDirection, boolean>>;
  showCatchment?: boolean;
  error?: string;
};

const formatArea = new Intl.NumberFormat("en-GB", { maximumSignificantDigits: 6 });

type LocatedStation = StationGroup &
  Pick<PublicMeasurement, "locationEvidence" | "source"> & {
    position: NonNullable<PublicMeasurement["position"]>;
  };

export function StationMap({
  stations,
  comparisonAction,
}: {
  stations: readonly LocatedStation[];
  comparisonAction: (measurement: PublicMeasurement) => ReactNode;
}) {
  const container = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const detailsId = useId();
  const [initialStations] = useState(stations);
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

  const traceFrom = useCallback(
    async (point: TracePoint, direction: RiverDirection, previous?: Trace) => {
      request.current?.abort();
      setTrace(previous ? { ...previous, error: undefined } : { point });
      if (previous?.[direction]) return;

      const controller = new AbortController();
      request.current = controller;
      const query = new URLSearchParams({
        lon: point[0].toFixed(8),
        lat: point[1].toFixed(8),
        direction,
      });
      try {
        const response = await fetch(`/api/river/trace?${query}`, { signal: controller.signal });
        const result = response.ok ? ((await response.json()) as { data: TraceResult }).data : null;
        if (controller.signal.aborted) return;
        setTrace((current) => {
          if (!current) return current;
          if (!result) {
            return { ...current, error: traceErrors[response.status] ?? "River trace unavailable" };
          }
          const other = current.upstream ?? current.downstream;
          // Keep the two directions together only when they describe the same match.
          if (
            other &&
            (other.release.version !== result.release.version ||
              other.release.releaseId !== result.release.releaseId ||
              other.matchStatus !== result.matchStatus)
          )
            return { point, [direction]: result };
          return { ...current, [direction]: result };
        });
      } catch {
        if (!controller.signal.aborted)
          setTrace((current) => current && { ...current, error: "River trace unavailable" });
      }
    },
    [],
  );

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
        const bounds = new library.LngLatBounds();
        for (const { position } of initialStations) {
          bounds.extend([position.longitude, position.latitude]);
        }
        map = new library.Map({
          container: element,
          style: "https://tiles.openfreemap.org/styles/positron",
          bounds,
          fitBoundsOptions: { padding: 36, maxZoom: 12, duration: 0 },
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
  }, [initialStations]);

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
  const result = trace?.[direction];
  const provenance = result ?? trace?.upstream ?? trace?.downstream;
  const snapped = trace?.upstream?.snappedSample ?? trace?.downstream?.snappedSample;
  const upstream = traceGeometry(trace?.upstream);
  const downstream = traceGeometry(trace?.downstream);
  const catchment = traceCatchment(trace?.upstream);
  useEffect(() => {
    if (!map || !styleReady || unavailable) return;
    drawRiverTrace(map, {
      point: trace?.point,
      snapped: snapped?.position,
      upstream: trace?.hiddenRoutes?.upstream ? null : traceGeometry(trace?.upstream),
      downstream: trace?.hiddenRoutes?.downstream ? null : traceGeometry(trace?.downstream),
      catchment: trace?.showCatchment ? traceCatchment(trace.upstream) : null,
    });
  }, [map, styleReady, unavailable, trace, snapped]);

  useEffect(() => {
    if (!renderer || unavailable) return;
    const { map, library } = renderer;
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
      return new library.Marker({ element: button }).setLngLat(point).addTo(map);
    });
    return () => markers.forEach((marker) => marker.remove());
  }, [detailsId, renderer, stations, unavailable]);

  const selectedStationId = selected?.stationId;
  useEffect(() => {
    if (selectedStationId) heading.current?.focus();
  }, [selectedStationId]);

  return (
    <div className="overflow-hidden rounded-lg border border-line bg-surface">
      {/* MapLibre adds its own classes to the container, so keep className stable. */}
      <div
        ref={container}
        role="region"
        aria-label="Station locations"
        hidden={unavailable}
        data-tracing={tracing}
        className="h-72 bg-canvas sm:h-96 lg:h-[clamp(26rem,60svh,42rem)] data-[tracing=true]:[&_.maplibregl-canvas]:cursor-crosshair"
      />
      {unavailable ? (
        <ErrorState title="Station map unavailable">Browse the station list.</ErrorState>
      ) : status === "tiles" || status === "loading" ? (
        <p role="status" className="px-4 py-2 text-sm text-ink-muted">
          {status === "loading" ? "Loading map…" : "Some basemap details could not load."}
        </p>
      ) : null}
      {!unavailable && stations.length === 0 ? (
        <p className="border-t border-line px-4 py-2 text-sm text-ink-muted">
          No matching stations have verified locations
        </p>
      ) : null}
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
                      if (trace) void traceFrom(trace.point, next, trace);
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
      {tracing && !unavailable ? (
        <div
          className={trace ? "space-y-2 border-t border-line px-5 py-3 text-sm sm:px-6" : undefined}
        >
          {trace ? (
            <>
              <p className="flex flex-wrap gap-x-4 gap-y-1 text-ink-muted">
                <span className="inline-flex items-center gap-1.5">
                  <span aria-hidden="true" className="size-3 rounded-full border-2 border-ink" />
                  Selected point
                </span>
                {snapped?.position ? (
                  <span className="inline-flex items-center gap-1.5">
                    <span aria-hidden="true" className="size-2 rounded-full bg-compare-secondary" />
                    Snapped sample · {Math.round(snapped.snapOffsetM)} m away
                  </span>
                ) : null}
                {trace.showCatchment && catchment?.pourPointOffsetM === 0 && snapped?.position ? (
                  <span className="inline-flex items-center gap-1.5">
                    <span
                      aria-hidden="true"
                      className="size-3 rounded-full border-2 border-accent"
                    />
                    Catchment pour point · at the snapped sample
                  </span>
                ) : null}
              </p>
              <div role="status" className="space-y-1">
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
                    {direction === "upstream" && result.matchStatus === "Matched" && !catchment ? (
                      <p>Catchment boundary unavailable for this trace.</p>
                    ) : null}
                  </>
                ) : (
                  <p>{trace.error ?? "Tracing river…"}</p>
                )}
              </div>
              {provenance ? (
                <p className="break-words text-ink-muted">
                  Release {provenance.release.releaseId} · {provenance.release.version.slice(0, 12)}
                  {provenance.attribution ? ` · ${provenance.attribution}` : null}
                </p>
              ) : null}
              {upstream || downstream || catchment ? (
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                  {(["upstream", "downstream"] as const).map((layer) => {
                    if (!(layer === "upstream" ? upstream : downstream)) return null;
                    return (
                      <label key={layer} className="inline-flex min-h-11 items-center gap-2">
                        <input
                          type="checkbox"
                          className="size-4 accent-accent"
                          checked={!trace.hiddenRoutes?.[layer]}
                          onChange={(event) => {
                            const hidden = !event.target.checked;
                            setTrace(
                              (current) =>
                                current && {
                                  ...current,
                                  hiddenRoutes: { ...current.hiddenRoutes, [layer]: hidden },
                                },
                            );
                          }}
                        />
                        <span
                          aria-hidden="true"
                          className={
                            layer === "upstream"
                              ? "h-0.5 w-3 bg-compare-tertiary"
                              : "h-0.5 w-3 bg-compare-secondary"
                          }
                        />
                        {layer === "upstream" ? "Upstream reaches" : "Downstream route"}
                      </label>
                    );
                  })}
                  {catchment ? (
                    <Button
                      className="min-h-11"
                      onClick={() =>
                        setTrace(
                          (current) =>
                            current && {
                              ...current,
                              showCatchment: !current.showCatchment,
                            },
                        )
                      }
                    >
                      {trace.showCatchment ? "Hide catchment" : "Show catchment"}
                    </Button>
                  ) : null}
                </div>
              ) : null}
              {trace.showCatchment && catchment ? (
                <div className="space-y-1 text-ink-muted">
                  <p>
                    <strong className="text-ink">
                      Catchment area {formatArea.format(catchment.areaKm2)} km²
                    </strong>
                  </p>
                  <p>Source · {catchment.sourceNetworkRelease}</p>
                  {catchment.pourPointOffsetM > 0 ? (
                    <p>
                      The catchment pour point is a published sample{" "}
                      {formatArea.format(catchment.pourPointOffsetM)} m downstream of the snapped
                      river sample for the selected point.
                    </p>
                  ) : null}
                  <p>
                    This boundary shows modelled drainage. Confirming upstream station connections
                    requires separate river-network evidence.
                  </p>
                </div>
              ) : null}
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
            <ul className="space-y-1">
              {selected.items.map(({ measurement }) => (
                <li key={measurement.measurementId} className="flex flex-wrap items-center gap-x-3">
                  <Link className="link" href={measurementPath(measurement.measurementId)}>
                    {parameterLabel(measurement.parameter)}
                  </Link>
                  {!tracing ? comparisonAction(measurement) : null}
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
    </div>
  );
}
