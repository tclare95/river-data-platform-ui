"use client";

import { useId, useMemo, useState } from "react";
import {
  CartesianGrid,
  ComposedChart,
  ResponsiveContainer,
  XAxis,
  YAxis,
  useXAxisScale,
  useYAxisScale,
} from "recharts";
import { ComparisonTable } from "@/components/compare/comparison-table";
import { alignReadings } from "@/lib/compare";
import { Button } from "@/components/button";
import { timeTicks } from "@/components/history/history-chart";
import {
  RainfallModeControl,
  RainfallTotalsNote,
  RainfallTotalsPlot,
  RainfallTotalValue,
} from "@/components/history/rainfall-totals";
import { ROWS_PER_PAGE } from "@/components/history/observation-table";
import { Time } from "@/components/latest-reading";
import { EmptyState } from "@/components/states";
import { formatPeriod, formatTime } from "@/lib/format";
import {
  INELIGIBLE_REASON,
  missingLabels,
  rainfallBounds,
  visibleRainfallIntervals,
  type RainfallInterval as Interval,
  type RainfallResult as History,
} from "@/lib/history/rainfall";
import {
  RAINFALL_MODES,
  rainfallSummaries,
  rainfallTotals,
  type RainfallMode,
  type RainfallTotal,
} from "@/lib/history/rainfall-totals";
import { qualityLabel } from "@/lib/labels";
import { epochMs, tickKey } from "@/lib/rdp/contract";

// A categorical bar series would give every row a width, including rows with unverified timing.
export function RainfallBars({
  intervals,
  yAxisId,
  color = "var(--color-accent)",
  fill = color,
  dash,
  opacity = 1,
}: {
  intervals: History["intervals"];
  yAxisId?: number;
  color?: string;
  fill?: string;
  dash?: string;
  opacity?: number;
}) {
  const x = useXAxisScale();
  const y = useYAxisScale(yAxisId);
  const baseline = y?.(0);
  if (!x || !y || baseline === undefined) return null;

  return intervals.map((row) => {
    const period = rainfallBounds(row);
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
          fill={fill}
          fillOpacity={opacity}
          stroke={color}
          strokeWidth={0.5}
          strokeDasharray={dash}
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
        stroke={period || yAxisId !== undefined ? color : "var(--color-ink-muted)"}
        strokeWidth={period ? 2 : 1.5}
        strokeDasharray={!period ? "2 2" : dash}
      >
        {title}
      </line>
    );
  });
}

function RainfallChart({
  history,
  intervals,
  totals,
  mode,
  summary,
}: {
  history: History;
  intervals: History["intervals"];
  totals: RainfallTotal[];
  mode: RainfallMode;
  summary: string;
}) {
  const { from, to, periodSeconds } = history;
  const data: readonly (Interval | RainfallTotal)[] = mode === "native" ? intervals : totals;
  // A selected label can represent an interval that straddles the label window. Keep the full bar.
  let start = epochMs(from);
  let end = epochMs(to);
  let max = totals.reduce((max, point) => Math.max(max, point.totalMm ?? 0), 0);
  for (const row of intervals) {
    const period = rainfallBounds(row);
    if (period) {
      start = Math.min(start, epochMs(period[0]));
      end = Math.max(end, epochMs(period[1]));
    }
    max = Math.max(max, row.totalMm ?? 0);
  }
  const x = timeTicks(start, end);
  const unverified = intervals.some((row) => row.totalMm !== null && !rainfallBounds(row));
  const ineligible = intervals.some((row) => row.totalMm === null);

  return (
    <figure>
      <figcaption className="mb-2 text-xs text-ink-muted">
        {mode === "native" ? `Rainfall per ${formatPeriod(periodSeconds)}` : RAINFALL_MODES[mode]}{" "}
        (mm)
      </figcaption>
      <div role="img" aria-label={summary} className="h-64 w-full sm:h-80">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart
            data={data}
            margin={{ top: 8, right: 12, bottom: 0, left: 0 }}
            accessibilityLayer={false}
          >
            <CartesianGrid vertical={false} stroke="var(--color-line)" />
            <XAxis
              dataKey={(row: Interval | RainfallTotal) =>
                epochMs("label" in row ? row.label : row.to)
              }
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
            {mode === "native" ? (
              <RainfallBars intervals={intervals} />
            ) : (
              <RainfallTotalsPlot totals={totals} mode={mode} />
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      {mode === "native" ? (
        <p className="text-sm text-ink-muted">
          Baseline marks show 0 mm. Gaps indicate missing readings.
          {ineligible ? " Crosses mark ineligible readings." : ""}
          {unverified ? " Grey marks use provider labels where interval timing is unverified." : ""}
        </p>
      ) : (
        <RainfallTotalsNote mode={mode} totals={totals} />
      )}
    </figure>
  );
}

function RainfallTable({
  intervals,
  gaps,
}: {
  intervals: History["intervals"];
  gaps: ReturnType<typeof missingLabels>;
}) {
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
              const period = rainfallBounds(row);
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
                    {(row.ineligibleReason && INELIGIBLE_REASON[row.ineligibleReason]) ||
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
  const [mode, setMode] = useState<RainfallMode>("daily");
  const summaries = useMemo(() => rainfallSummaries(history), [history]);
  const totals = useMemo(
    () => (mode === "native" ? [] : rainfallTotals(history, mode)),
    [history, mode],
  );
  const rows = useMemo(() => alignReadings([totals]), [totals]);
  const intervals = useMemo(() => visibleRainfallIntervals(history), [history]);
  const gaps = useMemo(() => missingLabels(history), [history]);
  const absent = gaps.reduce((count, gap) => count + gap.count, 0);
  const ineligible = intervals.filter((row) => row.totalMm === null).length;
  const counts = `${absent.toLocaleString("en-GB")} missing · ${ineligible.toLocaleString("en-GB")} ineligible`;

  return (
    <>
      <div>
        <h3 className="font-semibold">Recent rainfall</h3>
        <p className="mt-1 text-sm text-ink-muted">
          Windows ending <Time value={history.to} />
        </p>
        <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {summaries.map((total) => (
            <div key={total.label} className="rounded-lg border border-line bg-surface p-3">
              <dt className="text-sm font-medium">{total.label}</dt>
              <dd className="mt-1 text-sm tabular-nums [&>span:first-child]:text-lg [&>span:first-child]:font-semibold">
                <RainfallTotalValue total={total} />
              </dd>
            </div>
          ))}
        </dl>
        {summaries.some((total) => total.basis === "indicative") ? (
          <p className="mt-2 text-sm text-ink-muted">
            Indicative totals group provider labels where interval timing is unverified.
          </p>
        ) : null}
      </div>

      <RainfallModeControl mode={mode} onChange={setMode} />
      {(mode === "native" ? intervals.length : totals.some((total) => total.used)) ? (
        <RainfallChart
          history={history}
          intervals={mode === "native" ? intervals : []}
          totals={totals}
          mode={mode}
          summary={
            mode === "native"
              ? `Rainfall interval totals in mm, last ${span}. ${counts}. Every reading is in the Readings table below.`
              : `Rainfall ${RAINFALL_MODES[mode].toLowerCase()} in mm, last ${span}. Coverage is in the Totals table below.`
          }
        />
      ) : (
        <EmptyState
          title={
            mode === "native"
              ? `No readings in the last ${span}`
              : "Rainfall totals unavailable for this view"
          }
        />
      )}
      {mode !== "native" ? (
        <details>
          <summary className="cursor-pointer py-2 font-medium text-accent">Totals table</summary>
          <ComparisonTable
            key={mode}
            name="Rainfall totals"
            rows={rows}
            columns={[{ id: "rainfall", label: "Rainfall", unit: "mm", rainfall: true }]}
          />
        </details>
      ) : null}
      {intervals.length ? (
        <details>
          <summary className="cursor-pointer py-2 font-medium text-accent">
            Readings table ({intervals.length.toLocaleString("en-GB")})
          </summary>
          <RainfallTable intervals={intervals} gaps={gaps} />
        </details>
      ) : null}
    </>
  );
}
