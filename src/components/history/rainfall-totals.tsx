"use client";

import { useXAxisScale, useYAxisScale } from "recharts";
import {
  RAINFALL_MODES,
  rainfallDepth,
  rainfallTotalCoverage,
  type RainfallMode,
  type RainfallTotal,
} from "@/lib/history/rainfall-totals";
import { epochMs } from "@/lib/rdp/contract";

export function RainfallModeControl({
  mode,
  onChange,
}: {
  mode: RainfallMode;
  onChange: (mode: RainfallMode) => void;
}) {
  return (
    <label className="flex flex-wrap items-center gap-2 text-sm font-medium">
      Rainfall view
      <select
        value={mode}
        onChange={(event) => onChange(event.target.value as RainfallMode)}
        className="min-h-10 rounded border border-line-strong bg-surface px-2 text-ink"
      >
        {Object.entries(RAINFALL_MODES).map(([key, label]) => (
          <option key={key} value={key}>
            {label}
          </option>
        ))}
      </select>
    </label>
  );
}

function utc(timestamp: string) {
  return timestamp.slice(0, 16).replace("T", " ");
}

export function RainfallTotalValue({
  total,
  showWindow = false,
}: {
  total: RainfallTotal;
  showWindow?: boolean;
}) {
  return (
    <>
      <span>{rainfallDepth(total.totalMm)}</span>
      <span className="block text-ink-muted">{rainfallTotalCoverage(total)}</span>
      {showWindow ? (
        <span className="block text-ink-muted">
          <time dateTime={total.from}>{utc(total.from)}</time> to{" "}
          <time dateTime={total.to}>{utc(total.to)}</time> UTC
        </span>
      ) : null}
    </>
  );
}

export function RainfallTotalsNote({
  mode,
  totals,
}: {
  mode: RainfallMode;
  totals: readonly RainfallTotal[];
}) {
  const indicative = totals.some(({ basis }) => basis === "indicative");
  const partial = totals.some(({ status }) => status === "partial");
  const unavailable = totals.some(({ status }) => status === "unavailable");
  if (mode === "native" || !totals.length) return null;
  if (mode !== "daily" && !indicative && !partial && !unavailable) return null;
  return (
    <p className="text-sm text-ink-muted">
      {mode === "daily"
        ? "Days start at midnight UTC. The chart range can cut the first or last day short. "
        : ""}
      {indicative
        ? "Indicative totals group provider labels where interval timing is unverified. "
        : ""}
      {partial ? "Outlined marks show partial totals. " : ""}
      {unavailable ? "Gaps show unavailable totals." : ""}
    </p>
  );
}

export function RainfallTotalsPlot({
  totals,
  mode,
  yAxisId,
  color = "var(--color-accent)",
  dash,
  fill = color,
}: {
  totals: readonly RainfallTotal[];
  mode: RainfallMode;
  yAxisId?: number;
  color?: string;
  dash?: string;
  fill?: string;
}) {
  const x = useXAxisScale();
  const y = useYAxisScale(yAxisId);
  const baseline = y?.(0);
  if (!x || !y || baseline === undefined) return null;

  const bars = mode === "daily" || mode === "hourly";
  const points = totals.map((total) => ({
    at: x(epochMs(total.to)),
    left: bars ? x(epochMs(total.from)) : undefined,
    top: total.totalMm === null ? undefined : y(total.totalMm),
    total,
  }));
  return points.map(({ at, left, top, total }, index) => {
    if (at === undefined || top === undefined) return null;

    const partial = total.status === "partial";
    const indicative = total.basis === "indicative";
    const strokeDasharray = indicative ? "2 2" : dash;
    const title = (
      <title>
        {utc(total.from)} to {utc(total.to)} UTC · {rainfallDepth(total.totalMm)} ·{" "}
        {rainfallTotalCoverage(total)}
      </title>
    );

    if (left !== undefined) {
      return (
        <rect
          key={total.to}
          x={left}
          y={Math.min(top, baseline - 2)}
          width={at - left}
          height={Math.max(2, baseline - top)}
          fill={partial ? "none" : fill}
          fillOpacity={indicative ? 0.35 : 0.55}
          stroke={color}
          strokeDasharray={strokeDasharray}
        >
          {title}
        </rect>
      );
    }

    const previous = points[index - 1];
    const join =
      !partial &&
      previous?.total.status === "complete" &&
      previous.total.basis === total.basis &&
      previous.at !== undefined &&
      previous.top !== undefined;
    return (
      <g key={total.to}>
        {join ? (
          <line
            x1={previous.at}
            x2={at}
            y1={previous.top}
            y2={top}
            stroke={color}
            strokeWidth={1.5}
            strokeDasharray={strokeDasharray}
          />
        ) : null}
        <circle
          cx={at}
          cy={top}
          r={partial ? 2.5 : 1.5}
          stroke={color}
          fill={partial ? "var(--color-surface)" : color}
        >
          {title}
        </circle>
      </g>
    );
  });
}
