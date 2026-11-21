import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { cloneElement, type ReactElement } from "react";
import { expect, it, vi } from "vitest";
import { RainfallHistory } from "@/components/history/rainfall-history";
import type { HistoryResult } from "@/lib/history/load";

vi.mock("recharts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("recharts")>();
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: ReactElement<{ width?: number }> }) =>
      cloneElement(children, { width: 360, height: 256 } as { width: number }),
  };
});

type History = Extract<HistoryResult, { intervals: unknown }>;
const interval: History["intervals"][number] = {
  label: "2026-11-20T00:00:00Z",
  labelConvention: "period_end",
  periodStart: "2026-11-19T23:45:00Z",
  periodEnd: "2026-11-20T00:00:00Z",
  totalMm: 0.0125,
  eligible: true,
  quality: null,
  ineligibleReason: null,
  revision: 2,
};
const history: History = {
  status: "ok",
  from: "2026-11-20T00:00:00Z",
  to: "2026-11-20T01:15:00Z",
  retrievedAt: "2026-11-20T02:00:00Z",
  periodSeconds: 900,
  pages: 1,
  coverage: { status: "unknown", gaps: [] },
  window: null,
  windowUnavailable: null,
  intervals: [
    interval,
    {
      ...interval,
      label: "2026-11-20T00:15:00Z",
      periodStart: "2026-11-20T00:00:00Z",
      periodEnd: "2026-11-20T00:15:00Z",
      totalMm: 0,
    },
    {
      ...interval,
      label: "2026-11-20T00:45:00Z",
      labelConvention: "unverified",
      periodStart: null,
      periodEnd: null,
      totalMm: 0.25,
    },
    {
      ...interval,
      label: "2026-11-20T01:00:00Z",
      labelConvention: "period_start",
      periodStart: "2026-11-20T01:00:00Z",
      periodEnd: "2026-11-20T01:15:00Z",
      totalMm: null,
      eligible: false,
      ineligibleReason: "QualitySuspect",
    },
  ],
};

it("uses physical bounds for bars and only the label for unverified timing", async () => {
  render(<RainfallHistory history={history} span="7 days" />);
  const chart = screen.getByRole("img", { name: /1 missing · 1 ineligible/ });
  const bar = within(chart).getByText(/19 Nov, 23:45 to 20 Nov, 00:00 · 0\.0125 mm/).parentElement!;
  expect(bar.tagName).toBe("rect");
  expect(Number(bar.getAttribute("width"))).toBeGreaterThan(0);
  const unverified = within(chart).getByText(
    /00:45 \(provider label, timing unverified\) · 0\.25 mm/,
  ).parentElement!;
  expect(unverified.tagName).toBe("line");
  expect(unverified.getAttribute("x1")).toBe(unverified.getAttribute("x2"));
  expect(within(chart).getByText(/ · 0 mm/).parentElement?.tagName).toBe("line");
  expect(within(chart).getByText(/ · Ineligible/).parentElement?.tagName).toBe("path");
  expect(chart).not.toHaveTextContent("00:30");

  await userEvent.click(screen.getByText("Readings table (4)"));
  const table = screen.getByRole("table", { name: /^Rainfall readings in mm/ });
  expect(within(table).getByText("Ineligible")).toBeVisible();
  expect(within(table).getByText("Suspect quality")).toBeVisible();
  expect(
    within(table).getByText("Timing unverified").closest("tr")?.querySelectorAll("time"),
  ).toHaveLength(1);
  expect(within(table).getByText("0", { selector: "td" })).toBeVisible();
  expect(within(table).getByText("0.0125")).toBeVisible();
  expect(
    within(table)
      .getByText(/No reading for label/)
      .closest("tr"),
  ).toHaveTextContent("00:30");
});
