import { loadHistory } from "@/lib/history/load";
import { rainfallReadWindow, rainfallWindowTotal } from "@/lib/history/rainfall-totals";
import { rangeWindow } from "@/lib/history/range";
import {
  isRainfallTotal,
  MAX_MAP_RAINFALL_MEASUREMENTS,
  RAINFALL_MAP_PERIODS,
  type MapRainfallReading,
  type MapRainfallResponse,
  type RainfallMapPeriod,
} from "@/lib/rainfall-map";
import { isMeasurementId, tickKey } from "@/lib/rdp/contract";
import { publicMeasurements } from "@/lib/rdp/public";
import { getRdpClient } from "@/lib/rdp/server";

export const maxDuration = 25;
const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const period = params.get("period");
  const ids = params.getAll("id");
  if (
    period === null ||
    !Object.hasOwn(RAINFALL_MAP_PERIODS, period) ||
    params.size !== ids.length + 1 ||
    ids.length === 0 ||
    ids.length > MAX_MAP_RAINFALL_MEASUREMENTS ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => !isMeasurementId(id))
  ) {
    return Response.json({ error: { code: "INVALID_REQUEST" } }, { status: 400, headers });
  }

  const now = Date.now();
  // At the hour boundary itself, the exclusive read end must still be at or before now.
  const { to } = rangeWindow("7d", now - 1);
  const hours = RAINFALL_MAP_PERIODS[period as RainfallMapPeriod].hours;
  const window = { from: new Date(Date.parse(to) - hours * 3_600_000).toISOString(), to };

  try {
    const client = getRdpClient();
    const catalogue = publicMeasurements((await client.listMeasurements()).measurements);
    const allowed = new Set(
      catalogue.filter(isRainfallTotal).map(({ measurementId }) => measurementId),
    );
    if (ids.some((id) => !allowed.has(id))) {
      return Response.json({ error: { code: "NOT_FOUND" } }, { status: 404, headers });
    }
    const source = rainfallReadWindow(window, 0);
    const from = tickKey(window.from);
    const end = tickKey(window.to);
    const readings = await Promise.all(
      ids.map(async (id): Promise<[string, MapRainfallReading]> => {
        if (request.signal.aborted) return [id, { status: "unavailable" }];
        const result = await loadHistory(client, id, "period_total", source);
        if (result.status !== "ok" || !("intervals" in result))
          return [id, { status: "unavailable" }];
        const hasRows = result.intervals.some(({ label, labelConvention }) => {
          const time = tickKey(label);
          return labelConvention === "period_end"
            ? time > from && time <= end
            : time >= from && time < end;
        });
        return [
          id,
          hasRows
            ? { status: "total", total: rainfallWindowTotal(result, window) }
            : { status: "missing" },
        ];
      }),
    );
    return Response.json(
      { window, readings: Object.fromEntries(readings) } satisfies MapRainfallResponse,
      { headers },
    );
  } catch {
    return Response.json({ error: { code: "UNAVAILABLE" } }, { status: 503, headers });
  }
}
