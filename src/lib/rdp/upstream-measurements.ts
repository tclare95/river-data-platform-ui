import "server-only";
import {
  array,
  fail,
  finite,
  integer,
  isMeasurementId,
  object,
  oneOf,
  parseLocation,
  string,
  timestamp,
  type Measurement,
} from "./contract";
import { publicMeasurements, toPublicMeasurement } from "./public";
import {
  parseRiverMatchStatus,
  parseRiverPosition,
  parseRiverRelease,
  riverSamplePath,
} from "./river-tracer";

export const UPSTREAM_MEASUREMENTS_PATH = "/v1/river/upstream-measurements";
export const MAX_UPSTREAM_MEASUREMENTS_BYTES = 256 * 1024;
const MAX_MEASUREMENTS = 40;

export function isRiverReleaseToken(value: unknown): value is string {
  return typeof value === "string" && value.length === 16 && /^[a-f0-9]+$/.test(value);
}

export type UpstreamMeasurementQuery = { lon: string; lat: string; release?: string };

const outcome = oneOf(["available", "location_not_matched", "catchment_unavailable"]);
const parameter = oneOf(["level", "flow", "rainfall"]);
const completeness = oneOf(["complete", "incomplete"]);
const geographicRelationship = oneOf(["within_catchment"]);
const networkRelationship = oneOf(["not_assessed", "not_applicable"]);
const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function id(value: unknown) {
  const text = string(value);
  return text.trim() === text && identifier.test(text) ? text : fail();
}

function nonNegative(value: unknown) {
  const number = finite(value);
  return number >= 0 ? number : fail();
}

function stationCount(value: unknown) {
  const count = integer(value);
  return count >= 0 && count <= MAX_MEASUREMENTS ? count : fail();
}

function validateSample(sample: unknown, upstream: unknown, token: string) {
  const { basinId, sampleId, reachId, position, snapOffsetM } = object(sample);
  const basin = id(basinId);
  const sampleKey = id(sampleId);
  if (!/^[0-9]{1,9}$/.test(basin) || !/^[0-9]{1,12}$/.test(sampleKey)) fail();
  const path = riverSamplePath(token, basin, sampleKey, "upstream");
  if (upstream !== path) fail();
  id(reachId);
  parseRiverPosition(position);
  nonNegative(snapOffsetM);
}

export function parseUpstreamMeasurements(body: unknown, query: UpstreamMeasurementQuery) {
  const root = object(body);
  const status = outcome(root.status);
  const { release, token } = parseRiverRelease(root.release);
  const { longitude, latitude } = object(root.point);
  const match = object(root.match);
  const matchStatus = parseRiverMatchStatus(match.status);
  string(match.reason);
  if (
    longitude !== Number(query.lon) ||
    latitude !== Number(query.lat) ||
    (query.release !== undefined && token !== query.release)
  )
    fail();

  const base = { release, matchStatus };
  if (status !== "available") {
    if (
      root.catchment !== undefined ||
      root.data !== undefined ||
      root.meta !== undefined ||
      root.networkCoverage !== undefined
    )
      fail();
    if (status === "location_not_matched") {
      if (
        matchStatus === "Matched" ||
        root.canonicalSample !== undefined ||
        root.upstream !== undefined
      )
        fail();
    } else {
      if (matchStatus !== "Matched") fail();
      string(root.reason);
      if (root.canonicalSample !== undefined || root.upstream !== undefined)
        validateSample(root.canonicalSample, root.upstream, token);
    }
    return { ...base, status };
  }

  if (matchStatus !== "Matched") fail();
  validateSample(root.canonicalSample, root.upstream, token);
  const catchment = object(root.catchment);
  const areaKm2 = finite(catchment.areaKm2);
  const pourPointOffsetM = nonNegative(catchment.pourPointOffsetM);
  nonNegative(catchment.offsetFromCanonicalSampleM);
  id(catchment.sampleId);
  id(catchment.reachId);
  string(catchment.selection);
  if (areaKm2 <= 0) fail();

  const network = object(root.networkCoverage);
  array(network.reasons, 40).forEach(string);
  const networkCoverage = { completeness: completeness(network.completeness) };

  const stationIds = new Set<string>();
  const measurementIds = new Set<string>();
  const stations = array(root.data, MAX_MEASUREMENTS).map((value) => {
    const row = object(value);
    const stationId = id(row.stationId);
    if (stationIds.has(stationId)) fail();
    stationIds.add(stationId);
    const location = parseLocation(object(row.location));
    if (location.status !== "verified") return fail();
    const measurements = array(row.measurements, MAX_MEASUREMENTS).map((value) => {
      const row = object(value);
      const { measurementId } = row;
      if (!isMeasurementId(measurementId) || measurementIds.has(measurementId)) return fail();
      measurementIds.add(measurementId);
      const kind = parameter(row.parameter);
      const relationship = networkRelationship(row.networkRelationship);
      if (relationship !== (kind === "rainfall" ? "not_applicable" : "not_assessed")) fail();
      return { measurementId, parameter: kind, networkRelationship: relationship };
    });
    if (measurements.length === 0 || measurementIds.size > MAX_MEASUREMENTS) fail();
    return {
      stationId,
      provider: string(row.provider),
      location,
      geographicRelationship: geographicRelationship(row.geographicRelationship),
      measurements,
    };
  });

  const meta = object(root.meta);
  const wireCounts = object(meta.counts);
  const counts = {
    withinCatchment: stationCount(wireCounts.withinCatchment),
    outside: stationCount(wireCounts.outside),
    unknown: stationCount(wireCounts.unknown),
    ambiguous: stationCount(wireCounts.ambiguous),
    nearBoundary: stationCount(wireCounts.nearBoundary),
  };
  const scope = oneOf(["published_rainfall_level_flow"])(meta.scope);
  const retrievedAt = timestamp(meta.retrievedAt);
  const complete = counts.unknown + counts.ambiguous + counts.nearBoundary === 0;
  if (
    meta.complete !== complete ||
    counts.withinCatchment !== stations.length ||
    measurementIds.size + counts.outside + counts.unknown + counts.ambiguous + counts.nearBoundary >
      MAX_MEASUREMENTS
  )
    fail();

  return {
    ...base,
    status,
    catchment: { id: id(catchment.id), areaKm2, pourPointOffsetM },
    networkCoverage,
    stations,
    meta: { scope, retrievedAt, complete, counts },
  };
}

export type UpstreamMeasurements = ReturnType<typeof parseUpstreamMeasurements>;

export function toPublicUpstreamMeasurements(
  result: UpstreamMeasurements,
  catalogue: readonly Measurement[],
) {
  if (result.status !== "available") return result;
  const approved = new Map(publicMeasurements(catalogue).map((row) => [row.measurementId, row]));
  const { stations, ...metadata } = result;
  const data = stations.flatMap((station) => {
    const measurements = station.measurements.flatMap((entry) => {
      const measurement = approved.get(entry.measurementId);
      const position = measurement?.location;
      if (
        !measurement ||
        measurement.stationId !== station.stationId ||
        measurement.provider !== station.provider ||
        measurement.parameter !== entry.parameter ||
        position?.status !== "verified" ||
        position.longitude !== station.location.longitude ||
        position.latitude !== station.location.latitude ||
        position.precisionMetres !== station.location.precisionMetres
      )
        return [];
      return [
        { ...toPublicMeasurement(measurement), networkRelationship: entry.networkRelationship },
      ];
    });
    return measurements.length > 0
      ? [{ geographicRelationship: station.geographicRelationship, measurements }]
      : [];
  });
  return { ...metadata, data };
}

export type PublicUpstreamMeasurements = ReturnType<typeof toPublicUpstreamMeasurements>;
