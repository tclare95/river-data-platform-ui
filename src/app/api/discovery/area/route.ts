import { readInventoryBounds } from "@/lib/inventory";
import { getRdpClient, RdpError } from "@/lib/rdp/server";

export const maxDuration = 25;

const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

function failure(code: string, status: number) {
  return Response.json({ error: { code } }, { status, headers });
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const bbox = searchParams.get("bbox");
  if (bbox === null || searchParams.size !== 1 || !readInventoryBounds(bbox))
    return failure("INVALID_REQUEST", 400);

  try {
    return Response.json(
      { data: await getRdpClient().discoverArea(bbox, request.signal) },
      { headers },
    );
  } catch (error) {
    if (request.signal.aborted) return failure("CANCELLED", 499);
    if (
      error instanceof RdpError &&
      (error.code === "TIMEOUT" || error.code === "QUERY_TIMEOUT" || error.status === 504)
    )
      return failure("TIMEOUT", 504);
    if (error instanceof RdpError && error.code === "INVENTORY_CHANGED")
      return failure("INVENTORY_CHANGED", 409);
    return failure("UNAVAILABLE", 503);
  }
}
