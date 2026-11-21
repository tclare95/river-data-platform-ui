// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { HISTORY_MAX_PAGES, HISTORY_PAGE_LIMIT, loadHistory } from "@/lib/history/load";
import { rangeWindow } from "@/lib/history/range";
import { buildSeries } from "@/lib/history/series";
import { createRdpClient } from "@/lib/rdp/client";
import type { Coverage, LabelConvention, RainfallWindow } from "@/lib/rdp/contract";
import { RdpError } from "@/lib/rdp/errors";
import { createFixtureTransport } from "@/lib/rdp/fixture";
import { withDeadlineAndRetry, type RdpTransport } from "@/lib/rdp/transport";

const NOW = Date.parse("2026-11-19T12:07:00Z");
const MINUTE = 60_000;
const QUARTER = 15 * MINUTE;
const DAY = 24 * 60 * MINUTE;
const ID = "ea-colwick-level";
const RAIN_ID = "ea-stone-rainfall";
/** The detail page's 30-day window at NOW: [from, to) on whole UTC hours. */
const WINDOW = { from: "2026-10-20T13:00:00.000Z", to: "2026-11-19T13:00:00.000Z" };
const FROM_MS = Date.parse(WINDOW.from);
const TO_MS = Date.parse(WINDOW.to);

/** RDP's wire form: UTC with seven fractional digits. */
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, ".0000000Z");

type Row = Record<string, unknown>;
type Body = { data: Row[]; meta: Record<string, unknown> };
type Query = Readonly<Record<string, string>>;
type Handler = (query: Query, call: number) => unknown;

const UNKNOWN: Coverage = {
  status: "unknown",
  gaps: [{ from: iso(FROM_MS), to: iso(TO_MS), reason: "unknown" }],
};

function row(ms: number, value: number, extra: Row = {}): Row {
  return {
    observedAt: iso(ms),
    value,
    unit: "mASD",
    datum: "ASD",
    quality: JSON.stringify("Good"),
    sourceId: "ea-flood-monitoring",
    providerMeasureId: "4009-level-stage-i-15_min-mASD",
    ingestedAt: iso(ms + 5 * MINUTE),
    sourceReference: `test:${ms}`,
    revision: 1,
    ...extra,
  };
}

/** Regular 15-minute readings from `from` (inclusive) for `count` samples. */
function regular(count: number, start = FROM_MS): Row[] {
  return Array.from({ length: count }, (_, i) => row(start + i * QUARTER, 20 + i / 10_000));
}

function body(
  query: Query,
  data: Row[],
  nextCursor: string | null,
  meta: Record<string, unknown> = {},
): Body {
  return {
    data,
    meta: {
      measurementId: ID,
      from: iso(Date.parse(query.from)),
      to: iso(Date.parse(query.to)),
      requestAsOf: iso(NOW),
      cutoff: iso(NOW - 365 * DAY),
      coverage: UNKNOWN,
      pageIntegrity: "verified",
      nextCursor,
      ...meta,
    },
  };
}

/**
 * A scripted RDP serving `rows` with an offset cursor tagged by generation (`g<gen>o<offset>`). `pageSize` below the
 * requested limit simulates RDP's byte trimming. Every first-page request starts a new generation.
 */
function paged(
  rows: Row[],
  options: {
    pageSize?: number;
    coverage?: Coverage;
    requestAsOf?: (call: number) => string;
    rejectCursor?: (generation: number) => RdpError | undefined;
  } = {},
): Handler {
  let generation = 0;
  return (query, call) => {
    let offset = 0;
    let gen = generation;
    if (query.cursor === undefined) {
      gen = ++generation;
    } else {
      const match = /^g(\d+)o(\d+)$/.exec(query.cursor);
      if (!match) throw new RdpError("INVALID_CURSOR", 400);
      gen = Number(match[1]);
      offset = Number(match[2]);
      const rejection = options.rejectCursor?.(gen);
      if (rejection) throw rejection;
    }
    const size = Math.min(options.pageSize ?? Number.POSITIVE_INFINITY, Number(query.limit));
    const next = offset + size < rows.length ? `g${gen}o${offset + size}` : null;
    return body(query, rows.slice(offset, offset + size), next, {
      coverage: options.coverage ?? UNKNOWN,
      ...(options.requestAsOf ? { requestAsOf: options.requestAsOf(call) } : {}),
    });
  };
}

function setup(handler: Handler) {
  const fixture = createFixtureTransport(() => NOW);
  const requests: Query[] = [];
  const transport: RdpTransport = async (request) => {
    // The published catalogue comes from the fixture; only observation reads are scripted.
    if (!request.path.endsWith("/observations")) return fixture(request);
    requests.push({ ...request.query });
    return handler(request.query, requests.length);
  };
  const rdp = createRdpClient({
    mode: "fixture",
    transport,
    now: () => NOW,
    // The frozen clock never refills the request budget; rate limiting is covered in client tests.
    ratePerSecond: Number.POSITIVE_INFINITY,
    log: () => undefined,
  });
  return { rdp, requests, load: () => loadHistory(rdp, ID, "instantaneous", WINDOW) };
}

/** Wraps a handler so the n-th observation request (1-based) is answered differently. */
function onCall(
  base: Handler,
  n: number,
  replace: (query: Query, original: () => Body) => unknown,
) {
  return (query: Query, call: number) =>
    call === n ? replace(query, () => base(query, call) as Body) : base(query, call);
}

describe("loadHistory: continuation", () => {
  it("reads a 30-day 15-minute window (2,880 readings) across two pages, once each and in order", async () => {
    const rows = regular(2880);
    const { load, requests } = setup(
      paged(rows, {
        requestAsOf: (call) => (call === 1 ? iso(NOW) : iso(NOW + 4 * MINUTE)),
      }),
    );
    const result = await load();
    expect(result.status).toBe("ok");
    if (result.status !== "ok" || !("observations" in result)) return;
    expect(result.pages).toBe(2);
    expect(result.observations).toHaveLength(2880);
    expect(result.observations.map((o) => o.observedAt)).toEqual(rows.map((r) => r.observedAt));
    expect(new Set(result.observations.map((o) => o.observedAt)).size).toBe(2880);
    expect(result.observations[0].observedAt).toBe(iso(FROM_MS));
    expect(result.observations.at(-1)!.observedAt).toBe(iso(TO_MS - QUARTER));
    // Page 1 fixes the read instant; a continuation's own instant never replaces it.
    expect(result.retrievedAt).toBe(iso(NOW));
    expect(result.coverage).toEqual(UNKNOWN);
    expect(Date.parse(result.from)).toBe(FROM_MS);
    expect(Date.parse(result.to)).toBe(TO_MS);

    expect(requests).toHaveLength(2);
    const [first, second] = requests;
    expect(first.cursor).toBeUndefined();
    expect(first.limit).toBe(String(HISTORY_PAGE_LIMIT));
    expect(second).toEqual({
      from: first.from,
      to: first.to,
      limit: first.limit,
      cursor: "g1o2000",
    });
  });

  it("keeps a reading exactly at the inclusive start", async () => {
    const { load } = setup(paged([row(FROM_MS, 1.5), row(FROM_MS + QUARTER, 1.6)]));
    const result = await load();
    expect(result).toMatchObject({ status: "ok", pages: 1 });
    if (result.status === "ok" && "observations" in result)
      expect(result.observations[0].observedAt).toBe(iso(FROM_MS));
  });

  it("treats a row at the exclusive end as a broken page, not a shorter history", async () => {
    const { load } = setup(paged([row(TO_MS - QUARTER, 1), row(TO_MS, 2)]));
    await expect(load()).resolves.toEqual({ status: "unavailable" });
  });

  it("treats a row at the exclusive end on a continuation page as unavailable", async () => {
    const rows = [...regular(2000), row(TO_MS, 2)];
    const { load, requests } = setup(paged(rows));
    await expect(load()).resolves.toEqual({ status: "unavailable" });
    expect(requests).toHaveLength(2);
  });
});

describe("loadHistory: failed continuation pages", () => {
  it("returns unavailable when page 2 still fails with 503 after the transport's single retry", async () => {
    const attempt = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { code: "STORAGE_UNAVAILABLE", message: "x" } }), {
          status: 503,
          headers: { "content-type": "application/json", "retry-after": "2" },
        }),
    );
    const { load, requests } = setup(
      onCall(paged(regular(2880)), 2, () =>
        withDeadlineAndRetry(20_000, attempt, {
          sleep: async () => undefined,
          now: () => NOW,
          random: () => 0.5,
        }),
      ),
    );
    await expect(load()).resolves.toEqual({ status: "unavailable" });
    expect(attempt).toHaveBeenCalledTimes(2);
    // No restart: only cursor errors restart.
    expect(requests).toHaveLength(2);
  });

  it.each([
    ["throttled (429)", () => Promise.reject(new RdpError("THROTTLED", 429))],
    ["a timeout", () => Promise.reject(new RdpError("TIMEOUT"))],
    ["an invalid cursor", () => Promise.reject(new RdpError("INVALID_CURSOR", 400))],
  ])("returns unavailable when page 2 is %s", async (_name, fail) => {
    const { load, requests } = setup(onCall(paged(regular(2880)), 2, fail));
    await expect(load()).resolves.toEqual({ status: "unavailable" });
    expect(requests).toHaveLength(2);
  });

  it.each([
    ["missing page integrity", (b: Body) => void delete b.meta.pageIntegrity],
    ["a string value", (b: Body) => void (b.data[0].value = "20.1")],
    ["a different unit", (b: Body) => void (b.data[0].unit = "m")],
    ["a different datum", (b: Body) => void (b.data[0].datum = "mAOD")],
    ["a different window echo", (b: Body) => void (b.meta.to = iso(TO_MS + QUARTER))],
    ["another measurement", (b: Body) => void (b.meta.measurementId = "ea-shardlow-level")],
    ["revision 0", (b: Body) => void (b.data[0].revision = 0)],
  ])("returns unavailable when page 2 has %s", async (_name, corrupt) => {
    const { load } = setup(
      onCall(paged(regular(2880)), 2, (_query, original) => {
        const page = original();
        corrupt(page);
        return page;
      }),
    );
    await expect(load()).resolves.toEqual({ status: "unavailable" });
  });

  it("restarts once from a fresh page 1 when page 2's cursor has expired, despite the 60 s cache", async () => {
    const rows = regular(2880);
    const { load, requests } = setup(
      paged(rows, {
        // Only the first generation's cursor has expired; a reused cached page 1 would resend it and fail.
        rejectCursor: (gen) => (gen === 1 ? new RdpError("CURSOR_EXPIRED", 409) : undefined),
      }),
    );
    const result = await load();
    expect(requests.map((q) => q.cursor)).toEqual([undefined, "g1o2000", undefined, "g2o2000"]);
    expect(result).toMatchObject({ status: "ok", pages: 2 });
    if (result.status === "ok" && "observations" in result) {
      expect(result.observations.map((o) => o.observedAt)).toEqual(rows.map((r) => r.observedAt));
    }
    const windows = requests.map(({ from, to, limit }) => ({ from, to, limit }));
    expect(new Set(windows.map((w) => JSON.stringify(w))).size).toBe(1);
  });

  it("gives up after exactly one restart when the cursor is repeatedly stale", async () => {
    const { load, requests } = setup(
      paged(regular(2880), { rejectCursor: () => new RdpError("CURSOR_STALE", 409) }),
    );
    await expect(load()).resolves.toEqual({ status: "unavailable" });
    expect(requests.map((q) => q.cursor)).toEqual([undefined, "g1o2000", undefined, "g2o2000"]);
  });

  it("counts each cursor failure against the single restart", async () => {
    let rejected = 0;
    const { load, requests } = setup(
      paged(regular(2880), {
        rejectCursor: () => (rejected++ < 2 ? new RdpError("CURSOR_STALE", 409) : undefined),
      }),
    );
    // Two cursor failures exhaust the single restart.
    await expect(load()).resolves.toEqual({ status: "unavailable" });
    expect(requests).toHaveLength(4);
  });

  it("reports more than four pages as too large and never requests a fifth", async () => {
    const { load, requests } = setup(paged(regular(50), { pageSize: 10 }));
    await expect(load()).resolves.toEqual({ status: "too_large" });
    expect(requests).toHaveLength(HISTORY_MAX_PAGES);
  });

  it("accepts exactly four byte-trimmed pages", async () => {
    const rows = regular(40);
    const { load, requests } = setup(paged(rows, { pageSize: 10 }));
    const result = await load();
    expect(result).toMatchObject({ status: "ok", pages: 4 });
    if (result.status === "ok" && "observations" in result)
      expect(result.observations).toHaveLength(40);
    expect(requests).toHaveLength(4);
  });
});

describe("loadHistory: page consistency", () => {
  it("returns unavailable when coverage differs between pages", async () => {
    const partial: Coverage = {
      status: "partial",
      gaps: [{ from: iso(FROM_MS), to: iso(FROM_MS + DAY), reason: "source_outage" }],
    };
    const { load } = setup(
      onCall(paged(regular(2880)), 2, (_query, original) => {
        const page = original();
        page.meta.coverage = partial;
        return page;
      }),
    );
    await expect(load()).resolves.toEqual({ status: "unavailable" });
  });

  it("returns unavailable when page 2 repeats page 1's last reading", async () => {
    const rows = regular(2880);
    const { load } = setup((query) =>
      query.cursor === undefined
        ? body(query, rows.slice(0, 2000), "g1o2000")
        : body(query, rows.slice(1999), null),
    );
    await expect(load()).resolves.toEqual({ status: "unavailable" });
  });

  it("returns unavailable when page 2 overlaps earlier readings", async () => {
    const rows = regular(2880);
    const { load } = setup((query) =>
      query.cursor === undefined
        ? body(query, rows.slice(0, 2000), "g1o2000")
        : body(query, rows.slice(1500), null),
    );
    await expect(load()).resolves.toEqual({ status: "unavailable" });
  });

  it("returns unavailable for an empty page that still carries a cursor", async () => {
    const rows = regular(10);
    const { load } = setup((query) =>
      query.cursor === undefined ? body(query, [], "g1o0") : body(query, rows, null),
    );
    await expect(load()).resolves.toEqual({ status: "unavailable" });
  });

  it.each<[string, Coverage]>([
    ["unknown", UNKNOWN],
    [
      "partial",
      {
        status: "partial",
        gaps: [
          { from: iso(FROM_MS), to: iso(FROM_MS + DAY), reason: "source_outage" },
          { from: iso(FROM_MS + DAY), to: iso(TO_MS), reason: "unknown" },
        ],
      },
    ],
    ["complete", { status: "complete", gaps: [] }],
  ])("passes %s coverage through unchanged when there are no readings", async (_name, coverage) => {
    const { load, requests } = setup(paged([], { coverage }));
    const result = await load();
    expect(result).toEqual({
      status: "ok",
      from: iso(FROM_MS),
      to: iso(TO_MS),
      retrievedAt: iso(NOW),
      coverage,
      observations: [],
      pages: 1,
    });
    expect(requests).toHaveLength(1);
  });
});

describe("loadHistory: projection", () => {
  it("preserves values, quality, revisions and ingestion times, and drops upstream-only fields", async () => {
    const t = FROM_MS + 6 * QUARTER;
    const rows = [
      row(t, -0.215, { quality: null }),
      row(t + QUARTER, 0, { revision: 3, ingestedAt: iso(t + 3 * DAY) }),
      row(t + 2 * QUARTER, 21.0071, { quality: "Suspect" }),
    ];
    const { load } = setup(paged(rows));
    const result = await load();
    expect(result.status).toBe("ok");
    if (result.status !== "ok" || !("observations" in result)) return;
    expect(result.observations).toEqual([
      {
        observedAt: iso(t),
        value: -0.215,
        quality: null,
        ingestedAt: iso(t + 5 * MINUTE),
        revision: 1,
      },
      {
        observedAt: iso(t + QUARTER),
        value: 0,
        quality: JSON.stringify("Good"),
        ingestedAt: iso(t + 3 * DAY),
        revision: 3,
      },
      {
        observedAt: iso(t + 2 * QUARTER),
        value: 21.0071,
        quality: "Suspect",
        ingestedAt: iso(t + 2 * QUARTER + 5 * MINUTE),
        revision: 1,
      },
    ]);
    for (const observation of result.observations) {
      expect(observation.ingestedAt).not.toBe(observation.observedAt);
      expect(observation).not.toHaveProperty("sourceReference");
      expect(observation).not.toHaveProperty("providerMeasureId");
      expect(observation).not.toHaveProperty("sourceId");
    }
    expect(result).not.toHaveProperty("nextCursor");
    expect(result).not.toHaveProperty("cutoff");
  });

  it("ignores unknown upstream fields on rows and metadata", async () => {
    const rows = [row(FROM_MS, 1, { futureField: "x", sourceReference: "s3://secret/key" })];
    const { load } = setup((query) => body(query, rows, null, { requestId: "abc", debug: {} }));
    const result = await load();
    expect(JSON.stringify(result)).not.toMatch(/futureField|secret|requestId|debug/);
  });

  it("defers when RDP answers with a period-total page", async () => {
    const fixture = createFixtureTransport(() => NOW);
    const rdp = createRdpClient({
      mode: "fixture",
      transport: fixture,
      now: () => NOW,
      ratePerSecond: Number.POSITIVE_INFINITY,
      log: () => undefined,
    });
    await expect(
      loadHistory(rdp, "ea-stone-rainfall", "instantaneous", rangeWindow("7d", NOW)),
    ).resolves.toEqual({ status: "deferred" });
  });
});

function rainfallRow(
  t: number,
  labelConvention: LabelConvention,
  totalMm: number,
  extra: Row = {},
) {
  return {
    label: iso(t),
    labelConvention,
    periodSeconds: 900,
    periodStart:
      labelConvention === "unverified"
        ? null
        : iso(t - (labelConvention === "period_end" ? QUARTER : 0)),
    periodEnd:
      labelConvention === "unverified"
        ? null
        : iso(t + (labelConvention === "period_start" ? QUARTER : 0)),
    totalMm,
    sourceValue: String(totalMm),
    quality: null,
    eligible: true,
    ineligibleReason: null,
    knownAt: null,
    sourceId: "ea-flood-monitoring",
    providerMeasureId: "3014-rainfall-tipping_bucket_raingauge-t-15_min-mm",
    ingestedAt: iso(t + MINUTE),
    sourceReference: "fixture:rain",
    revision: 1,
    ...extra,
  };
}

function rainPage(
  query: Query,
  data: Row[],
  nextCursor: string | null,
  window: RainfallWindow | null = null,
) {
  return body(query, data, nextCursor, {
    measurementId: RAIN_ID,
    valueType: "total",
    periodSeconds: 900,
    knownAt: null,
    window,
    windowUnavailable: nextCursor !== null || query.cursor !== undefined ? "paginated" : null,
  });
}

describe("loadHistory: rainfall", () => {
  const range = { from: WINDOW.from, to: iso(FROM_MS + 4 * QUARTER) };
  const rain = [
    rainfallRow(FROM_MS, "period_end", 0),
    rainfallRow(FROM_MS + QUARTER, "period_end", 0.4, {
      quality: "Missing",
      eligible: false,
      ineligibleReason: "QualityMissing",
    }),
    rainfallRow(FROM_MS + 3 * QUARTER, "period_end", 0.8, { revision: 2 }),
  ];
  const summary: RainfallWindow = {
    firstLabel: iso(FROM_MS),
    lastLabel: iso(FROM_MS + 3 * QUARTER),
    expectedIntervals: 4,
    reported: 3,
    eligible: 2,
    absent: 1,
    ineligible: 1,
    notKnownAt: 0,
    status: "incomplete",
    totalMm: null,
    labelConvention: "period_end",
    periodStart: iso(FROM_MS - QUARTER),
    periodEnd: iso(FROM_MS + 3 * QUARTER),
    gaps: [
      {
        fromLabel: iso(FROM_MS + QUARTER),
        toLabel: iso(FROM_MS + QUARTER),
        intervals: 1,
        reason: "QualityMissing",
      },
      {
        fromLabel: iso(FROM_MS + 2 * QUARTER),
        toLabel: iso(FROM_MS + 2 * QUARTER),
        intervals: 1,
        reason: "absent",
      },
    ],
    gapsTruncated: false,
    knownAt: null,
    knownAtBasis: "latest_stored",
  };

  it("keeps RDP's whole-window gaps and distinguishes zero, ineligible and absent intervals", async () => {
    const { rdp } = setup((query) => rainPage(query, rain, null, summary));
    const result = await loadHistory(rdp, RAIN_ID, "period_total", range);
    expect(result).toMatchObject({
      status: "ok",
      pages: 1,
      periodSeconds: 900,
      window: summary,
      windowUnavailable: null,
      intervals: [
        {
          label: iso(FROM_MS),
          periodStart: iso(FROM_MS - QUARTER),
          periodEnd: iso(FROM_MS),
          totalMm: 0,
          eligible: true,
        },
        {
          label: iso(FROM_MS + QUARTER),
          quality: "Missing",
          totalMm: null,
          eligible: false,
          ineligibleReason: "QualityMissing",
        },
        { label: iso(FROM_MS + 3 * QUARTER), totalMm: 0.8, revision: 2 },
      ],
    });
  });

  it("follows the same label window across pages without deriving gaps, bounds or totals", async () => {
    const start = rainfallRow(FROM_MS + QUARTER, "period_start", 0.6);
    const unverified = rainfallRow(FROM_MS + 3 * QUARTER, "unverified", 0, { revision: 2 });
    const { rdp, requests } = setup((query) =>
      query.cursor
        ? rainPage(query, [unverified], null)
        : rainPage(query, [rain[0], start], "rain2"),
    );
    const result = await loadHistory(rdp, RAIN_ID, "period_total", range);
    expect(result).toMatchObject({
      status: "ok",
      pages: 2,
      retrievedAt: iso(NOW),
      coverage: UNKNOWN,
      window: null,
      windowUnavailable: "paginated",
      intervals: [
        {
          label: iso(FROM_MS),
          labelConvention: "period_end",
          periodStart: iso(FROM_MS - QUARTER),
          periodEnd: iso(FROM_MS),
        },
        {
          label: start.label,
          labelConvention: "period_start",
          periodStart: start.label,
          periodEnd: iso(FROM_MS + 2 * QUARTER),
        },
        {
          label: unverified.label,
          labelConvention: "unverified",
          periodStart: null,
          periodEnd: null,
          totalMm: 0,
          revision: 2,
        },
      ],
    });
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({ limit: String(HISTORY_PAGE_LIMIT) });
    expect(requests[1]).toEqual({ ...requests[0], cursor: "rain2" });
  });

  it.each(["failed continuation", "overlapping label", "summary on a continuation"])(
    "returns no rainfall intervals after %s",
    async (issue) => {
      const { rdp, requests } = setup((query) => {
        if (!query.cursor) return rainPage(query, rain.slice(0, 2), "rain2");
        if (issue === "failed continuation") throw new RdpError("STORAGE_UNAVAILABLE", 503);
        if (issue === "overlapping label") return rainPage(query, rain.slice(1), null);
        return rainPage(query, rain.slice(2), null, summary);
      });
      await expect(loadHistory(rdp, RAIN_ID, "period_total", range)).resolves.toEqual({
        status: "unavailable",
      });
      expect(requests).toHaveLength(2);
    },
  );

  it.each([false, true])(
    "restarts from a fresh first page once (repeated failure: %s)",
    async (repeated) => {
      const { rdp, requests } = setup((query, call) => {
        if (query.cursor === "stale" || (repeated && query.cursor === "fresh")) {
          throw new RdpError("CURSOR_STALE", 409);
        }
        if (query.cursor === "fresh") return rainPage(query, rain.slice(1), null);
        if (call === 1) return rainPage(query, [{ ...rain[0], totalMm: 0.2 }], "stale");
        return rainPage(query, rain.slice(0, 1), "fresh");
      });
      const result = await loadHistory(rdp, RAIN_ID, "period_total", range);
      expect(requests.map((query) => query.cursor)).toEqual([
        undefined,
        "stale",
        undefined,
        "fresh",
      ]);
      if (repeated) {
        expect(result).toEqual({ status: "unavailable" });
      } else {
        expect(result).toMatchObject({
          status: "ok",
          pages: 2,
          intervals: [{ totalMm: 0 }, { eligible: false }, { revision: 2 }],
        });
      }
    },
  );
});

describe("loadHistory: fixture transport", () => {
  it("assembles 30 days of fixture rainfall without a whole-window summary", async () => {
    const { rdp } = setup((query) =>
      createFixtureTransport(() => NOW)({
        path: `/v1/measurements/${RAIN_ID}/observations`,
        query,
        timeoutMs: 20_000,
      }),
    );
    const result = await loadHistory(rdp, RAIN_ID, "period_total", WINDOW);
    expect(result).toMatchObject({
      status: "ok",
      pages: 2,
      window: null,
      windowUnavailable: "paginated",
    });
    if (result.status !== "ok" || !("intervals" in result)) throw new Error("expected rainfall");
    expect(result.intervals.length).toBeGreaterThan(HISTORY_PAGE_LIMIT);
    expect(new Set(result.intervals.map(({ label }) => label)).size).toBe(result.intervals.length);
  });
  it("reads 30 days of Colwick over several pages with a weekly missing interval and corrections", async () => {
    const fixture = createFixtureTransport(() => NOW);
    const calls: Query[] = [];
    const rdp = createRdpClient({
      mode: "fixture",
      transport: (request) => {
        if (request.path.endsWith("/observations")) calls.push(request.query);
        return fixture(request);
      },
      now: () => NOW,
      ratePerSecond: Number.POSITIVE_INFINITY,
      log: () => undefined,
    });
    const window = rangeWindow("30d", NOW);
    const result = await loadHistory(rdp, ID, "instantaneous", window);
    expect(result.status).toBe("ok");
    if (result.status !== "ok" || !("observations" in result)) return;
    expect(result.pages).toBeGreaterThanOrEqual(2);
    expect(calls).toHaveLength(result.pages);

    const times = result.observations.map((o) => Date.parse(o.observedAt));
    expect(times.every((t, i) => i === 0 || t > times[i - 1])).toBe(true);
    expect(times[0]).toBeGreaterThanOrEqual(Date.parse(window.from));
    expect(times.at(-1)!).toBeLessThan(Date.parse(window.to));

    // The weekly three-hour hole (12 missing samples) appears as a 13-interval step with no rows inside.
    const steps = times.slice(1).map((t, i) => t - times[i]);
    expect(steps.filter((step) => step === 13 * QUARTER).length).toBeGreaterThanOrEqual(4);
    expect(steps.every((step) => step === QUARTER || step === 13 * QUARTER)).toBe(true);
    expect(result.observations.some((o) => o.revision === 2)).toBe(true);

    const series = buildSeries(
      result.observations.map(({ observedAt, value }) => ({ observedAt, value })),
      900,
    );
    expect(series.missing.length).toBe(steps.filter((step) => step > QUARTER).length);
    expect(series.count).toBe(result.observations.length);
  });
});

describe("assembled window cache", () => {
  function counting(fail: () => boolean) {
    const fixture = createFixtureTransport(() => NOW);
    const calls = { history: 0 };
    const transport: RdpTransport = async (request) => {
      if (request.path.endsWith("/observations")) {
        calls.history++;
        if (fail()) throw new RdpError("STORAGE_UNAVAILABLE", 503);
      }
      return fixture(request);
    };
    return { calls, client: createRdpClient({ mode: "fixture", transport, log: () => undefined }) };
  }

  it("reads a multi-page window once, including its continuation pages", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
    try {
      const { calls, client } = counting(() => false);
      const window = rangeWindow("30d", NOW);
      const [first, concurrent] = await Promise.all([
        loadHistory(client, ID, "instantaneous", window),
        loadHistory(client, ID, "instantaneous", window),
      ]);
      expect(first.status).toBe("ok");
      expect(concurrent).toBe(first);
      const pages = calls.history;
      expect(pages).toBeGreaterThan(1);
      await loadHistory(client, ID, "instantaneous", window);
      expect(calls.history).toBe(pages);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never serves a failure from cache", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
    try {
      let failing = true;
      const { client } = counting(() => failing);
      const window = rangeWindow("7d", NOW);
      expect((await loadHistory(client, ID, "instantaneous", window)).status).toBe("unavailable");
      failing = false;
      expect((await loadHistory(client, ID, "instantaneous", window)).status).toBe("ok");
    } finally {
      vi.useRealTimers();
    }
  });
});
