"use client";

import { useId, useState } from "react";
import { Button } from "@/components/button";
import type { AlignedRow } from "@/lib/compare";
import { formatTime } from "@/lib/format";

export const COMPARE_ROWS_PER_PAGE = 100;

export type ComparisonColumn = { label: string; unit: string };

function Cell({ value }: { value: number | null }) {
  return (
    <td className="px-4 py-2 text-right">
      {value === null ? <span className="text-ink-muted">No reading</span> : String(value)}
    </td>
  );
}

/**
 * Both series side by side at their exact observation times, newest first. A time with a reading in only one series
 * says "No reading" for the other: values are exactly as RDP returned them and nothing is filled in.
 */
export function ComparisonTable({
  rows,
  a,
  b,
}: {
  rows: readonly AlignedRow[];
  a: ComparisonColumn;
  b: ComparisonColumn;
}) {
  const [page, setPage] = useState(0);
  const statusId = useId();
  const pages = Math.max(1, Math.ceil(rows.length / COMPARE_ROWS_PER_PAGE));
  const current = Math.min(page, pages - 1);
  const start = current * COMPARE_ROWS_PER_PAGE;
  const visible = rows.slice(start, start + COMPARE_ROWS_PER_PAGE);
  const format = (n: number) => n.toLocaleString("en-GB");
  const status =
    rows.length === 0
      ? "No readings"
      : `Times ${format(start + 1)}–${format(start + visible.length)} of ${format(rows.length)}, newest first`;

  return (
    <div>
      {/* Focusable so keyboard users can scroll a table wider than a narrow screen (WCAG 2.1.1). */}
      <div
        role="region"
        aria-label="Compared readings"
        tabIndex={0}
        className="overflow-x-auto rounded-lg border border-line bg-surface"
      >
        <table className="w-full text-left text-sm tabular-nums">
          <caption className="sr-only">
            {a.label} in {a.unit} and {b.label} in {b.unit} at each observation time, newest first.
            Times are UK time.
          </caption>
          <thead className="border-b border-line text-ink-muted">
            <tr>
              <th scope="col" className="px-4 py-2.5 font-medium">
                Observed
              </th>
              <th scope="col" className="px-4 py-2.5 text-right font-medium">
                {a.label} ({a.unit})
              </th>
              <th scope="col" className="px-4 py-2.5 text-right font-medium">
                {b.label} ({b.unit})
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {visible.map((row) => (
              <tr key={row.observedAt}>
                <th scope="row" className="px-4 py-2 font-normal whitespace-nowrap">
                  <time dateTime={row.observedAt}>{formatTime(row.observedAt)}</time>
                </th>
                <Cell value={row.a} />
                <Cell value={row.b} />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <p id={statusId} role="status" className="text-sm text-ink-muted">
          {status}
        </p>
        {pages > 1 ? (
          <div className="flex gap-2">
            {/* aria-disabled, not disabled: a button that disables itself would drop keyboard focus. */}
            <Button
              onClick={() => current > 0 && setPage(current - 1)}
              aria-disabled={current === 0}
              aria-describedby={statusId}
            >
              Newer
            </Button>
            <Button
              onClick={() => current < pages - 1 && setPage(current + 1)}
              aria-disabled={current === pages - 1}
              aria-describedby={statusId}
            >
              Older
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
