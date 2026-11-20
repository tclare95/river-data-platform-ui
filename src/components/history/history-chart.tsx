"use client";

/**
 * A gauge's observed readings over a 7- or 30-day window.
 *
 * Only source readings are drawn, as straight segments between consecutive readings that `buildSeries` joins; its
 * `null` break points keep missing intervals and known coverage gaps unconnected. Known gaps are shaded at their real
 * width on a linear time axis. Nothing is interpolated, smoothed, resampled or clipped, and the y axis follows the
 * data (never forced to zero, negatives kept). The plot is one `role="img"` whose label summarises the data; the
 * readings themselves are in the table the page renders below the chart.
 */
import type { JSX } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceArea,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type DotItemDotProps,
  type TooltipContentProps,
} from "recharts";
import { formatNumber } from "@/lib/format";
import { buildSeries, type Series, type SeriesPoint } from "@/lib/history/series";
import { epochMs } from "@/lib/rdp/contract";

export type KnownGapReason = "not_collected" | "legacy_unrecoverable" | "source_outage";

export type HistoryChartProps = {
  /** Strictly ascending source readings in [from, to). Never empty when rendered. */
  readings: ReadonlyArray<{ observedAt: string; value: number }>;
  /** Window bounds (UTC ISO `Z`): inclusive from, exclusive to. The x domain is exactly [from, to]. */
  from: string;
  to: string;
  expectedIntervalSeconds: number;
  /** RDP coverage gaps with a KNOWN reason (never "unknown"); shade them and never join readings across them. */
  knownGaps: ReadonlyArray<{ from: string; to: string; reason: KnownGapReason }>;
  unit: string;
  parameterLabel: string;
  /** Charts with the same id move their hover cursor together, matched by time (comparison). */
  syncId?: string;
  /** Value range to scale against instead of this series' own (a shared scale across compared charts). */
  valueRange?: readonly [number, number];
  /** Fixed y-axis width, so stacked charts' time axes line up exactly. */
  yAxisWidth?: number;
  /** Where the readings are listed, for the accessible summary. */
  tableHint?: string;
};

const DAY_MS = 86_400_000;
/** Windows up to this long get a tick per day; longer ones a tick per week. */
const DAILY_TICKS_MAX_MS = 8 * DAY_MS;

const GAP_REASON: Record<KnownGapReason, string> = {
  not_collected: "not collected",
  legacy_unrecoverable: "unrecoverable from the legacy archive",
  source_outage: "source outage",
};

const UK = "Europe/London";
const dayTick = new Intl.DateTimeFormat("en-GB", {
  timeZone: UK,
  weekday: "short",
  day: "numeric",
});
const dateTick = new Intl.DateTimeFormat("en-GB", { timeZone: UK, day: "numeric", month: "short" });
const fullTime = new Intl.DateTimeFormat("en-GB", {
  timeZone: UK,
  weekday: "short",
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});
const shortTime = new Intl.DateTimeFormat("en-GB", {
  timeZone: UK,
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});
const ukClock = new Intl.DateTimeFormat("en-GB", {
  timeZone: UK,
  hour: "numeric",
  minute: "numeric",
  hourCycle: "h23",
});
const axisNumber = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 3 });

function plural(count: number, word: string) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** UK local midnights in [fromMs, toMs], found on whole UTC hours so BST/GMT changes are honoured. */
export function ukMidnights(fromMs: number, toMs: number): number[] {
  const result: number[] = [];
  for (let t = Math.ceil(fromMs / 3_600_000) * 3_600_000; t <= toMs; t += 3_600_000) {
    const parts = ukClock.formatToParts(t);
    const hour = parts.find((part) => part.type === "hour")?.value;
    const minute = parts.find((part) => part.type === "minute")?.value;
    if (Number(hour) === 0 && Number(minute) === 0) result.push(t);
  }
  return result;
}

/** X ticks at UK midnights: daily ("Wed 18") for a week, weekly dates ("18 Nov") for longer windows. */
export function timeTicks(fromMs: number, toMs: number) {
  const midnights = ukMidnights(fromMs, toMs);
  if (toMs - fromMs <= DAILY_TICKS_MAX_MS) {
    return { ticks: midnights, format: (t: number) => dayTick.format(t) };
  }
  return {
    ticks: midnights.filter((_, index) => index % 7 === 0),
    format: (t: number) => dateTick.format(t),
  };
}

function niceStep(raw: number) {
  const power = 10 ** Math.floor(Math.log10(raw));
  const fraction = raw / power;
  return (
    (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10) * power
  );
}

/**
 * Round y bounds and ticks around the data with a little padding. Zero is included only when the data reach it;
 * a flat series gets a small band around its value.
 */
export function valueAxis(min: number, max: number) {
  const span = max - min;
  const pad = span > 0 ? span * 0.08 : Math.max(Math.abs(max) * 0.05, 0.1);
  const step = niceStep((span + 2 * pad) / 5);
  const decimals = Math.max(0, -Math.floor(Math.log10(step)) + 1);
  const round = (value: number) => Number(value.toFixed(decimals));
  const lower = round(Math.floor((min - pad) / step) * step);
  const upper = round(Math.ceil((max + pad) / step) * step);
  const ticks: number[] = [];
  for (let value = lower; value <= upper + step / 2; value += step) ticks.push(round(value));
  return { domain: [lower, upper] as [number, number], ticks };
}

function summarise(props: HistoryChartProps, series: Series) {
  const window = `${shortTime.format(epochMs(props.from))} to ${shortTime.format(epochMs(props.to))}`;
  const parts = [`${props.parameterLabel}, ${window}.`];
  if (series.count === 0 || series.min === null || series.max === null) {
    parts.push("No readings.");
  } else {
    parts.push(
      `${plural(series.count, "reading")}, lowest ${formatNumber(series.min, props.unit)}, highest ${formatNumber(series.max, props.unit)}.`,
    );
  }
  if (series.missing.length > 0) {
    parts.push(`The line is broken at ${plural(series.missing.length, "missing interval")}.`);
  }
  if (props.knownGaps.length > 0) {
    const gaps = props.knownGaps.map(
      (gap) =>
        `${GAP_REASON[gap.reason]} from ${shortTime.format(epochMs(gap.from))} to ${shortTime.format(epochMs(gap.to))}`,
    );
    parts.push(`Shaded ${plural(props.knownGaps.length, "known gap")}: ${gaps.join("; ")}.`);
  }
  parts.push(props.tableHint ?? "Every reading is in the Readings table below.");
  return parts.join(" ");
}

/** The plot's accessible summary: parameter, UK window, count, range with unit, breaks and known gaps. */
export function describeChart(props: HistoryChartProps): string {
  return summarise(
    props,
    buildSeries(props.readings, props.expectedIntervalSeconds, props.knownGaps),
  );
}

/** A visible marker only for a reading with no joined neighbour; a line segment alone would hide it. */
function IsolatedDot({ cx, cy, payload, index }: DotItemDotProps) {
  const point = payload as SeriesPoint;
  if (!point.isolated || cx === undefined || cy === undefined) return <g key={index} />;
  return (
    <circle
      key={index}
      cx={cx}
      cy={cy}
      r={4}
      fill="var(--color-accent)"
      stroke="var(--color-surface)"
      strokeWidth={2}
    />
  );
}

function ReadingTooltip({
  active,
  payload,
  unit,
}: Pick<TooltipContentProps, "active" | "payload"> & { unit: string }) {
  const point = payload?.[0]?.payload as SeriesPoint | undefined;
  // Break markers are not readings: show nothing rather than a value for a gap.
  if (!active || !point || point.value === null) return null;
  return (
    <div className="rounded border border-line bg-surface px-3 py-2 text-sm text-ink shadow-sm">
      <p className="text-ink-muted">{fullTime.format(point.t)}</p>
      <p className="font-medium">{formatNumber(point.value, unit)}</p>
    </div>
  );
}

export function HistoryChart(props: HistoryChartProps): JSX.Element {
  const { readings, from, to, expectedIntervalSeconds, knownGaps, unit, parameterLabel } = props;
  const { syncId, valueRange, yAxisWidth } = props;
  const series = buildSeries(readings, expectedIntervalSeconds, knownGaps);
  const fromMs = epochMs(from);
  const toMs = epochMs(to);
  const x = timeTicks(fromMs, toMs);
  const y = valueRange
    ? valueAxis(valueRange[0], valueRange[1])
    : valueAxis(series.min ?? 0, series.max ?? 0);
  // Shade only the part of each gap inside the window.
  const shaded = knownGaps
    .map((gap) => [Math.max(epochMs(gap.from), fromMs), Math.min(epochMs(gap.to), toMs)] as const)
    .filter(([start, end]) => end > start);

  return (
    <figure className="m-0">
      <figcaption className="mb-2 text-xs text-ink-muted">
        {parameterLabel} ({unit})
      </figcaption>
      {/* Fixed height reserved before Recharts measures on the client, so hydration causes no layout shift. */}
      <div role="img" aria-label={summarise(props, series)} className="h-64 w-full sm:h-80">
        <ResponsiveContainer width="100%" height="100%">
          {/* The keyboard accessibility layer is off: inside role="img" its focusable surface would be a hidden
              tab stop, and every reading is available in the table below instead. */}
          <LineChart
            data={series.points}
            margin={{ top: 8, right: 12, bottom: 0, left: 0 }}
            accessibilityLayer={false}
            syncId={syncId}
            syncMethod="value"
          >
            <CartesianGrid vertical={false} stroke="var(--color-line)" />
            {shaded.map(([start, end]) => (
              <ReferenceArea
                key={`${start}-${end}`}
                x1={start}
                x2={end}
                ifOverflow="hidden"
                fill="var(--color-ink-muted)"
                fillOpacity={0.1}
                stroke="var(--color-line-input)"
                strokeDasharray="3 3"
              />
            ))}
            <XAxis
              dataKey="t"
              type="number"
              scale="time"
              domain={[fromMs, toMs]}
              allowDataOverflow={false}
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
              domain={y.domain}
              ticks={y.ticks}
              allowDataOverflow={false}
              tickFormatter={(value: number) => axisNumber.format(value)}
              width={yAxisWidth ?? "auto"}
              tick={{ fill: "var(--color-ink-muted)", fontSize: 12 }}
              tickLine={false}
              axisLine={false}
            />
            <Tooltip
              content={(content) => <ReadingTooltip {...content} unit={unit} />}
              cursor={{ stroke: "var(--color-line-strong)" }}
              isAnimationActive={false}
            />
            <Line
              dataKey="value"
              type="linear"
              connectNulls={false}
              stroke="var(--color-accent)"
              strokeWidth={2}
              dot={IsolatedDot}
              activeDot={{ r: 4, stroke: "var(--color-surface)", strokeWidth: 2 }}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </figure>
  );
}
