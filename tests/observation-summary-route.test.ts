import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRdpClient, type RdpClient } from "@/lib/rdp/client";
import { createFixtureTransport } from "@/lib/rdp/fixture";
import type { RdpTransport } from "@/lib/rdp/transport";

let client: RdpClient;
vi.mock("@/lib/rdp/server", () => ({ getRdpClient: () => client }));
const { GET } = await import("@/app/api/measurements/[id]/summary/route");
const NOW = Date.parse("2026-11-26T12:07:00Z");
const fixture = createFixtureTransport(() => NOW);

function getSummary(id: string, query = "") {
  return GET(new Request(`https://example.test/api/measurements/${id}/summary${query}`), {
    params: Promise.resolve({ id }),
  });
}

describe("observation summary route", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["Date"], now: NOW }));
  afterEach(() => vi.useRealTimers());

  function useTransport(transport: RdpTransport = fixture) {
    const request = vi.fn(transport);
    client = createRdpClient({ mode: "fixture", transport: request });
    return request;
  }

  it("uses one short history request and returns only public latest and derived values", async () => {
    const request = useTransport();
    const response = await getSummary("ea-colwick-level");
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(body.latest).toMatchObject({ freshness: "fresh", kind: "instantaneous" });
    expect(body.latest).not.toHaveProperty("sourceId");
    expect(body.summary).toMatchObject({ status: "available" });
    const history = request.mock.calls
      .map(([call]) => call)
      .filter(({ path }) => path.endsWith("/observations"));
    expect(history).toHaveLength(1);
    expect(history[0].query).toMatchObject({ limit: "1500" });
    expect(Date.parse(history[0].query.to) - Date.parse(history[0].query.from)).toBeLessThan(
      25 * 3_600_000,
    );
  });

  it("keeps the last known value but skips history for stale measurements", async () => {
    const request = useTransport();
    const response = await getSummary("ea-shardlow-flow");
    expect(await response.json()).toMatchObject({
      latest: { freshness: "stale", value: expect.any(Number) },
      summary: { status: "not_recent" },
    });
    expect(request.mock.calls.map(([call]) => call.path)).not.toContain(
      "/v1/measurements/ea-shardlow-flow/observations",
    );
  });

  it("does not continue or use a truncated history page", async () => {
    const request = useTransport(async (call) => {
      const body = await fixture(call);
      if (!call.path.endsWith("/observations")) return body;
      const page = body as { data: unknown[]; meta: Record<string, unknown> };
      return { ...page, meta: { ...page.meta, nextCursor: "next" } };
    });
    const response = await getSummary("ea-colwick-level");
    expect(await response.json()).toMatchObject({ summary: { status: "history_unavailable" } });
    expect(request.mock.calls.filter(([call]) => call.path.endsWith("/observations"))).toHaveLength(
      1,
    );
  });

  it("rejects arbitrary windows and excludes rainfall before a latest or history read", async () => {
    const request = useTransport();
    expect((await getSummary("ea-colwick-level", "?hours=90")).status).toBe(400);
    expect((await getSummary("ea-stone-rainfall")).status).toBe(404);
    expect(request.mock.calls.map(([call]) => call.path)).toEqual(["/v1/measurements"]);
  });
});
