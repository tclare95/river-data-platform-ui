import "server-only";
import { CACHE_TTL_MS, type RdpClient } from "@/lib/rdp/client";
import { tickKey, type HistoryPage } from "@/lib/rdp/contract";
import { RdpError } from "@/lib/rdp/errors";
import { toPublicHistory } from "@/lib/rdp/public";
import type { HistoryWindow } from "./range";
import { rainfallReadWindow } from "./rainfall-totals";

/**
 * RDP's default page size. Callers share the cached first page when their window and limit match.
 */
export const HISTORY_PAGE_LIMIT = 2000;
/**
 * Most pages one window may take (8,000 readings: 30 days at 15 minutes needs two). Beyond this the window is
 * reported as too large rather than cut short.
 */
export const HISTORY_MAX_PAGES = 4;
const HISTORY_DEADLINE_MS = 20_000;
/** A continuation that expires or goes stale restarts from the first page this many times. */
const MAX_RESTARTS = 1;

export type PublicObservation = Extract<
  ReturnType<typeof toPublicHistory>,
  { kind: "instantaneous" }
>["observations"][number];

type PublicRainfallHistory = Extract<ReturnType<typeof toPublicHistory>, { kind: "period_total" }>;

type LoadedHistory = {
  status: "ok";
  from: string;
  to: string;
  /** RDP's read instant for the first page; continuation pages keep its fixed cutoff. */
  retrievedAt: string;
  coverage: HistoryPage["coverage"];
  pages: number;
};

export type HistoryResult =
  | (LoadedHistory & { observations: PublicObservation[] })
  | (LoadedHistory &
      Pick<PublicRainfallHistory, "periodSeconds" | "intervals" | "window" | "windowUnavailable">)
  /** The expected instantaneous measurement is a period total. */
  | { status: "deferred" }
  /** More readings than {@link HISTORY_MAX_PAGES} pages: nothing is shown rather than a truncated record. */
  | { status: "too_large" }
  /** Any failed page (after one restart for an expired or stale cursor): no partial history is returned. */
  | { status: "unavailable" };

class Restart extends Error {}

async function readAllPages(
  rdp: RdpClient,
  id: string,
  kind: HistoryPage["kind"],
  window: HistoryWindow,
  signal: AbortSignal,
): Promise<HistoryResult> {
  const pages: HistoryPage[] = [];
  let cursor: string | undefined;
  let lastSeen: string | undefined;
  do {
    if (pages.length === HISTORY_MAX_PAGES) return { status: "too_large" };
    let page;
    try {
      page = await rdp.getHistory(id, { ...window, limit: HISTORY_PAGE_LIMIT, cursor });
    } catch (error) {
      if (
        error instanceof RdpError &&
        (error.code === "CURSOR_EXPIRED" || error.code === "CURSOR_STALE")
      ) {
        throw new Restart();
      }
      throw error;
    }
    if (signal.aborted) return { status: "unavailable" };
    if (page.kind !== kind) {
      if (kind === "instantaneous" && pages.length === 0) return { status: "deferred" };
      throw new RdpError("RESPONSE_CONTRACT_ERROR");
    }
    const paginated = cursor !== undefined || page.nextCursor !== null;
    if (
      page.kind === "period_total" &&
      (paginated
        ? page.window !== null || page.windowUnavailable !== "paginated"
        : page.window === null || page.windowUnavailable !== null)
    ) {
      throw new RdpError("RESPONSE_CONTRACT_ERROR");
    }

    const rows = page.kind === "instantaneous" ? page.observations : page.intervals;
    // RDP follows its own empty internal pages; an empty page that still continues is not a valid answer.
    if (rows.length === 0 && page.nextCursor !== null) {
      throw new RdpError("RESPONSE_CONTRACT_ERROR");
    }
    // Pages must continue the same answer: same coverage evidence and strictly later times or labels.
    const first = pages[0];
    const firstRow = rows[0];
    const firstNew = firstRow && ("label" in firstRow ? firstRow.label : firstRow.observedAt);
    if (
      (first && JSON.stringify(first.coverage) !== JSON.stringify(page.coverage)) ||
      (lastSeen !== undefined && firstNew !== undefined && tickKey(firstNew) <= tickKey(lastSeen))
    ) {
      throw new RdpError("RESPONSE_CONTRACT_ERROR");
    }
    const lastRow = rows.at(-1);
    if (lastRow) lastSeen = "label" in lastRow ? lastRow.label : lastRow.observedAt;
    pages.push(page);
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);

  const first = pages[0];
  const meta: LoadedHistory = {
    status: "ok",
    from: first.from,
    to: first.to,
    retrievedAt: first.requestAsOf,
    coverage: first.coverage,
    pages: pages.length,
  };
  const projected = pages.map(toPublicHistory);
  if (first.kind === "period_total") {
    return {
      ...meta,
      periodSeconds: first.periodSeconds,
      window: first.window,
      windowUnavailable: first.windowUnavailable,
      intervals: projected.flatMap((page) => (page.kind === "period_total" ? page.intervals : [])),
    };
  }
  return {
    ...meta,
    observations: projected.flatMap((page) =>
      page.kind === "instantaneous" ? page.observations : [],
    ),
  };
}

type Entry = { expires: number; result: Promise<HistoryResult> };
/**
 * Whole assembled windows, per client: the client caches only first pages, so without this every 30-day view would
 * re-read its continuation pages from the shared RDP throttle. Loads in flight are shared; only `ok` results are
 * kept, so a failure is never served from cache (the next view reads again).
 */
const assembled = new WeakMap<RdpClient, Map<string, Entry>>();
const MAX_ENTRIES = 200;

/**
 * Reads one history window completely, following RDP's continuation cursor with the
 * identical window. The result is all or nothing: a failed page never yields a shorter history presented as whole.
 * Identical windows read within {@link CACHE_TTL_MS.history} share one result.
 */
export function loadHistory(
  rdp: RdpClient,
  id: string,
  kind: HistoryPage["kind"],
  window: HistoryWindow,
): Promise<HistoryResult> {
  let cache = assembled.get(rdp);
  if (!cache) assembled.set(rdp, (cache = new Map()));
  const key = `${id}|${kind}|${window.from}|${window.to}`;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expires > now) return hit.result;
  if (hit) cache.delete(key);
  if (cache.size >= MAX_ENTRIES) {
    for (const [name, entry] of cache) if (entry.expires <= now) cache.delete(name);
    if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value!);
  }
  const deadline = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // A page read can be shared with another caller. Bound this load's wait and stop pagination when it expires.
  const expired = new Promise<HistoryResult>((resolve) => {
    timer = setTimeout(() => {
      deadline.abort();
      resolve({ status: "unavailable" });
    }, HISTORY_DEADLINE_MS);
  });
  const result = Promise.race([
    readHistory(rdp, id, kind, window, deadline.signal),
    expired,
  ]).finally(() => clearTimeout(timer));
  const entry = { expires: now + CACHE_TTL_MS.history, result };
  cache.set(key, entry);
  void result.then((value) => {
    if (value.status !== "ok" && cache.get(key) === entry) cache.delete(key);
  });
  return result;
}

async function readHistory(
  rdp: RdpClient,
  id: string,
  kind: HistoryPage["kind"],
  window: HistoryWindow,
  signal: AbortSignal,
): Promise<HistoryResult> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await readAllPages(rdp, id, kind, window, signal);
    } catch (error) {
      if (error instanceof Restart && attempt < MAX_RESTARTS && !signal.aborted) continue;
      return { status: "unavailable" };
    }
  }
}

/** Read bounded lookback for rainfall transforms while retaining the selected chart window. */
export async function loadChartHistory(
  rdp: RdpClient,
  id: string,
  kind: HistoryPage["kind"],
  window: HistoryWindow,
): Promise<HistoryResult> {
  if (kind !== "period_total") return loadHistory(rdp, id, kind, window);

  const result = await loadHistory(rdp, id, kind, rainfallReadWindow(window));
  if (result.status !== "ok" || !("intervals" in result)) return result;

  const from = tickKey(window.from);
  const to = tickKey(window.to);
  const gaps = result.coverage.gaps
    .filter((gap) => tickKey(gap.from) < to && tickKey(gap.to) > from)
    .map((gap) => ({
      ...gap,
      from: tickKey(gap.from) < from ? window.from : gap.from,
      to: tickKey(gap.to) > to ? window.to : gap.to,
    }));
  return {
    ...result,
    ...window,
    coverage: {
      status: gaps.some((gap) => gap.reason === "unknown")
        ? "unknown"
        : gaps.length > 0
          ? "partial"
          : result.coverage.gaps.length > 0
            ? "complete"
            : result.coverage.status,
      gaps,
    },
    window: null,
    windowUnavailable: null,
  };
}
