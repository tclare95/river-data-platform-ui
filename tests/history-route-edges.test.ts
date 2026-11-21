// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rangeWindow } from "@/lib/history/range";
import { createRdpClient, type HistoryQuery, type RdpClient } from "@/lib/rdp/client";
import { createFixtureTransport } from "@/lib/rdp/fixture";

let client: RdpClient;
vi.mock("@/lib/rdp/server", async () => ({
  getRdpClient: () => client,
  RdpError: (await import("@/lib/rdp/errors")).RdpError,
}));
const { GET, HISTORY_BOUNDS } = await import("@/app/api/measurements/[id]/history/route");

const NOW = Date.parse("2026-11-19T12:07:42.123Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
let historyCalls: HistoryQuery[];

function call(id: string, query = "") {
  return GET(new Request(`https://ui.test/api/measurements/${id}/history${query}`), {
    params: Promise.resolve({ id }),
  } as never);
}

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  const base = createRdpClient({
    mode: "fixture",
    transport: createFixtureTransport(() => NOW),
    now: () => NOW,
    // The frozen test clock never refills the request budget; rate limiting is covered elsewhere.
    ratePerSecond: Number.POSITIVE_INFINITY,
    log: () => undefined,
  });
  historyCalls = [];
  client = {
    ...base,
    getHistory: (id, query) => {
      historyCalls.push(query);
      return base.getHistory(id, query);
    },
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("history route edges", () => {
  it("defaults to the detail page's 7-day window ending on the latest whole hour", async () => {
    const response = await call("ea-colwick-level");
    expect(response.status).toBe(200);
    expect(historyCalls).toHaveLength(1);
    const { from, to, limit } = historyCalls[0];
    expect({ from, to }).toEqual(rangeWindow("7d", NOW));
    expect(to).toBe("2026-11-19T12:00:00.000Z");
    expect(Date.parse(to) - Date.parse(from)).toBe(7 * DAY);
    expect(Date.parse(from) % HOUR).toBe(0);
    expect(limit).toBe(HISTORY_BOUNDS.pageLimit);
  });

  it("accepts an explicit endpoint exactly at now", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-19T12:00:00Z"));
    const response = await call("ea-colwick-level", "?from=2026-11-12T12:00Z&to=2026-11-19T12:00Z");
    expect(response.status).toBe(200);
    expect(historyCalls[0].to).toBe("2026-11-19T12:00:00.000Z");
  });

  it("keeps the default window stable until it advances at the hour boundary", async () => {
    await call("ea-colwick-level");
    vi.spyOn(Date, "now").mockReturnValue(NOW + 40 * 60_000);
    await call("ea-colwick-level");
    expect(historyCalls[1]).toEqual(historyCalls[0]);
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-19T13:00:00Z"));
    await call("ea-colwick-level");
    expect(historyCalls[2].to).toBe("2026-11-19T13:00:00.000Z");
  });

  it("accepts exactly 31 days and rejects 31 days plus one hour", async () => {
    const ok = await call("ea-colwick-level", "?from=2026-10-19T12:00Z&to=2026-11-19T12:00Z");
    expect(ok.status).toBe(200);
    const tooLong = await call("ea-colwick-level", "?from=2026-10-19T11:00Z&to=2026-11-19T12:00Z");
    expect(tooLong.status).toBe(400);
    expect(await tooLong.json()).toEqual({ error: { code: "INVALID_REQUEST" } });
    expect(historyCalls).toHaveLength(1);
  });

  it.each([
    ["a future end", "?from=2026-11-12T13:00Z&to=2026-11-19T13:00Z"],
    ["equal bounds", "?from=2026-11-19T00:00Z&to=2026-11-19T00:00Z"],
    ["a reversed window", "?from=2026-11-19T00:00Z&to=2026-11-18T00:00Z"],
    ["a non-hour bound", "?from=2026-11-18T00:30Z&to=2026-11-19T00:00Z"],
    ["non-zero seconds", "?from=2026-11-18T00:00:30Z&to=2026-11-19T00:00Z"],
    ["a caller-chosen limit", "?from=2026-11-18T00:00Z&to=2026-11-19T00:00Z&limit=10"],
    ["an empty cursor", "?from=2026-11-18T00:00Z&to=2026-11-19T00:00Z&cursor="],
    ["a date without time", "?from=2026-11-18&to=2026-11-19"],
  ])("rejects %s", async (_name, query) => {
    const response = await call("ea-colwick-level", query);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: "INVALID_REQUEST" } });
    expect(historyCalls).toHaveLength(0);
  });

  it("continues through cursor pages for the identical window", async () => {
    // 31 days of 15-minute readings (2,976) spans two fixed-size pages. Shardlow's fixture has no missing interval.
    const window = "from=2026-10-19T12:00Z&to=2026-11-19T12:00Z";
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query = cursor ? `?${window}&cursor=${cursor}` : `?${window}`;
      const response = await call("ea-shardlow-level", query);
      expect(response.status).toBe(200);
      const history = (await response.json()).data.history;
      expect(history.from).toMatch(/^2026-10-19T12:00:00/);
      expect(history.to).toMatch(/^2026-11-19T12:00:00/);
      expect(history.observations.length).toBeLessThanOrEqual(HISTORY_BOUNDS.pageLimit);
      seen.push(...history.observations.map((row: { observedAt: string }) => row.observedAt));
      cursor = history.nextCursor;
      pages++;
    } while (cursor && pages < 10);
    expect(pages).toBe(2);
    expect(seen).toHaveLength(31 * 96);
    expect(new Set(seen).size).toBe(seen.length);
    expect([...seen].sort()).toEqual(seen);
  });

  it("passes an invalid cursor through as INVALID_CURSOR", async () => {
    const response = await call(
      "ea-colwick-level",
      "?from=2026-11-18T00:00Z&to=2026-11-19T00:00Z&cursor=bm90LWpzb24",
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: "INVALID_CURSOR" } });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it.each(["ea-colwick-level", "ea-stone-rainfall"])(
    "never includes internal provenance for %s",
    async (id) => {
      const response = await call(id, "?from=2026-11-18T00:00Z&to=2026-11-19T00:00Z");
      expect(response.status).toBe(200);
      const text = await response.text();
      for (const hidden of [
        "providerMeasureId",
        "sourceReference",
        "cutoff",
        "sourceValue",
        "fixture:",
      ]) {
        expect(text).not.toContain(hidden);
      }
    },
  );
});
