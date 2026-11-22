/**
 * Fixture mode: sample responses in RDP's exact wire shapes, for local development and tests.
 *
 * Identities and metadata mirror RDP's published registry (the production selection plus one EA rain gauge,
 * in registry order); every value is synthetic and generated
 * deterministically. The UI labels fixture mode visibly, and Vercel Production refuses it (see config.ts).
 * The fixture cursor is a plain offset, not RDP's AEAD cursor.
 */
import { RdpError } from "./errors";
import type { RdpTransport } from "./transport";
import { UPSTREAM_MEASUREMENTS_PATH } from "./upstream-measurements";

const QUARTER_HOUR = 15 * 60 * 1000;

type FixtureMeasure = {
  wire: Record<string, unknown>;
  providerMeasureId: string;
  /** Minutes behind "now" of the newest sample, or null when never collected. */
  lagMinutes: number | null;
  sample: (index: number) => number;
  /** Sample indexes (quarter-hours since the epoch) with no stored reading, to exercise missing intervals. */
  missing?: (index: number) => boolean;
  /** Sample indexes stored as a correction (revision 2). */
  corrected?: (index: number) => boolean;
};

const EA = {
  provider: "environment-agency",
  sourceId: "ea-flood-monitoring",
  datum: "ASD",
  expectedIntervalSeconds: 900,
};

export const FIXTURE_MEASURES: ReadonlyArray<FixtureMeasure> = [
  {
    wire: {
      ...EA,
      measurementId: "ea-colwick-level",
      stationId: "ea-colwick",
      parameter: "level",
      unit: "mASD",
      name: "Colwick",
    },
    providerMeasureId: "4009-level-stage-i-15_min-mASD",
    lagMinutes: 20,
    sample: (i) => round(20.6 + 0.25 * Math.sin(i / 40), 3),
    // Three hours missing once a week and an occasional correction.
    missing: (i) => i % 672 >= 300 && i % 672 < 312,
    corrected: (i) => i % 500 === 0,
  },
  {
    wire: {
      ...EA,
      measurementId: "ea-shardlow-level",
      stationId: "ea-shardlow",
      parameter: "level",
      unit: "mASD",
      name: "Shardlow",
    },
    providerMeasureId: "4007-level-stage-i-15_min-mASD",
    lagMinutes: 20,
    sample: (i) => round(27.4 + 0.3 * Math.sin(i / 50), 3),
  },
  {
    wire: {
      ...EA,
      datum: "unknown",
      measurementId: "ea-shardlow-flow",
      stationId: "ea-shardlow",
      parameter: "flow",
      unit: "m3/s",
      name: "Shardlow",
    },
    providerMeasureId: "4007-flow--i-15_min-m3_s",
    lagMinutes: 190,
    sample: (i) => round(85 + 20 * Math.sin(i / 55), 2),
  },
  {
    wire: {
      ...EA,
      measurementId: "ea-clifton-bridge-level",
      stationId: "ea-clifton-bridge",
      parameter: "level",
      unit: "mASD",
      name: "Clifton Bridge",
    },
    providerMeasureId: "4126-level-stage-i-15_min-mASD",
    lagMinutes: 5,
    sample: (i) => round(21.9 + 0.2 * Math.sin(i / 45), 3),
  },
  {
    wire: {
      ...EA,
      measurementId: "ea-church-wilne-level",
      stationId: "ea-church-wilne",
      parameter: "level",
      unit: "mASD",
      name: "Church Wilne",
    },
    providerMeasureId: "4067-level-stage-i-15_min-mASD",
    lagMinutes: 20,
    sample: (i) => round(29.1 + 0.15 * Math.sin(i / 35), 3),
  },
  {
    wire: {
      ...EA,
      measurementId: "ea-kegworth-level",
      stationId: "ea-kegworth",
      parameter: "level",
      unit: "mASD",
      name: "Kegworth",
    },
    providerMeasureId: "4074-level-stage-i-15_min-mASD",
    lagMinutes: null,
    sample: () => 0,
  },
  {
    wire: {
      ...EA,
      datum: "none",
      measurementId: "ea-stone-rainfall",
      stationId: "ea-stone-raingauge",
      parameter: "rainfall",
      unit: "mm",
      name: "Stone",
      valueType: "total",
      periodSeconds: 900,
    },
    providerMeasureId: "3014-rainfall-tipping_bucket_raingauge-t-15_min-mm",
    lagMinutes: 60,
    sample: (i) => (i % 9 < 2 ? round(0.2 * ((i % 5) + 1), 1) : 0),
  },
];

function round(value: number, digits: number) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function iso(ms: number) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, ".0000000Z");
}

function find(id: string) {
  return FIXTURE_MEASURES.find((measure) => measure.wire.measurementId === id);
}

function isTotal(measure: FixtureMeasure) {
  return measure.wire.valueType === "total";
}

/** Newest sample time for a measure at `now`, aligned to the 15-minute grid. */
function newest(measure: FixtureMeasure, now: number): number | null {
  if (measure.lagMinutes === null) return null;
  return Math.floor((now - measure.lagMinutes * 60_000) / QUARTER_HOUR) * QUARTER_HOUR;
}

function freshnessAt(sampleMs: number | null, now: number) {
  if (sampleMs === null) return "unknown";
  return now - sampleMs <= 2 * QUARTER_HOUR ? "fresh" : "stale";
}

function latest(measure: FixtureMeasure, now: number) {
  const id = measure.wire.measurementId;
  const at = newest(measure, now);
  const value = at === null ? null : measure.sample(at / QUARTER_HOUR);
  if (isTotal(measure)) {
    return {
      measurementId: id,
      status: at === null ? "no_observations" : "available",
      valueType: "total",
      periodSeconds: 900,
      label: at === null ? null : iso(at),
      labelConvention: at === null ? null : "period_end",
      periodStart: at === null ? null : iso(at - QUARTER_HOUR),
      periodEnd: at === null ? null : iso(at),
      totalMm: value,
      unit: "mm",
      quality: null,
      eligible: at === null ? null : true,
      labelAgeSeconds: at === null ? null : Math.round((now - at) / 1000),
      freshness: freshnessAt(at, now),
      errorCode: null,
    };
  }
  return {
    measurementId: id,
    status: at === null ? "no_observations" : "available",
    observedAt: at === null ? null : iso(at),
    value,
    unit: measure.wire.unit,
    quality: at === null ? null : JSON.stringify("Good"),
    freshness: freshnessAt(at, now),
    errorCode: null,
  };
}

function health(measure: FixtureMeasure, now: number) {
  const at = newest(measure, now);
  const common = {
    measurementId: measure.wire.measurementId,
    lastAttemptAt: iso(now - 5 * 60_000),
    lastPersistedAt: at === null ? null : iso(at + 5 * 60_000),
    sourceState: "healthy",
    persistenceState: at === null ? "unknown" : "successful",
    freshness: freshnessAt(at, now),
    lastErrorCode: null,
  };
  if (isTotal(measure)) {
    return {
      ...common,
      valueType: "total",
      lastLabel: at === null ? null : iso(at),
      labelConvention: at === null ? null : "period_end",
      lastPeriodEnd: at === null ? null : iso(at),
      lastSourceLabel: at === null ? null : iso(at),
      labelToIngestSeconds: at === null ? null : 300,
    };
  }
  return {
    ...common,
    lastObservedAt: at === null ? null : iso(at),
    lastSourceObservedAt: at === null ? null : iso(at),
    ingestLagSeconds: at === null ? null : 300,
  };
}

function encodeCursor(offset: number) {
  return Buffer.from(JSON.stringify({ fixture: offset })).toString("base64url");
}

function decodeCursor(cursor: string): number {
  try {
    const offset = (
      JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { fixture?: unknown }
    ).fixture;
    if (Number.isSafeInteger(offset) && (offset as number) >= 0) return offset as number;
  } catch {
    // fall through
  }
  throw new RdpError("INVALID_CURSOR", 400);
}

function history(measure: FixtureMeasure, query: Readonly<Record<string, string>>, now: number) {
  const from = Date.parse(query.from ?? "");
  const to = Date.parse(query.to ?? "");
  const limit = Number(query.limit ?? "2000");
  if (
    !Number.isFinite(from) ||
    !Number.isFinite(to) ||
    from >= to ||
    to - from > 366 * 86_400_000
  ) {
    throw new RdpError("INVALID_QUERY", 400);
  }
  const last = newest(measure, now);
  const times: number[] = [];
  if (last !== null) {
    for (
      let t = Math.ceil(from / QUARTER_HOUR) * QUARTER_HOUR;
      t < to && t <= last;
      t += QUARTER_HOUR
    )
      if (!measure.missing?.(t / QUARTER_HOUR)) times.push(t);
  }
  const offset = query.cursor ? decodeCursor(query.cursor) : 0;
  const page = times.slice(offset, offset + limit);
  const nextCursor = offset + limit < times.length ? encodeCursor(offset + limit) : null;
  const total = isTotal(measure);
  const meta: Record<string, unknown> = {
    measurementId: measure.wire.measurementId,
    from: iso(from),
    to: iso(to),
    requestAsOf: iso(now),
    cutoff: iso(now - 365 * 86_400_000),
    coverage: { status: "unknown", gaps: [{ from: iso(from), to: iso(to), reason: "unknown" }] },
    pageIntegrity: "verified",
    nextCursor,
  };
  const provenance = (t: number) => ({
    sourceId: measure.wire.sourceId,
    providerMeasureId: measure.providerMeasureId,
    ingestedAt: iso(t + 5 * 60_000),
    sourceReference: `fixture:${measure.wire.measurementId}/${iso(t)}`,
    revision: measure.corrected?.(t / QUARTER_HOUR) ? 2 : 1,
  });
  if (!total) {
    const data = page.map((t) => ({
      observedAt: iso(t),
      value: measure.sample(t / QUARTER_HOUR),
      unit: measure.wire.unit,
      datum: measure.wire.datum,
      quality: JSON.stringify("Good"),
      ...provenance(t),
    }));
    return { data, meta };
  }
  const data = page.map((t) => {
    const totalMm = measure.sample(t / QUARTER_HOUR);
    return {
      label: iso(t),
      periodSeconds: 900,
      labelConvention: "period_end",
      periodStart: iso(t - QUARTER_HOUR),
      periodEnd: iso(t),
      totalMm,
      sourceValue: totalMm.toFixed(1),
      quality: null,
      eligible: true,
      ineligibleReason: null,
      knownAt: null,
      ...provenance(t),
    };
  });
  const firstLabel = Math.ceil(from / QUARTER_HOUR) * QUARTER_HOUR;
  const expected = Math.max(0, Math.ceil((to - firstLabel) / QUARTER_HOUR));
  const paginated = nextCursor !== null || offset > 0;
  const absent = expected - times.length;
  const window = paginated
    ? null
    : {
        firstLabel: expected > 0 ? iso(firstLabel) : null,
        lastLabel: expected > 0 ? iso(firstLabel + (expected - 1) * QUARTER_HOUR) : null,
        expectedIntervals: expected,
        reported: times.length,
        eligible: times.length,
        absent,
        ineligible: 0,
        notKnownAt: 0,
        status: expected === 0 ? "empty" : absent === 0 ? "complete" : "incomplete",
        totalMm:
          absent === 0 && expected > 0
            ? round(
                data.reduce((sum, row) => sum + row.totalMm, 0),
                1,
              )
            : null,
        labelConvention: "period_end",
        periodStart: expected > 0 ? iso(firstLabel - QUARTER_HOUR) : null,
        periodEnd: expected > 0 ? iso(firstLabel + (expected - 1) * QUARTER_HOUR) : null,
        gaps:
          absent > 0 && times.length < expected
            ? [
                {
                  fromLabel: iso(firstLabel + times.length * QUARTER_HOUR),
                  toLabel: iso(firstLabel + (expected - 1) * QUARTER_HOUR),
                  intervals: absent,
                  reason: "absent",
                },
              ]
            : [],
        gapsTruncated: false,
        knownAt: null,
        knownAtBasis: "latest_stored",
      };
  return {
    data,
    meta: {
      ...meta,
      valueType: "total",
      periodSeconds: 900,
      knownAt: null,
      window,
      windowUnavailable: paginated ? "paginated" : null,
    },
  };
}

/** Serves the four observation routes from synthetic data, mirroring RDP's status codes for bad requests. */
export function createFixtureTransport(now: () => number = Date.now): RdpTransport {
  return async ({ path, query }) => {
    const at = now();
    if (path === UPSTREAM_MEASUREMENTS_PATH)
      throw new RdpError("CATCHMENT_DISCOVERY_DISABLED", 404);
    if (path === "/v1/measurements") {
      return {
        // Fresh copies: a caller mutating the response must never alter the fixture registry.
        data: FIXTURE_MEASURES.map((measure) => structuredClone(measure.wire)),
        meta: { retrievedAt: iso(at) },
      };
    }
    if (path === "/v1/measurements/latest") {
      const ids = (query.ids ?? "").split(",");
      const measures = ids.map(find);
      if (measures.some((measure) => !measure)) throw new RdpError("MEASUREMENT_NOT_FOUND", 404);
      return {
        data: measures.map((measure) => latest(measure!, at)),
        meta: { retrievedAt: iso(at), partial: false },
      };
    }
    const match = /^\/v1\/measurements\/([a-z0-9][a-z0-9-]{0,79})\/(health|observations)$/.exec(
      path,
    );
    const measure = match ? find(match[1]) : undefined;
    if (!match || !measure) throw new RdpError("MEASUREMENT_NOT_FOUND", 404);
    if (match[2] === "health") return { data: health(measure, at), meta: { retrievedAt: iso(at) } };
    return history(measure, query, at);
  };
}
