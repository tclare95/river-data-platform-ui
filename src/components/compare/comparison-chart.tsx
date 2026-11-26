"use client";

import Link from "next/link";
import { useId, useMemo } from "react";
import {
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceArea,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ComparisonValue } from "@/components/compare/comparison-table";
import { IsolatedDot, timeTicks, valueAxis } from "@/components/history/history-chart";
import { RainfallBars } from "@/components/history/rainfall-history";
import { Time } from "@/components/latest-reading";
import {
  comparisonAxes,
  comparisonInspectionRows,
  type AlignedRow,
  type ComparisonSide,
} from "@/lib/compare";
import { formatPeriod } from "@/lib/format";
import { rainfallBounds } from "@/lib/history/rainfall";
import { buildSeries } from "@/lib/history/series";
import { datumSummary, measurementPath, parameterLabel } from "@/lib/labels";
import { epochMs, tickKey } from "@/lib/rdp/contract";

const STYLES = [
  { color: "var(--color-accent)", dash: undefined, angle: 0 },
  { color: "var(--color-compare-secondary)", dash: "5 2", angle: 45 },
  { color: "var(--color-compare-tertiary)", dash: "2 3", angle: -45 },
  { color: "var(--color-compare-quaternary)", dash: "8 3 2 3", angle: 90 },
];
const axisNumber = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 3 });
const inspectionTime = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

export function ComparisonChart({ sides, rows }: { sides: ComparisonSide[]; rows: AlignedRow[] }) {
  const patternId = useId();
  const data = useMemo(() => comparisonInspectionRows(rows), [rows]);
  const series = sides.flatMap(({ measurement, result }, index) => {
    if (result.status !== "ok") return [];
    const intervals = "intervals" in result ? result.intervals : null;
    const observations = "observations" in result ? result.observations : null;
    if (!intervals?.length && !observations?.length) return [];
    const gaps = result.coverage.gaps.filter((gap) => gap.reason !== "unknown");
    const line =
      observations && buildSeries(observations, measurement.expectedIntervalSeconds, gaps);
    const max = intervals?.reduce((max, row) => Math.max(max, row.totalMm ?? 0), 0);
    const label = `${measurement.name} ${parameterLabel(measurement.parameter).toLowerCase()}`;
    const unit =
      "periodSeconds" in result
        ? `${measurement.unit} per ${formatPeriod(result.periodSeconds)}`
        : measurement.unit;

    return [
      {
        index,
        measurement,
        result,
        gaps,
        intervals,
        line,
        label,
        unit,
        ...STYLES[index],
        min: line?.min ?? 0,
        max: line?.max ?? max ?? 0,
      },
    ];
  });
  const axes = comparisonAxes(series, (item) => item.measurement);
  const dual = axes.length === 2;
  let start = epochMs(series[0].result.from);
  let end = epochMs(series[0].result.to);
  for (const { intervals } of series) {
    for (const row of intervals ?? []) {
      const period = rainfallBounds(row);
      if (period) {
        start = Math.min(start, epochMs(period[0]));
        end = Math.max(end, epochMs(period[1]));
      }
    }
  }
  const x = timeTicks(start, end);
  const axisSide = (axis: number) => (dual ? (axis === 0 ? "Left axis" : "Right axis") : "Y axis");
  const firstRain = series.find((item) => item.intervals);
  const legend = series.map((item) => {
    const axisId = axes.findIndex((group) => group.includes(item));
    const datum = datumSummary(item.measurement);
    const axis = [axisSide(axisId), item.unit, datum].filter(Boolean).join(" · ");
    // Transparent hatching keeps overlapping interval bars at their actual bounds.
    const pattern = item.intervals && item !== firstRain ? `${patternId}-${item.index}` : undefined;
    return { ...item, axisId, axis, pattern };
  });

  return (
    <figure className="rounded-lg border border-line bg-surface px-2 py-3 sm:px-4">
      <svg aria-hidden="true" width="0" height="0" className="absolute">
        <defs>
          {legend.map(({ pattern, color, angle }) =>
            pattern ? (
              <pattern
                key={pattern}
                id={pattern}
                width="5"
                height="5"
                patternUnits="userSpaceOnUse"
                patternTransform={`rotate(${angle})`}
              >
                <path d="M 0 0 L 0 5" stroke={color} strokeWidth="2.5" />
              </pattern>
            ) : null,
          )}
        </defs>
      </svg>
      <figcaption>
        <ul
          aria-label="Chart legend"
          className="flex flex-wrap justify-between gap-x-5 gap-y-2 px-2 pb-2"
        >
          {legend.map(({ measurement, color, dash, intervals, label, axis, pattern }) => (
            <li key={measurement.measurementId} className="flex items-start gap-2 text-sm">
              <svg aria-hidden="true" className="mt-1 shrink-0" width="20" height="12">
                {intervals ? (
                  <rect
                    x="4"
                    y="1"
                    width="12"
                    height="10"
                    fill={pattern ? `url(#${pattern})` : color}
                    stroke={color}
                  />
                ) : (
                  <line
                    x1="0"
                    x2="20"
                    y1="6"
                    y2="6"
                    stroke={color}
                    strokeWidth="2"
                    strokeDasharray={dash}
                  />
                )}
              </svg>
              <div>
                <Link
                  href={measurementPath(measurement.measurementId)}
                  className="link font-medium"
                >
                  {label}
                </Link>
                <p className="text-xs text-ink-muted">{axis}</p>
              </div>
            </li>
          ))}
        </ul>
      </figcaption>
      <p id={`${patternId}-instructions`} className="sr-only">
        Use the left and right arrow keys to inspect the timeline.
      </p>
      <div
        role="group"
        aria-label={`Shared timeline in UK time. ${legend.map(({ label, axis }) => `${label}, ${axis}`).join(". ")}. Readings are in the comparison table below.`}
        className="h-64 w-full touch-pan-y sm:h-80"
      >
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart
            data={data}
            margin={{ top: 8, left: 4, right: 4, bottom: 0 }}
            accessibilityLayer
            aria-label="Inspect compared readings"
            aria-describedby={`${patternId}-instructions`}
          >
            <CartesianGrid yAxisId={0} vertical={false} stroke="var(--color-line)" />
            <XAxis
              dataKey="t"
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
            <XAxis
              xAxisId="readings"
              dataKey="t"
              type="number"
              scale="linear"
              domain={[start, end]}
              allowDataOverflow
              hide
            />
            {axes.map((items, axis) => {
              const min = Math.min(...items.map((item) => item.min));
              const max = Math.max(...items.map((item) => item.max));
              const rainfall = items[0].intervals !== null;
              const values = rainfall
                ? { domain: [0, max || 1], ticks: undefined }
                : valueAxis(min, max);

              return (
                <YAxis
                  key={axis}
                  yAxisId={axis}
                  orientation={axis === 0 ? "left" : "right"}
                  type="number"
                  domain={values.domain}
                  ticks={values.ticks}
                  allowDataOverflow
                  width="auto"
                  tickFormatter={(value: number) => axisNumber.format(value)}
                  tick={{
                    fill: dual && items.length === 1 ? items[0].color : "var(--color-ink-muted)",
                    fontSize: 12,
                  }}
                  tickLine={false}
                  axisLine={false}
                />
              );
            })}
            {series.flatMap(({ index, color, gaps }) =>
              gaps.map((gap) => (
                <ReferenceArea
                  key={`${index}-${gap.from}`}
                  yAxisId={0}
                  x1={Math.max(start, epochMs(gap.from))}
                  x2={Math.min(end, epochMs(gap.to))}
                  fill={color}
                  fillOpacity={0.08}
                  stroke={color}
                  strokeOpacity={0.35}
                  strokeDasharray={index === 0 ? "3 3" : "1 3"}
                  ifOverflow="hidden"
                />
              )),
            )}
            {legend.map(({ index, color, dash, intervals, axisId, pattern }) =>
              intervals ? (
                <RainfallBars
                  key={index}
                  intervals={intervals}
                  yAxisId={axisId}
                  color={color}
                  fill={pattern ? `url(#${pattern})` : color}
                  dash={dash}
                  opacity={0.55}
                />
              ) : null,
            )}
            {legend.map(({ index, color, dash, line, axisId }) =>
              line ? (
                <Line
                  key={index}
                  data={line.points}
                  dataKey="value"
                  yAxisId={axisId}
                  type="linear"
                  connectNulls={false}
                  stroke={color}
                  strokeWidth={2}
                  strokeDasharray={dash}
                  dot={IsolatedDot}
                  activeDot={false}
                  isAnimationActive={false}
                />
              ) : null,
            )}
            <Line
              xAxisId="readings"
              dataKey={() => 0}
              stroke="none"
              dot={false}
              activeDot={false}
              isAnimationActive={false}
            />
            <Tooltip
              axisId="readings"
              isAnimationActive={false}
              cursor={{ stroke: "var(--color-line-strong)" }}
              content={({ active, activeIndex }) => {
                const row = active && activeIndex != null ? data[Number(activeIndex)] : undefined;
                if (!row) return null;
                return (
                  <div
                    role="status"
                    className="max-w-56 rounded border border-line bg-surface px-3 py-2 text-xs text-ink shadow-sm"
                  >
                    <p className="text-ink-muted">
                      <time dateTime={row.time}>{inspectionTime.format(row.t)}</time>
                    </p>
                    {legend.map(({ index, label, measurement, color }) => {
                      const reading = row.readings[index];
                      if (!reading) return null;
                      return (
                        <div key={index} className="mt-1">
                          <p className="font-semibold" style={{ color }}>
                            {label}
                          </p>
                          <ComparisonValue reading={reading} unit={measurement.unit} />
                          {"label" in reading && tickKey(reading.label) !== tickKey(row.time) ? (
                            <p className="text-ink-muted">
                              Provider label <Time value={reading.label} />
                            </p>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                );
              }}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </figure>
  );
}
