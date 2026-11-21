import "server-only";
import { RdpError } from "./errors";

export const RIVER_LOCATE_PATH = "/v1/river/locate";
export const RIVER_SAMPLE_PATH =
  /^\/v1\/river\/releases\/[a-f0-9]{16}\/basins\/[0-9]{1,9}\/samples\/[0-9]{1,12}\/(upstream|downstream)$/;

export type RiverDirection = "upstream" | "downstream";
export type RiverGeometry = "reaches" | "none";
type Position = readonly [longitude: number, latitude: number];
const MATCH_STATUSES = ["Matched", "Ambiguous", "NoMatch", "OutOfCoverage"] as const;
const RELEASE_ID = /^[a-z0-9][a-z0-9-]{0,79}$/;
const VERSION = /^[a-f0-9]{64}$/;
const DECIMAL = /^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)$/;

export function isRiverDirection(value: unknown): value is RiverDirection {
  return value === "upstream" || value === "downstream";
}

export function isRiverCoordinate(value: unknown, limit: number): value is string {
  return (
    typeof value === "string" &&
    value.length <= 32 &&
    DECIMAL.test(value) &&
    Math.abs(Number(value)) <= limit
  );
}

function invalid(): never {
  throw new RdpError("RESPONSE_CONTRACT_ERROR");
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function position(value: unknown): Position {
  if (!Array.isArray(value) || value.length !== 2) invalid();
  const [lon, lat] = value;
  if (
    typeof lon !== "number" ||
    !(Math.abs(lon) <= 180) ||
    typeof lat !== "number" ||
    !(Math.abs(lat) <= 90)
  )
    invalid();
  return [lon, lat];
}

export function riverSamplePath(
  release: string,
  basin: string,
  sample: string,
  direction: RiverDirection,
): string {
  const path = `/v1/river/releases/${release}/basins/${basin}/samples/${sample}/${direction}`;
  if (!RIVER_SAMPLE_PATH.test(path)) throw new RdpError("INVALID_QUERY");
  return path;
}

export function parseRiverLocation(body: unknown) {
  const data = object(object(body).data);
  const match = object(data.match);
  const status = MATCH_STATUSES.find((value) => value === match.status);
  const { releaseId, version, token } = object(data.release);
  if (
    !status ||
    typeof releaseId !== "string" ||
    !RELEASE_ID.test(releaseId) ||
    typeof version !== "string" ||
    !VERSION.test(version) ||
    token !== version.slice(0, 16)
  )
    invalid();
  const location = { status, release: { releaseId, version }, token: version.slice(0, 16) };
  if (data.sample === null) {
    if (data.links !== null) invalid();
    return { ...location, sample: null };
  }
  const { sampleId, position: coordinates, snapOffsetM } = object(data.sample);
  const basinId = data.basinId;
  if (
    status !== "Matched" ||
    typeof basinId !== "string" ||
    !/^[0-9]{1,9}$/.test(basinId) ||
    typeof sampleId !== "string" ||
    !/^[0-9]{1,12}$/.test(sampleId) ||
    typeof snapOffsetM !== "number" ||
    !Number.isFinite(snapOffsetM) ||
    snapOffsetM < 0
  )
    invalid();
  // Match both advertised links against the exact relative paths. Never resolve a link supplied by RDP.
  const links = object(data.links);
  for (const direction of ["upstream", "downstream"] as const) {
    if (links[direction] !== riverSamplePath(location.token, basinId, sampleId, direction))
      invalid();
  }
  return {
    ...location,
    sample: { basinId, sampleId, position: position(coordinates), snapOffsetM },
  };
}

export type RiverLocation = ReturnType<typeof parseRiverLocation>;

function positions(value: unknown, min: number): Position[] {
  if (!Array.isArray(value) || value.length < min) invalid();
  return value.map(position);
}

function polygon(value: unknown) {
  if (!Array.isArray(value) || value.length === 0) invalid();
  for (const ring of value) {
    const vertices = positions(ring, 4);
    const [lon, lat] = vertices[0];
    const [endLon, endLat] = vertices[vertices.length - 1];
    if (lon !== endLon || lat !== endLat) invalid();
  }
}

export function parseRiverRoute(
  body: unknown,
  location: RiverLocation,
  direction: RiverDirection,
  geometry: RiverGeometry,
) {
  const collection = object(body);
  const meta = object(collection.riverTracer);
  const route = object(meta.route);
  const sample = location.sample;
  const { completeness } = route;
  const { attribution } = meta;
  if (
    !sample ||
    collection.type !== "FeatureCollection" ||
    !Array.isArray(collection.features) ||
    meta.schema !== "rdp.river-tracer.route/v1" ||
    meta.kind !== `point-${direction}` ||
    meta.releaseVersion !== location.release.version ||
    object(meta.canonicalSample).sampleId !== sample.sampleId ||
    object(meta.match).status !== "Matched" ||
    route.status !== "traced" ||
    route.direction !== direction ||
    meta.geometry !== (geometry === "reaches" ? "reaches" : "omitted") ||
    (completeness !== "complete" && completeness !== "incomplete") ||
    typeof attribution !== "string" ||
    !attribution.trim() ||
    attribution.length > 1024
  )
    invalid();

  let snapped: Position | undefined;
  const reaches: Position[][] = [];
  for (const value of collection.features) {
    const feature = object(value);
    const { type, coordinates } = object(feature.geometry);
    const { kind } = object(feature.properties);
    if (feature.type !== "Feature") invalid();
    if (type === "Point" && kind === "query-point" && !snapped) {
      snapped = position(coordinates);
    } else if (type === "LineString" && kind === `${direction}-reach` && geometry === "reaches") {
      reaches.push(positions(coordinates, 2));
    } else if (type === "Polygon" && direction === "upstream" && kind === "catchment") {
      polygon(coordinates);
    } else if (
      type === "MultiPolygon" &&
      direction === "upstream" &&
      kind === "catchment" &&
      Array.isArray(coordinates) &&
      coordinates.length > 0
    ) {
      for (const part of coordinates) polygon(part);
    } else invalid();
  }
  if (
    !snapped ||
    snapped[0] !== sample.position[0] ||
    snapped[1] !== sample.position[1] ||
    (geometry === "reaches" && reaches.length !== route.reachCount)
  )
    invalid();
  return {
    direction,
    completeness,
    release: location.release,
    sample: { sampleId: sample.sampleId, position: snapped },
    attribution,
    reaches,
  };
}

export type RiverRoute = ReturnType<typeof parseRiverRoute>;
