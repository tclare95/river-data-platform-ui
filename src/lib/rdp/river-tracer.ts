import "server-only";
import { fail as invalid, object, oneOf } from "./contract";
import { RdpError } from "./errors";

export const RIVER_LOCATE_PATH = "/v1/river/locate";
export const RIVER_SAMPLE_PATH =
  /^\/v1\/river\/releases\/[a-f0-9]{16}\/basins\/[0-9]{1,9}\/samples\/[0-9]{1,12}\/(upstream|downstream)$/;

export type RiverDirection = "upstream" | "downstream";
export type RiverGeometry = "reaches" | "none";
type Position = readonly [longitude: number, latitude: number];
type PolygonCoordinates = Position[][];
type CatchmentGeometry =
  | { type: "Polygon"; coordinates: PolygonCoordinates }
  | { type: "MultiPolygon"; coordinates: PolygonCoordinates[] };
type RiverCatchment = {
  status: "published" | "unavailable" | "not-loaded";
  id: string | null;
  areaKm2: number | null;
  pourPointOffsetM: number | null;
  sourceNetworkRelease: string | null;
  geometry: CatchmentGeometry | null;
};

// The publisher's OGL v3.0 catchment grant is specific to this source layer.
const CATCHMENT_DATASET = "OpenRiversNetwork (ORN) v2.0 with ORN Catchments";
const CATCHMENT_SOURCE_RELEASE =
  "ORN v2.0 GeoPackage (2025-03); network corrected from OS Open Rivers as downloaded 2023-02-09";
export const parseRiverMatchStatus = oneOf(["Matched", "Ambiguous", "NoMatch", "OutOfCoverage"]);
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
    value.trim() === value &&
    DECIMAL.test(value) &&
    Math.abs(Number(value)) <= limit
  );
}

export function parseRiverPosition(value: unknown): Position {
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

export function parseRiverRelease(value: unknown) {
  const { releaseId, version, token } = object(value);
  if (
    typeof releaseId !== "string" ||
    releaseId.trim() !== releaseId ||
    !RELEASE_ID.test(releaseId) ||
    typeof version !== "string" ||
    version.length !== 64 ||
    !VERSION.test(version) ||
    token !== version.slice(0, 16)
  )
    invalid();
  return { release: { releaseId, version }, token: version.slice(0, 16) };
}

export function parseRiverLocation(body: unknown) {
  const data = object(object(body).data);
  const status = parseRiverMatchStatus(object(data.match).status);
  const location = { status, ...parseRiverRelease(data.release) };
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
    sample: { basinId, sampleId, position: parseRiverPosition(coordinates), snapOffsetM },
  };
}

export type RiverLocation = ReturnType<typeof parseRiverLocation>;

function positions(value: unknown, min: number): Position[] {
  if (!Array.isArray(value) || value.length < min) invalid();
  return value.map(parseRiverPosition);
}

function polygon(value: unknown): PolygonCoordinates {
  if (!Array.isArray(value) || value.length === 0) invalid();
  return value.map((ring) => {
    const vertices = positions(ring, 4);
    const [lon, lat] = vertices[0];
    const [endLon, endLat] = vertices[vertices.length - 1];
    if (lon !== endLon || lat !== endLat) invalid();
    return vertices;
  });
}

function parseCatchmentGeometry(value: unknown): CatchmentGeometry | null {
  try {
    const { type, coordinates } = object(value);
    if (type === "Polygon") return { type, coordinates: polygon(coordinates) };
    if (type === "MultiPolygon" && Array.isArray(coordinates) && coordinates.length > 0)
      return { type, coordinates: coordinates.map(polygon) };
    return null;
  } catch (error) {
    // An invalid catchment must not invalidate an otherwise valid reach trace.
    if (error instanceof RdpError) return null;
    throw error;
  }
}

function parseCatchment(
  metadata: unknown,
  network: unknown,
  features: { id: unknown; geometry: unknown }[],
): RiverCatchment | null {
  if (!metadata || typeof metadata !== "object") return null;
  const { status, id, areaKm2, pourPointOffsetM } = metadata as Record<string, unknown>;
  if (status !== "published" && status !== "unavailable" && status !== "not-loaded") return null;

  const source = network as Record<string, unknown> | null | undefined;
  const sourceNetworkRelease =
    source?.dataset === CATCHMENT_DATASET && source.release === CATCHMENT_SOURCE_RELEASE
      ? CATCHMENT_SOURCE_RELEASE
      : null;
  const area =
    status === "published" && typeof areaKm2 === "number" && Number.isFinite(areaKm2) && areaKm2 > 0
      ? areaKm2
      : null;
  const offset =
    status === "published" &&
    typeof pourPointOffsetM === "number" &&
    Number.isFinite(pourPointOffsetM) &&
    pourPointOffsetM >= 0
      ? pourPointOffsetM
      : null;
  const catchmentId =
    status === "published" &&
    typeof id === "string" &&
    id.trim() === id &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)
      ? id
      : null;
  const geometry =
    catchmentId !== null &&
    area !== null &&
    offset !== null &&
    features.length === 1 &&
    features[0].id === catchmentId
      ? parseCatchmentGeometry(features[0].geometry)
      : null;
  return {
    status,
    id: geometry ? catchmentId : null,
    areaKm2: area,
    pourPointOffsetM: offset,
    sourceNetworkRelease,
    geometry,
  };
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
  const catchmentFeatures: { id: unknown; geometry: unknown }[] = [];
  for (const value of collection.features) {
    const feature = object(value);
    const { kind, id } = object(feature.properties);
    if (feature.type !== "Feature") invalid();
    if (direction === "upstream" && kind === "catchment") {
      catchmentFeatures.push({ id, geometry: feature.geometry });
      continue;
    }
    const { type, coordinates } = object(feature.geometry);
    if (type === "Point" && kind === "query-point" && !snapped) {
      snapped = parseRiverPosition(coordinates);
    } else if (type === "LineString" && kind === `${direction}-reach` && geometry === "reaches") {
      reaches.push(positions(coordinates, 2));
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
    catchment:
      direction === "upstream"
        ? parseCatchment(meta.catchment, meta.network, catchmentFeatures)
        : null,
  };
}

export type RiverRoute = ReturnType<typeof parseRiverRoute>;
