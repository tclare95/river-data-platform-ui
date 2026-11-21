"use client";

import { useId, useState } from "react";
import {
  CartesianGrid,
  ComposedChart,
  ResponsiveContainer,
  XAxis,
  YAxis,
  useXAxisScale,
  useYAxisScale,
} from "recharts";
import { Button } from "@/components/button";
import { timeTicks } from "@/components/history/history-chart";
import { ROWS_PER_PAGE } from "@/components/history/observation-table";
import { Time } from "@/components/latest-reading";
import { EmptyState } from "@/components/states";
import { formatPeriod, formatTime } from "@/lib/format";
import type { HistoryResult } from "@/lib/history/load";
import { qualityLabel } from "@/lib/labels";
import { epochMs, tickKey } from "@/lib/rdp/contract";

type History = Extract<HistoryResult, { intervals: unknown }>;
type Interval = History["intervals"][number];
type Missing = { fromLabel: string; toLabel: string; count: number };

const REASON = {
  QualityMissing: "Flagged as missing",
  QualitySuspect: "Suspect quality",
  NegativeDepth: "Negative depth",
};

function bounds(row: Interval) {
  if (row.labelConvention === "unverified" || !row.periodStart || !row.periodEnd) return null;
  return [row.periodStart, row.periodEnd] as const;
}

function missingLabels({ from, to, periodSeconds, intervals }: History) {
  // RDP selects on a UTC label grid, including from and excluding to. Missing labels have no known physical bounds.
  const stride = periodSeconds * 1000;
  const labels = new Set(intervals.map((row) => tickKey(row.label)));
  const gaps: Missing[] = [];
  let run: Missing | undefined;
  for (let t = Math.ceil(epochMs(from) / stride) * stride; t < epochMs(to); t += stride) {
    const label = new Date(t).toISOString();
    if (labels.has(tickKey(label))) {
      run = undefined;
    } else if (run) {
      run.toLabel = label;
      run.count++;
    } else {
      run = { fromLabel: label, toLabel: label, count: 1 };
      gaps.push(run);
    }
  }
  return gaps;
}

// A categorical bar series would give every row a width, including rows with unverified timing.
function RainfallBars({ intervals }: { intervals: History["intervals"] }) {
  const x = useXAxisScale();
  const y = useYAxisScale();
  const baseline = y?.(0);
  if (!x || !y || baseline === undefined) return null;

  return intervals.map((row) => {
    const period = bounds(row);
    const left = x(epochMs(period?.[0] ?? row.label));
    const right = x(epochMs(period?.[1] ?? row.label));
    if (left === undefined || right === undefined) return null;
    const middle = (left + right) / 2;
    const timing = period
      ? `${formatTime(period[0])} to ${formatTime(period[1])}`
      : `${formatTime(row.label)} (provider label, timing unverified)`;
    if (row.totalMm === null) {
      return (
        <path
          key={row.label}
          d={`M ${middle - 1.5} ${baseline - 5} l 3 -3 m -3 0 l 3 3`}
          stroke="var(--color-danger)"
          fill="none"
        >
          <title>{timing} · Ineligible</title>
        </path>
      );
    }
    const top = y(row.totalMm);
    if (top === undefined) return null;
    const title = (
      <title>
        {timing} · {String(row.totalMm)} mm
      </title>
    );
    if (period && row.totalMm > 0) {
      return (
        <rect
          key={row.label}
          x={left}
          y={top}
          width={right - left}
          height={baseline - top}
          fill="var(--color-accent)"
          stroke="var(--color-accent)"
          strokeWidth={0.5}
        >
          {title}
        </rect>
      );
    }
    return (
      <line
        key={row.label}
        x1={period ? left : middle}
        x2={period ? right : middle}
        y1={row.totalMm === 0 && !period ? baseline - 2 : top}
        y2={baseline}
        stroke={period ? "var(--color-accent)" : "var(--color-ink-muted)"}
        strokeWidth={period ? 2 : 1.5}
        strokeDasharray={!period && row.totalMm > 0 ? "3 2" : undefined}
      >
        {title}
      </line>
    );
  });
}

function RainfallChart({ history, summary }: { history: History; summary: string }) {
  const { from, to, intervals, periodSeconds } = history;
  // A selected label can represent an interval that straddles the label window. Keep the full bar.
  let start = epochMs(from);
  let end = epochMs(to);
  let max = 0;
  for (const row of intervals) {
    const period = bounds(row);
    if (period) {
      start = Math.min(start, epochMs(period[0]));
      end = Math.max(end, epochMs(period[1]));
    }
    max = Math.max(max, row.totalMm ?? 0);
  }
  const x = timeTicks(start, end);
  const unverified = intervals.some((row) => row.totalMm !== null && !bounds(row));
  const ineligible = intervals.some((row) => row.totalMm === null);

  return (
    <figure>
      <figcaption className="mb-2 text-xs text-ink-muted">
        Rainfall per {formatPeriod(periodSeconds)} (mm)
      </figcaption>
      <div role="img" aria-label={summary} className="h-64 w-full sm:h-80">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart
            data={intervals}
            margin={{ top: 8, right: 12, bottom: 0, left: 0 }}
            accessibilityLayer={false}
          >
            <CartesianGrid vertical={false} stroke="var(--color-line)" />
            <XAxis
              dataKey={(row: Interval) => epochMs(row.label)}
              type="number"
              scale="linear"
              domain={[start, end]}
              allowDataOverflow
              ticks={x.ticks}
              tickFormatter={x.format}
              interval="preserveStartEnd"
              minTickGap={8}
              tick={{ fill: "var(--color-ink-muted)", fontSize: 12 }}
              tickLine={false}
              axisLine={{ stroke: "var(--color-line-strong)" }}
            />
            <YAxis
              type="number"
              domain={[0, max || 1]}
              allowDataOverflow
              width="auto"
              tick={{ fill: "var(--color-ink-muted)", fontSize: 12 }}
              tickLine={false}
              axisLine={false}
            />
            <RainfallBars intervals={intervals} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <p className="text-sm text-ink-muted">
        Baseline marks show 0 mm. Gaps indicate missing readings.
        {ineligible ? " Crosses mark ineligible readings." : ""}
        {unverified ? " Grey marks use provider labels where interval timing is unverified." : ""}
      </p>
    </figure>
  );
}

function RainfallTable({ intervals, gaps }: { intervals: History["intervals"]; gaps: Missing[] }) {
  const [page, setPage] = useState(0);
  const statusId = useId();
  const rows = [...intervals, ...gaps].sort((a, b) =>
    tickKey("label" in b ? b.label : b.toLabel).localeCompare(
      tickKey("label" in a ? a.label : a.toLabel),
    ),
  );
  const first = page * ROWS_PER_PAGE;
  const visible = rows.slice(first, first + ROWS_PER_PAGE);
  const hasOlder = first + visible.length < rows.length;

  return (
    <div className="mt-3">
      <div
        role="region"
        aria-label="Rainfall readings"
        tabIndex={0}
        className="overflow-x-auto rounded-lg border border-line bg-surface"
      >
        <table className="w-full text-left text-sm tabular-nums">
          <caption className="sr-only">
            Rainfall readings in mm, newest first. Times are UK time.
          </caption>
          <thead className="border-b border-line text-ink-muted">
            <tr>
              <th scope="col" className="px-4 py-2.5 font-medium">
                Interval or provider label
              </th>
              <th scope="col" className="px-4 py-2.5 text-right font-medium">
                Rainfall (mm)
              </th>
              <th scope="col" className="px-4 py-2.5 font-medium">
                Quality
              </th>
              <th scope="col" className="px-4 py-2.5 text-right font-medium">
                Revision
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {visible.map((row) => {
              if (!("label" in row)) {
                return (
                  <tr key={row.fromLabel} className="bg-canvas">
                    <td colSpan={4} className="px-4 py-2 text-ink-muted">
                      No reading for {row.count === 1 ? "label" : `${row.count} labels from`}{" "}
                      <Time value={row.fromLabel} />
                      {row.count > 1 ? (
                        <>
                          {" "}
                          to <Time value={row.toLabel} />
                        </>
                      ) : null}
                    </td>
                  </tr>
                );
              }
              const period = bounds(row);
              return (
                <tr key={row.label}>
                  <th scope="row" className="px-4 py-2 font-normal whitespace-nowrap">
                    {period ? (
                      <>
                        <Time value={period[0]} /> to <Time value={period[1]} />
                      </>
                    ) : (
                      <>
                        <Time value={row.label} />{" "}
                        <span className="block text-ink-muted">Timing unverified</span>
                      </>
                    )}
                  </th>
                  <td className="px-4 py-2 text-right">
                    {row.totalMm === null ? "Ineligible" : String(row.totalMm)}
                  </td>
                  <td className="px-4 py-2">
                    {(row.ineligibleReason && REASON[row.ineligibleReason]) ||
                      qualityLabel(row.quality) ||
                      "Not stated"}
                  </td>
                  <td className="px-4 py-2 text-right">
                    {row.revision > 1 ? `${row.revision} (corrected)` : row.revision}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <p id={statusId} role="status" className="text-sm text-ink-muted">
          Rows {(first + 1).toLocaleString("en-GB")}–
          {(first + visible.length).toLocaleString("en-GB")} of{" "}
          {rows.length.toLocaleString("en-GB")}, newest first
        </p>
        {page > 0 || hasOlder ? (
          <div className="flex gap-2">
            <Button
              onClick={() => page > 0 && setPage(page - 1)}
              aria-disabled={page === 0}
              aria-describedby={statusId}
            >
              Newer
            </Button>
            <Button
              onClick={() => hasOlder && setPage(page + 1)}
              aria-disabled={!hasOlder}
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

export function RainfallHistory({ history, span }: { history: History; span: string }) {
  const { intervals, window } = history;
  const gaps = missingLabels(history);
  const absent = gaps.reduce((count, gap) => count + gap.count, 0);
  const ineligible = intervals.filter((row) => row.totalMm === null).length;
  const counts = `${absent.toLocaleString("en-GB")} missing · ${ineligible.toLocaleString("en-GB")} ineligible`;
  const total = window?.status === "complete" ? window.totalMm : null;

  return (
    <>
      {intervals.length ? (
        <RainfallChart
          history={history}
          summary={`Rainfall interval totals in mm, last ${span}. ${counts}. Every reading is in the Readings table below.`}
        />
      ) : (
        <EmptyState title={`No readings in the last ${span}`} />
      )}
      <p className="text-sm text-ink-muted">
        {counts}.
        {total != null
          ? ` Total across the selected labels: ${String(total)} mm.`
          : " No verified total for this range."}
      </p>
      {intervals.length ? (
        <details className="group">
          <summary className="cursor-pointer py-2 font-medium text-accent">
            Readings table ({intervals.length.toLocaleString("en-GB")})
          </summary>
          <RainfallTable intervals={intervals} gaps={gaps} />
        </details>
      ) : null}
    </>
  );
}
