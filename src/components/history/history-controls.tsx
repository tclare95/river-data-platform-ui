import Link from "next/link";
import { Time } from "@/components/latest-reading";
import { cx } from "@/lib/cx";
import { HISTORY_RANGES, type HistoryRange } from "@/lib/history/range";
import type { Coverage, CoverageGap } from "@/lib/rdp/contract";

function rangeClass(active: boolean) {
  return cx(
    "inline-flex min-h-10 items-center rounded px-3 text-sm font-medium",
    active ? "bg-accent text-surface" : "text-accent hover:bg-canvas",
  );
}

export type KnownGap = CoverageGap & { reason: Exclude<CoverageGap["reason"], "unknown"> };

const GAP_REASON: Record<KnownGap["reason"], string> = {
  not_collected: "Not collected",
  source_outage: "Source outage",
  legacy_unrecoverable: "Not recoverable from earlier records",
};

export function knownGaps(coverage: Coverage): KnownGap[] {
  return coverage.gaps.filter((gap): gap is KnownGap => gap.reason !== "unknown");
}

/** Range links for pages and buttons for history loaded in place. */
export function RangeNav({
  range,
  hrefFor,
  prefetch,
  onRangeChange,
}: {
  range: HistoryRange;
} & (
  | { hrefFor: (range: HistoryRange) => string; prefetch?: false; onRangeChange?: never }
  | { onRangeChange: (range: HistoryRange) => void; hrefFor?: never; prefetch?: never }
)) {
  return (
    <nav aria-label="History range">
      <ul className="flex gap-1 rounded-md border border-line-strong bg-surface p-1">
        {(Object.keys(HISTORY_RANGES) as HistoryRange[]).map((key) => (
          <li key={key}>
            {hrefFor ? (
              <Link
                href={hrefFor(key)}
                prefetch={prefetch}
                scroll={false}
                aria-current={key === range ? "page" : undefined}
                className={rangeClass(key === range)}
              >
                {HISTORY_RANGES[key].label}
              </Link>
            ) : (
              <button
                type="button"
                aria-pressed={key === range}
                onClick={() => onRangeChange(key)}
                className={rangeClass(key === range)}
              >
                {HISTORY_RANGES[key].label}
              </button>
            )}
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** RDP's coverage verdict in plain words. Unknown is never presented as complete. */
export function CoverageNote({ coverage }: { coverage: Coverage }) {
  const gaps = knownGaps(coverage);
  return (
    <div className="text-sm text-ink-muted">
      {coverage.status === "complete" ? (
        <p>Coverage verified complete for this period.</p>
      ) : coverage.status === "unknown" ? (
        <p>This record hasn’t been verified as complete.</p>
      ) : (
        <p>Part of this period has no data.</p>
      )}
      {gaps.length > 0 ? (
        <ul className="mt-1 list-disc pl-5">
          {gaps.map((gap) => (
            <li key={gap.from}>
              {GAP_REASON[gap.reason]}: <Time value={gap.from} /> to <Time value={gap.to} />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
