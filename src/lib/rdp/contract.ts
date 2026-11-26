/**
 * Typed projection of RDP's observation read contract (RDP docs/openapi.json, READ-API.md, RAINFALL.md).
 *
 * Parsers validate every field the UI relies on and copy only those fields, so unknown or future upstream
 * fields never pass through. RDP owns identities and semantics; nothing here derives freshness, coverage or
 * period boundaries. Instantaneous readings and rainfall period totals are distinct `kind`s and never share
 * a value field.
 */
import { RdpError } from "./errors";

// RDP PublicationRules.MaxPublished (#140).
export const MAX_PUBLISHED_MEASUREMENTS = 500;

export type Freshness = "fresh" | "stale" | "unknown";
export type Availability = "available" | "no_observations" | "unavailable";
export type LabelConvention = "period_end" | "period_start" | "unverified";

type StationWatercourse =
  { status: "verified"; name: string } | { status: "not_applicable" | "not_published"; name: null };

type StationLocation = {
  evidence: string | null;
  retrievedAt: string | null;
} & (
  | {
      status: "verified";
      latitude: number;
      longitude: number;
      crs: "EPSG:4326";
      precisionMetres: 1 | 10 | 100 | 1000;
    }
  | {
      status: "unknown" | "ambiguous";
      latitude: null;
      longitude: null;
      crs: null;
      precisionMetres: null;
    }
);

type MeasurementBase = {
  measurementId: string;
  provider: string;
  sourceId: string;
  stationId: string;
  parameter: string;
  unit: string;
  datum: string;
  expectedIntervalSeconds: number;
  /** Station label from RDP's registry. */
  name: string;
  watercourse?: StationWatercourse;
  location?: StationLocation;
};

export type InstantMeasurement = MeasurementBase & { kind: "instantaneous" };
/** #54 period total (EA observed rainfall): mm per period, not an instantaneous sample. */
export type PeriodTotalMeasurement = MeasurementBase & {
  kind: "period_total";
  periodSeconds: number;
};
export type Measurement = InstantMeasurement | PeriodTotalMeasurement;

/** Published measurements only. Publication does not imply collection or freshness. */
export type Catalogue = { measurements: Measurement[]; retrievedAt: string };

export type InstantLatest = {
  kind: "instantaneous";
  measurementId: string;
  status: Availability;
  observedAt: string | null;
  value: number | null;
  unit: string;
  quality: string | null;
  freshness: Freshness;
  errorCode: string | null;
};

/** Newest stored interval of a period total. Deliberately has no `observedAt`/`value`. */
export type PeriodTotalLatest = {
  kind: "period_total";
  measurementId: string;
  status: Availability;
  periodSeconds: number;
  label: string | null;
  labelConvention: LabelConvention | null;
  periodStart: string | null;
  periodEnd: string | null;
  totalMm: number | null;
  unit: "mm";
  quality: string | null;
  eligible: boolean | null;
  labelAgeSeconds: number | null;
  freshness: Freshness;
  errorCode: string | null;
};

export type Latest = InstantLatest | PeriodTotalLatest;
export type LatestBatch = { items: Latest[]; retrievedAt: string; partial: boolean };

type SourceState = "unknown" | "healthy" | "failed";
type PersistenceState = "unknown" | "successful" | "failed";

export type InstantHealth = {
  kind: "instantaneous";
  measurementId: string;
  lastAttemptAt: string | null;
  lastPersistedAt: string | null;
  lastObservedAt: string | null;
  lastSourceObservedAt: string | null;
  sourceState: SourceState;
  persistenceState: PersistenceState;
  freshness: Freshness;
  ingestLagSeconds: number | null;
  lastErrorCode: string | null;
};

export type PeriodTotalHealth = {
  kind: "period_total";
  measurementId: string;
  lastAttemptAt: string | null;
  lastPersistedAt: string | null;
  lastLabel: string | null;
  labelConvention: LabelConvention | null;
  lastPeriodEnd: string | null;
  lastSourceLabel: string | null;
  sourceState: SourceState;
  persistenceState: PersistenceState;
  freshness: Freshness;
  labelToIngestSeconds: number | null;
  lastErrorCode: string | null;
};

export type Health = (InstantHealth | PeriodTotalHealth) & { retrievedAt: string };

export type CoverageGap = {
  from: string;
  to: string;
  reason: "not_collected" | "legacy_unrecoverable" | "source_outage" | "unknown";
};
/** `unknown` is the honest default: rows may be present while coverage is unproven. */
export type Coverage = { status: "complete" | "partial" | "unknown"; gaps: CoverageGap[] };

export type Observation = {
  observedAt: string;
  value: number;
  unit: string;
  datum: string;
  quality: string | null;
  sourceId: string;
  providerMeasureId: string;
  ingestedAt: string;
  sourceReference: string;
  revision: number;
};

export type RainfallInterval = {
  /** Provider time label. Not an instant of measurement. */
  label: string;
  periodSeconds: number;
  labelConvention: LabelConvention;
  periodStart: string | null;
  periodEnd: string | null;
  totalMm: number;
  sourceValue: string;
  quality: string | null;
  eligible: boolean;
  ineligibleReason: "QualityMissing" | "QualitySuspect" | "NegativeDepth" | null;
  knownAt: boolean | null;
  sourceId: string;
  providerMeasureId: string;
  ingestedAt: string;
  sourceReference: string;
  revision: number;
};

export type RainfallWindowGap = {
  fromLabel: string;
  toLabel: string;
  intervals: number;
  reason: "absent" | "QualityMissing" | "QualitySuspect" | "NegativeDepth" | "not_known_at";
};

/** Expected label grid over [from, to). `totalMm` is only set when every interval is reported and eligible. */
export type RainfallWindow = {
  firstLabel: string | null;
  lastLabel: string | null;
  expectedIntervals: number;
  reported: number;
  eligible: number;
  absent: number;
  ineligible: number;
  notKnownAt: number;
  status: "complete" | "incomplete" | "unknown" | "empty";
  totalMm: number | null;
  labelConvention: LabelConvention | "mixed";
  periodStart: string | null;
  periodEnd: string | null;
  gaps: RainfallWindowGap[];
  gapsTruncated: boolean;
  knownAt: string | null;
  knownAtBasis: "latest_stored" | "rdp_first_durable_capture";
};

type HistoryMeta = {
  measurementId: string;
  from: string;
  to: string;
  requestAsOf: string;
  cutoff: string;
  coverage: Coverage;
  nextCursor: string | null;
};

export type InstantHistoryPage = HistoryMeta & {
  kind: "instantaneous";
  observations: Observation[];
};
export type PeriodTotalHistoryPage = HistoryMeta & {
  kind: "period_total";
  periodSeconds: number;
  knownAt: string | null;
  window: RainfallWindow | null;
  windowUnavailable: "paginated" | null;
  intervals: RainfallInterval[];
};
export type HistoryPage = InstantHistoryPage | PeriodTotalHistoryPage;

// ---------------------------------------------------------------------------------------------------------
// Primitive validators. Any violation is a RESPONSE_CONTRACT_ERROR; details never leave the adapter.

type Json = Record<string, unknown>;

export function fail(): never {
  throw new RdpError("RESPONSE_CONTRACT_ERROR");
}

export function object(value: unknown): Json {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : fail();
}

export function array(value: unknown, max: number): unknown[] {
  return Array.isArray(value) && value.length <= max ? value : fail();
}

export function string(value: unknown): string {
  return typeof value === "string" && value.length > 0 && value.length <= 2048 ? value : fail();
}

function nullable<T>(read: (value: unknown) => T) {
  return (value: unknown): T | null => (value === null ? null : read(value));
}

export function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fail();
}

export function integer(value: unknown): number {
  return Number.isSafeInteger(value) ? (value as number) : fail();
}

function boolean(value: unknown): boolean {
  return typeof value === "boolean" ? value : fail();
}

export function oneOf<const T extends readonly string[]>(options: T) {
  return (value: unknown): T[number] =>
    typeof value === "string" && options.includes(value) ? (value as T[number]) : fail();
}

/** RDP emits UTC with `Z` and up to seven fractional digits; we keep the original string. */
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z$/;

export function epochMs(timestamp: string): number {
  const match = UTC.exec(timestamp);
  if (!match) return Number.NaN;
  // Date.parse only guarantees millisecond precision; trim extra fractional digits first.
  return Date.parse(timestamp.replace(/(\.\d{3})\d+Z$/, "$1Z"));
}

export function timestamp(value: unknown): string {
  return typeof value === "string" && Number.isFinite(epochMs(value)) ? value : fail();
}

const nullableString = nullable(string);
const nullableTimestamp = nullable(timestamp);
const nullableFinite = nullable(finite);
const freshness = oneOf(["fresh", "stale", "unknown"] as const);
const availability = oneOf(["available", "no_observations", "unavailable"] as const);
const convention = oneOf(["period_end", "period_start", "unverified"] as const);
const sourceState = oneOf(["unknown", "healthy", "failed"] as const);
const persistenceState = oneOf(["unknown", "successful", "failed"] as const);

const MEASUREMENT_ID = /^[a-z0-9][a-z0-9-]{0,79}$/;
export function isMeasurementId(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && MEASUREMENT_ID.test(value);
}

function measurementId(value: unknown): string {
  return isMeasurementId(value) ? value : fail();
}

function envelope(body: unknown): { data: unknown; meta: Json } {
  const root = object(body);
  return { data: root.data, meta: object(root.meta) };
}

// ---------------------------------------------------------------------------------------------------------
// Catalogue

/** Optional geography must not make an otherwise valid measurement unavailable. */
function optionalGeography<T>(value: unknown, parse: (row: Json) => T): T | undefined {
  if (value === undefined) return undefined;
  try {
    return parse(object(value));
  } catch (error) {
    if (!(error instanceof RdpError)) throw error;
    return undefined;
  }
}

function parseWatercourse({ name, status }: Json): StationWatercourse {
  if (status === "verified" && typeof name === "string" && name.trim()) {
    return { status, name: string(name) };
  }
  if ((status === "not_applicable" || status === "not_published") && name === null) {
    return { status, name };
  }
  return fail();
}

export function parseLocation(row: Json): StationLocation {
  const { status, crs, precisionMetres } = row;
  const latitude = nullableFinite(row.latitude);
  const longitude = nullableFinite(row.longitude);
  const evidence = nullableString(row.evidence);
  const retrievedAt = nullableTimestamp(row.retrievedAt);
  if (evidence !== null && !URL.canParse(evidence)) fail();

  if (status === "verified") {
    if (
      latitude === null ||
      Math.abs(latitude) > 90 ||
      longitude === null ||
      Math.abs(longitude) > 180
    )
      fail();
    if (
      crs !== "EPSG:4326" ||
      !(
        precisionMetres === 1 ||
        precisionMetres === 10 ||
        precisionMetres === 100 ||
        precisionMetres === 1000
      )
    )
      fail();
    return { status, latitude, longitude, crs, precisionMetres, evidence, retrievedAt };
  }
  if (
    (status === "unknown" || status === "ambiguous") &&
    latitude === null &&
    longitude === null &&
    crs === null &&
    precisionMetres === null
  ) {
    return { status, latitude, longitude, crs, precisionMetres, evidence, retrievedAt };
  }
  return fail();
}

export function parseCatalogue(body: unknown): Catalogue {
  const { data, meta } = envelope(body);
  const seen = new Set<string>();
  const measurements = array(data, MAX_PUBLISHED_MEASUREMENTS).map((item): Measurement => {
    const row = object(item);
    const base: MeasurementBase = {
      measurementId: measurementId(row.measurementId),
      provider: string(row.provider),
      sourceId: string(row.sourceId),
      stationId: string(row.stationId),
      parameter: string(row.parameter),
      unit: string(row.unit),
      datum: string(row.datum),
      expectedIntervalSeconds: integer(row.expectedIntervalSeconds),
      name: string(row.name),
      watercourse: optionalGeography(row.watercourse, parseWatercourse),
      location: optionalGeography(row.location, parseLocation),
    };
    if (seen.has(base.measurementId) || base.expectedIntervalSeconds <= 0) fail();
    seen.add(base.measurementId);
    if (row.valueType === undefined) {
      if (row.periodSeconds !== undefined) fail();
      return { kind: "instantaneous", ...base };
    }
    if (row.valueType !== "total" || base.unit !== "mm") fail();
    const periodSeconds = integer(row.periodSeconds);
    if (periodSeconds <= 0) fail();
    return { kind: "period_total", ...base, periodSeconds };
  });
  return { measurements, retrievedAt: timestamp(meta.retrievedAt) };
}

// ---------------------------------------------------------------------------------------------------------
// Latest

function parseInstantLatest(row: Json, measure: InstantMeasurement): InstantLatest {
  const latest: InstantLatest = {
    kind: "instantaneous",
    measurementId: measurementId(row.measurementId),
    status: availability(row.status),
    observedAt: nullableTimestamp(row.observedAt),
    value: nullableFinite(row.value),
    unit: string(row.unit),
    quality: nullableString(row.quality),
    freshness: freshness(row.freshness),
    errorCode: nullableString(row.errorCode),
  };
  if (latest.unit !== measure.unit) fail();
  // A reading is only shown when RDP says one is available; otherwise it must carry no value.
  const hasReading = latest.observedAt !== null && latest.value !== null;
  if ((latest.status === "available") !== hasReading) fail();
  if (latest.status !== "available" && (latest.observedAt !== null || latest.value !== null))
    fail();
  return latest;
}

function parsePeriodTotalLatest(row: Json, measure: PeriodTotalMeasurement): PeriodTotalLatest {
  if (row.valueType !== "total" || "value" in row || "observedAt" in row) fail();
  const latest: PeriodTotalLatest = {
    kind: "period_total",
    measurementId: measurementId(row.measurementId),
    status: availability(row.status),
    periodSeconds: integer(row.periodSeconds),
    label: nullableTimestamp(row.label),
    labelConvention: nullable(convention)(row.labelConvention),
    periodStart: nullableTimestamp(row.periodStart),
    periodEnd: nullableTimestamp(row.periodEnd),
    totalMm: nullableFinite(row.totalMm),
    unit: row.unit === "mm" ? "mm" : fail(),
    quality: nullableString(row.quality),
    eligible: nullable(boolean)(row.eligible),
    labelAgeSeconds: nullableFinite(row.labelAgeSeconds),
    freshness: freshness(row.freshness),
    errorCode: nullableString(row.errorCode),
  };
  if (latest.periodSeconds !== measure.periodSeconds) fail();
  const hasTotal =
    latest.label !== null && latest.totalMm !== null && latest.labelConvention !== null;
  if ((latest.status === "available") !== hasTotal) fail();
  // An unverified label convention never offers period boundaries.
  if (
    latest.labelConvention === "unverified" &&
    (latest.periodStart !== null || latest.periodEnd !== null)
  )
    fail();
  return latest;
}

/** Rows must come back in request order; each is validated against its own catalogue kind and unit. */
export function parseLatest(body: unknown, requested: readonly Measurement[]): LatestBatch {
  const { data, meta } = envelope(body);
  const rows = array(data, 20);
  if (rows.length !== requested.length) fail();
  const items = rows.map((item, index) => {
    const row = object(item);
    const measure = requested[index];
    if (row.measurementId !== measure.measurementId) fail();
    return measure.kind === "period_total"
      ? parsePeriodTotalLatest(row, measure)
      : parseInstantLatest(row, measure);
  });
  const partial = boolean(meta.partial);
  return { items, retrievedAt: timestamp(meta.retrievedAt), partial };
}

// ---------------------------------------------------------------------------------------------------------
// Health

export function parseHealth(body: unknown, measure: Measurement): Health {
  const { data, meta } = envelope(body);
  const row = object(data);
  if (row.measurementId !== measure.measurementId) fail();
  const common = {
    measurementId: measure.measurementId,
    lastAttemptAt: nullableTimestamp(row.lastAttemptAt),
    lastPersistedAt: nullableTimestamp(row.lastPersistedAt),
    sourceState: sourceState(row.sourceState),
    persistenceState: persistenceState(row.persistenceState),
    freshness: freshness(row.freshness),
    lastErrorCode: nullableString(row.lastErrorCode),
    retrievedAt: timestamp(meta.retrievedAt),
  };
  if (measure.kind === "period_total") {
    if (row.valueType !== "total") fail();
    return {
      kind: "period_total",
      ...common,
      lastLabel: nullableTimestamp(row.lastLabel),
      labelConvention: nullable(convention)(row.labelConvention),
      lastPeriodEnd: nullableTimestamp(row.lastPeriodEnd),
      lastSourceLabel: nullableTimestamp(row.lastSourceLabel),
      labelToIngestSeconds: nullableFinite(row.labelToIngestSeconds),
    };
  }
  if (row.valueType !== undefined) fail();
  return {
    kind: "instantaneous",
    ...common,
    lastObservedAt: nullableTimestamp(row.lastObservedAt),
    lastSourceObservedAt: nullableTimestamp(row.lastSourceObservedAt),
    ingestLagSeconds: nullableFinite(row.ingestLagSeconds),
  };
}

// ---------------------------------------------------------------------------------------------------------
// History

const gapReason = oneOf([
  "not_collected",
  "legacy_unrecoverable",
  "source_outage",
  "unknown",
] as const);

function parseCoverage(value: unknown): Coverage {
  const coverage = object(value);
  return {
    status: oneOf(["complete", "partial", "unknown"] as const)(coverage.status),
    gaps: array(coverage.gaps, 257).map((item) => {
      const gap = object(item);
      return { from: timestamp(gap.from), to: timestamp(gap.to), reason: gapReason(gap.reason) };
    }),
  };
}

function parseCursor(value: unknown): string | null {
  if (value === null) return null;
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,7000}$/.test(value) ? value : fail();
}

function parseHistoryMeta(meta: Json, measure: Measurement): HistoryMeta {
  if (meta.measurementId !== measure.measurementId || meta.pageIntegrity !== "verified") fail();
  return {
    measurementId: measure.measurementId,
    from: timestamp(meta.from),
    to: timestamp(meta.to),
    requestAsOf: timestamp(meta.requestAsOf),
    cutoff: timestamp(meta.cutoff),
    coverage: parseCoverage(meta.coverage),
    nextCursor: parseCursor(meta.nextCursor),
  };
}

/** Rows must be strictly ascending and inside [from, to). */
/** Tick-precise sort key: RDP de-duplicates on exact 100 ns ticks, finer than Date's milliseconds. */
export function tickKey(timestamp: string): string {
  return timestamp.replace(
    /(?:\.(\d{1,7}))?Z$/,
    (_match, fraction = "") => `.${fraction.padEnd(7, "0")}Z`,
  );
}

function assertOrdered(times: string[], from: string, to: string) {
  const start = tickKey(from);
  const end = tickKey(to);
  let previous = "";
  for (const time of times.map(tickKey)) {
    if (!(time > previous) || time < start || time >= end) fail();
    previous = time;
  }
}

function parseObservation(item: unknown, measure: InstantMeasurement): Observation {
  const row = object(item);
  const observation: Observation = {
    observedAt: timestamp(row.observedAt),
    value: finite(row.value),
    unit: string(row.unit),
    datum: string(row.datum),
    quality: nullableString(row.quality),
    sourceId: string(row.sourceId),
    providerMeasureId: string(row.providerMeasureId),
    ingestedAt: timestamp(row.ingestedAt),
    sourceReference: string(row.sourceReference),
    revision: integer(row.revision),
  };
  if (
    observation.unit !== measure.unit ||
    observation.datum !== measure.datum ||
    observation.sourceId !== measure.sourceId ||
    observation.revision < 1
  )
    fail();
  return observation;
}

const ineligibleReason = nullable(
  oneOf(["QualityMissing", "QualitySuspect", "NegativeDepth"] as const),
);
const windowGapReason = oneOf([
  "absent",
  "QualityMissing",
  "QualitySuspect",
  "NegativeDepth",
  "not_known_at",
] as const);

function parseInterval(item: unknown, measure: PeriodTotalMeasurement): RainfallInterval {
  const row = object(item);
  const interval: RainfallInterval = {
    label: timestamp(row.label),
    periodSeconds: integer(row.periodSeconds),
    labelConvention: convention(row.labelConvention),
    periodStart: nullableTimestamp(row.periodStart),
    periodEnd: nullableTimestamp(row.periodEnd),
    totalMm: finite(row.totalMm),
    sourceValue: string(row.sourceValue),
    quality: nullableString(row.quality),
    eligible: boolean(row.eligible),
    ineligibleReason: ineligibleReason(row.ineligibleReason),
    knownAt: nullable(boolean)(row.knownAt),
    sourceId: string(row.sourceId),
    providerMeasureId: string(row.providerMeasureId),
    ingestedAt: timestamp(row.ingestedAt),
    sourceReference: string(row.sourceReference),
    revision: integer(row.revision),
  };
  if (
    interval.periodSeconds !== measure.periodSeconds ||
    interval.sourceId !== measure.sourceId ||
    interval.totalMm < 0 ||
    (interval.labelConvention === "unverified" &&
      (interval.periodStart !== null || interval.periodEnd !== null))
  )
    fail();
  return interval;
}

function parseWindow(value: unknown): RainfallWindow | null {
  if (value === null) return null;
  const window = object(value);
  return {
    firstLabel: nullableTimestamp(window.firstLabel),
    lastLabel: nullableTimestamp(window.lastLabel),
    expectedIntervals: integer(window.expectedIntervals),
    reported: integer(window.reported),
    eligible: integer(window.eligible),
    absent: integer(window.absent),
    ineligible: integer(window.ineligible),
    notKnownAt: integer(window.notKnownAt),
    status: oneOf(["complete", "incomplete", "unknown", "empty"] as const)(window.status),
    totalMm: nullableFinite(window.totalMm),
    labelConvention: oneOf(["period_end", "period_start", "unverified", "mixed"] as const)(
      window.labelConvention,
    ),
    periodStart: nullableTimestamp(window.periodStart),
    periodEnd: nullableTimestamp(window.periodEnd),
    gaps: array(window.gaps, 96).map((item) => {
      const gap = object(item);
      return {
        fromLabel: timestamp(gap.fromLabel),
        toLabel: timestamp(gap.toLabel),
        intervals: integer(gap.intervals),
        reason: windowGapReason(gap.reason),
      };
    }),
    gapsTruncated: boolean(window.gapsTruncated),
    knownAt: nullableTimestamp(window.knownAt),
    knownAtBasis: oneOf(["latest_stored", "rdp_first_durable_capture"] as const)(
      window.knownAtBasis,
    ),
  };
}

export function parseHistory(body: unknown, measure: Measurement): HistoryPage {
  const { data, meta } = envelope(body);
  const rows = array(data, 5000);
  const common = parseHistoryMeta(meta, measure);
  if (measure.kind === "period_total") {
    if (meta.valueType !== "total" || integer(meta.periodSeconds) !== measure.periodSeconds) fail();
    const intervals = rows.map((row) => parseInterval(row, measure));
    assertOrdered(
      intervals.map((row) => row.label),
      common.from,
      common.to,
    );
    const windowUnavailable =
      meta.windowUnavailable === null
        ? null
        : oneOf(["paginated"] as const)(meta.windowUnavailable);
    return {
      kind: "period_total",
      ...common,
      periodSeconds: measure.periodSeconds,
      knownAt: nullableTimestamp(meta.knownAt),
      window: parseWindow(meta.window),
      windowUnavailable,
      intervals,
    };
  }
  if (meta.valueType !== undefined || meta.window !== undefined) fail();
  const observations = rows.map((row) => parseObservation(row, measure));
  assertOrdered(
    observations.map((row) => row.observedAt),
    common.from,
    common.to,
  );
  return { kind: "instantaneous", ...common, observations };
}
