"use client";

import { useId, useState } from "react";
import { Button } from "@/components/button";
import { Time } from "@/components/latest-reading";
import type { AlignedRow, ComparisonReading } from "@/lib/compare";
import { INELIGIBLE_REASON, rainfallBounds } from "@/lib/history/rainfall";

export const COMPARE_ROWS_PER_PAGE = 100;

type ComparisonColumn = { label: string; unit: string; rainfall: boolean };

export function ComparisonValue({ reading, unit }: { reading: ComparisonReading; unit?: string }) {
  const rain = "label" in reading ? reading : null;
  const value = "value" in reading ? reading.value : reading.totalMm;
  const period = rain && rainfallBounds(rain);
  return (
    <>
      <span>{value === null ? "Ineligible" : `${value}${unit ? ` ${unit}` : ""}`}</span>
      {rain ? (
        <span className="block text-ink-muted">
          {period ? (
            <>
              <Time value={period[0]} /> to <Time value={period[1]} />
              <span className="block">
                {rain.labelConvention === "period_start" ? "Start label" : "End label"}
              </span>
            </>
          ) : (
            "Timing unverified"
          )}
        </span>
      ) : null}
      {rain?.ineligibleReason ? (
        <span className="block text-ink-muted">{INELIGIBLE_REASON[rain.ineligibleReason]}</span>
      ) : null}
      {reading.revision > 1 ? (
        <span className="block text-ink-muted">Revision {reading.revision} (corrected)</span>
      ) : null}
    </>
  );
}

function Cell({ reading }: { reading: ComparisonReading | null }) {
  return (
    <td className="px-4 py-2 text-right align-top">
      {reading ? (
        <ComparisonValue reading={reading} />
      ) : (
        <span className="text-ink-muted">No reading</span>
      )}
    </td>
  );
}

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
            {a.label} in {a.unit} and {b.label} in {b.unit} newest first. Times are UK time.
          </caption>
          <thead className="border-b border-line text-ink-muted">
            <tr>
              <th scope="col" className="px-4 py-2.5 font-medium">
                {a.rainfall || b.rainfall ? "Observation time or rainfall label" : "Observed"}
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
              <tr key={row.time}>
                <th scope="row" className="px-4 py-2 font-normal whitespace-nowrap">
                  <Time value={row.time} />
                </th>
                <Cell reading={row.a} />
                <Cell reading={row.b} />
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
