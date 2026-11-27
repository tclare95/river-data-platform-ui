"use client";

import { useEffect, useRef, useState } from "react";
import type { Map as MapLibreMap } from "maplibre-gl";
import { Button } from "@/components/button";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { inventoryViewport, type InventoryArea, type InventoryStation } from "@/lib/inventory";
import { MAX_MAP_ZOOM } from "@/lib/map-context";
import { markerButtonClasses, stationMarkerButton } from "./station-markers";
import { stationAvailability, type StationMarker } from "@/lib/station-markers";

export const INVENTORY_DEBOUNCE_MS = 400;

type InventoryView =
  | { status: "moving" | "loading" | "zoom" | "outside" | "unavailable" }
  | { status: "ready"; data: InventoryArea };

export function useViewportInventory(map: MapLibreMap | undefined) {
  const [view, setView] = useState<InventoryView>({ status: "moving" });
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!map) return;
    let timer: ReturnType<typeof setTimeout>;
    let request: AbortController | undefined;

    const cancel = () => {
      clearTimeout(timer);
      request?.abort();
    };
    const moving = () => {
      cancel();
      setView({ status: "moving" });
    };
    const settled = () => {
      cancel();
      const bounds = map.getBounds();
      const viewport = inventoryViewport([
        bounds.getWest(),
        bounds.getSouth(),
        bounds.getEast(),
        bounds.getNorth(),
      ]);
      if (viewport.status !== "area") return setView(viewport);
      setView({ status: "loading" });
      timer = setTimeout(async () => {
        const controller = new AbortController();
        request = controller;
        try {
          const query = new URLSearchParams({ bbox: viewport.bbox });
          const response = await fetch(`/api/discovery/area?${query}`, {
            signal: controller.signal,
          });
          if (!response.ok) throw new Error("Inventory unavailable");
          const { data } = (await response.json()) as { data: InventoryArea };
          if (!controller.signal.aborted) setView({ status: "ready", data });
        } catch {
          if (!controller.signal.aborted) setView({ status: "unavailable" });
        }
      }, INVENTORY_DEBOUNCE_MS);
    };
    map.on("movestart", moving);
    map.on("moveend", settled);
    settled();
    return () => {
      cancel();
      map.off("movestart", moving);
      map.off("moveend", settled);
    };
  }, [map, retry]);
  return { view, retry: () => setRetry((attempt) => attempt + 1) };
}

export type InventoryMapStation = InventoryStation & { marker: StationMarker };

export function useInventoryMarkers(
  renderer: { map: MapLibreMap; library: typeof import("maplibre-gl") } | undefined,
  stations: readonly InventoryMapStation[],
  onSelect: (station: InventoryStation) => void,
  onBrowse: () => void,
  detailsId: string,
) {
  useEffect(() => {
    if (!renderer || !stations.length) return;
    const { map, library } = renderer;
    const cells = new Map<string, InventoryMapStation[]>();
    for (const station of stations) {
      const { longitude, latitude } = station.position;
      const { x, y } = map.project([longitude, latitude]);
      const cell = `${Math.floor(x / 52)}:${Math.floor(y / 52)}`;
      const group = cells.get(cell);
      if (group) group.push(station);
      else cells.set(cell, [station]);
    }
    const markers = [...cells.values()].map((group) => {
      const [station] = group;
      const { longitude, latitude } = station.position;
      const point: [number, number] = [longitude, latitude];
      if (group.length === 1) {
        const button = stationMarkerButton(station.name, station.marker);
        button.setAttribute("aria-controls", detailsId);
        button.onclick = () => onSelect(station);
        return new library.Marker({ element: button }).setLngLat(point).addTo(map);
      }
      const button = document.createElement("button");
      button.type = "button";
      button.className = markerButtonClasses;
      const count = document.createElement("span");
      count.className =
        "grid size-8 place-items-center rounded-full border border-line-strong bg-surface text-sm font-semibold text-ink shadow-md";
      count.textContent = String(group.length);
      button.append(count);
      button.setAttribute("aria-label", `${group.length} stations`);
      button.onclick = () => {
        if (map.getZoom() >= MAX_MAP_ZOOM) onBrowse();
        else map.easeTo({ center: point, zoom: Math.min(MAX_MAP_ZOOM, map.getZoom() + 2) });
      };
      return new library.Marker({ element: button }).setLngLat(point).addTo(map);
    });
    return () => markers.forEach((marker) => marker.remove());
  }, [renderer, stations, onSelect, onBrowse, detailsId]);
}

const freshnessLabels = {
  fresh: "Current inventory",
  stale: "Stale inventory",
  expired: "Inventory expired",
  unavailable: "Inventory unavailable",
  failed: "Inventory unavailable",
  not_integrated: "Inventory not yet supported",
  unknown: "Inventory coverage unknown",
};
const dateFormat = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

export function InventoryPanel({
  view,
  visibleStations,
  retry,
  selected,
  onSelect,
  browse,
}: {
  view: InventoryView;
  visibleStations: readonly InventoryMapStation[];
  retry: () => void;
  selected?: InventoryStation;
  onSelect: (station: InventoryStation) => void;
  browse: number;
}) {
  const list = useRef<HTMLDetailsElement>(null);
  const picker = useRef<HTMLSelectElement>(null);
  useEffect(() => {
    if (browse && list.current) {
      list.current.open = true;
      picker.current?.focus();
    }
  }, [browse]);

  if (view.status === "moving") return null;
  if (view.status === "zoom")
    return (
      <p role="status" className="text-sm text-ink-muted">
        Zoom in to discover provider stations.
      </p>
    );
  if (view.status === "outside")
    return (
      <p role="status" className="text-sm text-ink-muted">
        This map area is outside the Great Britain inventory search area.
      </p>
    );
  if (view.status === "loading")
    return <LoadingState label="Finding provider stations" lines={1} className="py-2" />;
  if (view.status === "unavailable")
    return (
      <ErrorState
        title="Provider inventory unavailable"
        action={<Button onClick={retry}>Retry station discovery</Button>}
      />
    );
  if (view.status !== "ready") return null;

  const { stations, coverage, truncated } = view.data;
  return (
    <div className="space-y-2 text-sm">
      {stations.length === 0 ? (
        <EmptyState title="No stations from available inventories in this map area" />
      ) : visibleStations.length === 0 ? (
        <EmptyState title="No provider stations match the map filters" />
      ) : (
        <>
          <p role="status">
            {visibleStations.length} provider{" "}
            {visibleStations.length === 1 ? "station" : "stations"} shown.
          </p>
          <details ref={list}>
            <summary className="cursor-pointer py-2 underline">
              Browse stations in this map area
            </summary>
            <label className="flex flex-col gap-1">
              Provider station
              <select
                ref={picker}
                className="min-h-11 w-full rounded-md border border-line-input bg-surface px-2"
                value={
                  visibleStations.some(({ key }) => key === selected?.key) ? selected?.key : ""
                }
                onChange={(event) => {
                  const station = visibleStations.find(({ key }) => key === event.target.value);
                  if (station) onSelect(station);
                }}
              >
                <option value="" disabled>
                  Select a station
                </option>
                {visibleStations.map((station) => (
                  <option key={station.key} value={station.key}>
                    {station.name}
                    {station.watercourse ? ` · ${station.watercourse}` : ""}
                    {" · "}
                    {stationAvailability[station.marker.availability]}
                  </option>
                ))}
              </select>
            </label>
          </details>
        </>
      )}
      {truncated ? <p>Results are limited. Zoom in to see more stations.</p> : null}
      <details className="text-ink-muted">
        <summary className="cursor-pointer py-2 underline">Provider inventory coverage</summary>
        <p>The inventory covers part of Great Britain’s monitoring network.</p>
        <ul className="mt-1 space-y-1">
          {coverage.map((entry) => (
            <li key={entry.providerId}>
              {entry.label} · {freshnessLabels[entry.status]}
              {entry.lastVerifiedAt
                ? ` · Verified ${dateFormat.format(new Date(entry.lastVerifiedAt))} UTC`
                : null}
              {entry.unpositioned
                ? ` · ${entry.unpositioned} stations lack verified positions`
                : null}
              {entry.measureDetailPartial ? " · Measurement listings are incomplete" : null}
            </li>
          ))}
        </ul>
      </details>
      {coverage.some(
        ({ status }) =>
          status === "stale" ||
          status === "expired" ||
          status === "unavailable" ||
          status === "failed" ||
          status === "unknown",
      ) ? (
        <p className="text-ink-muted">
          Some provider inventories are out of date or unavailable. See coverage for details.
        </p>
      ) : null}
      {coverage.map(
        (entry) =>
          entry.attribution && (
            <p key={entry.providerId} className="text-ink-muted">
              {entry.attribution}
            </p>
          ),
      )}
    </div>
  );
}
