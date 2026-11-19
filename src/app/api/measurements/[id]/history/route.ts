import { isMeasurementId } from "@/lib/rdp/contract";
import { publicSource, toPublicHistory, toPublicMeasurement } from "@/lib/rdp/public";
import { getRdpClient, RdpError } from "@/lib/rdp/server";

/** UI bounds, tighter than RDP's 366 days / 5,000 rows. */
export const HISTORY_BOUNDS = Object.freeze({
  defaultDays: 7,
  maxDays: 31,
  defaultLimit: 2000,
  maxLimit: 5000,
});
const DAY = 86_400_000;
const ALLOWED = new Set(["from", "to", "limit", "cursor"]);

type ErrorCode =
  "INVALID_REQUEST" | "INVALID_CURSOR" | "RESTART_REQUIRED" | "NOT_FOUND" | "UNAVAILABLE";
const STATUS: Record<ErrorCode, number> = {
  INVALID_REQUEST: 400,
  INVALID_CURSOR: 400,
  RESTART_REQUIRED: 409,
  NOT_FOUND: 404,
  UNAVAILABLE: 503,
};

function failure(code: ErrorCode) {
  const headers: Record<string, string> = {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  };
  if (code === "UNAVAILABLE") headers["Retry-After"] = "5";
  return Response.json({ error: { code } }, { status: STATUS[code], headers });
}

function codeFor(error: unknown): ErrorCode {
  if (!(error instanceof RdpError)) return "UNAVAILABLE";
  switch (error.code) {
    case "INVALID_QUERY":
      return "INVALID_REQUEST";
    case "INVALID_CURSOR":
      return "INVALID_CURSOR";
    case "CURSOR_EXPIRED":
    case "CURSOR_STALE":
      return "RESTART_REQUIRED";
    case "MEASUREMENT_NOT_FOUND":
      return "NOT_FOUND";
    default:
      // Configuration, authorisation, throttling, integrity and contract failures all look the same publicly.
      return "UNAVAILABLE";
  }
}

const MINUTE_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d{1,3})?Z$/;

function parseWindow(params: URLSearchParams, now: number) {
  const from = params.get("from");
  const to = params.get("to");
  if (from === null && to === null) {
    // Minute-aligned default so repeated loads share one cached upstream page.
    const end = Math.floor(now / 60_000) * 60_000;
    return {
      from: new Date(end - HISTORY_BOUNDS.defaultDays * DAY).toISOString(),
      to: new Date(end).toISOString(),
    };
  }
  if (from === null || to === null || !MINUTE_TIMESTAMP.test(from) || !MINUTE_TIMESTAMP.test(to))
    return null;
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (!(end > start) || end - start > HISTORY_BOUNDS.maxDays * DAY) return null;
  return { from: new Date(start).toISOString(), to: new Date(end).toISOString() };
}

/**
 * GET /api/measurements/{id}/history?from&to&limit&cursor
 *
 * One bounded page of a published, publicly displayable measurement. `from` (inclusive) and `to` (exclusive) are
 * UTC `Z` timestamps at most 31 days apart; omit both for the last 7 days. Continue with the returned `nextCursor`
 * and the identical window. Not a proxy: only this route, shape and bound exist.
 */
export async function GET(
  request: Request,
  context: RouteContext<"/api/measurements/[id]/history">,
) {
  const { id } = await context.params;
  const params = new URL(request.url).searchParams;
  const names = [...params.keys()];
  if (
    !isMeasurementId(id) ||
    names.some((name) => !ALLOWED.has(name)) ||
    new Set(names).size !== names.length
  ) {
    return failure("INVALID_REQUEST");
  }
  const window = parseWindow(params, Date.now());
  const limitText = params.get("limit");
  const limit =
    limitText === null
      ? HISTORY_BOUNDS.defaultLimit
      : /^[1-9]\d{0,3}$/.test(limitText)
        ? Number(limitText)
        : NaN;
  const cursor = params.get("cursor") ?? undefined;
  if (
    !window ||
    !(limit <= HISTORY_BOUNDS.maxLimit) ||
    (cursor !== undefined && !/^[A-Za-z0-9_-]{1,7000}$/.test(cursor))
  ) {
    return failure("INVALID_REQUEST");
  }

  try {
    const rdp = getRdpClient();
    const measure = await rdp.getMeasurement(id);
    if (!publicSource(measure)) return failure("NOT_FOUND");
    const page = await rdp.getHistory(id, { ...window, limit, cursor });
    return Response.json(
      {
        mode: rdp.mode,
        data: { measurement: toPublicMeasurement(measure), history: toPublicHistory(page) },
      },
      {
        headers: {
          "Cache-Control": "public, max-age=0, s-maxage=60",
          "X-Content-Type-Options": "nosniff",
        },
      },
    );
  } catch (error) {
    return failure(codeFor(error));
  }
}
