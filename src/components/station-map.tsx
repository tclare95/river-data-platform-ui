"use client";

import "maplibre-gl/dist/maplibre-gl.css";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type KeyboardEvent,
  type SetStateAction,
  type ReactNode,
} from "react";
import type { Map as MapLibreMap, MapMouseEvent } from "maplibre-gl";
import { Button } from "@/components/button";
import { CatchmentMeasurements, type CatchmentDiscovery } from "./catchment-measurements";
import {
  fetchInventoryArea,
  InventoryPanel,
  useInventoryMarkers,
  useViewportInventory,
} from "./inventory-map";
import { StationMarkerControls, stationMarkerButton } from "./station-markers";
import { RainfallMapDetails, rainfallMarkerLabel, useRainfallMap } from "./rainfall-map";
import {
  isRainfall,
  isRainfallTotal,
  RAINFALL_MAP_PERIODS,
  type RainfallMapPeriod,
} from "@/lib/rainfall-map";
import { inventoryViewport, type InventoryStation } from "@/lib/inventory";
import { classifyStation, matchesStation, type StationFilters } from "@/lib/station-markers";
import type { OverviewItem } from "@/lib/overview";
import { StationSelection } from "./station-selection";
import {
  drawRiverTrace,
  traceCatchment,
  traceGeometry,
  type TracePoint,
  type TraceResult,
} from "./river-trace-layer";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import type { StationGroup } from "@/lib/discovery";
import { parameterLabel } from "@/lib/labels";
import { writeExplorerParams } from "@/lib/explorer-state";
import {
  GB_BOUNDS,
  LOCATION_ZOOM,
  MAX_MAP_ZOOM,
  mapSelectionParams,
  mapViewParams,
  readMapContext,
  type MapContext,
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

function cameraParams(map: MapLibreMap) {
  const { lng, lat } = map.getCenter().wrap();
  return mapViewParams({ center: [lng, Math.max(-85, Math.min(lat, 85))], zoom: map.getZoom() });
}

export type WorkspacePanel = "stations" | "layers" | "catchment" | "comparison";

const panelClass =
  "explorer-panel min-w-0 overflow-y-auto overscroll-contain rounded-lg border border-line bg-surface p-3 text-sm shadow-md";

type LocatedStation = StationGroup &
  Pick<PublicMeasurement, "locationEvidence" | "source"> & {
    position: NonNullable<PublicMeasurement["position"]>;
  };

type MapStation = Omit<LocatedStation, "items"> & {
  measurements: readonly PublicMeasurement[];
  match: boolean;
};

function inventoryRainfall(
  station: InventoryStation,
  published: ReadonlyMap<string, PublicMeasurement>,
) {
  const rainfallMeasures = station.measures.filter(
    ({ parameter, measurementId }) =>
      isRainfall(parameter) ||
      (measurementId && isRainfall(published.get(measurementId)?.parameter ?? null)),
  );
  const linked = rainfallMeasures.flatMap(({ measurementId }) => {
    const measurement = measurementId && published.get(measurementId);
    return measurement && isRainfallTotal(measurement) ? [measurement] : [];
  });
  return {
    rainfallIds: [...new Set(linked.map(({ measurementId }) => measurementId))],
    rainfallMarker: classifyStation(linked, rainfallMeasures),
  };
}

export function StationMap({
  stations,
  items,
  filteredStationIds,
  initialContext,
  onMapUrlChange,
  comparisonAction,
  comparisonCount,
  shareControls,
  comparison,
  comparisonHistory,
  stationList,
  panel,
  setPanel,
}: {
  stations: readonly LocatedStation[];
  items: readonly OverviewItem[];
  filteredStationIds: ReadonlySet<string>;
  initialContext: MapContext;
  onMapUrlChange: (context: MapContext) => void;
  comparisonAction: (measurement: PublicMeasurement) => ReactNode;
  comparisonCount: number;
  shareControls: ReactNode;
  comparison: ReactNode;
  comparisonHistory: ReactNode;
  stationList: ReactNode;
  panel: WorkspacePanel | null;
  setPanel: Dispatch<SetStateAction<WorkspacePanel | null>>;
}) {
  const container = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const focusSelection = useRef(false);
  const detailsId = useId();
  const { view: initialView, station: initialStationId, trace: initialTrace } = initialContext;
  const panelId = useId();
  const traceButtonId = useId();
  const panelFocus = useRef(false);
  const pushMapChange = useRef(false);
  const writeMap = useCallback(
    (params: Record<string, string | undefined>, push = false) => {
      writeExplorerParams(params, push);
      onMapUrlChange(readMapContext(new URLSearchParams(location.search)));
    },
    [onMapUrlChange],
  );
  const [initialStation] = useState(() =>
    stations.find(({ stationId }) => stationId === initialStationId),
  );
  const [initialCamera] = useState(() => {
    if (initialView) return initialView;
    if (initialStation) {
      const { longitude, latitude } = initialStation.position;
      return { center: [longitude, latitude] as TracePoint, zoom: LOCATION_ZOOM };
    }
    if (initialTrace) return { center: initialTrace.point, zoom: LOCATION_ZOOM };
    return { bounds: GB_BOUNDS, fitBoundsOptions: { padding: 20, duration: 0 } };
  });
  const [styleReady, setStyleReady] = useState(false);
  const [renderer, setRenderer] = useState<{
    map: MapLibreMap;
    library: typeof import("maplibre-gl");
  }>();
  const [status, setStatus] = useState<"loading" | "ready" | "tiles" | "unavailable">("loading");
  const [selectedId, select] = useState(initialStationId);
  const [filters, setFilters] = useState<StationFilters>(
    initialContext.filters ?? { type: "", availability: "" },
  );
  const [inventorySelection, setInventorySelection] = useState<
    | {
        key: string;
        station?: InventoryStation;
      }
    | undefined
  >(() => (initialContext.inventory ? { key: initialContext.inventory } : undefined));
  const inventoryKey = inventorySelection?.key;
  const [inventoryLookup, setInventoryLookup] = useState<
    { key: string; station?: InventoryStation; unavailable?: boolean } | undefined
  >();
  const [collapsed, setCollapsed] = useState(false);
  const [browseInventory, setBrowseInventory] = useState(0);
  const [choosingTracePoint, setChoosingTracePoint] = useState(false);
  const showInventoryPicker = useCallback(() => {
    setChoosingTracePoint(false);
    setPanel("layers");
    setBrowseInventory((value) => value + 1);
  }, [setPanel]);
  const [showStations, setShowStations] = useState(initialContext.showStations ?? true);
  const [rainfallPeriod, setRainfallPeriod] = useState<RainfallMapPeriod | "">("");
  const rainfallEnabled = rainfallPeriod !== "";
  const [tracePending, setTracePending] = useState(false);
  const [direction, setDirection] = useState<RiverDirection>(initialTrace?.direction ?? "upstream");
  const [trace, setTrace] = useState<Trace | undefined>(() =>
    initialTrace
      ? {
          point: initialTrace.point,
          showCatchment: initialTrace.showCatchment,
          hiddenRoutes: initialTrace.hiddenRoutes,
        }
      : undefined,
  );
  const request = useRef<AbortController>(null);
  const discoveryRequest = useRef<AbortController>(null);

  const cancelTrace = useCallback(() => {
    setChoosingTracePoint(false);
    request.current?.abort();
    setTracePending(false);
    // A shared link can have a point before either route has loaded.
    setTrace((current) =>
      current?.upstream || current?.downstream || current?.error ? current : undefined,
    );
  }, []);

  const showStationPanel = useCallback(
    (sameStation: boolean) => {
      const title = heading.current;
      if (sameStation && title && !title.closest("[hidden]")) {
        title.focus({ preventScroll: true });
      } else {
        focusSelection.current = true;
      }
      setPanel(null);
    },
    [setPanel],
  );

  const selectInventory = useCallback(
    (station: InventoryStation) => {
      if (selectedId || inventoryKey !== station.key) {
        pushMapChange.current = true;
      }
      cancelTrace();
      select(undefined);
      showStationPanel(inventoryKey === station.key);
      setCollapsed(false);
      setInventorySelection({ key: station.key, station });
    },
    [cancelTrace, inventoryKey, selectedId, showStationPanel],
  );

  const clearTrace = () => {
    pushMapChange.current = true;
    cancelTrace();
    discoveryRequest.current?.abort();
    setTrace(undefined);
    setPanel(null);
    document.getElementById(traceButtonId)?.focus({ preventScroll: true });
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
      if (
        data.release.version !== upstreamResult.release.version ||
        data.release.releaseId !== upstreamResult.release.releaseId
      )
        return update({ status: "release-changed" });
      if (data.status === "available" && data.catchment.id !== upstreamResult.catchment?.id)
        return update({ status: "catchment-changed" });
      update({ status: "result", data });
    } catch {
      update({ status: "unavailable" });
    }
  }, []);

  const traceFrom = useCallback(
    async (
      point: TracePoint,
      direction: RiverDirection,
      {
        previous,
        displayDirection = direction,
        onCommit,
      }: { previous?: Trace; displayDirection?: RiverDirection; onCommit?: () => void } = {},
    ) => {
      request.current?.abort();
      if (previous?.[direction]) {
        onCommit?.();
        setDirection(displayDirection);
        setTracePending(false);
        return;
      }

      const controller = new AbortController();
      request.current = controller;
      setTracePending(true);
      const query = pointQuery(point);
      query.set("direction", direction);
      const commit = (result: TraceResult | null, error?: string, retired = false) => {
        if (controller.signal.aborted) return;
        const other = previous?.upstream ?? previous?.downstream;
        // Keep the two directions together only when they describe the same match.
        const changed =
          result &&
          other &&
          (other.release.version !== result.release.version ||
            other.release.releaseId !== result.release.releaseId ||
            other.matchStatus !== result.matchStatus);
        if (!previous || changed || retired) discoveryRequest.current?.abort();
        onCommit?.();
        setDirection(displayDirection);
        setTrace((current) => {
          const base = previous && !changed && !retired ? (current ?? previous) : { point };
          return result ? { ...base, [direction]: result, error: undefined } : { ...base, error };
        });
        if (direction === "upstream" && result && traceCatchment(result)) {
          void findMeasurements(point, result);
        }
      };
      try {
        const response = await fetch(`/api/river/trace?${query}`, { signal: controller.signal });
        const result = response.ok ? ((await response.json()) as { data: TraceResult }).data : null;
        commit(
          result,
          traceErrors[response.status] ?? "River trace unavailable",
          response.status === 410,
        );
        return { result, signal: controller.signal };
      } catch {
        commit(null, "River trace unavailable");
      } finally {
        if (!controller.signal.aborted) setTracePending(false);
      }
    },
    [findMeasurements],
  );

  const point = trace?.point;
  const upstreamResult = trace?.upstream;
  const catchment = useMemo(() => traceCatchment(upstreamResult), [upstreamResult]);
  const selectPoint = useCallback(
    (point: TracePoint, fromMap = false) => {
      setChoosingTracePoint(false);
      void traceFrom(point, "upstream", {
        onCommit: () => {
          pushMapChange.current = true;
          if (document.getElementById(detailsId)?.contains(document.activeElement)) {
            panelFocus.current = true;
          }
          setPanel((current) => current ?? "catchment");
          if (fromMap) {
            select(undefined);
            setInventorySelection(undefined);
          }
        },
      });
    },
    [detailsId, setPanel, traceFrom],
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
        const publishedStation = markers.get(stationId);
        markers.set(
          stationId,
          publishedStation
            ? { ...publishedStation, match: true }
            : {
                stationId,
                name,
                watercourseName,
                source,
                locationEvidence,
                position,
                measurements,
                match: true,
              },
        );
      }
    }
    return [...markers.values()];
  }, [stations, matchedStations]);
  const selected = mappedStations.find((station) => station.stationId === selectedId);

  const awaitingCatchment =
    initialTrace &&
    point === initialTrace.point &&
    (!upstreamResult || (!!catchment && (!discovery || discovery.status === "loading"))) &&
    !trace?.error;
  const sharedStationId = selected || awaitingCatchment ? selectedId : undefined;

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
          const { point, direction, showCatchment, hiddenRoutes, bothDirections } = initialTrace;
          const previous = { point, showCatchment, hiddenRoutes };
          void traceFrom(point, direction, { previous }).then((completed) => {
            if (
              active &&
              completed &&
              !completed.signal.aborted &&
              completed.result?.matchStatus === "Matched" &&
              (direction === "downstream" || bothDirections)
            ) {
              const other = direction === "downstream" ? "upstream" : "downstream";
              void traceFrom(point, other, {
                previous: { ...previous, [direction]: completed.result },
                displayDirection: direction,
              });
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
  const activePanel =
    unavailable && panel !== "comparison" && panel !== "layers" ? "stations" : panel;

  useEffect(() => {
    if (activePanel && panelFocus.current) {
      document.getElementById(`${panelId}-${activePanel}-panel`)?.focus({ preventScroll: true });
    }
    panelFocus.current = false;
  }, [activePanel, panelId]);

  function togglePanel(next: WorkspacePanel) {
    setChoosingTracePoint(false);
    if (activePanel === next) {
      setPanel(null);
    } else {
      panelFocus.current = true;
      setPanel(next);
    }
  }

  function closePanel() {
    if (!activePanel || (unavailable && activePanel === "stations")) return;
    setPanel(null);
    document.getElementById(`${panelId}-${activePanel}`)?.focus({ preventScroll: true });
  }
  const map = renderer?.map;
  const refreshSelectedInventory = useCallback((stations: InventoryStation[]) => {
    setInventorySelection((current) => {
      const station = current && stations.find(({ key }) => key === current.key);
      return station && station !== current?.station ? { key: station.key, station } : current;
    });
  }, []);
  const inventory = useViewportInventory(unavailable ? undefined : map, refreshSelectedInventory);
  const inventoryStations =
    inventory.view.status === "ready" ? inventory.view.data.stations : undefined;
  const inventorySelected =
    inventorySelection?.station ??
    (inventoryLookup?.key === inventoryKey ? inventoryLookup?.station : undefined);
  const inventorySettled = !["moving", "loading"].includes(inventory.view.status);

  const sharedInventoryPosition =
    inventoryKey === initialContext.inventory ? initialContext.inventoryPosition : undefined;
  const lookupArea = sharedInventoryPosition
    ? inventoryViewport([
        sharedInventoryPosition[0] - 0.005,
        sharedInventoryPosition[1] - 0.005,
        sharedInventoryPosition[0] + 0.005,
        sharedInventoryPosition[1] + 0.005,
      ])
    : undefined;
  const lookupBbox = lookupArea?.status === "area" ? lookupArea.bbox : undefined;
  useEffect(() => {
    if (
      !map ||
      unavailable ||
      !inventoryKey ||
      !lookupBbox ||
      !inventorySettled ||
      inventorySelected ||
      inventoryLookup?.key === inventoryKey
    )
      return;
    const controller = new AbortController();
    void fetchInventoryArea(lookupBbox, controller.signal).then(
      ({ stations }) => {
        if (!controller.signal.aborted)
          setInventoryLookup({
            key: inventoryKey,
            station: stations.find(({ key }) => key === inventoryKey),
          });
      },
      () => {
        if (!controller.signal.aborted)
          setInventoryLookup({ key: inventoryKey, unavailable: true });
      },
    );
    return () => controller.abort();
  }, [
    inventoryKey,
    lookupBbox,
    inventoryLookup,
    inventorySelected,
    inventorySettled,
    map,
    unavailable,
  ]);

  const publishedMeasurements = useMemo(
    () =>
      new Map([
        ...items.map(({ measurement }) => [measurement.measurementId, measurement] as const),
        ...(matchedStations ?? []).flatMap(({ measurements }) =>
          measurements.map((measurement) => [measurement.measurementId, measurement] as const),
        ),
      ]),
    [items, matchedStations],
  );
  const { inventoryWithMarkers, markersByStation } = useMemo(() => {
    const publishedByStation = new Map<string, PublicMeasurement[]>();
    for (const measurement of publishedMeasurements.values()) {
      const group = publishedByStation.get(measurement.stationId) ?? [];
      group.push(measurement);
      publishedByStation.set(measurement.stationId, group);
    }
    const inventoryByStation = new Map<string, InventoryStation["measures"]>();
    // Join the feeds by published IDs, which can link to a group containing additional types.
    const inventoryWithMarkers = (inventoryStations ?? []).map((station) => {
      const linkedStationIds = new Set(
        station.measures.flatMap(({ measurementId }) => {
          const measurement = measurementId && publishedMeasurements.get(measurementId);
          return measurement ? [measurement.stationId] : [];
        }),
      );
      for (const id of linkedStationIds) {
        inventoryByStation.set(id, [...(inventoryByStation.get(id) ?? []), ...station.measures]);
      }
      const published = [...linkedStationIds].flatMap((id) => publishedByStation.get(id) ?? []);
      const rain = inventoryRainfall(station, publishedMeasurements);
      return {
        ...station,
        rainfallIds: rain.rainfallIds,
        marker: rainfallEnabled
          ? rain.rainfallMarker
          : classifyStation(published, station.measures),
      };
    });
    const markersByStation = new Map(
      [...publishedByStation].map(([id, measurements]) => [
        id,
        classifyStation(measurements, inventoryByStation.get(id)),
      ]),
    );
    return { inventoryWithMarkers, markersByStation };
  }, [inventoryStations, publishedMeasurements, rainfallEnabled]);
  const inventorySelectionRain = useMemo(
    () => inventorySelected && inventoryRainfall(inventorySelected, publishedMeasurements),
    [inventorySelected, publishedMeasurements],
  );
  const visibleInventory = useMemo(
    () =>
      inventoryWithMarkers.filter(({ marker }) =>
        rainfallEnabled
          ? marker.type === "rainfall"
          : (showStations || marker.availability !== "published") &&
            matchesStation(marker, filters),
      ),
    [inventoryWithMarkers, filters, showStations, rainfallEnabled],
  );
  const inventoryMarkers = useMemo(() => {
    const preferredIds = new Set(
      mappedStations.flatMap(({ match, stationId, measurements }) =>
        rainfallEnabled
          ? measurements.filter(isRainfallTotal).map(({ measurementId }) => measurementId)
          : match || stationId === selectedId
            ? measurements.map(({ measurementId }) => measurementId)
            : [],
      ),
    );
    const markers = visibleInventory.filter(
      ({ key, measures, rainfallIds }) =>
        key === inventoryKey ||
        (rainfallEnabled
          ? !rainfallIds.some((id) => preferredIds.has(id))
          : !measures.some(
              ({ measurementId }) => measurementId && preferredIds.has(measurementId),
            )),
    );
    if (inventorySelected && !markers.some(({ key }) => key === inventoryKey)) {
      const marker =
        rainfallEnabled && inventorySelectionRain
          ? inventorySelectionRain.rainfallMarker
          : classifyStation([], inventorySelected.measures);
      if (
        rainfallEnabled
          ? marker.type === "rainfall"
          : (showStations || marker.availability !== "published") && matchesStation(marker, filters)
      )
        markers.push({
          ...inventorySelected,
          marker,
          rainfallIds: inventorySelectionRain?.rainfallIds ?? [],
        });
    }
    return markers;
  }, [
    visibleInventory,
    mappedStations,
    selectedId,
    inventoryKey,
    inventorySelected,
    inventorySelectionRain,
    filters,
    showStations,
    rainfallEnabled,
  ]);
  const inventoryMeasurementIds = useMemo(
    () =>
      new Set(
        inventoryMarkers.flatMap(({ measures, rainfallIds }) =>
          rainfallEnabled
            ? rainfallIds
            : measures.flatMap(({ measurementId }) => (measurementId ? [measurementId] : [])),
        ),
      ),
    [inventoryMarkers, rainfallEnabled],
  );
  const visibleMappedStations = useMemo(
    () =>
      mappedStations.flatMap((station) => {
        const { stationId, match, measurements } = station;
        const rain = measurements.filter(isRainfallTotal);
        const rainfallIds = rain.map(({ measurementId }) => measurementId);
        const marker = rainfallEnabled
          ? classifyStation(rain)
          : (markersByStation.get(stationId) ?? classifyStation(measurements));
        const representedByInventory = (rainfallEnabled ? rain : measurements).some(
          ({ measurementId }) => inventoryMeasurementIds.has(measurementId),
        );
        const shown =
          !representedByInventory &&
          (rainfallEnabled
            ? rainfallIds.length > 0
            : (match ||
                (showStations &&
                  (stationId === selectedId || filteredStationIds.has(stationId)))) &&
              matchesStation(marker, filters));
        return shown ? [{ ...station, marker, rainfallIds }] : [];
      }),
    [
      mappedStations,
      rainfallEnabled,
      markersByStation,
      inventoryMeasurementIds,
      showStations,
      selectedId,
      filteredStationIds,
      filters,
    ],
  );
  const rainfallGauges = useMemo(
    () => [...visibleMappedStations, ...inventoryMarkers],
    [visibleMappedStations, inventoryMarkers],
  );
  const rainfall = useRainfallMap(unavailable ? undefined : map, rainfallPeriod, rainfallGauges);
  const inventoryRainfallLabel = useCallback(
    ({ rainfallIds }: { rainfallIds: readonly string[] }) =>
      rainfallMarkerLabel(rainfallIds, rainfall),
    [rainfall],
  );
  useInventoryMarkers(
    unavailable ? undefined : renderer,
    inventoryMarkers,
    selectInventory,
    showInventoryPicker,
    detailsId,
    inventoryKey,
    rainfallEnabled ? inventoryRainfallLabel : undefined,
  );
  useEffect(() => {
    if (!map || unavailable) return;
    const onMoveEnd = () => writeMap(cameraParams(map));
    map.on("moveend", onMoveEnd);
    return () => {
      map.off("moveend", onMoveEnd);
    };
  }, [map, unavailable, writeMap]);

  useEffect(() => {
    if (!map || !choosingTracePoint || unavailable) return;
    const onClick = ({ originalEvent, lngLat }: MapMouseEvent) => {
      if (
        originalEvent.defaultPrevented ||
        (originalEvent.target as Element | null)?.closest(".maplibregl-marker, .maplibregl-ctrl")
      )
        return;
      map.off("click", onClick);
      const { lng, lat } = lngLat.wrap();
      selectPoint([lng, lat], true);
    };
    map.on("click", onClick);
    return () => {
      map.off("click", onClick);
    };
  }, [map, choosingTracePoint, unavailable, selectPoint]);

  const result = trace?.[direction];
  const provenance = result ?? trace?.upstream ?? trace?.downstream;
  const snapped = trace?.upstream?.snappedSample ?? trace?.downstream?.snappedSample;
  const upstream = traceGeometry(upstreamResult);
  const downstream = traceGeometry(trace?.downstream);
  const showCatchment = trace?.showCatchment !== false;
  const sharedCatchment = catchment ? showCatchment : trace?.showCatchment;
  const hiddenRoutes = trace?.hiddenRoutes;
  const bothDirections =
    (!!trace?.upstream && !!trace?.downstream) ||
    (point === initialTrace?.point && initialTrace?.bothDirections);
  const inventoryPosition = inventorySelected?.position;
  const inventoryLongitude = inventoryPosition?.longitude ?? sharedInventoryPosition?.[0];
  const inventoryLatitude = inventoryPosition?.latitude ?? sharedInventoryPosition?.[1];
  useEffect(() => {
    const params = mapSelectionParams({
      station: sharedStationId,
      inventory: inventoryKey,
      inventoryPosition:
        inventoryKey && inventoryLongitude !== undefined && inventoryLatitude !== undefined
          ? [inventoryLongitude, inventoryLatitude]
          : undefined,
      showStations: showStations ? undefined : false,
      filters,
      trace: point
        ? { point, direction, showCatchment: sharedCatchment, bothDirections, hiddenRoutes }
        : undefined,
    });
    const push = pushMapChange.current;
    pushMapChange.current = false;
    if (push && map && !readMapContext(new URLSearchParams(location.search)).view) {
      writeMap(cameraParams(map));
    }
    writeMap(params, push);
  }, [
    sharedStationId,
    inventoryKey,
    inventoryLongitude,
    inventoryLatitude,
    map,
    filters,
    showStations,
    point,
    direction,
    sharedCatchment,
    bothDirections,
    hiddenRoutes,
    writeMap,
  ]);
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
    const markers = visibleMappedStations.map(
      ({ stationId, name, position, match, marker, rainfallIds }) => {
        const point: [number, number] = [position.longitude, position.latitude];
        const button = stationMarkerButton(
          name,
          marker,
          match,
          stationId === selectedId,
          rainfallEnabled ? rainfallMarkerLabel(rainfallIds, rainfall) : undefined,
        );
        button.setAttribute("aria-controls", detailsId);
        button.onclick = (event) => {
          event.stopPropagation();
          showStationPanel(selectedId === stationId);
          if (inventoryKey || selectedId !== stationId) {
            pushMapChange.current = true;
          }
          cancelTrace();
          setInventorySelection(undefined);
          setCollapsed(false);
          select(stationId);
        };
        return new library.Marker({ element: button }).setLngLat(point).addTo(map);
      },
    );
    return () => markers.forEach((marker) => marker.remove());
  }, [
    cancelTrace,
    detailsId,
    renderer,
    visibleMappedStations,
    unavailable,
    selectedId,
    showStationPanel,
    inventoryKey,
    rainfallEnabled,
    rainfall,
  ]);

  const activeStation = inventorySelected ?? selected;
  const awaitingInventory =
    !inventorySettled || (!!lookupBbox && inventoryLookup?.key !== inventoryKey);
  const inventoryUnavailable =
    inventoryLookup?.unavailable || inventory.view.status === "unavailable";
  const selectionKey = inventorySelected
    ? `inventory:${inventorySelected.key}`
    : selected
      ? `station:${selected.stationId}`
      : undefined;
  useEffect(() => {
    if (activePanel || choosingTracePoint) return;
    if (selectionKey && focusSelection.current) heading.current?.focus({ preventScroll: true });
    focusSelection.current = false;
  }, [activePanel, choosingTracePoint, selectionKey]);

  const latestById = useMemo(
    () => new Map(items.map(({ measurement, latest }) => [measurement.measurementId, latest])),
    [items],
  );
  const measures = inventorySelected
    ? inventorySelected.measures.map(({ measurementId, parameter, qualifier, status }) => ({
        key: JSON.stringify([measurementId, parameter, qualifier, status]),
        label: [parameter ? parameterLabel(parameter) : "Measurement type unknown", qualifier]
          .filter(Boolean)
          .join(" · "),
        measurementId: measurementId ?? undefined,
        measurement: measurementId ? publishedMeasurements.get(measurementId) : undefined,
        latest: measurementId ? latestById.get(measurementId) : undefined,
        availability: {
          published: "Published measurement unavailable",
          not_published: "No data published by RDP",
          unknown: "RDP availability unknown",
        }[status],
      }))
    : (selected?.measurements ?? []).map((measurement) => ({
        key: measurement.measurementId,
        measurementId: measurement.measurementId,
        label: parameterLabel(measurement.parameter),
        measurement,
        latest: latestById.get(measurement.measurementId),
      }));

  function dismissStation() {
    cancelTrace();
    pushMapChange.current = true;
    select(undefined);
    setInventorySelection(undefined);
    container.current?.focus({ preventScroll: true });
  }

  const panelButtons: { name: WorkspacePanel; label: string }[] = [
    { name: "stations", label: "Stations" },
    { name: "layers", label: "Layers" },
  ];
  if (!unavailable) panelButtons.push({ name: "catchment", label: "Catchment" });
  if (items.length) {
    panelButtons.push({ name: "comparison", label: `Compare (${comparisonCount})` });
  }

  function panelProps(name: WorkspacePanel) {
    return {
      id: `${panelId}-${name}-panel`,
      tabIndex: -1,
      hidden: activePanel !== name,
      onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key === "Escape" && !event.defaultPrevented) closePanel();
      },
    };
  }

  return (
    <div
      className="explorer-workspace flex min-h-0 flex-1 flex-col rounded-lg border border-line bg-surface [@media(scripting:none)]:border-0"
      data-map-unavailable={unavailable || undefined}
    >
      <div
        role="group"
        aria-label="Map tools"
        className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-line p-1.5 [@media(scripting:none)]:hidden"
      >
        {!unavailable && (
          <Button
            id={traceButtonId}
            aria-pressed={choosingTracePoint}
            className="px-2! aria-pressed:border-accent aria-pressed:bg-accent-soft sm:px-3.5!"
            disabled={!map || tracePending}
            onClick={() => {
              setChoosingTracePoint(!choosingTracePoint);
              if (!choosingTracePoint) setPanel(null);
            }}
          >
            Trace river
          </Button>
        )}
        {panelButtons.map(({ name, label }) => (
          <Button
            key={name}
            id={`${panelId}-${name}`}
            disabled={
              (name === "catchment" && !trace) ||
              (unavailable && name === "stations" && activePanel === name)
            }
            aria-expanded={activePanel === name}
            aria-controls={`${panelId}-${name}-panel`}
            className="px-2! aria-expanded:border-accent aria-expanded:bg-accent-soft sm:px-3.5!"
            onClick={() => togglePanel(name)}
          >
            {label}
          </Button>
        ))}
      </div>
      <div className={unavailable ? "relative min-h-72" : "relative min-h-0 flex-1"}>
        {/* MapLibre adds its own classes to the container, so keep className stable. */}
        <div
          ref={container}
          role="region"
          aria-label="River map"
          tabIndex={-1}
          hidden={unavailable}
          data-tracing={choosingTracePoint}
          className="h-full rounded-b-lg bg-canvas data-[tracing=true]:[&_.maplibregl-canvas]:cursor-crosshair [@media(scripting:none)]:hidden"
        />
        {unavailable ? (
          <ErrorState title="River map unavailable" className="m-2">
            Browse the station list.
          </ErrorState>
        ) : null}
        {!unavailable && (status !== "ready" || choosingTracePoint || tracePending) ? (
          <div className="absolute top-2 left-2 z-20 max-w-[min(26rem,calc(100%-4rem))] space-y-2 rounded-md bg-surface p-2 text-sm shadow [@media(scripting:none)]:hidden">
            <p role="status" className="text-ink-muted">
              {choosingTracePoint
                ? "Select a point on a river to trace its upstream catchment."
                : tracePending
                  ? "Tracing river…"
                  : status === "loading"
                    ? "Loading map…"
                    : "Some basemap details could not load."}
            </p>
            {choosingTracePoint || tracePending ? (
              <div className="flex flex-wrap gap-2">
                <Button
                  onClick={() => {
                    cancelTrace();
                    document.getElementById(traceButtonId)?.focus({ preventScroll: true });
                  }}
                >
                  Cancel trace
                </Button>
                {choosingTracePoint && map ? (
                  <Button
                    onClick={() => {
                      const { lng, lat } = map.getCenter().wrap();
                      selectPoint([lng, lat], true);
                      container.current?.focus({ preventScroll: true });
                    }}
                  >
                    Select map centre
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
        <div
          id={detailsId}
          hidden={
            activePanel !== null ||
            choosingTracePoint ||
            (!activeStation && !inventoryKey) ||
            unavailable
          }
          className="explorer-station-panel pointer-events-none [@media(scripting:none)]:hidden"
        >
          {activeStation && selectionKey && !unavailable ? (
            <StationSelection
              selectionKey={selectionKey}
              name={activeStation.name}
              river={inventorySelected ? inventorySelected.watercourse : selected?.watercourseName}
              measures={measures}
              discoverable={
                inventorySelected &&
                classifyStation([], inventorySelected.measures).availability === "discoverable"
              }
              headingRef={heading}
              collapsed={collapsed}
              onToggle={() => setCollapsed(!collapsed)}
              onClose={dismissStation}
              comparisonAction={comparisonAction}
              summary={
                rainfallPeriod ? (
                  <RainfallMapDetails
                    period={rainfallPeriod}
                    view={rainfall}
                    ids={
                      inventorySelected
                        ? (inventorySelectionRain?.rainfallIds ?? [])
                        : (selected?.measurements
                            .filter(isRainfallTotal)
                            .map(({ measurementId }) => measurementId) ?? [])
                    }
                    emptyLabel={
                      inventorySelectionRain?.rainfallMarker.availability === "discoverable"
                        ? "No rainfall observations published by RDP"
                        : "Rainfall total unavailable for this station"
                    }
                  />
                ) : null
              }
            >
              <p className="text-ink-muted">
                Station reference position · {activeStation.position.precisionMetres} m resolution
                {selected?.locationEvidence ? (
                  <>
                    {" · "}
                    <a className="link" href={selected.locationEvidence}>
                      {selected.source.label} station record
                    </a>
                  </>
                ) : null}
              </p>
              <Button
                onClick={() =>
                  selectPoint([activeStation.position.longitude, activeStation.position.latitude])
                }
              >
                Trace upstream catchment
              </Button>
            </StationSelection>
          ) : inventoryKey && !unavailable ? (
            <div className="pointer-events-auto rounded-lg bg-surface shadow-md">
              {awaitingInventory ? (
                <div className="space-y-2 p-3">
                  <p aria-hidden="true" className="text-sm">
                    Finding selected station…
                  </p>
                  <LoadingState
                    label="Finding selected station"
                    lines={1}
                    className="border-0 p-0"
                  />
                  <Button onClick={dismissStation}>Clear station selection</Button>
                </div>
              ) : (
                <EmptyState
                  title={
                    inventoryUnavailable
                      ? "Selected station is temporarily unavailable"
                      : "Selected station could not be found"
                  }
                  action={<Button onClick={dismissStation}>Clear station selection</Button>}
                />
              )}
            </div>
          ) : null}
        </div>
        <div
          {...panelProps("stations")}
          className={unavailable ? "p-3" : `${panelClass} explorer-stations`}
        >
          {stationList}
        </div>
        <div
          {...panelProps("layers")}
          aria-label="Map layers"
          role="region"
          className={unavailable ? "space-y-2 p-3" : `${panelClass} space-y-2`}
        >
          {map && !unavailable ? (
            <>
              <label className="flex flex-wrap items-center gap-2 font-medium">
                Rainfall accumulation
                <select
                  className="min-h-11 rounded-md border border-line-input bg-surface px-2"
                  value={rainfallPeriod}
                  onChange={(event) =>
                    setRainfallPeriod(event.target.value as RainfallMapPeriod | "")
                  }
                >
                  <option value="">Off</option>
                  {Object.entries(RAINFALL_MAP_PERIODS).map(([value, { label }]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              {rainfallEnabled && rainfall.limited ? (
                <p role="status">
                  Showing up to four rainfall totals. Zoom in to see other gauges’ totals.
                </p>
              ) : null}
              {!rainfallEnabled && stations.length > 0 ? (
                <Button
                  aria-pressed={showStations}
                  className="aria-pressed:border-accent aria-pressed:bg-accent-soft"
                  onClick={() => {
                    pushMapChange.current = true;
                    setShowStations(!showStations);
                  }}
                >
                  Published stations
                </Button>
              ) : null}
              {!rainfallEnabled &&
              showStations &&
              stations.length > 0 &&
              !stations.some(({ stationId }) => filteredStationIds.has(stationId)) ? (
                <p className="text-sm text-ink-muted">
                  No matching stations have verified locations
                </p>
              ) : null}
              {rainfallEnabled ? (
                <p className="text-ink-muted">
                  Outlined gauges are discoverable only. Dotted gauges have unknown publication.
                </p>
              ) : (
                <StationMarkerControls filters={filters} onChange={setFilters} />
              )}
              <InventoryPanel
                view={inventory.view}
                visibleStations={visibleInventory}
                retry={inventory.retry}
                selected={inventorySelected}
                onSelect={selectInventory}
                browse={browseInventory}
              />
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
                  Drainage area overview boundaries are currently unavailable. Select a river point
                  to check for a modelled upstream catchment.
                </p>
              </details>
            </>
          ) : null}
          {shareControls}
        </div>
        <div
          {...panelProps("catchment")}
          role="region"
          aria-label="Catchment"
          className={`${panelClass} space-y-2`}
        >
          {trace && !unavailable ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                {trace ? (
                  <>
                    <label className="flex items-center gap-2 text-sm">
                      Direction
                      <select
                        className="min-h-10 rounded-md border border-line-input bg-surface px-2"
                        value={direction}
                        disabled={tracePending || choosingTracePoint}
                        onChange={(event) => {
                          const next = event.target.value as RiverDirection;
                          if (next === direction) return;
                          void traceFrom(trace.point, next, {
                            previous: trace,
                            onCommit: () => {
                              pushMapChange.current = true;
                            },
                          });
                        }}
                      >
                        <option value="downstream">Downstream</option>
                        <option value="upstream">Upstream</option>
                      </select>
                    </label>
                    <Button onClick={clearTrace}>Clear catchment</Button>
                  </>
                ) : null}
              </div>
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
                  <p>{trace.error}</p>
                )}
              </div>
              {!result && trace.error ? (
                <Button
                  disabled={tracePending}
                  onClick={() => void traceFrom(trace.point, direction, { previous: trace })}
                >
                  Retry trace
                </Button>
              ) : null}
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
                            pushMapChange.current = true;
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
                      onClick={() => {
                        pushMapChange.current = true;
                        setTrace(
                          (current) =>
                            current && {
                              ...current,
                              showCatchment: current.showCatchment === false,
                            },
                        );
                      }}
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
              {trace && catchment ? (
                <CatchmentMeasurements
                  discovery={discovery ?? { status: "loading" }}
                  find={() => {
                    if (upstreamResult) void findMeasurements(trace.point, upstreamResult);
                  }}
                  refreshTrace={() => selectPoint(trace.point)}
                  comparisonAction={comparisonAction}
                />
              ) : null}
            </>
          ) : null}
        </div>
        <div {...panelProps("comparison")} className={unavailable ? "p-3" : panelClass}>
          {comparison}
          {activePanel === "comparison" ? comparisonHistory : null}
        </div>
      </div>
    </div>
  );
}
