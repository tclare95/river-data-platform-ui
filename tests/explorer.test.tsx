import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MeasurementExplorer } from "@/components/measurement-explorer";
import { createRdpClient } from "@/lib/rdp/client";
import { createFixtureTransport } from "@/lib/rdp/fixture";
import type { OverviewItem } from "@/lib/overview";
import { publicMeasurements, toPublicLatest, toPublicMeasurement } from "@/lib/rdp/public";

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

const links = () => screen.queryAllByRole("link").map((link) => link.textContent);

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

  it("keeps one marker per located station and updates selection with the list filters", async () => {
    addPublishedPositions();
    const user = userEvent.setup();
    render(<MeasurementExplorer items={items} initialQuery={{ q: "", type: null }} />);
    const mapRegion = screen.getByRole("region", { name: "Station locations" });
    const map = within(mapRegion);
    const shardlow = await map.findByRole("button", { name: "Shardlow" });
    expect(map.getAllByRole("button")).toHaveLength(2);
    expect(mapMock.create).toHaveBeenCalledWith(
      expect.objectContaining({ bounds: expect.anything() }),
    );
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
    expect(map.queryByRole("button")).not.toBeInTheDocument();
    const list = screen.getByRole("region", { name: "Stations" });
    expect(within(list).getByRole("link", { name: "Stone Rainfall" })).toBeInTheDocument();

    await user.clear(screen.getByRole("searchbox"));
    expect(screen.getByRole("region", { name: "Station locations" })).toBe(mapRegion);
    expect(map.getAllByRole("button")).toHaveLength(2);
    expect(details.queryByRole("heading")).not.toBeInTheDocument();
    expect(mapMock.create).toHaveBeenCalledTimes(1);
    expect(mapMock.fitBounds).not.toHaveBeenCalled();
  });

  it("shares a comparison between a marker and the accessible list and restores it from the URL", async () => {
    addPublishedPositions();
    const user = userEvent.setup();
    const explorer = <MeasurementExplorer items={items} initialQuery={{ q: "", type: null }} />;
    render(explorer);
    const map = within(screen.getByRole("region", { name: "Station locations" }));
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

  it("starts with list results when the URL filters out all verified locations", async () => {
    addPublishedPositions();
    window.history.replaceState(null, "", "/?q=stone");
    const user = userEvent.setup();
    render(<MeasurementExplorer items={items} initialQuery={{ q: "stone", type: null }} />);
    expect(screen.getByRole("link", { name: "Stone Rainfall" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Station locations" })).not.toBeInTheDocument();
    expect(mapMock.create).not.toHaveBeenCalled();
    await user.clear(screen.getByRole("searchbox"));
    expect(await screen.findByRole("button", { name: "Shardlow" })).toBeInTheDocument();
  });

  it.each(["WebGL", "tiles"])("keeps discovery usable when %s is unavailable", async (failure) => {
    addPublishedPositions();
    mapMock.fail = failure === "WebGL";
    const user = userEvent.setup();
    render(<MeasurementExplorer items={items} initialQuery={{ q: "", type: null }} />);
    if (failure === "tiles") {
      const marker = await screen.findByRole("button", { name: "Shardlow" });
      act(() => mapMock.events.dispatchEvent(new Event("error")));
      expect(screen.getByText("Some basemap details could not load.")).toBeInTheDocument();
      expect(marker).toBeInTheDocument();
    } else {
      expect(await screen.findByRole("alert")).toHaveTextContent("Station map unavailable");
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
    const map = screen.getByRole("region", { name: "Station locations" });
    const marker = await within(map).findByRole("button", { name: "Shardlow" });
    act(() => mapMock.events.dispatchEvent(new Event("load")));
    mapClick(map);
    expect(fetchTrace).not.toHaveBeenCalled();

    const mode = screen.getByRole("button", { name: "Trace river", pressed: false });
    expect(map).toHaveClass("maplibregl-map");
    await user.click(mode);
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
      const map = screen.getByRole("region", { name: "Station locations" });
      mapClick(map);
      expect(await screen.findByRole("checkbox", { name: "Downstream route" })).toBeChecked();
      const direction = screen.getByRole("combobox", { name: "Direction" });
      await user.selectOptions(direction, "upstream");
      const show = await screen.findByRole("button", { name: "Show catchment" });
      expect(traceKinds()).toEqual(["selected", "snapped", "upstream", "downstream"]);
      await user.click(show);
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
      expect(screen.getByText("Catchment area 12.5 km²")).toBeInTheDocument();
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
      expect(await screen.findByRole("button", { name: "Show catchment" })).toBeInTheDocument();
      expect(traceKinds()).toEqual(["selected", "snapped", "upstream"]);
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
    act(() => mapMock.events.dispatchEvent(new Event("load")));
    mapClick(screen.getByRole("region", { name: "Station locations" }));
    await screen.findByRole("checkbox", { name: "Downstream route" });
    await user.selectOptions(screen.getByRole("combobox", { name: "Direction" }), "upstream");
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show catchment" })).not.toBeInTheDocument();
    if (scenario === "unmatched") {
      expect(traceKinds()).toEqual(["selected"]);
    } else {
      expect(traceKinds()).toContain("downstream");
      expect(screen.getByText(/Synthetic network attribution/)).toBeInTheDocument();
    }
    expect(traceKinds()).not.toContain("catchment");
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
    mapClick(screen.getByRole("region", { name: "Station locations" }));
    expect(fetchTrace.mock.calls[0][0]).toBe(
      "/api/river/trace?lon=-1.25000000&lat=52.50000000&direction=downstream",
    );
    expect(screen.getByText("Tracing river…")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Shardlow Flow" })).toBeInTheDocument();
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
      mapClick(screen.getByRole("region", { name: "Station locations" }));
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
      expect(screen.getByRole("status")).toHaveTextContent("1 measurement found"),
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
    await user.tab(); // search
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
