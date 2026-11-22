import { isRiverCoordinate } from "@/lib/rdp/river-tracer";
import { getRdpClient, RdpError } from "@/lib/rdp/server";
import { waitForRdp } from "@/lib/rdp/transport";
import {
  isRiverReleaseToken,
  MAX_UPSTREAM_MEASUREMENTS_BYTES,
  toPublicUpstreamMeasurements,
} from "@/lib/rdp/upstream-measurements";

export const maxDuration = 30;

const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

function failure(code: string, status: number) {
  return Response.json({ error: { code } }, { status, headers });
}

export async function GET(request: Request) {
  const { search, searchParams } = new URL(request.url);
  const lon = searchParams.get("lon");
  const lat = searchParams.get("lat");
  const release = searchParams.get("release");
  if (
    search.length > 192 ||
    searchParams.size !== (release === null ? 2 : 3) ||
    !isRiverCoordinate(lon, 180) ||
    !isRiverCoordinate(lat, 90) ||
    (release !== null && !isRiverReleaseToken(release))
  )
    return failure("INVALID_REQUEST", 400);

  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(25_000)]);
  try {
    const rdp = getRdpClient();
    const result = await rdp.getUpstreamMeasurements(
      { lon, lat, release: release ?? undefined },
      signal,
    );
    // Shared catalogue loads keep their own deadline when this browser disconnects.
    const catalogue =
      result.status === "available"
        ? (await waitForRdp(() => rdp.listMeasurements(), signal)).measurements
        : [];
    const body = JSON.stringify({
      mode: rdp.mode,
      data: toPublicUpstreamMeasurements(result, catalogue),
    });
    if (Buffer.byteLength(body) > MAX_UPSTREAM_MEASUREMENTS_BYTES)
      return failure("RESULT_TOO_LARGE", 413);
    return new Response(body, { headers: { ...headers, "Content-Type": "application/json" } });
  } catch (error) {
    if (request.signal.aborted) return failure("CANCELLED", 499);
    if (
      signal.aborted ||
      (error instanceof RdpError &&
        (error.code === "TIMEOUT" || error.code === "QUERY_TIMEOUT" || error.status === 504))
    )
      return failure("TIMEOUT", 504);
    if (error instanceof RdpError) {
      if (error.code === "CATCHMENT_DISCOVERY_DISABLED") return failure("DISABLED", 404);
      if (error.code === "RELEASE_NOT_AVAILABLE") return failure("RELEASE_NOT_AVAILABLE", 410);
      if (error.code === "RESPONSE_TOO_LARGE" || error.status === 413)
        return failure("RESULT_TOO_LARGE", 413);
    }
    return failure("UNAVAILABLE", 503);
  }
}
