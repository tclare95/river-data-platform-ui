import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/discovery/area/route";
import { DISCOVERY_AREA_PATH } from "@/lib/rdp/inventory";
import { createRdpClient } from "@/lib/rdp/client";
import { RdpError } from "@/lib/rdp/errors";
import type { RdpTransport } from "@/lib/rdp/transport";
import { getRdpClient } from "@/lib/rdp/server";

vi.mock("@/lib/rdp/server", async () => ({
  RdpError: (await import("@/lib/rdp/errors")).RdpError,
  getRdpClient: vi.fn(),
}));

const bbox = "-1.5,52.6,-1,53";
const url = (query: string) => new Request(`https://explorer.test/api/discovery/area?${query}`);
const time = "2026-11-26T11:00:00Z";
const station = (key: string) => ({
  key: `environment-agency:${key}`,
  providerId: "environment-agency",
  label: key,
  relationship: "within_bounding_box",
  location: {
    status: "verified",
    crs: "EPSG:4326",
    latitude: 52.8,
    longitude: -1.4,
    precisionMetres: 10,
  },
  watercourse: { status: "provider_stated", name: "Trent" },
  registeredStationId: "private-station",
  measures: [
    {
      providerMeasureId: "internal-1",
      parameter: "level",
      rdp: { status: "published", measurementId: "ea-colwick-level" },
    },
    {
      providerMeasureId: "internal-2",
      parameter: "flow",
      qualifier: "Flow",
      rdp: { status: "not_published", measurementId: "private-measurement", selected: true },
    },
  ],
});
const page = (key: string, continuation: string | null = null) => ({
  mode: "area",
  view: "consumer",
  complete: false,
  continuation,
  stations: [station(key)],
  coverage: [
    { providerId: "environment-agency", status: "stale", lastVerifiedAt: time, unpositioned: 18 },
    { providerId: "natural-resources-wales", status: "not_integrated" },
  ],
});
const client = (transport: RdpTransport) =>
  createRdpClient({ mode: "live", transport, log: () => undefined });

describe("provider inventory area", () => {
  beforeEach(() => vi.mocked(getRdpClient).mockReset());

  it("pages through the signed adapter contract and returns only public station data", async () => {
    const transport = vi
      .fn<RdpTransport>()
      .mockResolvedValueOnce(page("first", "next"))
      .mockResolvedValueOnce(page("second"));
    vi.mocked(getRdpClient).mockReturnValue(client(transport));
    const response = await GET(url(`bbox=${bbox}`));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const { data } = await response.json();
    expect(data).toMatchObject({
      stations: [
        {
          name: "first",
          watercourse: "Trent",
          measures: [
            { measurementId: "ea-colwick-level", status: "published" },
            { measurementId: null, status: "not_published" },
          ],
        },
        { name: "second" },
      ],
      truncated: false,
      coverage: [
        {
          status: "stale",
          lastVerifiedAt: time,
          unpositioned: 18,
          attribution: expect.stringContaining("Open Government Licence"),
        },
        { status: "not_integrated" },
      ],
    });
    expect(JSON.stringify(data)).not.toMatch(/private-|internal-|selected|continuation/);
    expect(transport.mock.calls.map(([request]) => [request.path, request.query])).toEqual([
      [DISCOVERY_AREA_PATH, { bbox, limit: "200" }],
      [DISCOVERY_AREA_PATH, { bbox, limit: "200", cursor: "next" }],
    ]);
  });

  it.each([
    "bbox=-8,50,2,61",
    "bbox=-2,51,-3,52",
    "bbox=3,51,4,52",
    "bbox=-1,52,0,NaN",
    `bbox=${bbox}&bbox=${bbox}`,
    `bbox=${bbox}&cursor=custom`,
    `bbox=${bbox}&limit=500`,
  ])("rejects invalid bounds or extra inputs (%s) before accessing RDP", async (query) => {
    expect((await GET(url(query))).status).toBe(400);
    expect(getRdpClient).not.toHaveBeenCalled();
  });

  it("restarts from page one on a snapshot change and reports a capped result", async () => {
    const transport = vi
      .fn<RdpTransport>()
      .mockResolvedValueOnce(page("discard", "old"))
      .mockRejectedValueOnce(new RdpError("INVENTORY_CHANGED", 409))
      .mockResolvedValueOnce(page("first", "new"))
      .mockResolvedValueOnce(page("second", "more"))
      .mockResolvedValueOnce(page("third", "remainder"));
    const result = await client(transport).discoverArea(bbox);
    expect(result.stations.map(({ name }) => name)).toEqual(["first", "second", "third"]);
    expect(result.truncated).toBe(true);
    expect(transport.mock.calls.map(([request]) => request.query.cursor)).toEqual([
      undefined,
      "old",
      undefined,
      "new",
      "more",
    ]);
  });

  it("stops fetching pages when the browser cancels", async () => {
    const controller = new AbortController();
    const transport = vi.fn<RdpTransport>().mockImplementationOnce(async ({ signal }) => {
      controller.abort();
      expect(signal?.aborted).toBe(true);
      return page("discard", "next");
    });
    vi.mocked(getRdpClient).mockReturnValue(client(transport));
    const response = await GET(new Request(url(`bbox=${bbox}`), { signal: controller.signal }));
    expect(response.status).toBe(499);
    expect(transport).toHaveBeenCalledOnce();
  });

  it("reports a failed later page as unavailable without returning misleading emptiness", async () => {
    const transport = vi
      .fn<RdpTransport>()
      .mockResolvedValueOnce(page("discard", "next"))
      .mockRejectedValueOnce(new RdpError("STORAGE_UNAVAILABLE", 503));
    vi.mocked(getRdpClient).mockReturnValue(client(transport));
    const response = await GET(url(`bbox=${bbox}`));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: { code: "UNAVAILABLE" } });
  });

  it("rejects unverified or out-of-area locations and operator responses", async () => {
    const transport = vi
      .fn<RdpTransport>()
      .mockResolvedValueOnce({ ...page("operator"), view: "operator" })
      .mockResolvedValueOnce({
        ...page("outside"),
        stations: [
          { ...station("outside"), location: { ...station("outside").location, latitude: 54 } },
        ],
      });
    const rdp = client(transport);
    for (let i = 0; i < 2; i++) {
      await expect(rdp.discoverArea(bbox)).rejects.toMatchObject({
        code: "RESPONSE_CONTRACT_ERROR",
      });
    }
  });
});
