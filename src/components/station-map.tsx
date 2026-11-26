"use client";

import "maplibre-gl/dist/maplibre-gl.css";
import Link from "next/link";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import type { Map as MapLibreMap, MapMouseEvent } from "maplibre-gl";
import { Button } from "@/components/button";
import { CatchmentMeasurements, type CatchmentDiscovery } from "./catchment-measurements";
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
import {
  GB_BOUNDS,
  LOCATION_ZOOM,
  MAX_MAP_ZOOM,
  replaceExplorerParams,
  type readMapContext,
} from "@/lib/map-context";
import type { PublicMeasurement } from "@/lib/rdp/public";
import type { RiverDirection } from "@/lib/rdp/river-tracer";
import type { PublicUpstreamMeasurements } from "@/lib/rdp/upstream-measurements";

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
  discovery?: CatchmentDiscovery;
  error?: string;
};

const formatArea = new Intl.NumberFormat("en-GB", { maximumSignificantDigits: 6 });

function pointQuery([lon, lat]: TracePoint) {
  return new URLSearchParams({ lon: lon.toFixed(8), lat: lat.toFixed(8) });
}

type LocatedStation = StationGroup &
  Pick<PublicMeasurement, "locationEvidence" | "source"> & {
    position: NonNullable<PublicMeasurement["position"]>;
  };

type MapStation = Omit<LocatedStation, "items"> & {
  measurements: readonly PublicMeasurement[];
  match: boolean;
};

export function StationMap({
  stations,
  filteredStationIds,
  initialView,
  initialStationId,
  initialTrace,
  comparisonAction,
}: {
  stations: readonly LocatedStation[];
  filteredStationIds: ReadonlySet<string>;
  initialView?: ReturnType<typeof readMapContext>["view"];
  initialStationId?: string;
  initialTrace?: ReturnType<typeof readMapContext>["trace"];
  comparisonAction: (measurement: PublicMeasurement) => ReactNode;
}) {
  const container = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const focusSelection = useRef(false);
  const detailsId = useId();
  const [initialStation] = useState(() =>
    stations.find(({ stationId }) => stationId === initialStationId),
  );
  const [initialCamera] = useState(() => {
    if (initialView) return initialView;
    if (initialStation) {
      const { longitude, latitude } = initialStation.position;
      return { center: [longitude, latitude] as TracePoint, zoom: LOCATION_ZOOM };
    }
    return { bounds: GB_BOUNDS, fitBoundsOptions: { padding: 20, duration: 0 } };
  });
  const [styleReady, setStyleReady] = useState(false);
  const [renderer, setRenderer] = useState<{
    map: MapLibreMap;
    library: typeof import("maplibre-gl");
  }>();
  const [status, setStatus] = useState<"loading" | "ready" | "tiles" | "unavailable">("loading");
  const [selectedId, select] = useState(initialStation?.stationId);
  const [showStations, setShowStations] = useState(!!initialStation);
  const [tracing, setTracing] = useState(true);
  const [direction, setDirection] = useState<RiverDirection>(initialTrace?.direction ?? "upstream");
  const [trace, setTrace] = useState<Trace | undefined>(() =>
    initialTrace
      ? { point: initialTrace.point, showCatchment: initialTrace.showCatchment }
      : undefined,
  );
  const request = useRef<AbortController>(null);
  const discoveryRequest = useRef<AbortController>(null);

  const clearTrace = () => {
    request.current?.abort();
    discoveryRequest.current?.abort();
    setTrace(undefined);
  };

  const findMeasurements = useCallback(async (point: TracePoint, upstreamResult: TraceResult) => {
    discoveryRequest.current?.abort();
    const controller = new AbortController();
    discoveryRequest.current = controller;
    setTrace((current) =>
      current?.upstream === upstreamResult
        ? { ...current, discovery: { status: "loading" } }
        : current,
    );
    const query = pointQuery(point);
    query.set("release", upstreamResult.release.version.slice(0, 16));
    const update = (discovery: CatchmentDiscovery) => {
      if (controller.signal.aborted) return;
      setTrace((current) =>
        current?.upstream === upstreamResult ? { ...current, discovery } : current,
      );
    };
    try {
      const response = await fetch(`/api/river/upstream-measurements?${query}`, {
        signal: controller.signal,
      });
      if (response.status === 410) return update({ status: "release-changed" });
      if (!response.ok) return update({ status: "unavailable" });
      const { data } = (await response.json()) as { data: PublicUpstreamMeasurements };
      update(
        data.release.version === upstreamResult.release.version &&
          data.release.releaseId === upstreamResult.release.releaseId
          ? { status: "result", data }
          : { status: "release-changed" },
      );
    } catch {
      update({ status: "unavailable" });
    }
  }, []);

  const traceFrom = useCallback(
    async (point: TracePoint, direction: RiverDirection, previous?: Trace) => {
      request.current?.abort();
      if (!previous) discoveryRequest.current?.abort();
      setTrace((current) => (previous && current ? { ...current, error: undefined } : { point }));
      if (previous?.[direction]) return;

      const controller = new AbortController();
      request.current = controller;
      const query = pointQuery(point);
      query.set("direction", direction);
      try {
        const response = await fetch(`/api/river/trace?${query}`, { signal: controller.signal });
        const result = response.ok ? ((await response.json()) as { data: TraceResult }).data : null;
        if (controller.signal.aborted) return;
        const other = previous?.upstream ?? previous?.downstream;
        // Keep the two directions together only when they describe the same match.
        const changed =
          result &&
          other &&
          (other.release.version !== result.release.version ||
            other.release.releaseId !== result.release.releaseId ||
            other.matchStatus !== result.matchStatus);
        if (changed || response.status === 410) discoveryRequest.current?.abort();
        setTrace((current) => {
          if (!current) return current;
          if (response.status === 410) return { point, error: traceErrors[410] };
          if (!result) {
            return { ...current, error: traceErrors[response.status] ?? "River trace unavailable" };
          }
          if (changed) return { point, [direction]: result };
          return { ...current, [direction]: result };
        });
        if (direction === "upstream" && result && traceCatchment(result)) {
          void findMeasurements(point, result);
        }
        return result;
      } catch {
        if (!controller.signal.aborted)
          setTrace((current) => current && { ...current, error: "River trace unavailable" });
      }
    },
    [findMeasurements],
  );

  const point = trace?.point;
  const upstreamResult = trace?.upstream;
  const catchment = useMemo(() => traceCatchment(upstreamResult), [upstreamResult]);
  const selectPoint = useCallback(
    (point: TracePoint) => {
      setDirection("upstream");
      void traceFrom(point, "upstream");
    },
    [traceFrom],
  );

  const discovery = trace?.discovery;
  const matchedStations =
    discovery?.status === "result" && discovery.data.status === "available"
      ? discovery.data.data
      : undefined;
  const mappedStations = useMemo(() => {
    const markers = new Map<string, MapStation>(
      stations.map(({ items, ...station }) => [
        station.stationId,
        { ...station, measurements: items.map(({ measurement }) => measurement), match: false },
      ]),
    );
    for (const { measurements } of matchedStations ?? []) {
      const station = measurements.find(({ position }) => position);
      if (station?.position) {
        const { stationId, name, watercourseName, source, locationEvidence, position } = station;
        markers.set(stationId, {
          stationId,
          name,
          watercourseName,
          source,
          locationEvidence,
          position,
          measurements,
          match: true,
        });
      }
    }
    return [...markers.values()];
  }, [stations, matchedStations]);
  const selected = mappedStations.find((station) => station.stationId === selectedId);

  // Catchment-only stations may go away when a new point or release is selected.
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
          ...initialCamera,
          cooperativeGestures: true,
          dragRotate: false,
          pitchWithRotate: false,
          renderWorldCopies: false,
          scrollZoom: false,
          maxZoom: MAX_MAP_ZOOM,
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
        if (initialTrace) {
          const { point, direction, showCatchment } = initialTrace;
          const previous = { point, showCatchment };
          void traceFrom(point, direction, previous).then((result) => {
            if (active && result?.matchStatus === "Matched" && direction === "downstream") {
              void traceFrom(point, "upstream", { ...previous, downstream: result });
            }
          });
        }
      })
      .catch(() => {
        if (active) setStatus("unavailable");
      });

    return () => {
      active = false;
      request.current?.abort();
      discoveryRequest.current?.abort();
      map?.remove();
    };
  }, [initialCamera, initialTrace, traceFrom]);

  const unavailable = status === "unavailable";
  const map = renderer?.map;
  useEffect(() => {
    if (!map || unavailable) return;
    const onMoveEnd = () => {
      const { lng, lat } = map.getCenter().wrap();
      replaceExplorerParams({
        lon: lng.toFixed(6),
        lat: Math.max(-85, Math.min(lat, 85)).toFixed(6),
        zoom: map.getZoom().toFixed(3),
      });
    };
    map.on("moveend", onMoveEnd);
    return () => {
      map.off("moveend", onMoveEnd);
    };
  }, [map, unavailable]);

  useEffect(() => {
    if (!map || !tracing || unavailable) return;
    const onClick = ({ originalEvent, lngLat }: MapMouseEvent) => {
      if ((originalEvent.target as Element | null)?.closest(".maplibregl-marker")) return;
      const { lng, lat } = lngLat.wrap();
      select(undefined);
      selectPoint([lng, lat]);
    };
    map.on("click", onClick);
    return () => {
      map.off("click", onClick);
    };
  }, [map, tracing, unavailable, selectPoint]);

  const result = trace?.[direction];
  const provenance = result ?? trace?.upstream ?? trace?.downstream;
  const snapped = trace?.upstream?.snappedSample ?? trace?.downstream?.snappedSample;
  const upstream = traceGeometry(upstreamResult);
  const downstream = traceGeometry(trace?.downstream);
  const showCatchment = trace?.showCatchment !== false;
  const shareCatchment = !!catchment || trace?.showCatchment !== undefined;
  useEffect(() => {
    replaceExplorerParams({
      station: selectedId,
      traceLon: point?.[0].toFixed(8),
      traceLat: point?.[1].toFixed(8),
      direction: point ? direction : undefined,
      catchment: point && shareCatchment ? (showCatchment ? "show" : "hide") : undefined,
    });
  }, [selectedId, point, direction, shareCatchment, showCatchment]);
  const visibleUpstream = trace?.hiddenRoutes?.upstream ? null : upstream;
  const visibleDownstream = trace?.hiddenRoutes?.downstream ? null : downstream;
  useEffect(() => {
    if (!map || !styleReady || unavailable) return;
    drawRiverTrace(map, {
      point,
      snapped: snapped?.position,
      upstream: visibleUpstream,
      downstream: visibleDownstream,
      catchment: showCatchment ? catchment : null,
    });
  }, [
    map,
    styleReady,
    unavailable,
    point,
    snapped,
    visibleUpstream,
    visibleDownstream,
    showCatchment,
    catchment,
  ]);

  useEffect(() => {
    if (!renderer || unavailable) return;
    const { map, library } = renderer;
    const visible = mappedStations.filter(
      ({ stationId, match }) =>
        match || (showStations && (stationId === selectedId || filteredStationIds.has(stationId))),
    );
    const markers = visible.map(({ stationId, name, position, match }) => {
      const point: [number, number] = [position.longitude, position.latitude];
      const button = document.createElement("button");
      button.type = "button";
      button.className =
        "grid size-11 cursor-pointer place-items-center rounded-full focus-visible:bg-accent-soft after:rounded-full after:border-2 after:border-surface after:bg-accent-strong after:shadow-md " +
        (match ? "after:size-5 after:ring-2 after:ring-accent-strong" : "after:size-4");
      button.setAttribute("aria-label", match ? `${name}, inside the modelled catchment` : name);
      button.setAttribute("aria-controls", detailsId);
      button.title = name;
      button.onclick = () => {
        if (heading.current?.dataset.stationId === stationId) heading.current.focus();
        else focusSelection.current = true;
        select(stationId);
      };
      return new library.Marker({ element: button }).setLngLat(point).addTo(map);
    });
    return () => markers.forEach((marker) => marker.remove());
  }, [
    detailsId,
    renderer,
    mappedStations,
    unavailable,
    filteredStationIds,
    selectedId,
    showStations,
  ]);

  const selectedStationId = selected?.stationId;
  useEffect(() => {
    if (selectedStationId && focusSelection.current) heading.current?.focus();
    focusSelection.current = false;
  }, [selectedStationId]);

  return (
    <div className="overflow-hidden rounded-lg border border-line bg-surface">
      {/* MapLibre adds its own classes to the container, so keep className stable. */}
      <div
        ref={container}
        role="region"
        aria-label="River map"
        hidden={unavailable}
        data-tracing={tracing}
        className="h-72 bg-canvas sm:h-96 lg:h-[clamp(26rem,60svh,42rem)] data-[tracing=true]:[&_.maplibregl-canvas]:cursor-crosshair"
      />
      {unavailable ? (
        <ErrorState title="River map unavailable">Browse the station list.</ErrorState>
      ) : status === "tiles" || status === "loading" ? (
        <p role="status" className="px-4 py-2 text-sm text-ink-muted">
          {status === "loading" ? "Loading map…" : "Some basemap details could not load."}
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
            {stations.length > 0 ? (
              <Button
                aria-pressed={showStations}
                className="aria-pressed:border-accent aria-pressed:bg-accent-soft"
                onClick={() => setShowStations(!showStations)}
              >
                Published stations
              </Button>
            ) : null}
            {tracing ? (
              <>
                <label className="flex items-center gap-2 text-sm">
                  Direction
                  <select
                    className="min-h-10 rounded-md border border-line-input bg-surface px-2"
                    value={direction}
                    disabled={!point || (!trace?.upstream && !trace?.downstream && !trace?.error)}
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
                    select(undefined);
                    selectPoint([lng, lat]);
                  }}
                >
                  Select map centre
                </Button>
                <Button disabled={!point} onClick={clearTrace}>
                  Clear trace
                </Button>
              </>
            ) : null}
          </div>
          {tracing && !point ? (
            <p className="text-sm text-ink-muted">
              Select a point on a river to see its catchment.
            </p>
          ) : null}
          {showStations && !stations.some(({ stationId }) => filteredStationIds.has(stationId)) ? (
            <p className="text-sm text-ink-muted">No matching stations have verified locations</p>
          ) : null}
          <details className="text-sm text-ink-muted">
            <summary className="flex min-h-11 cursor-pointer items-center underline">
              Map sources and coverage
            </summary>
            <p>
              Basemap by{" "}
              <a className="link" href="https://openfreemap.org/">
                OpenFreeMap
              </a>{" "}
              using OpenStreetMap data.
            </p>
            <p>
              Drainage area overview boundaries are currently unavailable. Select a river point to
              check for a modelled upstream catchment.
            </p>
          </details>
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
                {showCatchment && catchment?.pourPointOffsetM === 0 && snapped?.position ? (
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
                              showCatchment: current.showCatchment === false,
                            },
                        )
                      }
                    >
                      {showCatchment ? "Hide catchment" : "Show catchment"}
                    </Button>
                  ) : null}
                </div>
              ) : null}
              {showCatchment && catchment ? (
                <div className="space-y-1 text-ink-muted">
                  <p>
                    <strong className="text-ink">
                      Selected point’s modelled catchment · {formatArea.format(catchment.areaKm2)}{" "}
                      km²
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
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
      {trace && catchment ? (
        <CatchmentMeasurements
          discovery={discovery ?? { status: "loading" }}
          find={() => {
            if (upstreamResult) void findMeasurements(trace.point, upstreamResult);
          }}
          refreshTrace={() => {
            setDirection("upstream");
            void traceFrom(trace.point, "upstream");
          }}
          comparisonAction={comparisonAction}
        />
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
              {selected.measurements.map((measurement) => (
                <li key={measurement.measurementId} className="flex flex-wrap items-center gap-x-3">
                  <Link className="link" href={measurementPath(measurement.measurementId)}>
                    {parameterLabel(measurement.parameter)}
                  </Link>
                  {comparisonAction(measurement)}
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
                  selectPoint([selected.position.longitude, selected.position.latitude])
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
