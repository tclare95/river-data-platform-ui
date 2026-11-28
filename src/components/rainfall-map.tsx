"use client";

import { useEffect, useMemo, useState } from "react";
import type { Map as MapLibreMap } from "maplibre-gl";
import { RainfallTotalValue, RainfallWindowLabel } from "@/components/history/rainfall-totals";
import { rainfallDepth } from "@/lib/history/rainfall-totals";
import {
  MAX_MAP_RAINFALL_MEASUREMENTS,
  RAINFALL_MAP_PERIODS,
  type MapRainfallResponse,
  type MapRainfallReading,
  type RainfallMapPeriod,
} from "@/lib/rainfall-map";

type Gauge = {
  rainfallIds: readonly string[];
  position: { longitude: number; latitude: number };
};

export function useRainfallMap(
  map: MapLibreMap | undefined,
  period: RainfallMapPeriod | "",
  gauges: readonly Gauge[],
) {
  const [bounds, setBounds] = useState<readonly [number, number, number, number]>();
  const enabled = period !== "";
  useEffect(() => {
    if (!map || !enabled) return;
    const moving = () => setBounds(undefined);
    const settled = () => {
      const bounds = map.getBounds();
      setBounds([bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()]);
    };
    map.on("movestart", moving);
    map.on("moveend", settled);
    if (map.isMoving()) moving();
    else settled();
    return () => {
      map.off("movestart", moving);
      map.off("moveend", settled);
    };
  }, [map, enabled]);

  const ids = useMemo(() => {
    if (!bounds || !period) return [];
    const [west, south, east, north] = bounds;
    const lon = (west + east) / 2;
    const lat = (south + north) / 2;
    const visible = gauges
      .filter(
        ({ position: p }) =>
          p.longitude >= west && p.longitude <= east && p.latitude >= south && p.latitude <= north,
      )
      .map(({ position, rainfallIds }) => ({
        rainfallIds,
        distance: Math.hypot(
          (position.longitude - lon) * Math.cos((lat * Math.PI) / 180),
          position.latitude - lat,
        ),
      }))
      .sort((a, b) => a.distance - b.distance);
    return [...new Set(visible.flatMap(({ rainfallIds }) => rainfallIds))];
  }, [bounds, gauges, period]);

  const idQuery = ids.slice(0, MAX_MAP_RAINFALL_MEASUREMENTS).sort().join(",");
  const query = useMemo(() => {
    if (!map || !bounds || !period || !idQuery) return null;
    const params = new URLSearchParams({ period });
    const ids = idQuery.split(",");
    for (const id of ids) params.append("id", id);
    return { url: `/api/measurements/rainfall-map?${params}`, ids };
  }, [map, bounds, period, idQuery]);
  const [response, setResponse] = useState<{
    query: NonNullable<typeof query>;
    data: MapRainfallResponse | null;
  }>();
  useEffect(() => {
    if (!query) return;
    const controller = new AbortController();
    const debounce = setTimeout(async () => {
      try {
        const result = await fetch(query.url, { signal: controller.signal });
        if (!result.ok) throw new Error("Rainfall totals unavailable");
        const data = (await result.json()) as MapRainfallResponse;
        if (!controller.signal.aborted) setResponse({ query, data });
      } catch {
        if (!controller.signal.aborted) setResponse({ query, data: null });
      }
    }, 400);
    return () => {
      clearTimeout(debounce);
      controller.abort();
    };
  }, [query]);

  // A superseded response must disappear immediately, including during the next debounce.
  const current = response?.query === query ? response : undefined;
  return useMemo(
    () => ({
      data: current?.data,
      requested: query?.ids ?? [],
      limited: ids.length > MAX_MAP_RAINFALL_MEASUREMENTS,
    }),
    [current, query, ids.length],
  );
}

type RainfallView = ReturnType<typeof useRainfallMap>;

function readingLabel(reading: MapRainfallReading) {
  if (reading.status === "missing") return "Missing";
  if (reading.status !== "total" || reading.total.totalMm === null) return "Unavailable";
  const total = reading.total;
  return [
    total.status === "partial" && "Partial",
    total.basis === "indicative" && "Indicative",
    rainfallDepth(total.totalMm),
  ]
    .filter(Boolean)
    .join(" ");
}

export function rainfallMarkerLabel(ids: readonly string[], { data, requested }: RainfallView) {
  if (data === null) return ids.some((id) => requested.includes(id)) ? "Unavailable" : undefined;
  const labels = [
    ...new Set(
      ids.flatMap((id) => {
        const reading = data?.readings[id];
        return reading ? [readingLabel(reading)] : [];
      }),
    ),
  ];
  if (labels.length === 0) return;
  return labels.length === 1 ? labels[0] : `${labels[0]} · +${labels.length - 1}`;
}

export function RainfallMapDetails({
  ids,
  period,
  view,
  emptyLabel,
}: {
  ids: readonly string[];
  period: RainfallMapPeriod;
  view: RainfallView;
  emptyLabel: string;
}) {
  const { data, limited, requested } = view;
  return (
    <div className="space-y-1" aria-live="polite">
      <p className="font-semibold">Rainfall accumulation · {RAINFALL_MAP_PERIODS[period].label}</p>
      {data && <RainfallWindowLabel window={data.window} />}
      {ids.length === 0 ? (
        <p>{emptyLabel}</p>
      ) : (
        <ul className="space-y-1">
          {ids.map((id) => {
            const reading = data?.readings[id];
            return (
              <li key={id}>
                {reading?.status === "total" ? (
                  <RainfallTotalValue total={reading.total} />
                ) : reading?.status === "missing" ? (
                  "No observations in this window"
                ) : reading?.status === "unavailable" ||
                  (data === null && requested.includes(id)) ? (
                  "Rainfall total unavailable"
                ) : requested.includes(id) ? (
                  "Loading rainfall total…"
                ) : limited ? (
                  "Zoom in to load this rainfall total"
                ) : (
                  "Rainfall total loads when the gauge is in view"
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
