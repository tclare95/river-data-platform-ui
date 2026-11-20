import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { MeasurementExplorer } from "@/components/measurement-explorer";
import { createRdpClient } from "@/lib/rdp/client";
import { createFixtureTransport } from "@/lib/rdp/fixture";
import type { OverviewItem } from "@/lib/overview";
import { publicMeasurements, toPublicLatest, toPublicMeasurement } from "@/lib/rdp/public";

async function fixtureItems(): Promise<OverviewItem[]> {
  const rdp = createRdpClient({
    mode: "fixture",
    transport: createFixtureTransport(() => Date.parse("2026-11-19T12:07:00Z")),
    log: () => undefined,
  });
  const measures = publicMeasurements((await rdp.listMeasurements()).measurements);
  const latest = await rdp.getLatest(measures.map((m) => m.measurementId));
  return measures.map((m) => ({
    measurement: toPublicMeasurement(m),
    latest: toPublicLatest(latest.items.find((item) => item.measurementId === m.measurementId)!),
  }));
}

const links = () => screen.queryAllByRole("link").map((link) => link.textContent);

describe("measurement explorer", () => {
  let items: OverviewItem[];
  beforeEach(async () => {
    window.history.replaceState(null, "", "/");
    items = await fixtureItems();
  });

  it("narrows results as the visitor types and announces the count", async () => {
    const user = userEvent.setup();
    render(<MeasurementExplorer items={items} initialQuery={{ q: "", type: null }} />);
    await user.type(screen.getByRole("searchbox", { name: "Search" }), "kegw");
    expect(links()).toEqual(["Kegworth Water level"]);
    // The visible count updates instantly; screen readers hear it once typing pauses.
    expect(
      screen.getByText("1 measurement found", { selector: ":not([role=status])" }),
    ).not.toHaveAttribute("aria-live");
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("1 measurement found"),
    );
    expect(window.location.search).toBe("?q=kegw");
  });

  it("filters by type with the keyboard alone", async () => {
    const user = userEvent.setup();
    render(<MeasurementExplorer items={items} initialQuery={{ q: "", type: null }} />);
    const group = screen.getByRole("group", { name: "Type" });
    expect(
      within(group)
        .getAllByRole("radio")
        .map((radio) => radio.closest("label")!.textContent),
    ).toEqual(["All", "Water level", "Flow", "Rainfall"]);
    await user.tab(); // search
    await user.tab(); // type: All
    expect(within(group).getByRole("radio", { name: "All" })).toHaveFocus();
    await user.keyboard("{ArrowRight}{ArrowRight}");
    expect(within(group).getByRole("radio", { name: "Flow" })).toBeChecked();
    expect(links()).toEqual(["Shardlow Flow"]);
    expect(window.location.search).toBe("?type=flow");
    // Tabbing on from the filter reaches the first result.
    await user.tab();
    expect(screen.getByRole("link", { name: "Shardlow Flow" })).toHaveFocus();
  });

  it("combines search and type", async () => {
    window.history.replaceState(null, "", "/?type=level");
    const user = userEvent.setup();
    render(<MeasurementExplorer items={items} initialQuery={{ q: "", type: "level" }} />);
    await user.type(screen.getByRole("searchbox"), "shardlow");
    expect(links()).toEqual(["Shardlow Water level"]);
  });

  it("shows an empty state with a way back when nothing matches", async () => {
    const user = userEvent.setup();
    render(<MeasurementExplorer items={items} initialQuery={{ q: "", type: null }} />);
    await user.type(screen.getByRole("searchbox"), "zzz");
    expect(screen.getByText("No matching measurements")).toBeInTheDocument();
    expect(screen.getAllByText("No measurements found")[0]).toBeInTheDocument();
    const clear = screen.getByRole("link", { name: "Clear search" });
    expect(clear).toHaveAttribute("href", "/");
    await user.click(clear);
    expect(screen.getByRole("searchbox")).toHaveValue("");
    expect(links()).toHaveLength(7);
    expect(window.location.search).toBe("");
  });

  it("hides the type filter when only one type is published", () => {
    const levels = items.filter((item) => item.measurement.parameter === "level");
    render(<MeasurementExplorer items={levels} initialQuery={{ q: "", type: null }} />);
    expect(screen.queryByRole("group", { name: "Type" })).toBeNull();
  });

  it("submits as a plain GET form when scripts are unavailable", () => {
    render(<MeasurementExplorer items={items} initialQuery={{ q: "", type: null }} />);
    const form = screen.getByRole("search");
    expect(form).toHaveAttribute("action", "/");
    expect(form).toHaveAttribute("method", "get");
    expect(screen.getByRole("searchbox")).toHaveAttribute("name", "q");
  });

  it("keeps unrelated query parameters and the fragment when syncing the URL", async () => {
    window.history.replaceState(null, "", "/?utm_source=x#main");
    const user = userEvent.setup();
    render(<MeasurementExplorer items={items} initialQuery={{ q: "", type: null }} />);
    await user.type(screen.getByRole("searchbox"), "colwick");
    expect(window.location.search).toBe("?utm_source=x&q=colwick");
    expect(window.location.hash).toBe("#main");
  });

  it("keeps an applied type visible and removable even with one published type", () => {
    const levels = items.filter((item) => item.measurement.parameter === "level");
    window.history.replaceState(null, "", "/?type=level");
    render(<MeasurementExplorer items={levels} initialQuery={{ q: "", type: "level" }} />);
    expect(screen.getByRole("radio", { name: "Water level" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "All" })).toBeInTheDocument();
  });

  it("restores the search from the URL when the page is restored with the original payload", () => {
    window.history.replaceState(null, "", "/?q=shardlow&type=flow");
    render(<MeasurementExplorer items={items} initialQuery={{ q: "", type: null }} />);
    expect(screen.getByRole("searchbox")).toHaveValue("shardlow");
    expect(links()).toEqual(["Shardlow Flow"]);
  });
});
