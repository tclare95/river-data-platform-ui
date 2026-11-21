import { describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/river/trace/route";
import { createRdpClient, type RdpClient } from "@/lib/rdp/client";
import { RdpError, errorFromResponse } from "@/lib/rdp/errors";
import type { RdpRequest } from "@/lib/rdp/transport";
import {
  attribution,
  locateFixture,
  reach,
  routeFixture,
  samplePath,
  snapped,
  unavailable,
  version,
} from "./river-tracer-fixtures";

let client: RdpClient;
vi.mock("@/lib/rdp/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rdp/server")>()),
  getRdpClient: () => client,
}));

function fixtureTransport(locate: unknown = locateFixture(), route: unknown = routeFixture()) {
  const transport = vi.fn(async ({ path }: RdpRequest) => {
    const body = path === "/v1/river/locate" ? locate : route;
    if (body instanceof Error) throw body;
    return body;
  });
  client = createRdpClient({ mode: "fixture", transport, log: vi.fn() });
  return transport;
}

const request = (query = "lon=-1.25&lat=52.5&direction=upstream") =>
  new Request(`https://ui.test/api/river/trace?${query}`);

describe("River Tracer application endpoint", () => {
  it("projects an attributed matched trace and shares the immutable sample result between clicks", async () => {
    const transport = fixtureTransport();
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({
      mode: "fixture",
      data: {
        matchStatus: "Matched",
        release: { releaseId: "orn-v2-gb", version },
        snappedSample: { position: snapped, snapOffsetM: 17 },
        route: { direction: "upstream", completeness: "incomplete" },
        attribution,
        geometry: { type: "MultiLineString", coordinates: [reach] },
      },
    });
    await GET(request("lon=-1.24&lat=52.5&direction=upstream"));
    expect(transport.mock.calls.map(([read]) => [read.path, read.query])).toEqual([
      ["/v1/river/locate", { lon: "-1.25", lat: "52.5" }],
      [`${samplePath}/upstream`, { geometry: "reaches" }],
      ["/v1/river/locate", { lon: "-1.24", lat: "52.5" }],
    ]);
  });

  it("reads downstream from the canonical sample", async () => {
    const transport = fixtureTransport(locateFixture(), routeFixture("downstream"));
    expect((await GET(request("lon=-1&lat=52&direction=downstream"))).status).toBe(200);
    expect(transport.mock.calls[1][0].path).toBe(`${samplePath}/downstream`);
  });

  it.each(["Ambiguous", "NoMatch", "OutOfCoverage", "Matched"])(
    "keeps %s without a snap distinct from failure",
    async (status) => {
      const transport = fixtureTransport(locateFixture(status, false));
      const response = await GET(request());
      expect(response.status).toBe(200);
      expect((await response.json()).data).toMatchObject({
        matchStatus: status,
        snappedSample: null,
        route: null,
        geometry: null,
        attribution: null,
      });
      expect(transport).toHaveBeenCalledOnce();
    },
  );

  it("keeps geometry server-side for other releases even when the result contains a catchment", async () => {
    const locate = locateFixture();
    const otherVersion = version.slice(0, -1) + "0";
    locate.data.release.version = otherVersion;
    const route = routeFixture("upstream", "none");
    route.riverTracer.releaseVersion = otherVersion;
    const transport = fixtureTransport(locate, route);
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect((await response.json()).data).toMatchObject({
      geometry: null,
      snappedSample: { position: null, snapOffsetM: 17 },
      attribution,
      release: { version: otherVersion },
    });
    expect(transport.mock.calls[1][0].query).toEqual({ geometry: "none" });
  });

  it.each([
    "lon=1e-2&lat=52&direction=upstream",
    "lon=1&lat=91&direction=upstream",
    "lon=1&lat=52&direction=upstream&direction=downstream",
    "lon=1&lat=52&direction=relationships",
    "lon=1&lat=52&direction=upstream&geometry=reaches",
  ])("rejects invalid input before calling RDP (%s)", async (query) => {
    const transport = fixtureTransport();
    expect((await GET(request(query))).status).toBe(400);
    expect(transport).not.toHaveBeenCalled();
  });

  it("rejects leads outside the exact release, basin and sample", async () => {
    const locate = locateFixture();
    locate.data.links!.upstream = `https://internal.example${samplePath}/upstream`;
    const transport = fixtureTransport(locate);
    expect((await GET(request())).status).toBe(503);
    expect(transport).toHaveBeenCalledOnce();
  });

  it("rejects malformed geometry and retries it on a subsequent request", async () => {
    const route = routeFixture();
    route.features[2].geometry.coordinates = [
      [-1.25, 52.5],
      [181, 52],
    ];
    const transport = fixtureTransport(locateFixture(), route);
    expect((await GET(request())).status).toBe(503);
    expect((await GET(request())).status).toBe(503);
    expect(transport).toHaveBeenCalledTimes(4);
  });

  it.each([
    [errorFromResponse(403, unavailable), 503, "UNAVAILABLE"],
    [new RdpError("UPSTREAM_ERROR", 404), 404, "NOT_FOUND"],
    [new RdpError("UPSTREAM_ERROR", 410), 410, "RELEASE_NOT_AVAILABLE"],
    [new RdpError("UPSTREAM_ERROR", 413), 413, "RESULT_TOO_LARGE"],
    [new RdpError("RESPONSE_TOO_LARGE", 200), 413, "RESULT_TOO_LARGE"],
    [new RdpError("TIMEOUT"), 504, "TIMEOUT"],
  ])("maps upstream failures to a fixed public response (%s)", async (error, status, code) => {
    fixtureTransport(locateFixture(), error);
    const response = await GET(request());
    expect(response.status).toBe(status);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: { code } });
  });
});
