// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/river/upstream-measurements/route";
import { createRdpClient, type RdpClient } from "@/lib/rdp/client";
import { errorFromResponse } from "@/lib/rdp/errors";
import { createFixtureTransport } from "@/lib/rdp/fixture";
import type { RdpRequest } from "@/lib/rdp/transport";
import { UPSTREAM_MEASUREMENTS_PATH } from "@/lib/rdp/upstream-measurements";
import { release, samplePath } from "./river-tracer-fixtures";

let client: RdpClient;
vi.mock("@/lib/rdp/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rdp/server")>()),
  getRdpClient: () => client,
}));

const lon = "-1.25";
const lat = "52.5";
const query = { lon, lat, release: release.token };
const queryString = new URLSearchParams(query).toString();
const url = "https://ui.test/api/river/upstream-measurements";
const request = (search = queryString) => new Request(`${url}?${search}`);
const at = "2026-11-22T12:00:00Z";
const location = {
  status: "verified",
  longitude: -1.21,
  latitude: 52.52,
  crs: "EPSG:4326",
  precisionMetres: 100,
  evidence: "https://example.test/private-location-record",
  retrievedAt: at,
};

function wireStation(stationId: string, provider: string, measurementIds: string[]) {
  return {
    stationId,
    provider,
    location,
    name: "private-discovery-name",
    providerStationId: "private-provider-station",
    geographicRelationship: "within_catchment",
    measurements: measurementIds.map((measurementId) => ({
      measurementId,
      parameter: measurementId.endsWith("-rain") ? "rainfall" : "level",
      networkRelationship: measurementId.endsWith("-rain") ? "not_applicable" : "not_assessed",
      providerMeasureId: "private-provider-measure",
    })),
  };
}

function available() {
  return {
    status: "available",
    point: { longitude: Number(lon), latitude: Number(lat) },
    release: { ...release, attribution: "private-release-metadata" },
    match: { status: "Matched", reason: "private-match-reason" },
    canonicalSample: {
      basinId: "42",
      sampleId: "123",
      reachId: "private-reach",
      position: [-1.24, 52.5],
      snapOffsetM: 17,
    },
    upstream: `${samplePath}/upstream`,
    catchment: {
      id: "catchment-456",
      sampleId: "456",
      reachId: "private-pour-reach",
      areaKm2: 12.5,
      offsetFromCanonicalSampleM: 8,
      pourPointOffsetM: 25,
      selection: "NearestDownstreamSample",
    },
    networkCoverage: { completeness: "incomplete", reasons: ["private-trace-reason"] },
    data: [
      wireStation("ea-example", "environment-agency", [
        "ea-example-level",
        "ea-example-rain",
        "missing-id",
        "moved-id",
      ]),
      wireStation("private-station", "unapproved-provider", ["private-id"]),
    ],
    meta: {
      scope: "published_rainfall_level_flow",
      retrievedAt: at,
      complete: false,
      registrationVersion: 14,
      publicationVersion: 8,
      counts: { withinCatchment: 2, outside: 1, unknown: 2, ambiguous: 1, nearBoundary: 3 },
    },
  };
}

function catalogueMeasurement(
  measurementId: string,
  stationId = "ea-example",
  provider = "environment-agency",
) {
  const rainfall = measurementId.endsWith("-rain");
  return {
    measurementId,
    stationId,
    provider,
    location,
    sourceId: "private-source",
    name: "Approved catalogue label",
    parameter: rainfall ? "rainfall" : "level",
    unit: rainfall ? "mm" : "m",
    datum: "ASD",
    expectedIntervalSeconds: 900,
    ...(rainfall ? { valueType: "total", periodSeconds: 900 } : {}),
  };
}

function stub(body: unknown, catalogue?: ReturnType<typeof catalogueMeasurement>[]) {
  const transport = vi.fn(async ({ path }: RdpRequest) => {
    if (path === UPSTREAM_MEASUREMENTS_PATH) {
      if (body instanceof Error) throw body;
      return body;
    }
    if (path !== "/v1/measurements") throw new Error("unexpected upstream request");
    return {
      data: catalogue ?? [
        catalogueMeasurement("ea-example-level"),
        catalogueMeasurement("ea-example-rain"),
        catalogueMeasurement("private-id", "private-station", "unapproved-provider"),
        { ...catalogueMeasurement("moved-id"), location: { ...location, longitude: -1.22 } },
      ],
      meta: { retrievedAt: at },
    };
  });
  client = createRdpClient({ mode: "fixture", transport, log: vi.fn() });
  return transport;
}

describe("upstream measurements application route", () => {
  it("uses catalogue details and preserves catchment, relationships and stage coverage", async () => {
    const transport = stub(available());
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body).toMatchObject({
      mode: "fixture",
      data: {
        status: "available",
        omittedMeasurements: 3,
        release: { releaseId: release.releaseId, version: release.version },
        catchment: { id: "catchment-456", areaKm2: 12.5, pourPointOffsetM: 25 },
        networkCoverage: { completeness: "incomplete" },
        meta: {
          scope: "published_rainfall_level_flow",
          complete: false,
          counts: { withinCatchment: 2, outside: 1, unknown: 2, ambiguous: 1, nearBoundary: 3 },
        },
        data: [
          {
            geographicRelationship: "within_catchment",
            measurements: [
              {
                measurementId: "ea-example-level",
                name: "Approved catalogue label",
                networkRelationship: "not_assessed",
              },
              {
                measurementId: "ea-example-rain",
                kind: "period_total",
                networkRelationship: "not_applicable",
              },
            ],
          },
        ],
      },
    });
    expect(JSON.stringify(body)).not.toMatch(
      /private|missing-id|moved-id|publicationVersion|registrationVersion|upstream.*samples/,
    );
    expect(body.data.data).toHaveLength(1);
    expect(body.data.data[0].measurements).toHaveLength(2);
    expect(transport.mock.calls[0][0]).toMatchObject({
      path: UPSTREAM_MEASUREMENTS_PATH,
      query,
      maxResponseBytes: 4 * 1024 * 1024,
      signal: expect.any(AbortSignal),
    });
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("projects all 500 measurements allowed by managed publication", async () => {
    const body = available();
    const ids = Array.from({ length: 500 }, (_, index) => `ea-example-level-${index}`);
    body.data = [wireStation("ea-example", "environment-agency", ids)];
    body.meta.complete = true;
    body.meta.counts = {
      withinCatchment: 1,
      outside: 0,
      unknown: 0,
      ambiguous: 0,
      nearBoundary: 0,
    };
    stub(
      body,
      ids.map((id) => catalogueMeasurement(id)),
    );

    const response = await GET(request());
    expect(response.status).toBe(200);
    const { data } = await response.json();
    expect(data.omittedMeasurements).toBe(0);
    expect(
      data.data[0].measurements.map((row: { measurementId: string }) => row.measurementId),
    ).toEqual(ids);
  });

  it.each([
    ["location_not_matched", "Ambiguous"],
    ["catchment_unavailable", "Matched"],
  ])("returns %s without refreshing the catalogue", async (status, matchStatus) => {
    const { point } = available();
    const transport = stub({
      status,
      point,
      release,
      match: { status: matchStatus, reason: "private" },
      ...(status === "catchment_unavailable" ? { reason: "private" } : {}),
    });
    const response = await GET(request(`lon=${lon}&lat=${lat}`));
    expect(await response.json()).toEqual({
      mode: "fixture",
      data: {
        status,
        matchStatus,
        release: { releaseId: release.releaseId, version: release.version },
      },
    });
    expect(transport).toHaveBeenCalledOnce();
    expect(transport.mock.calls[0][0].query).toEqual({ lon, lat });
  });

  it.each([
    "lon=-1.25&lat=91",
    "lon=181&lat=52.5",
    "lon=1e0&lat=52.5",
    "lon=1%0A&lat=52.5",
    "lon=NaN&lat=52.5",
    "lon=&lat=52.5",
    "lat=52.5&lon=1&lon=2",
    "lat=52.5&lon=1&extra=2",
    "lat=52.5&lon=1&release=",
    "lat=52.5&lon=1&release=0123456789ABCDEF",
    "lat=52.5&lon=1&release=0123456789abcdef&release=0123456789abcdef",
  ])("rejects invalid search %s before any upstream work", async (search) => {
    const transport = stub(available());
    expect((await GET(request(search))).status).toBe(400);
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([
    [404, "NOT_FOUND", 404, "DISABLED"],
    [410, "RELEASE_NOT_AVAILABLE", 410, "RELEASE_NOT_AVAILABLE"],
    [504, "QUERY_TIMEOUT", 504, "TIMEOUT"],
    [403, "FORBIDDEN", 503, "UNAVAILABLE"],
    [404, "gateway error", 503, "UNAVAILABLE"],
    [503, "CATCHMENT_UNAVAILABLE", 503, "UNAVAILABLE"],
  ])("maps upstream %i %s to a fixed public state", async (status, code, expected, publicCode) => {
    const transport = stub(errorFromResponse(status, { error: { code, message: "private" } }));
    const response = await GET(request());
    expect(response.status).toBe(expected);
    expect(await response.json()).toEqual({ error: { code: publicCode } });
    expect(transport).toHaveBeenCalledOnce();
  });

  it("reports discovery as disabled with the default local fixture transport", async () => {
    client = createRdpClient({
      mode: "fixture",
      transport: createFixtureTransport(),
      log: vi.fn(),
    });
    const response = await GET(request());
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: { code: "DISABLED" } });
  });

  it.each([
    { point: { longitude: 0, latitude: 0 } },
    { release: { ...release, token: "0000000000000000" } },
    { release: { ...release, version: "0".repeat(64), token: "0".repeat(16) } },
    { upstream: "https://example.test/private" },
    { data: Array(501).fill(null) },
    { meta: { ...available().meta, counts: { ...available().meta.counts, outside: 497 } } },
    { data: [wireStation("ea-example", "environment-agency", ["same-id", "same-id"])] },
    { catchment: { ...available().catchment, areaKm2: 0 } },
    { catchment: { ...available().catchment, pourPointOffsetM: -1 } },
    { meta: { ...available().meta, complete: true } },
  ])(
    "rejects malformed or inconsistent success payloads before catalogue work",
    async (changes) => {
      const transport = stub({ ...available(), ...changes });
      const response = await GET(request());
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: { code: "UNAVAILABLE" } });
      expect(transport).toHaveBeenCalledOnce();
    },
  );

  it("cancels queued discovery without calling the upstream or touching the catalogue", async () => {
    let finish!: (value: unknown) => void;
    const transport = vi.fn(() => new Promise<unknown>((resolve) => (finish = resolve)));
    client = createRdpClient({ mode: "fixture", transport, maxConcurrent: 1, log: vi.fn() });
    const blocking = client.getUpstreamMeasurements(query);
    const controller = new AbortController();
    const queued = GET(new Request(`${url}?${queryString}`, { signal: controller.signal }));
    controller.abort();
    expect((await queued).status).toBe(499);
    finish(available());
    await blocking;
    expect(transport).toHaveBeenCalledOnce();
  });
});
