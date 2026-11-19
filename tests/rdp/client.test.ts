// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { CACHE_TTL_MS, createLimiter, createRdpClient } from "@/lib/rdp/client";
import { RdpError } from "@/lib/rdp/errors";
import { createFixtureTransport } from "@/lib/rdp/fixture";
import type { RdpRequest } from "@/lib/rdp/transport";

function setup() {
  let now = Date.parse("2026-11-19T12:07:00Z");
  const fixture = createFixtureTransport(() => now);
  const failing = new Set<string>();
  const transport = vi.fn(async (request: RdpRequest) => {
    if (failing.has(request.path)) throw new RdpError("STORAGE_UNAVAILABLE", 503);
    return fixture(request);
  });
  const log = vi.fn();
  const client = createRdpClient({ mode: "fixture", transport, now: () => now, log });
  return { client, transport, failing, log, advance: (ms: number) => (now += ms) };
}

const paths = (transport: ReturnType<typeof setup>["transport"]) =>
  transport.mock.calls.map(([r]) => r.path);

describe("RDP client", () => {
  it("resolves IDs against the published catalogue before any per-measurement read", async () => {
    const { client, transport } = setup();
    await expect(client.getHealth("ea-unpublished-level")).rejects.toMatchObject({
      code: "MEASUREMENT_NOT_FOUND",
    });
    await expect(client.getLatest(["ea-colwick-level", "ea-colwick-level"])).rejects.toMatchObject({
      code: "INVALID_QUERY",
    });
    await expect(client.getLatest(["../x"])).rejects.toMatchObject({ code: "INVALID_QUERY" });
    await expect(
      client.getLatest(Array.from({ length: 21 }, (_, i) => `id-${i}`)),
    ).rejects.toMatchObject({ code: "INVALID_QUERY" });
    expect(paths(transport)).toEqual(["/v1/measurements"]);
  });

  it("caches briefly and refetches after the TTL", async () => {
    const { client, transport, advance } = setup();
    await client.getLatest(["ea-colwick-level"]);
    await client.getLatest(["ea-colwick-level"]);
    expect(paths(transport).filter((p) => p.endsWith("/latest"))).toHaveLength(1);
    advance(CACHE_TTL_MS.latest + 1);
    await client.getLatest(["ea-colwick-level"]);
    expect(paths(transport).filter((p) => p.endsWith("/latest"))).toHaveLength(2);
  });

  it("never answers a failed refresh with an expired reading", async () => {
    const { client, failing, advance, log } = setup();
    const first = await client.getLatest(["ea-colwick-level"]);
    expect(first.items[0].status).toBe("available");
    advance(CACHE_TTL_MS.latest + 1);
    failing.add("/v1/measurements/latest");
    await expect(client.getLatest(["ea-colwick-level"])).rejects.toMatchObject({
      code: "STORAGE_UNAVAILABLE",
    });
    // Failures are not cached either: the next call tries upstream again.
    failing.clear();
    await expect(client.getLatest(["ea-colwick-level"])).resolves.toMatchObject({ partial: false });
    expect(log).toHaveBeenCalledWith({
      route: "/v1/measurements/latest",
      code: "STORAGE_UNAVAILABLE",
      status: 503,
    });
  });

  it("validates and normalises history windows before calling RDP", async () => {
    const { client, transport } = setup();
    const page = await client.getHistory("ea-colwick-level", {
      from: "2026-11-18T13:00:00+01:00",
      to: "2026-11-19T12:00:00Z",
      limit: 10,
    });
    expect(page.from).toMatch(/^2026-11-18T12:00:00/);
    const call = transport.mock.calls.find(([r]) => r.path.endsWith("/observations"))![0];
    expect(call.query).toEqual({
      from: "2026-11-18T12:00:00.000Z",
      to: "2026-11-19T12:00:00.000Z",
      limit: "10",
    });
    expect(call.timeoutMs).toBeLessThanOrEqual(20_000);
    for (const query of [
      { from: "2026-11-19", to: "2026-11-20T00:00:00Z" },
      { from: "2026-11-19T00:00:00", to: "2026-11-20T00:00:00Z" },
      { from: "2026-11-20T00:00:00Z", to: "2026-11-19T00:00:00Z" },
      { from: "2025-01-01T00:00:00Z", to: "2026-11-19T00:00:00Z" },
      { from: "2026-11-18T00:00:00Z", to: "2026-11-19T00:00:00Z", limit: 5001 },
      { from: "2026-11-18T00:00:00Z", to: "2026-11-19T00:00:00Z", cursor: "not a cursor" },
      { from: "2026-11-18T00:00:00Z", to: "2026-11-19T00:00:00Z", knownAt: "2026-11-19T00:00:00Z" },
    ]) {
      await expect(client.getHistory("ea-colwick-level", query)).rejects.toMatchObject({
        code: "INVALID_QUERY",
      });
    }
  });

  it("follows continuation cursors without caching them", async () => {
    const { client, transport } = setup();
    const window = { from: "2026-11-19T00:00:00Z", to: "2026-11-19T12:00:00Z", limit: 20 };
    const first = await client.getHistory("ea-colwick-level", window);
    expect(first.nextCursor).not.toBeNull();
    const second = await client.getHistory("ea-colwick-level", {
      ...window,
      cursor: first.nextCursor!,
    });
    await client.getHistory("ea-colwick-level", { ...window, cursor: first.nextCursor! });
    expect(first.kind === "instantaneous" && second.kind === "instantaneous").toBe(true);
    expect(paths(transport).filter((p) => p.endsWith("/observations"))).toHaveLength(3);
  });

  it("accepts knownAt only for period totals", async () => {
    const { client } = setup();
    const page = await client.getHistory("ea-stone-rainfall", {
      from: "2026-11-19T00:00:00Z",
      to: "2026-11-19T06:00:00Z",
      knownAt: "2026-11-19T10:00:00Z",
    });
    expect(page.kind).toBe("period_total");
  });
});

describe("upstream limiter", () => {
  it("caps concurrency and sheds load beyond its queue", async () => {
    const limit = createLimiter(1, 1);
    let release!: () => void;
    const first = limit(() => new Promise<void>((resolve) => (release = resolve)));
    const second = limit(async () => "queued");
    await expect(limit(async () => "shed")).rejects.toMatchObject({ code: "THROTTLED" });
    release();
    await first;
    await expect(second).resolves.toBe("queued");
  });
});
