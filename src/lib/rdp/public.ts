/**
 * What this public site may show. RDP publishes measurements; this site additionally requires the provider's
 * licence to permit public display with attribution. Anything else is dropped before rendering or responding.
 * The projections below are the only shapes that leave the server. Times that distinguish when a value was observed,
 * stored by RDP and retrieved are provenance and pass through; internal source references, provider measure IDs,
 * error codes, health diagnostics, request IDs and upstream errors never do.
 */
import type { Health, HistoryPage, Latest, Measurement } from "./contract";

export type PublicSource = { label: string; attribution: string };

export const PUBLIC_SOURCES: Readonly<Record<string, PublicSource>> = Object.freeze({
  "environment-agency": {
    label: "Environment Agency",
    attribution:
      "Contains Environment Agency data licensed under the Open Government Licence v3.0.",
  },
});

export function publicSource(measure: Measurement): PublicSource | undefined {
  return Object.hasOwn(PUBLIC_SOURCES, measure.provider)
    ? PUBLIC_SOURCES[measure.provider]
    : undefined;
}

export function publicMeasurements(measurements: readonly Measurement[]): Measurement[] {
  return measurements.filter((measure) => publicSource(measure) !== undefined);
}

export type PublicMeasurement = {
  measurementId: string;
  stationId: string;
  name: string;
  watercourseName?: string;
  locationEvidence?: string;
  parameter: string;
  unit: string;
  datum: string;
  kind: Measurement["kind"];
  expectedIntervalSeconds: number;
  periodSeconds: number | null;
  source: PublicSource;
};

const EA_STATION_RECORD =
  /^https:\/\/environment\.data\.gov\.uk\/flood-monitoring\/id\/stations\/[a-zA-Z0-9_-]+$/;

export function toPublicMeasurement(measure: Measurement): PublicMeasurement {
  const source = publicSource(measure);
  if (!source) throw new Error("not public");
  const evidence = measure.location?.evidence;
  return {
    measurementId: measure.measurementId,
    stationId: measure.stationId,
    name: measure.name,
    watercourseName:
      measure.watercourse?.status === "verified" ? measure.watercourse.name : undefined,
    locationEvidence:
      measure.provider === "environment-agency" && evidence && EA_STATION_RECORD.test(evidence)
        ? evidence
        : undefined,
    parameter: measure.parameter,
    unit: measure.unit,
    datum: measure.datum,
    kind: measure.kind,
    expectedIntervalSeconds: measure.expectedIntervalSeconds,
    periodSeconds: measure.kind === "period_total" ? measure.periodSeconds : null,
    source,
  };
}

/** Latest projection: availability and freshness stay separate; RDP's verdicts are passed through, never derived. */
export function toPublicLatest(latest: Latest) {
  if (latest.kind === "period_total") {
    return {
      kind: latest.kind,
      status: latest.status,
      freshness: latest.freshness,
      label: latest.label,
      labelConvention: latest.labelConvention,
      periodStart: latest.periodStart,
      periodEnd: latest.periodEnd,
      // An ineligible interval is not an observed depth (RAINFALL.md eligibility): no number leaves the server.
      totalMm: latest.eligible === false ? null : latest.totalMm,
      eligible: latest.eligible,
      quality: latest.quality,
    };
  }
  return {
    kind: latest.kind,
    status: latest.status,
    freshness: latest.freshness,
    observedAt: latest.observedAt,
    value: latest.value,
    quality: latest.quality,
  };
}

/** History projection for the browser: rows, coverage and continuation only. */
export function toPublicHistory(page: HistoryPage) {
  const meta = {
    from: page.from,
    to: page.to,
    /** When RDP answered the first page (its fixed read instant for the whole continuation). */
    requestAsOf: page.requestAsOf,
    coverage: page.coverage,
    nextCursor: page.nextCursor,
  };
  if (page.kind === "period_total") {
    return {
      kind: page.kind,
      ...meta,
      periodSeconds: page.periodSeconds,
      window: page.window,
      windowUnavailable: page.windowUnavailable,
      intervals: page.intervals.map((row) => ({
        label: row.label,
        labelConvention: row.labelConvention,
        periodStart: row.periodStart,
        periodEnd: row.periodEnd,
        totalMm: row.eligible ? row.totalMm : null,
        quality: row.quality,
        eligible: row.eligible,
        ineligibleReason: row.ineligibleReason,
        revision: row.revision,
      })),
    };
  }
  return {
    kind: page.kind,
    ...meta,
    observations: page.observations.map((row) => ({
      observedAt: row.observedAt,
      value: row.value,
      quality: row.quality,
      /** When RDP durably stored this revision; never a substitute for `observedAt`. */
      ingestedAt: row.ingestedAt,
      revision: row.revision,
    })),
  };
}

/**
 * Collection provenance: when RDP last stored a reading, when it last asked the source and whether that worked.
 * Error codes, lags and persistence diagnostics stay on the server.
 */
export function toPublicHealth(health: Health) {
  return {
    lastAttemptAt: health.lastAttemptAt,
    lastPersistedAt: health.lastPersistedAt,
    sourceState: health.sourceState,
  };
}

export type PublicHistory = ReturnType<typeof toPublicHistory>;
export type PublicHealth = ReturnType<typeof toPublicHealth>;
export type PublicLatest = ReturnType<typeof toPublicLatest>;
