import { COMPARE_SLOTS, needsMoreCompareAxes, readCompareQuery } from "@/lib/compare";
import { loadComparable, loadComparison } from "@/lib/compare-load";
import { parseRange } from "@/lib/history/range";
import { isMeasurementId } from "@/lib/rdp/contract";

const ALLOWED = new Set<string>([...COMPARE_SLOTS, "range"]);
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

function failure(status: number, code: string) {
  return Response.json({ error: { code } }, { status, headers });
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const names = [...params.keys()];
  const { ids, range } = readCompareQuery(params);
  if (
    names.some((name) => !ALLOWED.has(name)) ||
    names.length !== new Set(names).size ||
    ids.length < 2 ||
    ids.length !== new Set(ids).size ||
    ids.some((id) => !isMeasurementId(id)) ||
    COMPARE_SLOTS.some((slot) => params.get(slot) === "") ||
    (params.has("range") && params.get("range") !== parseRange(params.get("range")))
  ) {
    return failure(400, "INVALID_REQUEST");
  }

  const catalogue = await loadComparable();
  if (catalogue.status === "unavailable") return failure(503, "UNAVAILABLE");

  const selected = ids.flatMap((id) => {
    const measurement = catalogue.measurements.find(({ measurementId }) => measurementId === id);
    return measurement ? [measurement] : [];
  });
  if (selected.length !== ids.length) return failure(404, "NOT_FOUND");
  if (needsMoreCompareAxes(selected)) return failure(400, "INCOMPATIBLE");

  const body = JSON.stringify({ data: await loadComparison(selected, range) });
  if (Buffer.byteLength(body) > MAX_RESPONSE_BYTES) return failure(413, "RESULT_TOO_LARGE");
  return new Response(body, { headers: { ...headers, "Content-Type": "application/json" } });
}
