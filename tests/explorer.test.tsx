import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INVENTORY_DEBOUNCE_MS } from "@/components/inventory-map";
import type { InventoryArea, InventoryStation } from "@/lib/inventory";
import { MeasurementExplorer } from "@/components/measurement-explorer";
import { loadChartHistory, type HistoryResult } from "@/lib/history/load";
import { rangeWindow } from "@/lib/history/range";
import { createRdpClient } from "@/lib/rdp/client";
import { createFixtureTransport } from "@/lib/rdp/fixture";
import { GB_BOUNDS, MAX_MAP_ZOOM } from "@/lib/map-context";
import { readExplorerState } from "@/lib/explorer-state";
import type { OverviewItem } from "@/lib/overview";
import { publicMeasurements, toPublicLatest, toPublicMeasurement } from "@/lib/rdp/public";
import type { PublicUpstreamMeasurements } from "@/lib/rdp/upstream-measurements";

const mapMock = vi.hoisted(() => ({
  fail: false,
  events: new EventTarget(),
  bounds: [-8.7, 49.8, 2.1, 60.9],
  zoom: 8.5,
  project: vi.fn(([lng, lat]: [number, number]) => ({ x: lng * 1000, y: lat * 1000 })),
  easeTo: vi.fn(),
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
    getZoom = () => mapMock.zoom;
    getBounds = () => ({
      getWest: () => mapMock.bounds[0],
      getSouth: () => mapMock.bounds[1],
      getEast: () => mapMock.bounds[2],
      getNorth: () => mapMock.bounds[3],
    });
    project = mapMock.project;
    easeTo = mapMock.easeTo;
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
  id: "test-catchment",
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

function catchmentResults(
  stations: OverviewItem["measurement"][][] = [],
  uncertain = false,
  { id = publishedCatchment.id, omittedMeasurements = 0 } = {},
) {
  return Response.json({
    data: {
      status: "available",
      release: traceRelease,
      matchStatus: "Matched",
      catchment: { id, areaKm2: 12.5, pourPointOffsetM: 43.5 },
      omittedMeasurements,
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
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(async (url) => historyResponse(url)),
    );
    mapMock.fail = false;
    mapMock.bounds = [-8.7, 49.8, 2.1, 60.9];
    mapMock.zoom = 8.5;
    mapMock.easeTo.mockClear();
    mapMock.events = new EventTarget();
    mapMock.create.mockClear();
    mapMock.fitBounds.mockClear();
    mapMock.setLngLat.mockClear();
    mapMock.setData.mockClear();
    mapMock.addSource.mockClear();
    mapMock.addLayer.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function historyResponse(
    url: Parameters<typeof fetch>[0],
    rainfall: HistoryResult = { status: "deferred" },
  ) {
    const { searchParams } = new URL(String(url), window.location.origin);
    return Response.json({
      window:
        rainfall.status === "ok"
          ? { from: rainfall.from, to: rainfall.to }
          : { from: "2026-11-12T12:00:00Z", to: "2026-11-19T12:00:00Z" },
      data: ["a", "b", "c", "d"].flatMap((slot) => {
        const measurement = items.find(
          ({ measurement }) => measurement.measurementId === searchParams.get(slot),
        )?.measurement;
        return measurement
          ? [
              {
                measurement,
                result: measurement.kind === "period_total" ? rainfall : { status: "deferred" },
              },
            ]
          : [];
      }),
    });
  }

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

  function providerStation(name: string, longitude: number, published = false): InventoryStation {
    return {
      key: name,
      name,
      position: { longitude, latitude: 52.81, precisionMetres: 10 },
      measures: [
        {
          parameter: published ? "level" : "rainfall",
          qualifier: null,
          measurementId: published ? "ea-shardlow-level" : null,
          status: published ? "published" : "not_published",
        },
      ],
    };
  }

  function inventoryResponse(stations: InventoryStation[], truncated = false) {
    return Response.json({
      data: {
        stations,
        truncated,
        coverage: [
          {
            providerId: "environment-agency",
            label: "Environment Agency",
            status: "stale",
            lastVerifiedAt: "2026-11-26T00:00:00Z",
            unpositioned: 4,
            measureDetailPartial: false,
            attribution:
              "Contains Environment Agency data licensed under the Open Government Licence v3.0.",
          },
          {
            providerId: "sepa",
            label: "Scottish Environment Protection Agency",
            status: "not_integrated",
            lastVerifiedAt: null,
            unpositioned: null,
            measureDetailPartial: false,
          },
        ],
      } satisfies InventoryArea,
    });
  }

  function moveArea(bounds: number[]) {
    act(() => {
      mapMock.events.dispatchEvent(new Event("movestart"));
      mapMock.bounds = bounds;
      mapMock.events.dispatchEvent(new Event("moveend"));
    });
  }

  it("debounces bounded map reads, aborts a superseded read and ignores its late result", async () => {
    let finishOld!: (response: Response) => void;
    const readArea = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishOld = resolve;
          }),
      )
      .mockResolvedValueOnce(inventoryResponse([providerStation("New gauge", -1.2)]));
    vi.stubGlobal("fetch", readArea);
    render(<MeasurementExplorer items={[]} initialQuery={{ q: "", type: null }} />);
    await screen.findByText("Zoom in to discover provider stations.");
    vi.useFakeTimers();
    moveArea([-1.6, 52.5, -1.1, 53]);
    await act(() => vi.advanceTimersByTimeAsync(INVENTORY_DEBOUNCE_MS - 1));
    expect(readArea).not.toHaveBeenCalled();
    moveArea([-1.5, 52.5, -1, 53]);
    await act(() => vi.advanceTimersByTimeAsync(INVENTORY_DEBOUNCE_MS));
    expect(readArea).toHaveBeenCalledOnce();
    const [url, init] = readArea.mock.calls[0];
    expect(new URL(String(url), location.origin).searchParams.get("bbox")).toBe(
      "-1.500000,52.500000,-1.000000,53.000000",
    );

    moveArea([-1.4, 52.5, -0.9, 53]);
    expect(init?.signal?.aborted).toBe(true);
    await act(() => vi.advanceTimersByTimeAsync(INVENTORY_DEBOUNCE_MS));
    await act(async () => finishOld(inventoryResponse([providerStation("Old gauge", -1.4)])));
    expect(
      screen.getByRole("button", { name: "New gauge · Rainfall · Discoverable only" }),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: /Old gauge/ })).not.toBeInTheDocument();

    moveArea([2.1, 52.5, 2.4, 53]);
    await act(() => vi.advanceTimersByTimeAsync(INVENTORY_DEBOUNCE_MS));
    expect(screen.getByText(/outside the Great Britain inventory search area/)).toBeVisible();
    expect(screen.queryByRole("button", { name: /New gauge/ })).not.toBeInTheDocument();
    expect(readArea).toHaveBeenCalledTimes(2);
  });

  it("clusters nearby inventory stations and shows known types, publication and incomplete coverage", async () => {
    addPublishedPositions();
    const fetchInventory = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        inventoryResponse(
          [
            providerStation("First rain gauge", -1.3),
            providerStation("Second rain gauge", -1.299),
            providerStation("Shardlow inventory", -1.1, true),
          ],
          true,
        ),
      );
    vi.stubGlobal("fetch", fetchInventory);
    render(<MeasurementExplorer items={items} initialQuery={{ q: "", type: null }} />);
    await screen.findByText("Zoom in to discover provider stations.");
    moveArea([-1.5, 52.5, -1, 53]);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "2 stations" }));
    expect(mapMock.easeTo).toHaveBeenCalledWith({ center: [-1.3, 52.81], zoom: 10.5 });
    expect(screen.getByText(/Results are limited/)).toBeVisible();
    await user.click(screen.getByText("Provider inventory coverage"));
    expect(screen.getByText(/Environment Agency · Stale inventory · Verified/)).toBeVisible();
    expect(
      screen.getByText(/Scottish Environment Protection Agency · Inventory not yet supported/),
    ).toBeVisible();

    await user.click(screen.getByText("Browse stations in this map area"));
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Provider station" }),
      "Second rain gauge",
    );
    expect(screen.getByRole("heading", { name: "Second rain gauge" })).toHaveFocus();
    expect(
      within(screen.getByRole("region", { name: "Second rain gauge" })).getByText("Rainfall"),
    ).toBeVisible();
    expect(screen.getByText("No data published by RDP")).toBeVisible();
    await user.click(
      screen.getByRole("button", {
        name: /^Shardlow inventory · Multiple types \(River level, Flow\) · Published by RDP$/,
      }),
    );
    expect(screen.getByRole("heading", { name: "Shardlow inventory" })).toHaveFocus();
    expect(
      screen
        .getAllByRole("link", { name: "Water level" })
        .some((link) => link.getAttribute("href") === "/measurements/ea-shardlow-level"),
    ).toBe(true);
    expect(fetchInventory).toHaveBeenCalledOnce();
  });

  it("filters both station sources before clustering and preserves station selection", async () => {
    addPublishedPositions();
    const flow = providerStation("Rain Lane", -1.299);
    flow.measures = [
      { parameter: "flow", qualifier: null, measurementId: null, status: "not_published" },
    ];
    const fetchInventory = vi
      .fn()
      .mockResolvedValue(
        inventoryResponse([
          providerStation("River Bank", -1.3),
          flow,
          providerStation("Shardlow inventory", -1.1, true),
        ]),
      );
    vi.stubGlobal("fetch", fetchInventory);
    const user = userEvent.setup();
    render(<MeasurementExplorer items={items} initialQuery={{ q: "", type: null }} />);
    await enableStations(user);
    mapMock.zoom = MAX_MAP_ZOOM;
    moveArea([-1.5, 52.5, -1, 53]);
    const map = within(screen.getByRole("region", { name: "River map" }));
    await user.click(await map.findByRole("button", { name: "2 stations" }));
    const picker = screen.getByRole("combobox", { name: "Provider station" });
    expect(picker).toHaveFocus();
    expect(mapMock.easeTo).not.toHaveBeenCalled();

    const type = screen.getByRole("combobox", { name: "Map measurement type" });
    const availability = screen.getByRole("combobox", { name: "Map station availability" });
    await user.selectOptions(type, "flow");
    expect(map.queryByRole("button", { name: "2 stations" })).not.toBeInTheDocument();
    const flowMarker = map.getByRole("button", { name: "Rain Lane · Flow · Discoverable only" });
    expect(map.getByRole("button", { name: /^Shardlow inventory · Multiple types/ })).toBeVisible();
    expect(map.queryByRole("button", { name: /^Shardlow ·/ })).not.toBeInTheDocument();
    expect(within(picker).queryByRole("option", { name: /River Bank/ })).not.toBeInTheDocument();
    flowMarker.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("heading", { name: "Rain Lane" })).toHaveFocus();

    await user.selectOptions(availability, "published");
    expect(map.queryByRole("button", { name: /Rain Lane/ })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Rain Lane" })).toBeVisible();
    await user.selectOptions(type, "rainfall");
    expect(screen.getByText("No provider stations match the map filters")).toBeVisible();
    await user.selectOptions(availability, "discoverable");
    expect(
      map.getByRole("button", { name: "River Bank · Rainfall · Discoverable only" }),
    ).toBeVisible();
    expect(stationList().getByRole("link", { name: "Kegworth Water level" })).toBeVisible();
    expect(fetchInventory).toHaveBeenCalledOnce();
  });

  it("offers a retry when the provider inventory is unavailable", async () => {
    const fetchInventory = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(inventoryResponse([]));
    vi.stubGlobal("fetch", fetchInventory);
    render(<MeasurementExplorer items={[]} initialQuery={{ q: "", type: null }} />);
    await screen.findByText("Zoom in to discover provider stations.");
    moveArea([-1.5, 52.5, -1, 53]);
    await userEvent
      .setup()
      .click(await screen.findByRole("button", { name: "Retry station discovery" }));
    expect(
      await screen.findByText("No stations from available inventories in this map area"),
    ).toBeVisible();
    expect(fetchInventory).toHaveBeenCalledTimes(2);
  });

  it("starts with just the GB basemap and traces an explicit point when no stations are published", async () => {
    const user = userEvent.setup();
    const fetchRiver = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(catchmentTrace())
      .mockResolvedValueOnce(catchmentResults());
    vi.stubGlobal("fetch", fetchRiver);
    render(<MeasurementExplorer items={[]} initialQuery={{ q: "", type: null }} />);
    const map = screen.getByRole("region", { name: "River map" });
    await screen.findByRole("button", { name: "Trace river" });
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

    mapClick(map);
    expect(await screen.findByText(/Selected point’s modelled catchment/)).toBeInTheDocument();
    expect(await screen.findByText("No matching published measurements")).toBeInTheDocument();
    expect(fetchRiver).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(traceKinds()).toContain("catchment"));
  });

  it.each([
    { lon: "-1.3", lat: "52.8", zoom: "8.5", camera: { center: [-1.3, 52.8], zoom: 8.5 } },
    { lon: "-1.3", lat: "52.8", camera: { center: [-1.3, 52.8], zoom: 12 } },
    { lon: ["-1.3", "0"], lat: "52.8", camera: { bounds: GB_BOUNDS } },
    { lon: "-1.3", lat: "91", zoom: "8.5", camera: { bounds: GB_BOUNDS } },
    { lon: "-1.3", lat: "52.8", zoom: "99", camera: { bounds: GB_BOUNDS } },
  ])("validates initial camera parameters $lon / $lat / $zoom", async ({ camera, ...params }) => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      for (const entry of Array.isArray(value) ? value : value ? [value] : [])
        search.append(key, entry);
    }
    window.history.replaceState(null, "", `/?${search}`);
    render(<MeasurementExplorer items={[]} initialQuery={{ q: "", type: null }} />);
    await screen.findByRole("button", { name: "Trace river" });
    expect(mapMock.create).toHaveBeenCalledWith(expect.objectContaining(camera));
  });

  it("opens a verified station even when the initial list filter excludes it", async () => {
    addPublishedPositions();
    const station = items.find(
      ({ measurement }) => measurement.measurementId === "ea-shardlow-level",
    )!.measurement.stationId;
    window.history.replaceState(null, "", `/?q=stone&station=${station}`);
    render(
      <MeasurementExplorer
        items={items}
        initialQuery={{ q: "stone", type: null }}
        initialState={readExplorerState({ station })}
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
    expect(map.queryByRole("button", { name: /^Shardlow ·/ })).not.toBeInTheDocument();
    await user.click(layer);
    const shardlow = await map.findByRole("button", { name: /^Shardlow ·/ });
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
    expect(details.getByRole("button", { name: "Collapse" })).toHaveFocus();

    await user.click(screen.getByRole("radio", { name: "Flow" }));
    expect(map.getByRole("button", { name: /^Shardlow ·/ })).toBeInTheDocument();
    expect(map.queryByRole("button", { name: /^Kegworth ·/ })).not.toBeInTheDocument();
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
    expect(map.queryByRole("button", { name: /^Shardlow ·/ })).not.toBeInTheDocument();
    expect(details.getByRole("heading", { name: "Shardlow" })).toBeInTheDocument();
    expect(mapMock.create).toHaveBeenCalledTimes(1);
    expect(mapMock.fitBounds).not.toHaveBeenCalled();
  });

  it("opens a desktop station panel at the map and ignores the previous station's pending summary", async () => {
    addPublishedPositions();
    vi.stubGlobal("innerWidth", 1280);
    const user = userEvent.setup();
    let completeSummary!: (response: Response) => void;
    const request = vi.fn<typeof fetch>().mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          completeSummary = resolve;
        }),
    );
    vi.stubGlobal("fetch", request);
    render(<MeasurementExplorer items={items} />);
    await enableStations(user);
    const mapRegion = screen.getByRole("region", { name: "River map" });
    const map = within(mapRegion);

    await user.click(map.getByRole("button", { name: /^Shardlow ·/ }));
    expect(map.getByRole("button", { name: /^Shardlow ·/, pressed: true })).toBeVisible();
    const panel = screen.getByRole("region", { name: "Shardlow" });
    expect(panel.parentElement?.parentElement).toBe(mapRegion.parentElement);
    expect(within(panel).getByText("River Trent")).toBeVisible();
    expect(within(panel).getAllByText("Recent").length).toBeGreaterThan(0);
    expect(panel.querySelector("time")).toBeVisible();
    expect(request).not.toHaveBeenCalled();

    await user.click(within(panel).getByLabelText("Recent observations for Shardlow flow"));
    expect(request).toHaveBeenCalledTimes(1);
    const signal = request.mock.calls[0][1]?.signal;

    await user.click(map.getByRole("button", { name: /^Kegworth ·/ }));
    expect(signal?.aborted).toBe(true);
    expect(map.getByRole("button", { name: /^Kegworth ·/, pressed: true })).toBeVisible();
    expect(map.getByRole("button", { name: /^Shardlow ·/, pressed: false })).toBeVisible();
    await act(async () =>
      completeSummary(Response.json({ latest: null, summary: { status: "not_recent" } })),
    );
    expect(screen.getByRole("region", { name: "Kegworth" })).toBe(panel);
    const nextPanel = within(panel);
    expect(nextPanel.getByText("River Soar")).toBeVisible();
    expect(nextPanel.getByRole("link", { name: "Water level" })).toHaveAttribute(
      "href",
      "/measurements/ea-kegworth-level",
    );
    expect(screen.queryByRole("region", { name: "Shardlow" })).not.toBeInTheDocument();
    expect(screen.queryByText("Recent changes unavailable")).not.toBeInTheDocument();

    await user.click(
      nextPanel.getByRole("button", { name: /^Add to comparison: Kegworth · Water level/ }),
    );
    expect(screen.getByRole("region", { name: "Comparison selection" })).toHaveTextContent(
      "1 of 4 selected",
    );
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("region", { name: "Kegworth" })).not.toBeInTheDocument();
    expect(mapRegion).toHaveFocus();
    expect(map.getByRole("button", { name: /^Kegworth ·/, pressed: false })).toBeVisible();
    expect(mapMock.create).toHaveBeenCalledTimes(1);
    expect(mapMock.easeTo).not.toHaveBeenCalled();
  });

  it("lets mobile users collapse, expand and dismiss a discoverable station at the map", async () => {
    vi.stubGlobal("innerWidth", 390);
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(inventoryResponse([providerStation("Rain Lane", -1.3)])),
    );
    render(<MeasurementExplorer items={items} />);
    await screen.findByRole("button", { name: "Trace river" });
    moveArea([-1.5, 52.5, -1, 53]);
    const mapRegion = screen.getByRole("region", { name: "River map" });
    const map = within(mapRegion);
    const marker = { name: "Rain Lane · Rainfall · Discoverable only" };
    await user.pointer({ keys: "[TouchA]", target: await map.findByRole("button", marker) });
    const panel = within(screen.getByRole("region", { name: "Rain Lane" }));
    expect(panel.getByRole("heading")).toHaveFocus();
    expect(panel.getByText("Observations are currently unavailable in RDP.")).toBeVisible();
    expect(panel.getByText("Rainfall")).toBeVisible();
    expect(panel.queryByRole("link")).not.toBeInTheDocument();
    expect(map.getByRole("button", { ...marker, pressed: true })).toBeVisible();

    await user.click(panel.getByRole("button", { name: "Collapse", expanded: true }));
    expect(panel.getByRole("heading")).toBeVisible();
    expect(panel.getByText("Rainfall")).not.toBeVisible();
    await user.click(panel.getByRole("button", { name: "Expand", expanded: false }));
    expect(panel.getByText("Rainfall")).toBeVisible();

    await user.click(panel.getByRole("button", { name: "Close station details" }));
    expect(screen.queryByRole("region", { name: "Rain Lane" })).not.toBeInTheDocument();
    expect(map.getByRole("button", { ...marker, pressed: false })).toBeVisible();
    expect(mapMock.create).toHaveBeenCalledTimes(1);
  });

  it("loads a map measurement summary only when opened and labels a stale flow reading", async () => {
    addPublishedPositions();
    const fetchSummary = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        latest: {
          kind: "instantaneous",
          status: "available",
          freshness: "stale",
          observedAt: "2026-11-19T09:00:00Z",
          value: 21.4,
        },
        summary: { status: "not_recent" },
      }),
    );
    vi.stubGlobal("fetch", fetchSummary);
    const user = userEvent.setup();
    render(<MeasurementExplorer items={items} initialQuery={{ q: "", type: null }} />);
    await enableStations(user);
    const map = within(screen.getByRole("region", { name: "River map" }));
    const marker = await map.findByRole("button", { name: /^Shardlow ·/ });
    await user.click(marker);
    const details = within(document.getElementById(marker.getAttribute("aria-controls")!)!);
    expect(fetchSummary).not.toHaveBeenCalled();
    const summary = details.getByLabelText("Recent observations for Shardlow flow");
    await user.click(summary);
    const disclosure = within(summary.closest("details")!);
    expect(await disclosure.findByText("21.4 m3/s")).toBeVisible();
    expect(disclosure.getByText("Not recent")).toBeVisible();
    expect(disclosure.getByText("Recent changes unavailable")).toBeVisible();
    expect(fetchSummary).toHaveBeenCalledExactlyOnceWith(
      "/api/measurements/ea-shardlow-flow/summary",
      { signal: expect.any(AbortSignal) },
    );
  });

  it("shares a comparison between a marker and the accessible list and restores it from the URL", async () => {
    addPublishedPositions();
    const user = userEvent.setup();
    const explorer = <MeasurementExplorer items={items} initialQuery={{ q: "", type: null }} />;
    render(explorer);
    const map = within(screen.getByRole("region", { name: "River map" }));
    await enableStations(user);
    const marker = await map.findByRole("button", { name: /^Shardlow ·/ });
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
    expect(selection.getByRole("link", { name: "Open full comparison" })).toHaveAttribute(
      "href",
      `/compare${query}`,
    );
    expect(Object.fromEntries(new URLSearchParams(window.location.search))).toMatchObject({
      a: "ea-shardlow-level",
      b: "ea-stone-rainfall",
      station: "ea-shardlow",
    });

    await user.type(screen.getByRole("searchbox"), "stone");
    expect(selection.getAllByRole("listitem")).toHaveLength(2);
    cleanup();
    render(explorer);
    expect(screen.getByRole("searchbox")).toHaveValue("stone");
    expect(screen.getByRole("link", { name: "Open full comparison" })).toHaveAttribute(
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
    expect(screen.queryByRole("button", { name: /^Shardlow ·/ })).not.toBeInTheDocument();
    await user.clear(screen.getByRole("searchbox"));
    expect(await screen.findByRole("button", { name: /^Shardlow ·/ })).toBeInTheDocument();
  });

  it.each(["WebGL", "tiles"])("keeps discovery usable when %s is unavailable", async (failure) => {
    addPublishedPositions();
    mapMock.fail = failure === "WebGL";
    const user = userEvent.setup();
    render(<MeasurementExplorer items={items} initialQuery={{ q: "", type: null }} />);
    if (failure === "tiles") {
      await enableStations(user);
      const marker = await screen.findByRole("button", { name: /^Shardlow ·/ });
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
    fetchTrace.mockResolvedValueOnce(
      Response.json({
        data: {
          ...matched,
          route: { ...route, direction: "upstream" },
          geometry: { type: "LineString", coordinates: geometry.coordinates[0] },
        },
      }),
    );
    fetchTrace.mockResolvedValueOnce(Response.json({ data: matched }));
    render(<MeasurementExplorer items={items} initialQuery={{ q: "", type: null }} />);
    const map = screen.getByRole("region", { name: "River map" });
    await enableStations(user);
    const marker = await within(map).findByRole("button", { name: /^Shardlow ·/ });
    act(() => mapMock.events.dispatchEvent(new Event("load")));
    const mode = screen.getByRole("button", { name: "Trace river", pressed: true });
    await user.click(mode);
    mapClick(map);
    expect(fetchTrace).not.toHaveBeenCalled();
    expect(map).toHaveClass("maplibregl-map");
    await user.click(mode);
    expect(mode).toHaveAttribute("aria-pressed", "true");
    expect(map).toHaveClass("maplibregl-map");
    marker.focus();
    await user.keyboard("{Enter}");
    mapClick(marker);
    expect(fetchTrace).not.toHaveBeenCalled();
    const details = within(document.getElementById(marker.getAttribute("aria-controls")!)!);
    expect(details.getAllByRole("button", { name: /^Add to comparison/ })).toHaveLength(2);
    const station = screen.getByRole("button", { name: "Trace from Shardlow" });
    station.focus();
    await user.keyboard("{Enter}");
    expect(fetchTrace.mock.calls[0][0]).toBe(
      "/api/river/trace?lon=-1.33536800&lat=52.86543100&direction=upstream",
    );
    expect(await screen.findByText(/upstream route incomplete/)).toBeInTheDocument();
    await waitFor(() => expect(traceKinds()).toContain("upstream"));
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
        {
          type: "Feature",
          properties: { kind: "upstream" },
          geometry: { type: "LineString", coordinates: geometry.coordinates[0] },
        },
      ],
    });

    await user.selectOptions(screen.getByRole("combobox", { name: "Direction" }), "downstream");
    expect(fetchTrace.mock.calls[1][0]).toBe(
      "/api/river/trace?lon=-1.33536800&lat=52.86543100&direction=downstream",
    );
    expect(await screen.findByText(/downstream route incomplete/)).toBeInTheDocument();
    await waitFor(() => expect(traceKinds()).toContain("downstream"));
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
        .mockResolvedValueOnce(
          Response.json({
            data: {
              ...matchedTrace("upstream"),
              catchment: { ...publishedCatchment, geometry, pourPointOffsetM },
            },
          }),
        )
        .mockResolvedValueOnce(catchmentResults())
        .mockResolvedValueOnce(Response.json({ data: matchedTrace("downstream") }))
        .mockResolvedValueOnce(
          Response.json({
            data: { ...matchedTrace("upstream"), catchment: publishedCatchment },
          }),
        )
        .mockResolvedValueOnce(catchmentResults());
      vi.stubGlobal("fetch", (url: Parameters<typeof fetch>[0], init?: RequestInit) =>
        String(url).startsWith("/api/measurements/comparison")
          ? Promise.resolve(historyResponse(url))
          : fetchTrace(url, init),
      );
      render(<MeasurementExplorer items={items} initialQuery={{ q: "", type: null }} />);
      await enableStations(user);
      await user.click(await screen.findByRole("button", { name: /^Shardlow ·/ }));
      act(() => mapMock.events.dispatchEvent(new Event("load")));
      const details = within(
        document.getElementById(
          screen.getByRole("button", { name: /^Shardlow ·/ }).getAttribute("aria-controls")!,
        )!,
      );
      for (const button of details.getAllByRole("button", { name: /^Add to comparison/ })) {
        await user.click(button);
      }
      const compare = screen.getByRole("link", { name: "Open full comparison" });
      const comparisonUrl = compare.getAttribute("href");
      const direction = screen.getByRole("combobox", { name: "Direction" });
      const map = screen.getByRole("region", { name: "River map" });
      mapClick(map);
      await screen.findByRole("button", { name: "Hide catchment" });
      await waitFor(() =>
        expect(currentTraceData().features).toContainEqual({
          type: "Feature",
          properties: { kind: "catchment" },
          geometry,
        }),
      );
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
      await screen.findByText("No matching published measurements");
      await user.selectOptions(direction, "downstream");
      expect(await screen.findByRole("checkbox", { name: "Downstream route" })).toBeChecked();
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
      expect(fetchTrace).toHaveBeenCalledTimes(3);
      await user.click(screen.getByRole("button", { name: "Clear trace" }));
      expect(traceKinds()).toEqual([]);
      expect(details.queryByRole("heading", { name: "Shardlow" })).not.toBeInTheDocument();
      expect(compare).toHaveAttribute("href", comparisonUrl);

      mapClick(map, -1.2, 52.6);
      expect(direction).toHaveValue("upstream");
      expect(await screen.findByRole("button", { name: "Hide catchment" })).toBeInTheDocument();
      await waitFor(() => expect(traceKinds()).toContain("catchment"));
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
  ])("offers no catchment when the result is %s", async (_scenario, data, message) => {
    addPublishedPositions();
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          data
            ? Response.json({ data: { ...matchedTrace("upstream"), ...data } })
            : new Response(null, { status: 413 }),
        ),
    );
    render(<MeasurementExplorer items={items} initialQuery={{ q: "", type: null }} />);
    await screen.findByRole("button", { name: "Trace river" });
    act(() => mapMock.events.dispatchEvent(new Event("load")));
    mapClick(screen.getByRole("region", { name: "River map" }));
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: "Catchment measurements" }),
    ).not.toBeInTheDocument();
    expect(traceKinds()).toContain("selected");
    expect(traceKinds()).not.toContain("catchment");
  });

  it("automatically finds published catchment stations and uses the shared comparison", async () => {
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
    let finishOldHistory!: (response: Response) => void;
    const fetchHistory = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishOldHistory = resolve;
          }),
      )
      .mockImplementation(async (url) => {
        const now = Date.parse("2026-11-19T12:07:00Z");
        const client = createRdpClient({
          mode: "fixture",
          transport: createFixtureTransport(() => now),
        });
        const rainfall = await loadChartHistory(
          client,
          stone.measurementId,
          stone.kind,
          rangeWindow("30d", now),
        );
        return historyResponse(url, rainfall);
      });
    vi.stubGlobal("fetch", (url: Parameters<typeof fetch>[0], init?: RequestInit) =>
      String(url).startsWith("/api/measurements/comparison")
        ? fetchHistory(url, init)
        : fetchRiver(url, init),
    );
    render(<MeasurementExplorer items={items} initialQuery={{ q: "shardlow", type: null }} />);
    await screen.findByRole("button", { name: "Trace river" });
    act(() => mapMock.events.dispatchEvent(new Event("load")));
    const map = screen.getByRole("region", { name: "River map" });
    mapClick(map);

    const panel = within(await screen.findByRole("region", { name: "Catchment measurements" }));
    await waitFor(() =>
      expect(traceKinds()).toEqual(expect.arrayContaining(["selected", "catchment"])),
    );
    expect(fetchRiver.mock.calls[1][0]).toBe(
      "/api/river/upstream-measurements?lon=-1.25000000&lat=52.50000000&release=0123456789abcdef",
    );
    const list = within(
      await panel.findByRole("list", { name: "Stations inside the modelled catchment" }),
    );
    expect(list.getAllByText("Upstream connection unverified")).toHaveLength(2);
    expect(list.getByLabelText("Recent observations for Shardlow flow")).toBeInTheDocument();
    expect(list.queryByLabelText("Recent observations for Stone rainfall")).not.toBeInTheDocument();
    expect(
      within(list.getByRole("link", { name: /^Rainfall/ }).closest("li")!).queryByText(
        "Upstream connection unverified",
      ),
    ).not.toBeInTheDocument();
    expect(
      list.getAllByRole("heading", { level: 3 }).map(({ textContent }) => textContent),
    ).toEqual(["Shardlow", "Stone"]);
    expect(list.getByRole("link", { name: /^Flow/ })).toHaveAttribute(
      "href",
      "/measurements/ea-shardlow-flow",
    );
    expect(
      within(list.getByRole("link", { name: /^Flow/ }).closest("li")!).getByText(
        "Upstream connection unverified",
      ),
    ).toBeInTheDocument();
    expect(within(map).getAllByRole("button")).toHaveLength(2);
    expect(mapMock.setLngLat).toHaveBeenCalledWith([-1.28, 52.81]);
    const marker = within(map).getByRole("button", {
      name: "Stone · Rainfall · Published by RDP · Inside the modelled catchment",
    });
    await user.click(marker);
    const details = document.getElementById(marker.getAttribute("aria-controls")!)!;
    const mapType = screen.getByRole("combobox", { name: "Map measurement type" });
    await user.selectOptions(mapType, "flow");
    expect(within(map).queryByRole("button", { name: /^Stone ·/ })).not.toBeInTheDocument();
    expect(within(details).getByRole("heading", { name: "Stone" })).toBeVisible();
    expect(list.getByRole("link", { name: /^Rainfall/ })).toBeVisible();
    expect(traceKinds()).toContain("catchment");
    await user.selectOptions(mapType, "");
    act(() => mapMock.events.dispatchEvent(new Event("moveend")));

    const comparison = within(screen.getByRole("region", { name: "Comparison selection" }));
    expect(comparison.queryByRole("list")).not.toBeInTheDocument();
    await user.click(
      list.getByRole("button", { name: /^Add to comparison: Shardlow · Water level/ }),
    );
    await user.click(list.getByRole("button", { name: /^Add to comparison: Stone · Rainfall/ }));
    const flow = list.getByRole("button", { name: /^Needs a third axis: Shardlow · Flow/ });
    expect(flow).toHaveAttribute("aria-disabled", "true");
    await user.click(flow);
    const compare = comparison.getByRole("link", { name: "Open full comparison" });
    expect(compare).toHaveAttribute("href", "/compare?a=ea-shardlow-level&b=ea-stone-rainfall");
    const chart = within(screen.getByRole("region", { name: "Comparison history" }));
    expect(chart.getByText("Loading 7 days for 2 measurements")).toBeInTheDocument();
    expect(fetchHistory).toHaveBeenCalledTimes(1);
    await user.click(chart.getByRole("button", { name: "30 days" }));
    expect(fetchHistory.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(fetchHistory.mock.calls[1][0]).toBe(
      "/api/measurements/comparison?a=ea-shardlow-level&b=ea-stone-rainfall&range=30d",
    );
    expect(await chart.findByText("Showing 30 days for 2 measurements")).toBeInTheDocument();
    const view = chart.getByRole("combobox", { name: "Rainfall view" });
    expect(view).toHaveDisplayValue("Rolling 24-hour total");
    await user.selectOptions(view, "hourly");
    expect(chart.getByRole("group", { name: /^Shared timeline/ })).toHaveAccessibleName(
      /mm · Hourly totals/,
    );
    await user.click(chart.getByText("Time shifts"));
    const shifts = chart.getByRole("group", { name: "Stone rainfall" });
    const offset = within(shifts).getByRole("spinbutton", { name: "Offset (minutes)" });
    await user.clear(offset);
    await user.type(offset, "30");
    await user.click(within(shifts).getByRole("button", { name: "Apply" }));
    expect(chart.getByRole("group", { name: /^Shared timeline/ })).toHaveAccessibleName(
      /Stone rainfall \(\+30 min\).*Hourly totals/,
    );
    expect(fetchHistory).toHaveBeenCalledTimes(2);
    expect(new URLSearchParams(location.search).get("rain")).toBe("hourly");
    expect(new URLSearchParams(location.search).get("ob")).toBe("30");
    await act(async () => finishOldHistory(new Response(null, { status: 503 })));
    expect(chart.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "River map" })).toBe(map);
    expect(within(details).getByRole("heading", { name: "Stone" })).toBeInTheDocument();
    expect(list.getByRole("heading", { name: "Stone" })).toBeInTheDocument();
    expect(mapMock.create).toHaveBeenCalledTimes(1);
    expect(mapMock.fitBounds).not.toHaveBeenCalled();
    expect(Object.fromEntries(new URLSearchParams(window.location.search))).toMatchObject({
      a: "ea-shardlow-level",
      b: "ea-stone-rainfall",
      range: "30d",
      lon: "-1.300000",
      lat: "52.800000",
      zoom: "8.500",
      station: stone.stationId,
      traceLon: "-1.25000000",
      traceLat: "52.50000000",
      direction: "upstream",
      catchment: "show",
    });
    await user.click(screen.getByRole("checkbox", { name: "Upstream reaches" }));
    expect(traceKinds()).toEqual(expect.arrayContaining(["selected", "catchment"]));
    await user.click(screen.getByRole("button", { name: "Hide catchment" }));
    expect(compare).toHaveAttribute(
      "href",
      "/compare?a=ea-shardlow-level&b=ea-stone-rainfall&range=30d",
    );
    await user.click(comparison.getByRole("button", { name: /^Remove Stone · Rainfall/ }));
    expect(screen.queryByRole("region", { name: "Comparison history" })).not.toBeInTheDocument();
    expect(new URLSearchParams(window.location.search).has("b")).toBe(false);
    expect(fetchHistory).toHaveBeenCalledTimes(2);
    expect(list.getByRole("button", { name: /^Add to comparison: Shardlow · Flow/ })).toBeEnabled();
    expect(fetchRiver).toHaveBeenCalledTimes(2);
  });

  it("restores comparison range, viewport, station and catchment from a shared explorer URL", async () => {
    addPublishedPositions();
    const station = items.find(
      ({ measurement }) => measurement.measurementId === "ea-shardlow-level",
    )!.measurement.stationId;
    const params = new URLSearchParams({
      a: "ea-shardlow-level",
      b: "ea-stone-rainfall",
      c: "ea-shardlow-flow",
      range: "30d",
      lon: "-1.3",
      lat: "52.8",
      zoom: "8.5",
      station,
      traceLon: "-1.25",
      traceLat: "52.5",
      direction: "downstream",
      catchment: "show",
    });
    window.history.replaceState(null, "", `/?${params}`);
    const fetchHistory = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockImplementationOnce(async (url) => historyResponse(url));
    const fetchTrace = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ data: matchedTrace("downstream") }))
      .mockResolvedValueOnce(catchmentTrace())
      .mockResolvedValueOnce(catchmentResults());
    vi.stubGlobal("fetch", (url: Parameters<typeof fetch>[0], init?: RequestInit) =>
      String(url).startsWith("/api/measurements/comparison")
        ? fetchHistory(url, init)
        : fetchTrace(url, init),
    );
    const user = userEvent.setup();
    render(<MeasurementExplorer items={items} initialQuery={{ q: "", type: null }} />);
    const chart = within(screen.getByRole("region", { name: "Comparison history" }));
    expect(chart.getByRole("button", { name: "30 days", pressed: true })).toBeInTheDocument();
    expect(await chart.findByRole("alert")).toHaveTextContent(
      "Comparison history unavailable right now",
    );
    expect(mapMock.create).toHaveBeenCalledWith(
      expect.objectContaining({ center: [-1.3, 52.8], zoom: 8.5 }),
    );
    expect(await screen.findByText(/Selected point’s modelled catchment/)).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Direction" })).toHaveValue("downstream");
    await screen.findByText("No matching published measurements");
    expect(fetchTrace.mock.calls.map(([url]) => url)).toEqual([
      "/api/river/trace?lon=-1.25000000&lat=52.50000000&direction=downstream",
      "/api/river/trace?lon=-1.25000000&lat=52.50000000&direction=upstream",
      "/api/river/upstream-measurements?lon=-1.25000000&lat=52.50000000&release=0123456789abcdef",
    ]);
    const map = screen.getByRole("region", { name: "River map" });
    const marker = within(map).getByRole("button", { name: /^Shardlow ·/ });
    const details = document.getElementById(marker.getAttribute("aria-controls")!)!;
    expect(within(details).getByRole("heading", { name: "Shardlow" })).toBeInTheDocument();
    await user.click(chart.getByRole("button", { name: "Try again" }));
    expect(await chart.findByText("Showing 30 days for 2 measurements")).toBeInTheDocument();
    expect(fetchHistory.mock.calls.map(([url]) => url)).toEqual(
      Array(2).fill(
        "/api/measurements/comparison?a=ea-shardlow-level&b=ea-stone-rainfall&range=30d",
      ),
    );
    expect(new URLSearchParams(window.location.search).has("c")).toBe(false);
    expect(mapMock.create).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("region", { name: "River map" })).toBe(map);
  });

  it("copies a clean link and restores its applied transforms using direct navigation and Back/Forward", async () => {
    addPublishedPositions();
    const now = Date.parse("2026-11-19T12:07:00Z");
    const client = createRdpClient({
      mode: "fixture",
      transport: createFixtureTransport(() => now),
    });
    const rainfall = await loadChartHistory(
      client,
      "ea-stone-rainfall",
      "period_total",
      rangeWindow("30d", now),
    );
    const fetchHistory = vi
      .fn<typeof fetch>()
      .mockImplementation(async (url) => historyResponse(url, rainfall));
    vi.stubGlobal("fetch", fetchHistory);
    window.history.replaceState(
      null,
      "",
      "/?a=ea-shardlow-level&b=ea-stone-rainfall&c=ea-unpublished&range=30d&rain=hourly&ob=30&q=private&token=secret#main",
    );
    const user = userEvent.setup();
    const write = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockRejectedValueOnce(new Error("Blocked"));
    const { unmount } = render(<MeasurementExplorer items={items} />);
    const chart = () => within(screen.getByRole("region", { name: "Comparison history" }));
    expect(await chart().findByRole("combobox", { name: "Rainfall view" })).toHaveValue("hourly");
    expect(chart().getByRole("group", { name: /^Shared timeline/ })).toHaveAccessibleName(
      /Stone rainfall \(\+30 min\)/,
    );
    expect(screen.getByText(/Some measurements in this link/)).toBeInTheDocument();
    expect(
      fetchHistory.mock.calls.map(([url, options]) => [url, options?.method ?? "GET"]),
    ).toEqual([
      ["/api/measurements/comparison?a=ea-shardlow-level&b=ea-stone-rainfall&range=30d", "GET"],
    ]);

    await user.click(screen.getByRole("button", { name: "Copy Explorer link" }));
    const url = new URL(
      (screen.getByRole("textbox", { name: "Copy this link" }) as HTMLInputElement).value,
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      a: "ea-shardlow-level",
      b: "ea-stone-rainfall",
      range: "30d",
      rain: "hourly",
      ob: "30",
    });
    expect(url.hash).toBe("");
    await user.click(screen.getByRole("button", { name: "Copy Explorer link" }));
    expect(write).toHaveBeenLastCalledWith(url.href);
    expect(screen.getByText("Link copied")).toBeInTheDocument();

    unmount();
    window.history.replaceState(null, "", url);
    render(<MeasurementExplorer items={items} />);
    const view = await chart().findByRole("combobox", { name: "Rainfall view" });
    expect(view).toHaveValue("hourly");
    await user.selectOptions(view, "native");
    const historyLength = history.length;
    await screen.findByRole("button", { name: "Trace river" });
    act(() => mapMock.events.dispatchEvent(new Event("moveend")));
    act(() => mapMock.events.dispatchEvent(new Event("moveend")));
    expect(history.length).toBe(historyLength);
    await act(async () => {
      const popped = new Promise((resolve) =>
        window.addEventListener("popstate", resolve, { once: true }),
      );
      history.back();
      await popped;
    });
    expect(chart().getByRole("combobox", { name: "Rainfall view" })).toHaveValue("hourly");
    expect(chart().getByRole("group", { name: /^Shared timeline/ })).toHaveAccessibleName(
      /Stone rainfall \(\+30 min\)/,
    );
    await act(async () => {
      const popped = new Promise((resolve) =>
        window.addEventListener("popstate", resolve, { once: true }),
      );
      history.forward();
      await popped;
    });
    expect(chart().getByRole("combobox", { name: "Rainfall view" })).toHaveValue("native");
    expect(fetchHistory).toHaveBeenCalledTimes(2);
  });

  it("restores a station and map controls when traversing Explorer history", async () => {
    addPublishedPositions();
    const user = userEvent.setup();
    render(<MeasurementExplorer items={items} />);
    await enableStations(user);
    const map = () => within(screen.getByRole("region", { name: "River map" }));
    await user.click(map().getByRole("button", { name: /^Shardlow ·/ }));
    const station = new URLSearchParams(location.search).get("station");
    const details = () =>
      document.getElementById(
        map()
          .getByRole("button", { name: /^Shardlow ·/ })
          .getAttribute("aria-controls")!,
      )!;
    expect(within(details()).getByRole("heading", { name: "Shardlow" })).toBeInTheDocument();

    await act(async () => {
      const popped = new Promise((resolve) =>
        window.addEventListener("popstate", resolve, { once: true }),
      );
      history.back();
      await popped;
    });
    await map().findByRole("button", { name: /^Shardlow ·/ });
    expect(within(details()).queryByRole("heading", { name: "Shardlow" })).not.toBeInTheDocument();
    expect(new URLSearchParams(location.search).has("station")).toBe(false);

    await act(async () => {
      const popped = new Promise((resolve) =>
        window.addEventListener("popstate", resolve, { once: true }),
      );
      history.forward();
      await popped;
    });
    await map().findByRole("button", { name: /^Shardlow ·/ });
    expect(within(details()).getByRole("heading", { name: "Shardlow" })).toBeInTheDocument();
    expect(new URLSearchParams(location.search).get("station")).toBe(station);
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
    act(() => mapMock.events.dispatchEvent(new Event("load")));
    const map = screen.getByRole("region", { name: "River map" });
    mapClick(map);
    await screen.findByRole("region", { name: "Catchment measurements" });
    expect(screen.getByText("Finding measurements")).toBeInTheDocument();
    mapClick(map, -1.2, 52.6);
    expect(traceKinds()).toEqual(["selected"]);
    expect(
      screen.queryByRole("region", { name: "Catchment measurements" }),
    ).not.toBeInTheDocument();
    expect(fetchRiver.mock.calls[1][1]?.signal?.aborted).toBe(true);
    await screen.findByRole("region", { name: "Catchment measurements" });
    expect(await screen.findByText("No matching published measurements")).toBeInTheDocument();
    expect(fetchRiver.mock.calls[3][0]).toBe(
      "/api/river/upstream-measurements?lon=-1.20000000&lat=52.60000000&release=0123456789abcdef",
    );
    const shardlow = items.find(
      ({ measurement }) => measurement.measurementId === "ea-shardlow-level",
    )!.measurement;
    await act(async () => finishFirst(catchmentResults([[shardlow]])));
    expect(screen.getByText("No matching published measurements")).toBeInTheDocument();
    expect(screen.getByText(/missing or uncertain positions/)).toBeInTheDocument();
    expect(screen.getByText(/near the catchment boundary/)).toBeInTheDocument();
    expect(screen.getByText(/network coverage is incomplete/)).toBeInTheDocument();
    expect(within(map).getByRole("button", { name: /^Shardlow ·/ })).toBeInTheDocument();
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
        .mockResolvedValueOnce(catchmentResults())
        .mockResolvedValueOnce(
          status === 200
            ? Response.json({ data: { ...matchedTrace("downstream"), release: nextRelease } })
            : new Response(null, { status }),
        );
      vi.stubGlobal("fetch", fetchRiver);
      render(<MeasurementExplorer items={[]} initialQuery={{ q: "", type: null }} />);
      await screen.findByRole("button", { name: "Trace river" });
      act(() => mapMock.events.dispatchEvent(new Event("load")));
      mapClick(screen.getByRole("region", { name: "River map" }));
      await screen.findByText("No matching published measurements");
      await waitFor(() => expect(traceKinds()).toContain("catchment"));

      await user.selectOptions(screen.getByRole("combobox", { name: "Direction" }), "downstream");
      expect(
        await screen.findByText(status === 200 ? /test-network-next/ : /River network updated/),
      ).toBeInTheDocument();
      await waitFor(() => expect(traceKinds()).not.toContain("catchment"));
      expect(
        screen.queryByRole("region", { name: "Catchment measurements" }),
      ).not.toBeInTheDocument();
      expect(mapMock.fitBounds).not.toHaveBeenCalled();
    },
  );

  it("keeps the boundary visible when measurement discovery fails and retries the same point", async () => {
    const user = userEvent.setup();
    const fetchRiver = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(catchmentTrace())
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(catchmentResults());
    vi.stubGlobal("fetch", fetchRiver);
    render(<MeasurementExplorer items={[]} initialQuery={{ q: "", type: null }} />);
    await screen.findByRole("button", { name: "Trace river" });
    act(() => mapMock.events.dispatchEvent(new Event("load")));
    mapClick(screen.getByRole("region", { name: "River map" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Measurement search unavailable");
    await waitFor(() => expect(traceKinds()).toContain("catchment"));
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("No matching published measurements")).toBeInTheDocument();
    expect(fetchRiver.mock.calls[2][0]).toBe(fetchRiver.mock.calls[1][0]);
    expect(fetchRiver).toHaveBeenCalledTimes(3);
  });

  it("requires discovery to match the displayed polygon within the same release", async () => {
    addPublishedPositions();
    const user = userEvent.setup();
    const shardlow = items.find(
      ({ measurement }) => measurement.measurementId === "ea-shardlow-level",
    )!.measurement;
    const fetchRiver = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(catchmentTrace())
      .mockResolvedValueOnce(catchmentResults([[shardlow]], false, { id: "different-catchment" }))
      .mockResolvedValueOnce(catchmentTrace())
      .mockResolvedValueOnce(catchmentResults([[shardlow]], false, { omittedMeasurements: 1 }));
    vi.stubGlobal("fetch", fetchRiver);
    render(<MeasurementExplorer items={[]} initialQuery={{ q: "", type: null }} />);
    await screen.findByRole("button", { name: "Trace river" });
    act(() => mapMock.events.dispatchEvent(new Event("load")));
    const map = screen.getByRole("region", { name: "River map" });
    mapClick(map);

    const panel = await screen.findByRole("region", { name: "Catchment measurements" });
    expect(await within(panel).findByRole("alert")).toHaveTextContent(
      "Measurement results are for a different catchment",
    );
    await waitFor(() => expect(traceKinds()).toContain("catchment"));
    expect(within(panel).queryByRole("link")).not.toBeInTheDocument();
    expect(
      within(map).queryByRole("button", { name: /inside the modelled catchment/i }),
    ).not.toBeInTheDocument();

    await user.click(within(panel).getByRole("button", { name: "Refresh catchment" }));
    const refreshed = await screen.findByRole("region", { name: "Catchment measurements" });
    expect(await within(refreshed).findByRole("link", { name: /Water level/ })).toHaveAttribute(
      "href",
      "/measurements/ea-shardlow-level",
    );
    expect(
      within(refreshed).getByText("Some matching measurements could not be displayed."),
    ).toBeInTheDocument();
    expect(fetchRiver.mock.calls[2][0]).toBe(fetchRiver.mock.calls[0][0]);
  });

  it("distinguishes undisplayable measurements from an empty catchment", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(catchmentTrace())
        .mockResolvedValueOnce(catchmentResults([], false, { omittedMeasurements: 2 })),
    );
    render(<MeasurementExplorer items={[]} initialQuery={{ q: "", type: null }} />);
    await screen.findByRole("button", { name: "Trace river" });
    mapClick(screen.getByRole("region", { name: "River map" }));

    expect(
      await screen.findByText("Matching measurements could not be displayed"),
    ).toBeInTheDocument();
    expect(screen.queryByText("No matching published measurements")).not.toBeInTheDocument();
  });

  it("refreshes the same river point after discovery reports a retired release", async () => {
    addPublishedPositions();
    const user = userEvent.setup();
    const fetchRiver = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(catchmentTrace())
      .mockResolvedValueOnce(new Response(null, { status: 410 }))
      .mockResolvedValueOnce(catchmentTrace())
      .mockResolvedValueOnce(catchmentResults());
    vi.stubGlobal("fetch", fetchRiver);
    render(<MeasurementExplorer items={items} initialQuery={{ q: "", type: null }} />);
    await screen.findByRole("button", { name: "Trace river" });
    mapClick(screen.getByRole("region", { name: "River map" }));
    await screen.findByRole("region", { name: "Catchment measurements" });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The river network release has changed",
    );
    await user.click(screen.getByRole("button", { name: "Refresh catchment" }));
    expect(await screen.findByText("No matching published measurements")).toBeInTheDocument();
    expect(fetchRiver.mock.calls[2][0]).toBe(fetchRiver.mock.calls[0][0]);
    expect(fetchRiver).toHaveBeenCalledTimes(4);
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
    await screen.findByRole("button", { name: "Trace river" });
    mapClick(screen.getByRole("region", { name: "River map" }));
    expect(fetchTrace.mock.calls[0][0]).toBe(
      "/api/river/trace?lon=-1.25000000&lat=52.50000000&direction=upstream",
    );
    expect(screen.getByText("Tracing river…")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Shardlow Flow" })).toBeInTheDocument();
    await enableStations(user);
    await user.click(await screen.findByRole("button", { name: /^Kegworth ·/ }));
    expect(screen.getByRole("button", { name: "Trace from Kegworth" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Select map centre" }));
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
      await screen.findByRole("button", { name: "Trace river" });
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
