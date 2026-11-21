"use client";

import "maplibre-gl/dist/maplibre-gl.css";
import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import type { Map as MapLibreMap } from "maplibre-gl";
import { ErrorState } from "@/components/states";
import type { StationGroup } from "@/lib/discovery";
import { measurementPath, parameterLabel } from "@/lib/labels";
import type { PublicMeasurement } from "@/lib/rdp/public";

type LocatedStation = StationGroup &
  Pick<PublicMeasurement, "locationEvidence" | "source"> & {
    position: NonNullable<PublicMeasurement["position"]>;
  };

export function StationMap({ stations }: { stations: readonly LocatedStation[] }) {
  const container = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const detailsId = useId();
  const [renderer, setRenderer] = useState<{
    map: MapLibreMap;
    library: typeof import("maplibre-gl");
  }>();
  const [status, setStatus] = useState<"loading" | "ready" | "tiles" | "unavailable">("loading");
  const [selectedId, select] = useState<string>();
  const selected = stations.find((station) => station.stationId === selectedId);

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
          if (active) setStatus((current) => (current === "loading" ? "ready" : current));
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
      map?.remove();
    };
  }, []);

  const unavailable = status === "unavailable";
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
      <div
        ref={container}
        role="region"
        aria-label="Station locations"
        hidden={unavailable}
        className="h-64 border-t border-line bg-canvas sm:h-80"
      />
      {unavailable ? (
        <ErrorState title="Station map unavailable">Browse the measurements below.</ErrorState>
      ) : status === "tiles" || status === "loading" ? (
        <p role="status" className="px-5 py-2 text-sm text-ink-muted sm:px-6">
          {status === "loading" ? "Loading map…" : "Some basemap details could not load."}
        </p>
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
          </div>
        ) : null}
      </div>
    </>
  );
}
