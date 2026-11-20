import { render, screen } from "@testing-library/react";
import { cloneElement, type ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

// jsdom has no layout, so ResponsiveContainer would measure 0×0 and draw nothing; give the chart a fixed size.
vi.mock("recharts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("recharts")>();
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: ReactElement<{ width?: number }> }) =>
      cloneElement(children, { width: 640, height: 320 } as { width: number }),
  };
});

const { HistoryChart, describeChart, timeTicks, ukMidnights, valueAxis } =
  await import("@/components/history/history-chart");
type Props = import("@/components/history/history-chart").HistoryChartProps;

const FROM = "2026-11-13T00:00:00Z";
const TO = "2026-11-20T00:00:00Z";

function readingsAt(times: string[], values: number[]) {
  return times.map((observedAt, index) => ({ observedAt, value: values[index] }));
}

const base: Props = {
  // 15-minute cadence with one missed run between 00:30 and 02:00, then an isolated reading at 05:00.
  readings: readingsAt(
    [
      "2026-11-18T00:00:00Z",
      "2026-11-18T00:15:00Z",
      "2026-11-18T00:30:00Z",
      "2026-11-18T02:00:00Z",
      "2026-11-18T02:15:00Z",
      "2026-11-18T05:00:00Z",
    ],
    [-0.25, -0.125, 0.5, 0.75, 1, 1.5],
  ),
  from: FROM,
  to: TO,
  expectedIntervalSeconds: 900,
  knownGaps: [],
  unit: "mASD",
  parameterLabel: "Water level",
};

describe("describeChart", () => {
  it("summarises window, count, range with unit and breaks, keeping negatives", () => {
    const label = describeChart(base);
    expect(label).toContain("Water level, 13 Nov 2026, 00:00 to 20 Nov 2026, 00:00.");
    expect(label).toContain("6 readings, lowest -0.25 mASD, highest 1.5 mASD.");
    expect(label).toContain("broken at 2 missing intervals");
    expect(label).not.toContain("known gap");
    expect(label).toMatch(/Readings table below\.$/);
  });

  it("names known gaps with reason and UK times", () => {
    const label = describeChart({
      ...base,
      // BST does not apply in November, so UK time equals UTC here.
      knownGaps: [
        { from: "2026-11-18T00:30:00Z", to: "2026-11-18T02:00:00Z", reason: "source_outage" },
      ],
    });
    expect(label).toContain(
      "Shaded 1 known gap: source outage from 18 Nov 2026, 00:30 to 18 Nov 2026, 02:00.",
    );
  });

  it("uses singular wording and UK summer time", () => {
    const label = describeChart({
      ...base,
      from: "2026-07-01T00:00:00Z",
      to: "2026-07-08T00:00:00Z",
      readings: readingsAt(["2026-07-02T11:00:00Z"], [3]),
      unit: "m3/s",
      parameterLabel: "Flow",
    });
    expect(label).toContain("Flow, 1 Jul 2026, 01:00 to 8 Jul 2026, 01:00.");
    expect(label).toContain("1 reading, lowest 3 m3/s, highest 3 m3/s.");
    expect(label).not.toContain("missing interval");
  });
});

describe("axes", () => {
  it("ticks at UK midnights, honouring summer time", () => {
    expect(
      ukMidnights(Date.parse("2026-07-01T00:00:00Z"), Date.parse("2026-07-02T00:00:00Z")),
    ).toEqual([Date.parse("2026-07-01T23:00:00Z")]);
  });

  it("uses day ticks for a week and weekly date ticks for 30 days", () => {
    const week = timeTicks(Date.parse(FROM), Date.parse(TO));
    expect(week.ticks).toHaveLength(8);
    expect(week.format(week.ticks[5])).toBe("Wed 18");

    const month = timeTicks(Date.parse("2026-10-21T00:00:00Z"), Date.parse(TO));
    expect(month.ticks.map(month.format)).toEqual([
      "22 Oct",
      "29 Oct",
      "5 Nov",
      "12 Nov",
      "19 Nov",
    ]);
  });

  it("follows the data without forcing zero and keeps negatives", () => {
    const high = valueAxis(10.2, 10.8);
    expect(high.domain[0]).toBeGreaterThan(9);
    expect(high.domain[0]).toBeLessThanOrEqual(10.2);
    expect(high.domain[1]).toBeGreaterThanOrEqual(10.8);

    const negative = valueAxis(-0.25, 1.5);
    expect(negative.domain[0]).toBeLessThan(-0.25);
    expect(negative.ticks.some((tick) => tick < 0)).toBe(true);

    const flat = valueAxis(2, 2);
    expect(flat.domain[0]).toBeLessThan(2);
    expect(flat.domain[1]).toBeGreaterThan(2);
  });
});

/** Points per drawn run of the line: each `M` starts a run, each `L` joins one more reading. */
function runs(container: HTMLElement) {
  const path = container.querySelector(".recharts-line-curve")?.getAttribute("d") ?? "";
  return path
    .split("M")
    .slice(1)
    .map((run) => run.split("L").length);
}

describe("HistoryChart", () => {
  it("exposes one image named by the summary, with no focusable chart surface", () => {
    const { container } = render(<HistoryChart {...base} />);
    expect(screen.getByRole("img", { name: describeChart(base) })).toBeInTheDocument();
    expect(screen.getByRole("figure")).toHaveTextContent("Water level (mASD)");
    expect(container.querySelector('[tabindex]:not([tabindex="-1"])')).toBeNull();
  });

  it("never joins readings across a missing interval and marks the isolated reading", () => {
    const { container } = render(<HistoryChart {...base} />);
    // Three separate runs (each starts with a move): 00:00–00:30, 02:00–02:15 and the lone 05:00 reading.
    expect(runs(container)).toEqual([3, 2, 1]);
    expect(container.querySelectorAll(".recharts-line-dots circle")).toHaveLength(1);
  });

  it("breaks the line at a known gap even within the expected cadence", () => {
    const props: Props = {
      ...base,
      readings: readingsAt(
        [
          "2026-11-18T00:00:00Z",
          "2026-11-18T00:15:00Z",
          "2026-11-18T00:30:00Z",
          "2026-11-18T00:45:00Z",
        ],
        [1, 2, 3, 4],
      ),
      knownGaps: [
        { from: "2026-11-18T00:20:00Z", to: "2026-11-18T00:25:00Z", reason: "not_collected" },
      ],
    };
    const { container } = render(<HistoryChart {...props} />);
    expect(runs(container)).toEqual([2, 2]);
    expect(container.querySelectorAll(".recharts-reference-area")).toHaveLength(1);
  });

  it("shows negative y ticks unchanged", () => {
    const { container } = render(<HistoryChart {...base} />);
    const ticks = Array.from(container.querySelectorAll(".recharts-cartesian-axis-tick-value")).map(
      (tick) => tick.textContent,
    );
    expect(ticks).toContain("-0.5");
  });
});
