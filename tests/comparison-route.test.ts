import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/measurements/comparison/route";
import type { ComparisonSide } from "@/lib/compare";
import { createRdpClient, type RdpClient } from "@/lib/rdp/client";
import { RdpError } from "@/lib/rdp/errors";
import { createFixtureTransport } from "@/lib/rdp/fixture";

let client: RdpClient;
vi.mock("@/lib/rdp/server", () => ({ getRdpClient: () => client }));

const NOW = Date.parse("2026-11-19T12:07:00Z");
const fixture = createFixtureTransport(() => NOW);
const transport = vi.fn(fixture);
const pair = "a=ea-shardlow-level&b=ea-stone-rainfall";
const request = (query: string) =>
  GET(new Request(`https://river.test/api/measurements/comparison?${query}`));
const historyCalls = () =>
  transport.mock.calls.filter(([call]) => call.path.endsWith("/observations"));

describe("inline comparison history", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
    transport.mockReset();
    client = createRdpClient({ mode: "fixture", transport, log: () => undefined });
  });
  afterEach(() => vi.useRealTimers());

  it.each([
    ["a=ea-shardlow-level", 400],
    ["a=ea-shardlow-level&b=ea-shardlow-level", 400],
    [`${pair}&b=ea-shardlow-flow`, 400],
    [`${pair}&range=365d`, 400],
    [`${pair}&range=7d&range=30d`, 400],
    [`${pair}&e=extra`, 400],
    ["a=ea-shardlow-level&b=unpublished-id", 404],
    [`${pair}&c=ea-shardlow-flow`, 400],
  ])("rejects %s before loading history", async (query, status) => {
    expect((await request(query)).status).toBe(status);
    expect(historyCalls()).toHaveLength(0);
  });

  it("returns public level and interval data and shares unchanged history across selections", async () => {
    const response = await request(`${pair}&range=30d`);
    expect(response.status).toBe(200);
    const { data } = (await response.json()) as { data: ComparisonSide[] };
    expect(data).toMatchObject([
      {
        measurement: { measurementId: "ea-shardlow-level", datum: "ASD" },
        result: { status: "ok", observations: expect.any(Array) },
      },
      {
        measurement: { measurementId: "ea-stone-rainfall", periodSeconds: 900 },
        result: { status: "ok", intervals: expect.any(Array) },
      },
    ]);
    const calls = historyCalls();
    expect(calls).toHaveLength(4);
    expect(calls.filter(([{ query }]) => query?.cursor)).toHaveLength(2);
    for (const [{ query }] of calls) {
      expect(query).toMatchObject({
        from: "2026-10-20T12:00:00.000Z",
        to: "2026-11-19T12:00:00.000Z",
        limit: "2000",
      });
    }
    transport.mockClear();
    const reordered = await request("a=ea-stone-rainfall&b=ea-shardlow-level&range=30d");
    expect(reordered.status).toBe(200);
    expect((await reordered.json()).data).toEqual([...data].reverse());
    expect(historyCalls()).toHaveLength(0);
  });

  it("keeps complete smaller series when the combined response exceeds the byte cap", async () => {
    transport.mockImplementation(async (call) => {
      const response = await fixture(call);
      if (!call.path.endsWith("/ea-shardlow-level/observations")) return response;
      const body = response as { data: { quality: string }[] };
      return {
        ...body,
        data: body.data.map((row) => ({ ...row, quality: "\u00e9".repeat(800) })),
      };
    });
    const response = await request(`${pair}&range=30d`);
    expect(response.status).toBe(200);
    const json = await response.text();
    expect(Buffer.byteLength(json)).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(JSON.parse(json).data).toMatchObject([
      {
        measurement: { measurementId: "ea-shardlow-level" },
        result: { status: "too_large" },
      },
      {
        measurement: { measurementId: "ea-stone-rainfall" },
        result: { status: "ok", pages: 2, intervals: expect.any(Array) },
      },
    ]);
  });

  it("keeps a failed series independent of the other series", async () => {
    transport.mockImplementation((call) => {
      if (call.path.endsWith("/ea-shardlow-level/observations")) {
        throw new RdpError("STORAGE_UNAVAILABLE");
      }
      return fixture(call);
    });
    const response = await request(pair);
    expect(response.status).toBe(200);
    expect((await response.json()).data).toMatchObject([
      { result: { status: "unavailable" } },
      { result: { status: "ok" } },
    ]);
  });
});
