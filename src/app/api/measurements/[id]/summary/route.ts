import { loadObservationSummary } from "@/lib/history/load-observation-summary";
import { supportsObservationSummary } from "@/lib/history/observation-summary";
import { loadMeasurementLatest, loadPublishedMeasurement } from "@/lib/measurement-detail";

const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

export async function GET(
  request: Request,
  context: RouteContext<"/api/measurements/[id]/summary">,
) {
  if (new URL(request.url).search) return new Response(null, { status: 400, headers });
  const { id } = await context.params;
  const published = await loadPublishedMeasurement(id);
  if (published.status === "unavailable") return new Response(null, { status: 503, headers });
  if (published.status === "not_found" || !supportsObservationSummary(published.measurement)) {
    return new Response(null, { status: 404, headers });
  }
  const { latest } = await loadMeasurementLatest(id);
  const summary = await loadObservationSummary(published.measurement, latest);
  return Response.json({ latest, summary }, { headers });
}
