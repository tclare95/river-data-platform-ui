import {
  COMPARE_SLOTS,
  needsMoreCompareAxes,
  readCompareQuery,
  type ComparisonSide,
} from "@/lib/compare";
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

  const sides = await loadComparison(selected, range);
  const encoded = sides.map((side, index) => {
    const json = JSON.stringify(side);
    return { index, json, bytes: Buffer.byteLength(json) };
  });
  // Include the envelope and separators in the budget. Keep complete smaller series if the response would overflow.
  let bytes = Buffer.byteLength('{"data":[]}') + encoded.length - 1;
  for (const side of encoded) bytes += side.bytes;
  if (bytes > MAX_RESPONSE_BYTES) {
    for (const entry of [...encoded].sort((a, b) => b.bytes - a.bytes)) {
      const { measurement, result } = sides[entry.index];
      if (result.status !== "ok") continue;
      const replacement: ComparisonSide = { measurement, result: { status: "too_large" } };
      entry.json = JSON.stringify(replacement);
      bytes += Buffer.byteLength(entry.json) - entry.bytes;
      if (bytes <= MAX_RESPONSE_BYTES) break;
    }
  }
  if (bytes > MAX_RESPONSE_BYTES) return failure(413, "RESULT_TOO_LARGE");
  const body = `{"data":[${encoded.map(({ json }) => json).join(",")}]}`;
  return new Response(body, { headers: { ...headers, "Content-Type": "application/json" } });
}
