import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MeasurementExplorer } from "@/components/measurement-explorer";
import { createRdpClient } from "@/lib/rdp/client";
import { createFixtureTransport } from "@/lib/rdp/fixture";
import { GB_BOUNDS, readMapContext } from "@/lib/map-context";
import type { OverviewItem } from "@/lib/overview";
import { publicMeasurements, toPublicLatest, toPublicMeasurement } from "@/lib/rdp/public";
import type { PublicUpstreamMeasurements } from "@/lib/rdp/upstream-measurements";

const mapMock = vi.hoisted(() => ({
  fail: false,
  events: new EventTarget(),
  create: vi.fn(),
  fitBounds: vi.fn(),
  setLngLat: vi.fn(),
  setData: vi.fn(),
  addSource: vi.fn(),
  addLayer: vi.fn(),
}));

vi.mock("maplibre-gl", () => ({
  setWorkerUrl: vi.fn(),
  Map: class {
    constructor(readonly options: { container: HTMLElement }) {
      mapMock.create(options);
      if (mapMock.fail) throw new Error("WebGL unavailable");
      options.container.classList.add("maplibregl-map");
    }
    touchZoomRotate = { disableRotation: vi.fn() };
    addControl = vi.fn();
    fitBounds = mapMock.fitBounds;
    remove = vi.fn();
    on = mapMock.events.addEventListener.bind(mapMock.events);
    off = mapMock.events.removeEventListener.bind(mapMock.events);
    once = (name: string, handler: EventListener) =>
      mapMock.events.addEventListener(name, handler, { once: true });
    getContainer = () => this.options.container;
    getCenter = () => ({ wrap: () => ({ lng: -1.3, lat: 52.8 }) });
    addLayer = mapMock.addLayer;
    addSource = mapMock.addSource;
    getSource = () =>
      mapMock.addSource.mock.calls.length ? { setData: mapMock.setData } : undefined;
  },
  NavigationControl: class {},
  LngLatBounds: class {
    extend = vi.fn();
  },
  Marker: class {
    constructor(readonly options: { element: HTMLElement }) {
      options.element.classList.add("maplibregl-marker");
    }
    setLngLat(point: [number, number]) {
      mapMock.setLngLat(point);
      return this;
    }
    addTo(map: { options: { container: HTMLElement } }) {
      map.options.container.append(this.options.element);
      return this;
    }
    remove() {
      this.options.element.remove();
    }
  },
}));

async function fixtureItems(): Promise<OverviewItem[]> {
  const rdp = createRdpClient({
    mode: "fixture",
    transport: createFixtureTransport(() => Date.parse("2026-11-19T12:07:00Z")),
    log: () => undefined,
  });
  const measures = publicMeasurements((await rdp.listMeasurements()).measurements);
  const latest = await rdp.getLatest(measures.map((m) => m.measurementId));
  return measures.map((m) => ({
    measurement: toPublicMeasurement(m),
    latest: toPublicLatest(latest.items.find((item) => item.measurementId === m.measurementId)!),
  }));
}

const stationList = () => within(screen.getByRole("region", { name: "Stations" }));
const links = () =>
  stationList()
    .queryAllByRole("link")
    .map((link) => link.textContent);
const enableStations = async (user: ReturnType<typeof userEvent.setup>) =>
  user.click(await screen.findByRole("button", { name: "Published stations", pressed: false }));

function mapClick(target: HTMLElement, lng = -1.25, lat = 52.5) {
  act(() => {
    mapMock.events.dispatchEvent(
      Object.assign(new Event("click"), {
        lngLat: { wrap: () => ({ lng, lat }) },
        originalEvent: { target },
      }),
    );
  });
}

const traceRelease = { releaseId: "test-network", version: "0123456789abcdef".repeat(4) };
const currentTraceData = () =>
  mapMock.setData.mock.lastCall?.[0] ?? mapMock.addSource.mock.lastCall?.[1].data;
const traceKinds = () =>
  currentTraceData()?.features.map(
    (feature: { properties: { kind: string } }) => feature.properties.kind,
  );
const traceLine = {
  type: "LineString",
  coordinates: [
    [-1.32, 52.86],
    [-1.3, 52.88],
  ],
};
const polygon = [
  [
    [-1.32, 52.86],
    [-1.2, 52.8],
    [-1.3, 52.7],
    [-1.32, 52.86],
  ],
];
const publishedCatchment = {
  status: "published",
  geometry: { type: "Polygon", coordinates: polygon },
  areaKm2: 12.5,
  pourPointOffsetM: 25.5,
  sourceNetworkRelease: "ORN v2.0 GeoPackage (2025-03)",
};
const matchedTrace = (direction: string) => ({
  matchStatus: "Matched",
  release: traceRelease,
  snappedSample: { position: [-1.32, 52.86], snapOffsetM: 18 },
  route: { direction, completeness: "incomplete" },
  geometry: traceLine,
  attribution: "Synthetic network attribution",
});

const catchmentTrace = () =>
  Response.json({ data: { ...matchedTrace("upstream"), catchment: publishedCatchment } });

function catchmentResults(stations: OverviewItem["measurement"][][] = [], uncertain = false) {
  return Response.json({
    data: {
      status: "available",
      release: traceRelease,
      matchStatus: "Matched",
      catchment: { id: "test-catchment", areaKm2: 12.5, pourPointOffsetM: 43.5 },
      networkCoverage: { completeness: uncertain ? "incomplete" : "complete" },
      meta: {
        scope: "published_rainfall_level_flow",
        retrievedAt: "2026-11-19T12:07:00Z",
        complete: !uncertain,
        counts: {
          withinCatchment: stations.length,
          outside: 0,
          unknown: uncertain ? 1 : 0,
          ambiguous: 0,
          nearBoundary: uncertain ? 1 : 0,
        },
      },
      data: stations.map((measurements) => ({
        geographicRelationship: "within_catchment",
        measurements: measurements.map((measurement) => ({
          ...measurement,
          networkRelationship:
            measurement.parameter === "rainfall" ? "not_applicable" : "not_assessed",
        })),
      })),
    } satisfies PublicUpstreamMeasurements,
  });
}

describe("measurement explorer", () => {
  let items: OverviewItem[];
  beforeEach(async () => {
    window.history.replaceState(null, "", "/");
    items = await fixtureItems();
    mapMock.fail = false;
    mapMock.events = new EventTarget();
    mapMock.create.mockClear();
    mapMock.fitBounds.mockClear();
    mapMock.setLngLat.mockClear();
    mapMock.setData.mockClear();
    mapMock.addSource.mockClear();
    mapMock.addLayer.mockClear();
  });
  afterEach(() => vi.unstubAllGlobals());

  function addPublishedPositions() {
    // Shardlow and Kegworth from the RDP #129 catalogue example.
    for (const { measurement } of items) {
      if (measurement.measurementId === "ea-shardlow-level") {
        measurement.position = { longitude: -1.335368, latitude: 52.865431, precisionMetres: 10 };
        measurement.watercourseName = "River Trent";
        measurement.locationEvidence =
          "https://environment.data.gov.uk/flood-monitoring/id/stations/4007";
      }
      if (measurement.name === "Kegworth") {
        measurement.position = { longitude: -1.273539, latitude: 52.831898, precisionMetres: 10 };
        measurement.watercourseName = "River Soar";
      }
    }
  }

  it("starts with just the GB basemap and traces an explicit point when no stations are published", async () => {
    const user = userEvent.setup();
    const fetchRiver = vi.fn<typeof fetch>().mockResolvedValueOnce(catchmentTrace());
    vi.stubGlobal("fetch", fetchRiver);
    render(<MeasurementExplorer items={[]} initialQuery={{ q: "", type: null }} />);
    const map = screen.getByRole("region", { name: "River map" });
    const trace = await screen.findByRole("button", { name: "Trace river" });
    act(() => mapMock.events.dispatchEvent(new Event("load")));
    act(() => mapMock.events.dispatchEvent(new Event("moveend")));
    expect(mapMock.create).toHaveBeenCalledWith(expect.objectContaining({ bounds: GB_BOUNDS }));
    expect(mapMock.addSource).not.toHaveBeenCalled();
    expect(fetchRiver).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Published stations" })).not.toBeInTheDocument();
    expect(stationList().getByText("No measurements to show yet")).toBeInTheDocument();
    await user.click(screen.getByText("Map sources and coverage"));
    expect(
      screen.getByText(/Drainage area overview boundaries are currently unavailable/),
    ).toBeVisible();

    await user.click(trace);
    mapClick(map);
    expect(await screen.findByText(/Selected point’s modelled catchment/)).toBeInTheDocument();
    expect(fetchRiver).toHaveBeenCalledTimes(1);
    expect(traceKinds()).toContain("catchment");
  });

  it.each([
    { lon: "-1.3", lat: "52.8", zoom: "8.5", camera: { center: [-1.3, 52.8], zoom: 8.5 } },
    { lon: "-1.3", lat: "52.8", camera: { center: [-1.3, 52.8], zoom: 12 } },
    { lon: ["-1.3", "0"], lat: "52.8", camera: { bounds: GB_BOUNDS } },
    { lon: "-1.3", lat: "91", zoom: "8.5", camera: { bounds: GB_BOUNDS } },
    { lon: "-1.3", lat: "52.8", zoom: "99", camera: { bounds: GB_BOUNDS } },
  ])("validates initial camera parameters $lon / $lat / $zoom", async ({ camera, ...params }) => {
    render(
      <MeasurementExplorer
        items={[]}
        initialQuery={{ q: "", type: null }}
        initialMapContext={readMapContext(params)}
      />,
    );
    await screen.findByRole("button", { name: "Trace river" });
    expect(mapMock.create).toHaveBeenCalledWith(expect.objectContaining(camera));
  });

  it("opens a verified station even when the initial list filter excludes it", async () => {
    addPublishedPositions();
    const station = items.find(
      ({ measurement }) => measurement.measurementId === "ea-shardlow-level",
    )!.measurement.stationId;
    window.history.replaceState(null, "", "/?q=stone");
    render(
      <MeasurementExplorer
        items={items}
        initialQuery={{ q: "stone", type: null }}
        initialMapContext={readMapContext({ station })}
      />,
    );
    expect(
      await screen.findByRole("button", { name: "Published stations", pressed: true }),
    ).toBeInTheDocument();
    expect(mapMock.create).toHaveBeenCalledWith(
      expect.objectContaining({ center: [-1.335368, 52.865431], zoom: 12 }),
    );
    expect(screen.getByRole("heading", { name: "Shardlow" })).toBeInTheDocument();
    expect(stationList().getByRole("link", { name: "Stone Rainfall" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Shardlow" })).not.toHaveFocus();
  });

  it("starts with the GB map and keeps selected station details and viewport through filters", async () => {
    addPublishedPositions();
    const user = userEvent.setup();
    render(<MeasurementExplorer items={items} initialQuery={{ q: "", type: null }} />);
    const mapRegion = screen.getByRole("region", { name: "River map" });
    const map = within(mapRegion);
    const layer = await screen.findByRole("button", { name: "Published stations", pressed: false });
    expect(map.queryByRole("button", { name: "Shardlow" })).not.toBeInTheDocument();
    await user.click(layer);
    const shardlow = await map.findByRole("button", { name: "Shardlow" });
    expect(map.getAllByRole("button")).toHaveLength(2);
    expect(mapMock.create).toHaveBeenCalledWith(expect.objectContaining({ bounds: GB_BOUNDS }));
    expect(mapMock.setLngLat).toHaveBeenCalledWith([-1.335368, 52.865431]);
    expect(screen.getByRole("link", { name: "Stone Rainfall" })).toBeInTheDocument();

    shardlow.focus();
    await user.keyboard("{Enter}");
    const details = within(document.getElementById(shardlow.getAttribute("aria-controls")!)!);
    expect(details.getByRole("heading", { name: "Shardlow" })).toHaveFocus();
    expect(details.getByText("River Trent")).toBeInTheDocument();
    expect(details.getByText(/10 m resolution/)).toBeInTheDocument();
    expect(details.getByRole("link", { name: "Water level" })).toHaveAttribute(
      "href",
      "/measurements/ea-shardlow-level",
    );
    expect(details.getByRole("link", { name: "Flow" })).toHaveAttribute(
      "href",
      "/measurements/ea-shardlow-flow",
    );
    expect(
      details.getByRole("link", { name: "Environment Agency station record" }),
    ).toHaveAttribute("href", "https://environment.data.gov.uk/flood-monitoring/id/stations/4007");
    await user.tab();
    expect(details.getByRole("link", { name: "Water level" })).toHaveFocus();

    await user.click(screen.getByRole("radio", { name: "Flow" }));
    expect(map.getByRole("button", { name: "Shardlow" })).toBeInTheDocument();
    expect(map.queryByRole("button", { name: "Kegworth" })).not.toBeInTheDocument();
    expect(details.getByRole("link", { name: "Water level" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Shardlow Flow" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Shardlow Water level" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: "All" }));
    await user.type(screen.getByRole("searchbox"), "stone");
    expect(screen.getByText("No matching stations have verified locations")).toBeInTheDocument();
    expect(map.getAllByRole("button")).toHaveLength(1);
    const list = screen.getByRole("region", { name: "Stations" });
    expect(within(list).getByRole("link", { name: "Stone Rainfall" })).toBeInTheDocument();

    await user.clear(screen.getByRole("searchbox"));
    expect(screen.getByRole("region", { name: "River map" })).toBe(mapRegion);
    expect(map.getAllByRole("button")).toHaveLength(2);
    expect(details.getByRole("heading", { name: "Shardlow" })).toBeInTheDocument();
    await user.click(layer);
    expect(map.queryByRole("button", { name: "Shardlow" })).not.toBeInTheDocument();
    expect(details.getByRole("heading", { name: "Shardlow" })).toBeInTheDocument();
    expect(mapMock.create).toHaveBeenCalledTimes(1);
    expect(mapMock.fitBounds).not.toHaveBeenCalled();
  });

  it("shares a comparison between a marker and the accessible list and restores it from the URL", async () => {
    addPublishedPositions();
    const user = userEvent.setup();
    const explorer = <MeasurementExplorer items={items} initialQuery={{ q: "", type: null }} />;
    render(explorer);
    const map = within(screen.getByRole("region", { name: "River map" }));
    await enableStations(user);
    const marker = await map.findByRole("button", { name: "Shardlow" });
    await user.click(marker);
    const details = within(document.getElementById(marker.getAttribute("aria-controls")!)!);
    const list = within(screen.getByRole("region", { name: "Stations" }));
    const selection = within(screen.getByRole("region", { name: "Comparison selection" }));

    await user.click(
      details.getByRole("button", { name: /^Add to comparison: Shardlow · Water level/ }),
    );
    expect(selection.queryByRole("link")).not.toBeInTheDocument();
    const duplicate = list.getByRole("button", {
      name: /^Added to comparison: Shardlow · Water level/,
    });
    expect(duplicate).toHaveAttribute("aria-disabled", "true");
    await user.click(duplicate);
    expect(selection.getAllByRole("listitem")).toHaveLength(1);

    await user.click(details.getByRole("button", { name: /^Add to comparison: Shardlow · Flow/ }));
    const rainfall = list.getByRole("button", { name: /^Needs a third axis: Stone · Rainfall/ });
    expect(rainfall).toHaveAttribute("aria-disabled", "true");
    await user.click(rainfall);
    expect(selection.getAllByRole("listitem")).toHaveLength(2);
    await user.click(selection.getByRole("button", { name: /^Remove Shardlow · Flow/ }));
    await user.click(list.getByRole("button", { name: /^Add to comparison: Stone · Rainfall/ }));
    const query = "?a=ea-shardlow-level&b=ea-stone-rainfall";
    expect(selection.getByRole("link", { name: "Compare selected measurements" })).toHaveAttribute(
      "href",
      `/compare${query}`,
    );
    expect(window.location.search).toBe(query);

    await user.type(screen.getByRole("searchbox"), "stone");
    expect(selection.getAllByRole("listitem")).toHaveLength(2);
    cleanup();
    render(explorer);
    expect(screen.getByRole("searchbox")).toHaveValue("stone");
    expect(screen.getByRole("link", { name: "Compare selected measurements" })).toHaveAttribute(
      "href",
      `/compare${query}`,
    );
  });

  it("accepts four compatible IDs and blocks a fifth until one is removed", async () => {
    const levels = items.filter(({ measurement }) => measurement.parameter === "level");
    for (const { measurement } of levels) {
      measurement.datum = "AOD";
      measurement.unit = "mAOD";
    }
    const user = userEvent.setup();
    render(<MeasurementExplorer items={levels} initialQuery={{ q: "", type: null }} />);
    const list = within(screen.getByRole("region", { name: "Stations" }));
    for (const button of list.getAllByRole("button", { name: /^Add to comparison/ }).slice(0, 4)) {
      await user.click(button);
    }
    const selection = within(screen.getByRole("region", { name: "Comparison selection" }));
    const fifth = list.getByRole("button", { name: /^Four measurements selected/ });
    expect(fifth).toHaveAttribute("aria-disabled", "true");
    await user.click(fifth);
    expect(selection.getAllByRole("listitem")).toHaveLength(4);
    const href = selection.getByRole("link").getAttribute("href");
    expect(href).toBe(
      "/compare?" +
        new URLSearchParams(
          Object.fromEntries(
            levels
              .slice(0, 4)
              .map(({ measurement }, index) => ["abcd"[index], measurement.measurementId]),
          ),
        ),
    );
    await user.click(selection.getAllByRole("button", { name: /^Remove/ })[0]);
    expect(fifth).toHaveAttribute("aria-disabled", "false");
    await user.click(fifth);
    expect(selection.getAllByRole("listitem")).toHaveLength(4);
  });

  it("opens the GB map even when the URL filters out all verified locations", async () => {
    addPublishedPositions();
    window.history.replaceState(null, "", "/?q=stone");
    const user = userEvent.setup();
    render(<MeasurementExplorer items={items} initialQuery={{ q: "stone", type: null }} />);
    expect(screen.getByRole("link", { name: "Stone Rainfall" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "River map" })).toBeInTheDocument();
    await enableStations(user);
    expect(mapMock.create).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Shardlow" })).not.toBeInTheDocument();
    await user.clear(screen.getByRole("searchbox"));
    expect(await screen.findByRole("button", { name: "Shardlow" })).toBeInTheDocument();
  });

  it.each(["WebGL", "tiles"])("keeps discovery usable when %s is unavailable", async (failure) => {
    addPublishedPositions();
    mapMock.fail = failure === "WebGL";
    const user = userEvent.setup();
    render(<MeasurementExplorer items={items} initialQuery={{ q: "", type: null }} />);
    if (failure === "tiles") {
      await enableStations(user);
      const marker = await screen.findByRole("button", { name: "Shardlow" });
      act(() => mapMock.events.dispatchEvent(new Event("error")));
      expect(screen.getByText("Some basemap details could not load.")).toBeInTheDocument();
      expect(marker).toBeInTheDocument();
    } else {
      expect(await screen.findByRole("alert")).toHaveTextContent("River map unavailable");
    }

    await user.type(screen.getByRole("searchbox"), "kegw");
    expect(screen.getByRole("link", { name: "Kegworth Water level" })).toHaveAttribute(
      "href",
      "/measurements/ea-kegworth-level",
    );
    expect(screen.queryByRole("link", { name: "Shardlow Flow" })).not.toBeInTheDocument();
  });

  it("traces only in trace mode and keeps station markers available for browsing", async () => {
    addPublishedPositions();
    const user = userEvent.setup();
    const fetchTrace = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchTrace);
    const route = { direction: "downstream", completeness: "incomplete" };
    const geometry = {
      type: "MultiLineString",
      coordinates: [
        [
          [-1.32, 52.86],
          [-1.3, 52.88],
        ],
        [
          [-1.2, 52.9],
          [-1.1, 52.92],
        ],
      ],
    };
    const matched = {
      matchStatus: "Matched",
      release: traceRelease,
      snappedSample: { position: [-1.32, 52.86], snapOffsetM: 17.6 },
      route,
      attribution: "Synthetic network attribution",
      geometry,
    };
    fetchTrace.mockResolvedValueOnce(Response.json({ data: matched }));
    fetchTrace.mockResolvedValueOnce(
      Response.json({
        data: {
          ...matched,
          route: { ...route, direction: "upstream" },
          geometry: { type: "LineString", coordinates: geometry.coordinates[0] },
        },
      }),
    );
    render(<MeasurementExplorer items={items} initialQuery={{ q: "", type: null }} />);
    const map = screen.getByRole("region", { name: "River map" });
    await enableStations(user);
    const marker = await within(map).findByRole("button", { name: "Shardlow" });
    act(() => mapMock.events.dispatchEvent(new Event("load")));
    mapClick(map);
    expect(fetchTrace).not.toHaveBeenCalled();

    const mode = screen.getByRole("button", { name: "Trace river", pressed: false });
    expect(map).toHaveClass("maplibregl-map");
    await user.click(mode);
    await user.selectOptions(screen.getByRole("combobox", { name: "Direction" }), "downstream");
    expect(mode).toHaveAttribute("aria-pressed", "true");
    expect(map).toHaveClass("maplibregl-map");
    marker.focus();
    await user.keyboard("{Enter}");
    mapClick(marker);
    expect(fetchTrace).not.toHaveBeenCalled();
    const details = within(document.getElementById(marker.getAttribute("aria-controls")!)!);
    expect(details.queryByRole("button", { name: /^Add to comparison/ })).not.toBeInTheDocument();
    const station = screen.getByRole("button", { name: "Trace from Shardlow" });
    station.focus();
    await user.keyboard("{Enter}");
    expect(fetchTrace.mock.calls[0][0]).toBe(
      "/api/river/trace?lon=-1.33536800&lat=52.86543100&direction=downstream",
    );
    expect(await screen.findByText(/downstream route incomplete/)).toBeInTheDocument();
    expect(screen.getByText(/Snapped sample · 18 m away/)).toBeInTheDocument();
    expect(
      screen.getByText(/test-network · 0123456789ab · Synthetic network attribution/),
    ).toBeInTheDocument();
    expect(currentTraceData()).toEqual({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { kind: "selected" },
          geometry: { type: "Point", coordinates: [-1.335368, 52.865431] },
        },
        {
          type: "Feature",
          properties: { kind: "snapped" },
          geometry: { type: "Point", coordinates: [-1.32, 52.86] },
        },
        { type: "Feature", properties: { kind: "downstream" }, geometry },
      ],
    });

    await user.selectOptions(screen.getByRole("combobox", { name: "Direction" }), "upstream");
    expect(fetchTrace.mock.calls[1][0]).toBe(
      "/api/river/trace?lon=-1.33536800&lat=52.86543100&direction=upstream",
    );
    expect(await screen.findByText(/upstream route incomplete/)).toBeInTheDocument();
    expect(mapMock.setData.mock.lastCall?.[0].features[2].geometry.type).toBe("LineString");
    expect(mapMock.addSource).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Clear trace" }));
    expect(mapMock.setData).toHaveBeenLastCalledWith({ type: "FeatureCollection", features: [] });
    expect(screen.queryByText(/upstream route incomplete/)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Shardlow Flow" })).toBeInTheDocument();
    await user.click(mode);
    expect(details.getAllByRole("button", { name: /^Add to comparison/ })).toHaveLength(2);
    expect(map).toHaveClass("maplibregl-map");
    mapClick(map);
    expect(fetchTrace).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["Polygon", polygon, 0],
    ["MultiPolygon", [polygon], 25.5],
  ])(
    "toggles a %s separately from both traced directions and preserves the comparison",
    async (type, coordinates, pourPointOffsetM) => {
      addPublishedPositions();
      const user = userEvent.setup();
      const geometry = { type, coordinates };
      const fetchTrace = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json({ data: matchedTrace("downstream") }))
        .mockResolvedValueOnce(
          Response.json({
            data: {
              ...matchedTrace("upstream"),
              catchment: { ...publishedCatchment, geometry, pourPointOffsetM },
            },
          }),
        )
        .mockResolvedValueOnce(
          Response.json({
            data: { ...matchedTrace("upstream"), catchment: publishedCatchment },
          }),
        );
      vi.stubGlobal("fetch", fetchTrace);
      render(<MeasurementExplorer items={items} initialQuery={{ q: "", type: null }} />);
      await enableStations(user);
      await user.click(await screen.findByRole("button", { name: "Shardlow" }));
      act(() => mapMock.events.dispatchEvent(new Event("load")));
      const details = within(
        document.getElementById(
          screen.getByRole("button", { name: "Shardlow" }).getAttribute("aria-controls")!,
        )!,
      );
      for (const button of details.getAllByRole("button", { name: /^Add to comparison/ })) {
        await user.click(button);
      }
      const compare = screen.getByRole("link", { name: "Compare selected measurements" });
      const comparisonUrl = compare.getAttribute("href");
      await user.click(screen.getByRole("button", { name: "Trace river" }));
      const direction = screen.getByRole("combobox", { name: "Direction" });
      await user.selectOptions(direction, "downstream");
      const map = screen.getByRole("region", { name: "River map" });
      mapClick(map);
      expect(await screen.findByRole("checkbox", { name: "Downstream route" })).toBeChecked();
      await user.selectOptions(direction, "upstream");
      await screen.findByRole("button", { name: "Hide catchment" });
      expect(currentTraceData().features).toContainEqual({
        type: "Feature",
        properties: { kind: "catchment" },
        geometry,
      });
      expect(mapMock.addLayer).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "fill",
          source: "river-trace",
          filter: ["==", ["get", "kind"], "catchment"],
          paint: expect.objectContaining({ "fill-opacity": 0.15 }),
        }),
      );
      expect(mapMock.addLayer).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "line",
          source: "river-trace",
          filter: ["==", ["get", "kind"], "catchment"],
          paint: expect.objectContaining({ "line-dasharray": [3, 2] }),
        }),
      );
      expect(
        screen.getByText("Selected point’s modelled catchment · 12.5 km²"),
      ).toBeInTheDocument();
      expect(screen.getByText(/ORN v2.0 GeoPackage/)).toBeInTheDocument();
      expect(screen.getByText(/separate river-network evidence/)).toBeInTheDocument();
      if (pourPointOffsetM) {
        expect(
          screen.getByText(/25.5 m downstream of the snapped river sample/),
        ).toBeInTheDocument();
        expect(traceKinds()).not.toContain("pour-point");
      } else {
        expect(
          screen.getByText(/Catchment pour point · at the snapped sample/),
        ).toBeInTheDocument();
        expect(currentTraceData().features).toContainEqual({
          type: "Feature",
          properties: { kind: "pour-point" },
          geometry: { type: "Point", coordinates: [-1.32, 52.86] },
        });
      }
      const upstream = screen.getByRole("checkbox", { name: "Upstream reaches" });
      const downstream = screen.getByRole("checkbox", { name: "Downstream route" });
      await user.click(upstream);
      expect(traceKinds()).not.toContain("upstream");
      expect(traceKinds()).toContain("downstream");
      await user.click(downstream);
      expect(traceKinds()).not.toContain("downstream");
      expect(traceKinds()).toContain("catchment");
      await user.click(upstream);
      await user.click(screen.getByRole("button", { name: "Hide catchment" }));
      expect(traceKinds()).toEqual(["selected", "snapped", "upstream"]);
      await user.click(screen.getByRole("button", { name: "Show catchment" }));
      await user.selectOptions(direction, "downstream");
      expect(traceKinds()).toContain("catchment");
      expect(downstream).not.toBeChecked();
      expect(fetchTrace).toHaveBeenCalledTimes(2);
      await user.click(screen.getByRole("button", { name: "Clear trace" }));
      expect(traceKinds()).toEqual([]);
      expect(details.getByRole("heading", { name: "Shardlow" })).toBeInTheDocument();
      expect(compare).toHaveAttribute("href", comparisonUrl);

      await user.selectOptions(direction, "upstream");
      mapClick(map, -1.2, 52.6);
      expect(await screen.findByRole("button", { name: "Hide catchment" })).toBeInTheDocument();
      expect(traceKinds()).toContain("catchment");
    },
  );

  it.each([
    [
      "unmatched",
      { matchStatus: "NoMatch", route: null, snappedSample: null, geometry: null, catchment: null },
      /No river matched/,
    ],
    [
      "unavailable",
      { catchment: { ...publishedCatchment, status: "unavailable", geometry: null } },
      /Catchment boundary unavailable/,
    ],
    [
      "not loaded",
      { catchment: { ...publishedCatchment, status: "not-loaded", geometry: null } },
      /Catchment boundary unavailable/,
    ],
    [
      "invalid geometry withheld",
      { catchment: { ...publishedCatchment, geometry: null } },
      /Catchment boundary unavailable/,
    ],
    [
      "unapproved source withheld",
      { catchment: { ...publishedCatchment, geometry: null, sourceNetworkRelease: null } },
      /Catchment boundary unavailable/,
    ],
    ["oversized", null, /River trace is too large to display/],
  ])("offers no catchment when the result is %s", async (scenario, data, message) => {
    addPublishedPositions();
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json({ data: matchedTrace("downstream") }))
        .mockResolvedValueOnce(
          data
            ? Response.json({ data: { ...matchedTrace("upstream"), ...data } })
            : new Response(null, { status: 413 }),
        ),
    );
    render(<MeasurementExplorer items={items} initialQuery={{ q: "", type: null }} />);
    await user.click(await screen.findByRole("button", { name: "Trace river" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Direction" }), "downstream");
    act(() => mapMock.events.dispatchEvent(new Event("load")));
    mapClick(screen.getByRole("region", { name: "River map" }));
    await screen.findByRole("checkbox", { name: "Downstream route" });
    await user.selectOptions(screen.getByRole("combobox", { name: "Direction" }), "upstream");
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Find measurements" })).not.toBeInTheDocument();
    if (scenario === "unmatched") {
      expect(traceKinds()).toEqual(["selected"]);
    } else {
      expect(traceKinds()).toContain("downstream");
      expect(screen.getByText(/Synthetic network attribution/)).toBeInTheDocument();
    }
    expect(traceKinds()).not.toContain("catchment");
  });

  it("finds published catchment stations on demand and uses the shared comparison", async () => {
    window.history.replaceState(null, "", "/?q=shardlow");
    addPublishedPositions();
    const user = userEvent.setup();
    const shardlow = items
      .map(({ measurement }) => measurement)
      .filter(({ name }) => name === "Shardlow");
    shardlow[1].position = shardlow[0].position;
    const stone = items.find(
      ({ measurement }) => measurement.parameter === "rainfall",
    )!.measurement;
    stone.position = { longitude: -1.28, latitude: 52.81, precisionMetres: 10 };
    const fetchRiver = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(catchmentTrace())
      .mockResolvedValueOnce(catchmentResults([shardlow, [stone]]));
    vi.stubGlobal("fetch", fetchRiver);
    render(<MeasurementExplorer items={items} initialQuery={{ q: "shardlow", type: null }} />);
    await user.click(await screen.findByRole("button", { name: "Trace river" }));
    act(() => mapMock.events.dispatchEvent(new Event("load")));
    const map = screen.getByRole("region", { name: "River map" });
    mapClick(map);

    const panel = within(await screen.findByRole("region", { name: "Catchment measurements" }));
    expect(traceKinds()).toEqual(expect.arrayContaining(["selected", "catchment"]));
    expect(fetchRiver).toHaveBeenCalledTimes(1);
    expect(within(map).queryByRole("button", { name: /Stone/ })).not.toBeInTheDocument();
    await user.click(panel.getByRole("button", { name: "Find measurements" }));
    expect(fetchRiver.mock.calls[1][0]).toBe(
      "/api/river/upstream-measurements?lon=-1.25000000&lat=52.50000000&release=0123456789abcdef",
    );
    const list = within(
      await panel.findByRole("list", { name: "Stations inside the modelled catchment" }),
    );
    expect(
      list.getAllByRole("heading", { level: 3 }).map(({ textContent }) => textContent),
    ).toEqual(["Shardlow", "Stone"]);
    expect(list.getByRole("link", { name: /^Flow/ })).toHaveAttribute(
      "href",
      "/measurements/ea-shardlow-flow",
    );
    expect(
      panel.getByText("Upstream connections for level and flow are unverified."),
    ).toBeInTheDocument();
    expect(within(map).getAllByRole("button")).toHaveLength(2);
    expect(
      within(map).getByRole("button", { name: "Stone, inside the modelled catchment" }),
    ).toBeInTheDocument();
    expect(mapMock.setLngLat).toHaveBeenCalledWith([-1.28, 52.81]);

    const comparison = within(screen.getByRole("region", { name: "Comparison selection" }));
    expect(comparison.queryByRole("list")).not.toBeInTheDocument();
    await user.click(
      list.getByRole("button", { name: /^Add to comparison: Shardlow · Water level/ }),
    );
    await user.click(list.getByRole("button", { name: /^Add to comparison: Stone · Rainfall/ }));
    const flow = list.getByRole("button", { name: /^Needs a third axis: Shardlow · Flow/ });
    expect(flow).toHaveAttribute("aria-disabled", "true");
    await user.click(flow);
    const compare = comparison.getByRole("link", { name: "Compare selected measurements" });
    expect(compare).toHaveAttribute("href", "/compare?a=ea-shardlow-level&b=ea-stone-rainfall");
    await user.click(screen.getByRole("checkbox", { name: "Upstream reaches" }));
    expect(traceKinds()).toEqual(expect.arrayContaining(["selected", "catchment"]));
    await user.click(screen.getByRole("button", { name: "Hide catchment" }));
    expect(compare).toHaveAttribute("href", "/compare?a=ea-shardlow-level&b=ea-stone-rainfall");
    await user.click(comparison.getByRole("button", { name: /^Remove Stone · Rainfall/ }));
    expect(list.getByRole("button", { name: /^Add to comparison: Shardlow · Flow/ })).toBeEnabled();
    expect(fetchRiver).toHaveBeenCalledTimes(2);
  });

  it("ignores a discovery response for an old point and qualifies empty results", async () => {
    addPublishedPositions();
    const user = userEvent.setup();
    let finishFirst!: (response: Response) => void;
    const fetchRiver = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(catchmentTrace())
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishFirst = resolve;
          }),
      )
      .mockResolvedValueOnce(catchmentTrace())
      .mockResolvedValueOnce(catchmentResults([], true));
    vi.stubGlobal("fetch", fetchRiver);
    render(<MeasurementExplorer items={items} initialQuery={{ q: "", type: null }} />);
    await enableStations(user);
    await user.click(await screen.findByRole("button", { name: "Trace river" }));
    const map = screen.getByRole("region", { name: "River map" });
    mapClick(map);
    await user.click(await screen.findByRole("button", { name: "Find measurements" }));
    expect(screen.getByText("Finding measurements")).toBeInTheDocument();
    mapClick(map, -1.2, 52.6);
    expect(fetchRiver.mock.calls[1][1]?.signal?.aborted).toBe(true);
    await user.click(await screen.findByRole("button", { name: "Find measurements" }));
    expect(await screen.findByText("No matching published measurements")).toBeInTheDocument();
    const shardlow = items.find(
      ({ measurement }) => measurement.measurementId === "ea-shardlow-level",
    )!.measurement;
    await act(async () => finishFirst(catchmentResults([[shardlow]])));
    expect(screen.getByText("No matching published measurements")).toBeInTheDocument();
    expect(screen.getByText(/missing or uncertain positions/)).toBeInTheDocument();
    expect(screen.getByText(/near the catchment boundary/)).toBeInTheDocument();
    expect(screen.getByText(/network coverage is incomplete/)).toBeInTheDocument();
    expect(within(map).getByRole("button", { name: "Shardlow" })).toBeInTheDocument();
    expect(
      screen.queryByRole("list", { name: "Stations inside the modelled catchment" }),
    ).not.toBeInTheDocument();
  });

  it.each([200, 410])(
    "clears old catchment evidence when the trace release changes (%s)",
    async (status) => {
      const user = userEvent.setup();
      const nextRelease = { releaseId: "test-network-next", version: "f".repeat(64) };
      const fetchRiver = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(catchmentTrace())
        .mockResolvedValueOnce(
          status === 200
            ? Response.json({ data: { ...matchedTrace("downstream"), release: nextRelease } })
            : new Response(null, { status }),
        );
      vi.stubGlobal("fetch", fetchRiver);
      render(<MeasurementExplorer items={[]} initialQuery={{ q: "", type: null }} />);
      await user.click(await screen.findByRole("button", { name: "Trace river" }));
      act(() => mapMock.events.dispatchEvent(new Event("load")));
      mapClick(screen.getByRole("region", { name: "River map" }));
      await screen.findByRole("button", { name: "Find measurements" });
      expect(traceKinds()).toContain("catchment");

      await user.selectOptions(screen.getByRole("combobox", { name: "Direction" }), "downstream");
      expect(
        await screen.findByText(status === 200 ? /test-network-next/ : /River network updated/),
      ).toBeInTheDocument();
      expect(traceKinds()).not.toContain("catchment");
      expect(screen.queryByRole("button", { name: "Find measurements" })).not.toBeInTheDocument();
      expect(mapMock.fitBounds).not.toHaveBeenCalled();
    },
  );

  it("refreshes the same river point after discovery reports a retired release", async () => {
    addPublishedPositions();
    const user = userEvent.setup();
    const fetchRiver = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(catchmentTrace())
      .mockResolvedValueOnce(new Response(null, { status: 410 }))
      .mockResolvedValueOnce(catchmentTrace());
    vi.stubGlobal("fetch", fetchRiver);
    render(<MeasurementExplorer items={items} initialQuery={{ q: "", type: null }} />);
    await user.click(await screen.findByRole("button", { name: "Trace river" }));
    mapClick(screen.getByRole("region", { name: "River map" }));
    await user.click(await screen.findByRole("button", { name: "Find measurements" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The river network release has changed",
    );
    await user.click(screen.getByRole("button", { name: "Refresh catchment" }));
    expect(await screen.findByRole("button", { name: "Find measurements" })).toBeInTheDocument();
    expect(fetchRiver.mock.calls[2][0]).toBe(fetchRiver.mock.calls[0][0]);
    expect(fetchRiver).toHaveBeenCalledTimes(3);
  });

  it("ignores superseded responses and shows a failing trace without blocking discovery", async () => {
    addPublishedPositions();
    const user = userEvent.setup();
    const fetchTrace = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchTrace);
    let finishFirst!: (response: Response) => void;
    fetchTrace.mockReturnValueOnce(
      new Promise((resolve) => {
        finishFirst = resolve;
      }),
    );
    fetchTrace.mockResolvedValueOnce(new Response(null, { status: 504 }));
    render(<MeasurementExplorer items={items} initialQuery={{ q: "", type: null }} />);
    await user.click(await screen.findByRole("button", { name: "Trace river" }));
    mapClick(screen.getByRole("region", { name: "River map" }));
    expect(fetchTrace.mock.calls[0][0]).toBe(
      "/api/river/trace?lon=-1.25000000&lat=52.50000000&direction=upstream",
    );
    expect(screen.getByText("Tracing river…")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Shardlow Flow" })).toBeInTheDocument();
    await enableStations(user);
    await user.click(await screen.findByRole("button", { name: "Kegworth" }));
    expect(screen.getByRole("button", { name: "Trace from Kegworth" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Trace map centre" }));
    expect(fetchTrace.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(await screen.findByText("River trace timed out")).toBeInTheDocument();
    await act(async () =>
      finishFirst(
        Response.json({
          data: { matchStatus: "NoMatch", release: traceRelease, route: null, geometry: null },
        }),
      ),
    );
    expect(screen.getByText("River trace timed out")).toBeInTheDocument();
    expect(screen.queryByText("No river matched this point.")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Kegworth Water level" })).toBeInTheDocument();
  });

  it.each([
    ["Ambiguous", null, /Several rivers could match/],
    ["NoMatch", null, /No river matched/],
    ["OutOfCoverage", null, /outside the river network coverage/],
    ["Matched", { type: "MultiLineString", coordinates: [] }, /No route geometry to display/],
    ["Matched", null, /No route geometry to display/],
  ])(
    "leaves the map without a route for %s when geometry is %j",
    async (matchStatus, geometry, label) => {
      addPublishedPositions();
      const user = userEvent.setup();
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          Response.json({
            data: {
              matchStatus,
              release: traceRelease,
              geometry,
              snappedSample: null,
              route: null,
              attribution: null,
            },
          }),
        ),
      );
      render(<MeasurementExplorer items={items} initialQuery={{ q: "", type: null }} />);
      await user.click(await screen.findByRole("button", { name: "Trace river" }));
      act(() => mapMock.events.dispatchEvent(new Event("load")));
      mapClick(screen.getByRole("region", { name: "River map" }));
      expect(await screen.findByText(label)).toBeInTheDocument();
      expect(currentTraceData()?.features).toEqual([
        {
          type: "Feature",
          properties: { kind: "selected" },
          geometry: { type: "Point", coordinates: [-1.25, 52.5] },
        },
      ]);
    },
  );

  it("narrows results as the visitor types and announces the count", async () => {
    const user = userEvent.setup();
    render(<MeasurementExplorer items={items} initialQuery={{ q: "", type: null }} />);
    await user.type(screen.getByRole("searchbox", { name: "Search" }), "kegw");
    expect(links()).toEqual(["Kegworth Water level"]);
    // The visible count updates instantly; screen readers hear it once typing pauses.
    expect(
      screen.getByText("1 measurement found", { selector: ":not([role=status])" }),
    ).not.toHaveAttribute("aria-live");
    await waitFor(() =>
      expect(
        screen
          .getAllByRole("status")
          .some((status) => status.textContent === "1 measurement found"),
      ).toBe(true),
    );
    expect(window.location.search).toBe("?q=kegw");
  });

  it("filters by type with the keyboard alone", async () => {
    const user = userEvent.setup();
    render(<MeasurementExplorer items={items} initialQuery={{ q: "", type: null }} />);
    const group = screen.getByRole("group", { name: "Type" });
    expect(
      within(group)
        .getAllByRole("radio")
        .map((radio) => radio.closest("label")!.textContent),
    ).toEqual(["All", "Water level", "Flow", "Rainfall"]);
    screen.getByRole("searchbox").focus();
    await user.tab(); // type: All
    expect(within(group).getByRole("radio", { name: "All" })).toHaveFocus();
    await user.keyboard("{ArrowRight}{ArrowRight}");
    expect(within(group).getByRole("radio", { name: "Flow" })).toBeChecked();
    expect(links()).toEqual(["Shardlow Flow"]);
    expect(window.location.search).toBe("?type=flow");
    // Tabbing on from the filter reaches the first result.
    await user.tab();
    expect(screen.getByRole("link", { name: "Shardlow Flow" })).toHaveFocus();
  });

  it("combines search and type", async () => {
    window.history.replaceState(null, "", "/?type=level");
    const user = userEvent.setup();
    render(<MeasurementExplorer items={items} initialQuery={{ q: "", type: "level" }} />);
    await user.type(screen.getByRole("searchbox"), "shardlow");
    expect(links()).toEqual(["Shardlow Water level"]);
  });

  it("finds and displays a verified river once per station", async () => {
    for (const { measurement } of items) {
      if (measurement.name === "Shardlow") measurement.watercourseName = "River Trent";
    }
    const user = userEvent.setup();
    render(<MeasurementExplorer items={items} initialQuery={{ q: "", type: null }} />);
    expect(screen.getByRole("heading", { name: "Stone" }).closest("li")).not.toHaveTextContent(
      "River Trent",
    );
    await user.type(screen.getByRole("searchbox"), "river trent");
    expect(screen.getAllByText("River Trent")).toHaveLength(1);
    expect(links()).toEqual(["Shardlow Water level", "Shardlow Flow"]);
  });

  it("shows an empty state with a way back when nothing matches", async () => {
    const user = userEvent.setup();
    render(<MeasurementExplorer items={items} initialQuery={{ q: "", type: null }} />);
    await user.type(screen.getByRole("searchbox"), "zzz");
    expect(screen.getByText("No matching measurements")).toBeInTheDocument();
    expect(screen.getAllByText("No measurements found")[0]).toBeInTheDocument();
    const clear = screen.getByRole("link", { name: "Clear search" });
    expect(clear).toHaveAttribute("href", "/");
    await user.click(clear);
    expect(screen.getByRole("searchbox")).toHaveValue("");
    expect(links()).toHaveLength(7);
    expect(window.location.search).toBe("");
  });

  it("hides the type filter when only one type is published", () => {
    const levels = items.filter((item) => item.measurement.parameter === "level");
    render(<MeasurementExplorer items={levels} initialQuery={{ q: "", type: null }} />);
    expect(screen.queryByRole("group", { name: "Type" })).toBeNull();
  });

  it("submits as a plain GET form when scripts are unavailable", () => {
    render(<MeasurementExplorer items={items} initialQuery={{ q: "", type: null }} />);
    const form = screen.getByRole("search");
    expect(form).toHaveAttribute("action", "/");
    expect(form).toHaveAttribute("method", "get");
    expect(screen.getByRole("searchbox")).toHaveAttribute("name", "q");
  });

  it("keeps unrelated query parameters and the fragment when syncing the URL", async () => {
    window.history.replaceState(null, "", "/?utm_source=x#main");
    const user = userEvent.setup();
    render(<MeasurementExplorer items={items} initialQuery={{ q: "", type: null }} />);
    await user.type(screen.getByRole("searchbox"), "colwick");
    expect(window.location.search).toBe("?utm_source=x&q=colwick");
    expect(window.location.hash).toBe("#main");
  });

  it("keeps an applied type visible and removable even with one published type", () => {
    const levels = items.filter((item) => item.measurement.parameter === "level");
    window.history.replaceState(null, "", "/?type=level");
    render(<MeasurementExplorer items={levels} initialQuery={{ q: "", type: "level" }} />);
    expect(screen.getByRole("radio", { name: "Water level" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "All" })).toBeInTheDocument();
  });

  it("restores the search from the URL when the page is restored with the original payload", () => {
    window.history.replaceState(null, "", "/?q=shardlow&type=flow");
    render(<MeasurementExplorer items={items} initialQuery={{ q: "", type: null }} />);
    expect(screen.getByRole("searchbox")).toHaveValue("shardlow");
    expect(links()).toEqual(["Shardlow Flow"]);
  });
});
