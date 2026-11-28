import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/measurements/rainfall-map/route";
import { loadHistory } from "@/lib/history/load";
import type { RainfallInterval, RainfallResult } from "@/lib/history/rainfall";
import { createRdpClient } from "@/lib/rdp/client";
import { createFixtureTransport } from "@/lib/rdp/fixture";
import { getRdpClient } from "@/lib/rdp/server";

vi.mock("@/lib/rdp/server", () => ({ getRdpClient: vi.fn() }));
vi.mock("@/lib/history/load", () => ({ loadHistory: vi.fn() }));

const HOUR = 3_600_000;
const STEP = HOUR / 4;
const END = Date.parse("2026-11-28T12:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
const ids = ["ea-stone-rainfall", "rain-empty", "rain-quality", "rain-error"];
const window = { from: iso(END - 24 * HOUR), to: iso(END) };

function interval(end: number, totalMm: number | null): RainfallInterval {
  return {
    label: iso(end),
    labelConvention: "period_end",
    periodStart: iso(end - STEP),
    periodEnd: iso(end),
    totalMm,
    revision: 1,
    eligible: totalMm !== null,
    quality: null,
    ineligibleReason: totalMm === null ? "QualitySuspect" : null,
  };
}

function history(intervals: RainfallInterval[]): RainfallResult {
  return {
    ...window,
    status: "ok",
    retrievedAt: iso(END + HOUR / 2),
    coverage: { status: "unknown", gaps: [] },
    periodSeconds: 900,
    pages: 1,
    window: null,
    windowUnavailable: null,
    intervals,
  };
}

function request(query: string) {
  return GET(new Request(`https://example.test/api/measurements/rainfall-map?${query}`));
}

describe("map rainfall route", () => {
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: END + HOUR / 2 });
    const client = createRdpClient({ mode: "fixture", transport: createFixtureTransport() });
    const catalogue = await client.listMeasurements();
    const rain = catalogue.measurements.find(({ measurementId }) => measurementId === ids[0])!;
    vi.mocked(getRdpClient).mockReturnValue({
      ...client,
      listMeasurements: async () => ({
        ...catalogue,
        measurements: [
          ...catalogue.measurements,
          ...ids.slice(1).map((measurementId) => ({ ...rain, measurementId })),
          { ...rain, measurementId: "private-rain", provider: "private-provider" },
        ],
      }),
    });
    vi.mocked(loadHistory).mockReset();
  });

  afterEach(() => vi.useRealTimers());

  it("reuses the exact UTC window, includes a right-edge period and preserves per-gauge outcomes", async () => {
    vi.mocked(loadHistory)
      .mockResolvedValueOnce(history([interval(END - 24 * HOUR, 50), interval(END, 0)]))
      .mockResolvedValueOnce(history([]))
      .mockResolvedValueOnce(history([interval(END, null)]))
      .mockResolvedValueOnce({ status: "unavailable" });
    const response = await request(`period=24h&id=${ids.join("&id=")}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({
      window,
      readings: {
        "ea-stone-rainfall": {
          status: "total",
          total: {
            ...window,
            status: "partial",
            basis: "verified",
            totalMm: 0,
            used: 1,
            expected: 96,
          },
        },
        "rain-empty": { status: "missing" },
        "rain-quality": {
          status: "total",
          total: {
            ...window,
            status: "unavailable",
            basis: "verified",
            totalMm: null,
            used: 0,
            expected: 96,
          },
        },
        "rain-error": { status: "unavailable" },
      },
    });
    expect(
      vi.mocked(loadHistory).mock.calls.map(([, id, kind, source]) => [id, kind, source]),
    ).toEqual(ids.map((id) => [id, "period_total", { from: window.from, to: iso(END + 1) }]));
  });

  it.each([
    ["72h", 72],
    ["7d", 168],
  ])("supports %s without extra history lookback", async (period, hours) => {
    vi.mocked(loadHistory).mockResolvedValue(history([]));
    const response = await request(`period=${period}&id=${ids[0]}`);
    const from = iso(END - hours * HOUR);
    expect(await response.json()).toMatchObject({ window: { from, to: iso(END) } });
    expect(loadHistory).toHaveBeenCalledWith(expect.anything(), ids[0], "period_total", {
      from,
      to: iso(END + 1),
    });
  });

  it("rejects oversized batches, duplicate IDs, unapproved measurements and arbitrary windows", async () => {
    expect((await request(`period=24h&id=${ids.join("&id=")}&id=extra`)).status).toBe(400);
    expect((await request(`period=24h&id=${ids[0]}&id=${ids[0]}`)).status).toBe(400);
    expect((await request(`period=2d&id=${ids[0]}`)).status).toBe(400);
    expect((await request(`period=24h&id=${ids[0]}&from=${window.from}`)).status).toBe(400);
    expect((await request("period=24h&id=ea-colwick-level")).status).toBe(404);
    expect((await request("period=24h&id=private-rain")).status).toBe(404);
    expect(loadHistory).not.toHaveBeenCalled();
  });
});
