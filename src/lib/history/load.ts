import "server-only";
import type { RdpClient } from "@/lib/rdp/client";
import { tickKey, type Coverage, type InstantHistoryPage } from "@/lib/rdp/contract";
import { RdpError } from "@/lib/rdp/errors";
import { toPublicHistory } from "@/lib/rdp/public";
import type { HistoryWindow } from "./range";

/**
 * RDP's default page size. The detail page and `/api/measurements/{id}/history` use the same window and limit, so
 * they share one cached first page.
 */
export const HISTORY_PAGE_LIMIT = 2000;
/**
 * Most pages one window may take (8,000 readings: 30 days at 15 minutes needs two). Beyond this the window is
 * reported as too large rather than cut short.
 */
export const HISTORY_MAX_PAGES = 4;
/** A continuation that expires or goes stale restarts from the first page this many times. */
const MAX_RESTARTS = 1;

export type PublicObservation = Extract<
  ReturnType<typeof toPublicHistory>,
  { kind: "instantaneous" }
>["observations"][number];

export type HistoryResult =
  | {
      status: "ok";
      from: string;
      to: string;
      /** RDP's read instant for the first page; continuation pages keep its fixed cutoff. */
      retrievedAt: string;
      coverage: Coverage;
      /** Every reading in [from, to), strictly ascending, across all pages. */
      observations: PublicObservation[];
      pages: number;
    }
  /** Rainfall period totals are not charted in this wave. */
  | { status: "deferred" }
  /** More readings than {@link HISTORY_MAX_PAGES} pages: nothing is shown rather than a truncated record. */
  | { status: "too_large" }
  /** Any failed page (after one restart for an expired or stale cursor): no partial history is returned. */
  | { status: "unavailable" };

class Restart extends Error {}

function sameCoverage(a: Coverage, b: Coverage) {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function readAllPages(
  rdp: RdpClient,
  id: string,
  window: HistoryWindow,
): Promise<HistoryResult> {
  const pages: InstantHistoryPage[] = [];
  let cursor: string | undefined;
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
    if (page.kind !== "instantaneous") return { status: "deferred" };
    // RDP follows its own empty internal pages; an empty page that still continues is not a valid answer.
    if (page.observations.length === 0 && page.nextCursor !== null) {
      throw new RdpError("RESPONSE_CONTRACT_ERROR");
    }
    const previous = pages.at(-1);
    if (previous) {
      // Pages must continue the same answer: same coverage evidence and strictly later rows.
      const lastSeen = previous.observations.at(-1)?.observedAt;
      const firstNew = page.observations[0]?.observedAt;
      if (
        !sameCoverage(previous.coverage, page.coverage) ||
        (lastSeen !== undefined && firstNew !== undefined && tickKey(firstNew) <= tickKey(lastSeen))
      ) {
        throw new RdpError("RESPONSE_CONTRACT_ERROR");
      }
    }
    pages.push(page);
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);

  const first = pages[0];
  return {
    status: "ok",
    from: first.from,
    to: first.to,
    retrievedAt: first.requestAsOf,
    coverage: first.coverage,
    observations: pages.flatMap((page) => {
      const projected = toPublicHistory(page);
      return projected.kind === "instantaneous" ? projected.observations : [];
    }),
    pages: pages.length,
  };
}

/**
 * Reads one window of an instantaneous measurement completely, following RDP's continuation cursor with the
 * identical window. The result is all or nothing: a failed page never yields a shorter history presented as whole.
 */
export async function loadHistory(
  rdp: RdpClient,
  id: string,
  kind: "instantaneous" | "period_total",
  window: HistoryWindow,
): Promise<HistoryResult> {
  if (kind === "period_total") return { status: "deferred" };
  for (let attempt = 0; ; attempt++) {
    try {
      return await readAllPages(rdp, id, window);
    } catch (error) {
      if (error instanceof Restart && attempt < MAX_RESTARTS) continue;
      return { status: "unavailable" };
    }
  }
}
