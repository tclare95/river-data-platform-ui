import { isRiverCoordinate, isRiverDirection } from "@/lib/rdp/river-tracer";
import { getRdpClient, RdpError } from "@/lib/rdp/server";

export const maxDuration = 30;

const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const PUBLIC_GEOMETRY_RELEASE = "838c7ed826b26ee16a11ba2b5be9dc4d286bca8cc0159c6f33d540bf04c0155c";
const MAX_PUBLIC_BYTES = 4 * 1024 * 1024;

function failure(code: string, status: number) {
  return Response.json({ error: { code } }, { status, headers });
}

export async function GET(request: Request) {
  const { search, searchParams } = new URL(request.url);
  const lon = searchParams.get("lon");
  const lat = searchParams.get("lat");
  const direction = searchParams.get("direction");
  if (
    search.length > 192 ||
    searchParams.size !== 3 ||
    !isRiverCoordinate(lon, 180) ||
    !isRiverCoordinate(lat, 90) ||
    !isRiverDirection(direction)
  ) {
    return failure("INVALID_REQUEST", 400);
  }

  try {
    const rdp = getRdpClient();
    const location = await rdp.locateRiver(lon, lat);
    // Publication approval applies to the reviewed ORN v2 release.
    const publishGeometry = location.release.version === PUBLIC_GEOMETRY_RELEASE;
    const route = location.sample
      ? await rdp.getRiverRoute(location, direction, publishGeometry ? "reaches" : "none")
      : null;
    const catchment = route?.catchment;
    const publishCatchment =
      publishGeometry &&
      location.release.releaseId === "orn-v2-gb" &&
      catchment?.sourceNetworkRelease;
    const body = JSON.stringify({
      mode: rdp.mode,
      data: {
        matchStatus: location.status,
        release: location.release,
        snappedSample: location.sample
          ? {
              snapOffsetM: location.sample.snapOffsetM,
              position: publishGeometry ? location.sample.position : null,
            }
          : null,
        route: route ? { direction: route.direction, completeness: route.completeness } : null,
        attribution: route?.attribution ?? null,
        geometry:
          publishGeometry && route ? { type: "MultiLineString", coordinates: route.reaches } : null,
        catchment: catchment
          ? {
              status: catchment.status,
              areaKm2: catchment.areaKm2,
              pourPointOffsetM: catchment.pourPointOffsetM,
              sourceNetworkRelease: catchment.sourceNetworkRelease,
              geometry: publishCatchment ? catchment.geometry : null,
            }
          : null,
      },
    });
    if (Buffer.byteLength(body) > MAX_PUBLIC_BYTES) return failure("RESULT_TOO_LARGE", 413);
    return new Response(body, { headers: { ...headers, "Content-Type": "application/json" } });
  } catch (error) {
    if (error instanceof RdpError) {
      if (error.status === 404) return failure("NOT_FOUND", 404);
      if (error.status === 410) return failure("RELEASE_NOT_AVAILABLE", 410);
      if (error.status === 413 || error.code === "RESPONSE_TOO_LARGE")
        return failure("RESULT_TOO_LARGE", 413);
      if (error.status === 504 || error.code === "TIMEOUT" || error.code === "QUERY_TIMEOUT")
        return failure("TIMEOUT", 504);
    }
    return failure("UNAVAILABLE", 503);
  }
}
