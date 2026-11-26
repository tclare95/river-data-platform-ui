import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { cloneElement, type ReactElement } from "react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRdpClient, type RdpClient } from "@/lib/rdp/client";
import { RdpError } from "@/lib/rdp/errors";
import { createFixtureTransport } from "@/lib/rdp/fixture";
import type { RdpTransport } from "@/lib/rdp/transport";

let getClient: () => RdpClient;
vi.mock("next/server", () => ({ connection: async () => undefined }));
vi.mock("@/lib/rdp/server", () => ({ getRdpClient: () => getClient() }));
vi.mock("recharts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("recharts")>();
  return {
    ...actual,
    ResponsiveContainer: ({
      children,
    }: {
      children: ReactElement<{ width: number; height: number }>;
    }) => cloneElement(children, { width: 360, height: 256 }),
  };
});
const { default: ComparePage } = await import("@/app/compare/page");

const NOW = Date.parse("2026-11-19T12:07:00Z");
type Body = { data: Array<Record<string, unknown>>; meta: Record<string, unknown> };

function useClient(transport: RdpTransport, mode: "fixture" | "live" = "fixture") {
  const client = createRdpClient({ mode: "fixture", transport, log: () => undefined });
  getClient = () => (mode === "live" ? ({ ...client, mode: "live" } as RdpClient) : client);
}

function withHistory(
  edit: (body: Body, path: string, query: Record<string, string>) => Body | Promise<Body>,
) {
  const fixture = createFixtureTransport(() => NOW);
  return async (request: Parameters<RdpTransport>[0]) => {
    const body = await fixture(request);
    return request.path.endsWith("/observations")
      ? edit(body as Body, request.path, request.query as Record<string, string>)
      : body;
  };
}

async function renderCompare(params: Record<string, string | string[]>) {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  const page = await ComparePage({
    params: Promise.resolve({}),
    searchParams: Promise.resolve(params),
  } as unknown as PageProps<"/compare">);
  await act(async () => {
    render(page);
  });
  vi.useRealTimers();
}

function rows(scope: HTMLElement) {
  return within(scope).getAllByRole("row").slice(1);
}

describe("compare page", () => {
  beforeEach(() => useClient(createFixtureTransport(() => NOW)));

  it("offers only comparable measurements and suggests a first pair", async () => {
    await renderCompare({});
    const first = screen.getByRole("combobox", { name: "Choose a measurement" });
    const options = within(first)
      .getAllByRole("option")
      .map((option) => option.textContent);
    expect(options).toContain("Shardlow · Flow (m3/s)");
    expect(options.some((text) => text?.includes("Rainfall"))).toBe(true);
    expect(screen.getByRole("link", { name: "Shardlow flow and water level" })).toHaveAttribute(
      "href",
      "/compare?a=ea-shardlow-flow&b=ea-shardlow-level",
    );
    // A plain GET form: it works without JavaScript.
    const form = screen.getByRole("form", { name: "Choose measurements" });
    expect(form).toHaveAttribute("method", "get");
    expect(form).toHaveAttribute("action", "/compare");
    expect(screen.getByRole("note")).toHaveTextContent("Sample data for development");
    expect(screen.queryByRole("region", { name: "History" })).toBeNull();
  });

  it("adds a published measurement with a keyboard-accessible GET form and preserves the selection", async () => {
    await renderCompare({ a: "ea-shardlow-level", range: "30d" });
    const form = screen.getByRole<HTMLFormElement>("form", { name: "Choose measurements" });
    const add = within(form).getByRole("combobox", { name: "Add a measurement" });
    expect(within(add).queryByRole("option", { name: /^Shardlow · Water level/ })).toBeNull();
    const user = userEvent.setup();
    await user.tab();
    expect(screen.getByRole("link", { name: "Back to explorer" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("link", { name: /^Remove Shardlow/ })).toHaveFocus();
    await user.tab();
    expect(add).toHaveFocus();
    await user.selectOptions(add, "ea-colwick-level");
    await user.tab();
    expect(within(form).getByRole("button", { name: "Add" })).toHaveFocus();
    expect(Object.fromEntries(new FormData(form))).toEqual({
      a: "ea-shardlow-level",
      b: "ea-colwick-level",
      range: "30d",
    });
  });

  it("loads four measurements over one window, with a labelled legend and two axes", async () => {
    const fixture = createFixtureTransport(() => NOW);
    const transport = vi.fn<RdpTransport>(async (request) => {
      const body = (await fixture(request)) as Body;
      return {
        ...body,
        data: body.data.map((row) =>
          row.datum === "ASD" ? { ...row, datum: "AOD", unit: "mAOD" } : row,
        ),
      };
    });
    useClient(transport);
    const params = {
      a: "ea-colwick-level",
      b: "ea-stone-rainfall",
      c: "ea-clifton-bridge-level",
      d: "ea-church-wilne-level",
    };
    await renderCompare(params);

    const legend = screen.getByRole("list", { name: "Chart legend" });
    expect(within(legend).getAllByRole("listitem")).toHaveLength(4);
    expect(within(legend).getAllByText(/Left axis · mAOD/)).toHaveLength(3);
    expect(within(legend).getByText(/Right axis.*mm · Rolling 24-hour total/)).toBeVisible();
    const styles = [...legend.querySelectorAll("line")].map((line) =>
      line.getAttribute("stroke-dasharray"),
    );
    expect(new Set(styles).size).toBe(4);
    const chart = screen.getByRole("group", { name: /^Shared timeline/ });
    expect(chart.querySelectorAll(".recharts-yAxis")).toHaveLength(2);
    expect(chart.querySelectorAll(".recharts-xAxis")).toHaveLength(1);
    expect(screen.queryByRole("combobox", { name: "Add a measurement" })).toBeNull();
    expect(screen.getByRole("link", { name: /^Remove Stone/ })).toHaveAttribute(
      "href",
      "/compare?a=ea-colwick-level&b=ea-clifton-bridge-level&c=ea-church-wilne-level&range=7d",
    );
    expect(screen.getByRole("link", { name: "30 days" })).toHaveAttribute(
      "href",
      "/compare?a=ea-colwick-level&b=ea-stone-rainfall&c=ea-clifton-bridge-level&d=ea-church-wilne-level&range=30d",
    );
    await userEvent.click(screen.getByText(/^Compared readings table/));
    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("columnheader")).toHaveLength(5);
    expect(rows(table)[0].querySelectorAll("td")).toHaveLength(4);

    const reads = transport.mock.calls
      .map(([request]) => request)
      .filter(({ path }) => path.endsWith("/observations"));
    expect(reads.map(({ path }) => path).sort()).toEqual(
      Object.values(params)
        .map((id) => `/v1/measurements/${id}/observations`)
        .sort(),
    );
    for (const { path, query } of reads) {
      const rain = path.includes("rainfall");
      expect(query).toMatchObject({
        from: rain ? "2026-11-04T12:00:00.000Z" : "2026-11-11T12:00:00.000Z",
        to: rain ? "2026-11-19T12:07:00.001Z" : "2026-11-19T12:07:00.000Z",
        limit: "2000",
      });
    }
  });

  it("explains a third axis in the selector and rejects incompatible deep links before loading history", async () => {
    const transport = vi.fn(createFixtureTransport(() => NOW));
    useClient(transport);
    const pair = { a: "ea-colwick-level", b: "ea-shardlow-level" };
    await renderCompare(pair);
    const picker = screen.getByRole("combobox", { name: "Add a measurement" });
    expect(
      within(picker).getByRole("option", { name: /Church Wilne.*Needs a third axis/ }),
    ).toBeDisabled();
    expect(picker).toHaveAccessibleDescription(/two axes.*level datum/);

    cleanup();
    transport.mockClear();
    await renderCompare({ ...pair, c: "ea-church-wilne-level" });
    expect(screen.getByRole("alert")).toHaveTextContent(/more than two separate axes/);
    expect(screen.getByRole("link", { name: /^Remove Church Wilne/ })).toHaveAttribute(
      "href",
      "/compare?a=ea-colwick-level&b=ea-shardlow-level&range=7d",
    );
    expect(screen.queryByRole("region", { name: "History" })).toBeNull();
    expect(transport).not.toHaveBeenCalled();
  });

  it("draws level and flow on one timeline and preserves the range links", async () => {
    await renderCompare({ a: "ea-shardlow-level", b: "ea-shardlow-flow", range: "7d" });
    const history = screen.getByRole("region", { name: "History" });
    const chart = within(history).getByRole("group", { name: /^Shared timeline/ });
    expect(chart).toHaveAccessibleName(
      /Shardlow water level, Left axis · mASD · Local gauge datum.*Shardlow flow, Right axis · m3\/s/,
    );
    expect(chart.querySelectorAll(".recharts-yAxis")).toHaveLength(2);
    expect(within(history).getByRole("link", { name: "30 days" })).toHaveAttribute(
      "href",
      "/compare?a=ea-shardlow-level&b=ea-shardlow-flow&range=30d",
    );
    expect(document.getElementById("compare-status")).toHaveTextContent(
      "Showing 7 days for 2 measurements",
    );
    expect(screen.getByText(/Environment Agency data/)).toBeVisible();
  });

  it("applies and resets a manual shift and identifies both times in the shared tooltip", async () => {
    const time = "2026-11-18T12:00:00.0000000Z";
    useClient(
      withHistory((body) => ({
        ...body,
        data: body.data.filter((row) => row.observedAt === time),
      })),
    );
    await renderCompare({ a: "ea-shardlow-level", b: "ea-shardlow-flow" });
    const user = userEvent.setup();
    await user.click(screen.getByText("Time shifts"));
    const controls = screen.getByRole("group", { name: "Shardlow water level" });
    const offset = within(controls).getByRole("spinbutton", { name: "Offset (minutes)" });
    await user.clear(offset);
    await user.type(offset, "-60");
    await user.click(within(controls).getByRole("button", { name: "Apply" }));
    const chart = screen.getByRole("group", { name: /^Shared timeline/ });
    expect(chart).toHaveAccessibleName(/Shardlow water level \(−1 h\)/);
    const inspector = within(chart).getByRole("application", { name: "Inspect compared readings" });
    await act(async () => inspector.focus());
    const tooltip = await within(chart).findByRole("status");
    expect(tooltip).toHaveTextContent("Displayed time 18 Nov, 11:00:00");
    expect(tooltip).toHaveTextContent("Original observation time 18 Nov, 12:00");
    expect(tooltip).toHaveTextContent("Displayed observation time 18 Nov, 11:00");
    expect(tooltip).not.toHaveTextContent("Shardlow flow");
    fireEvent.keyDown(inspector, { key: "ArrowRight" });
    expect(await within(tooltip).findByText("Shardlow flow")).toBeVisible();

    await user.click(within(controls).getByRole("button", { name: "Reset" }));
    expect(offset).toHaveValue(0);
    const resetTimeline = screen.getByRole("group", { name: /^Shared timeline/ });
    expect(resetTimeline).not.toHaveAccessibleName(/−1 h/);
    const resetChart = within(resetTimeline);
    await act(async () => resetChart.getByRole("application").focus());
    expect(await resetChart.findByRole("status")).toHaveTextContent("Shardlow water level");
    expect(resetChart.getByRole("status")).toHaveTextContent("Shardlow flow");
  });

  it("labels independent local datum scales for levels from different stations", async () => {
    await renderCompare({ a: "ea-colwick-level", b: "ea-shardlow-level" });
    const chart = screen.getByRole("group", { name: /^Shared timeline/ });
    expect(chart).toHaveAccessibleName(
      /Colwick water level, Left axis · mASD · Local gauge datum.*Shardlow water level, Right axis · mASD · Local gauge datum/,
    );
    const axes = Array.from(chart.querySelectorAll(".recharts-yAxis"));
    expect(axes).toHaveLength(2);
    const ticks = (color: string) =>
      Array.from(chart.querySelectorAll(`text[fill="${color}"]`), (tick) => tick.textContent);
    expect(ticks("var(--color-accent)").length).toBeGreaterThan(0);
    expect(ticks("var(--color-compare-secondary)").length).toBeGreaterThan(0);
    expect(ticks("var(--color-accent)")).not.toEqual(ticks("var(--color-compare-secondary)"));
  });

  it("plots level and rainfall together with verified bars and honest missing and unverified intervals", async () => {
    const first = "2026-11-18T12:00:00.0000000Z";
    const zero = "2026-11-18T12:15:00.0000000Z";
    const missing = "2026-11-18T12:30:00.0000000Z";
    const unverified = "2026-11-18T12:45:00.0000000Z";
    const ineligible = "2026-11-18T13:00:00.0000000Z";
    useClient(
      withHistory((body, path) => {
        if (path.includes("rainfall")) {
          return {
            data: body.data
              .filter((row) => [first, zero, unverified, ineligible].includes(row.label as string))
              .map((row) => {
                if (row.label === first)
                  return { ...row, totalMm: 1.25, sourceValue: "1.25", revision: 2 };
                if (row.label === zero) return { ...row, totalMm: 0, sourceValue: "0" };
                if (row.label === unverified)
                  return {
                    ...row,
                    labelConvention: "unverified",
                    periodStart: null,
                    periodEnd: null,
                    totalMm: 0.2,
                    sourceValue: "0.2",
                  };
                return {
                  ...row,
                  totalMm: 0.4,
                  eligible: false,
                  quality: "Suspect",
                  ineligibleReason: "QualitySuspect",
                };
              }),
            meta: {
              ...body.meta,
              window: {
                ...(body.meta.window as Record<string, unknown>),
                reported: 4,
                eligible: 3,
                absent: 668,
                ineligible: 1,
                status: "incomplete",
                totalMm: null,
                labelConvention: "mixed",
                periodStart: null,
                periodEnd: null,
                gaps: [],
                gapsTruncated: true,
              },
            },
          };
        }
        return {
          ...body,
          data: body.data.filter((row) =>
            [first, zero, missing, ineligible].includes(row.observedAt as string),
          ),
        };
      }),
    );
    await renderCompare({ a: "ea-colwick-level", b: "ea-stone-rainfall" });
    expect(screen.getByRole("link", { name: "Back to explorer" })).toHaveAttribute(
      "href",
      "/?a=ea-colwick-level&b=ea-stone-rainfall",
    );
    const view = screen.getByRole("combobox", { name: "Rainfall view" });
    expect(view).toHaveDisplayValue("Rolling 24-hour total");
    const chart = screen.getByRole("group", { name: /^Shared timeline/ });
    expect(chart).toHaveAccessibleName(/Left axis · mASD.*Right axis · mm · Rolling 24-hour total/);
    expect(chart).toHaveTextContent(/Partial · Indicative · 3\/96 expected labels/);
    await userEvent.selectOptions(view, "native");
    expect(chart).toHaveAccessibleName(/Left axis · mASD.*Right axis · mm per 15 minutes/);
    const bar = within(chart).getByText(/18 Nov, 11:45 to 18 Nov, 12:00 · 1.25 mm/).parentElement!;
    expect(bar.tagName).toBe("rect");
    expect(Number(bar.getAttribute("width"))).toBeGreaterThan(0);
    expect(
      within(chart).getByText(/12:45 \(provider label, timing unverified\)/).parentElement?.tagName,
    ).toBe("line");
    expect(within(chart).getByText(/ · Ineligible/).parentElement?.tagName).toBe("path");
    expect(within(chart).queryByText(/18 Nov, 12:15 to 18 Nov, 12:30/)).toBeNull();
    const levelPath = chart.querySelector('path.recharts-line-curve[stroke="var(--color-accent)"]');
    expect(levelPath?.getAttribute("d")?.match(/M/g)).toHaveLength(2);

    const inspector = within(chart).getByRole("application", { name: "Inspect compared readings" });
    expect(inspector).toHaveAccessibleDescription(/left and right arrow keys/);
    await act(async () => inspector.focus());
    expect(inspector).toHaveFocus();
    expect(await within(chart).findByText("1.25 mm")).toBeVisible();
    expect(within(chart).getByText(/Provider label/)).toHaveTextContent("18 Nov, 12:00");
    expect(within(chart).getByText(/18 Nov, 11:52:30/)).toBeVisible();
    expect(within(chart).getByRole("status")).not.toHaveTextContent("Colwick water level");
    fireEvent.keyDown(inspector, { key: "ArrowRight" });
    expect(await within(chart).findByText(/18 Nov, 12:00:00/)).toBeVisible();
    const inspected = within(chart).getByRole("status");
    expect(inspected).toHaveTextContent("Colwick water level");
    expect(inspected).toHaveTextContent("Stone rainfall");
    expect(inspected).toHaveTextContent(/-?\d[\d.]* mASD/);
    await act(async () => inspector.blur());

    const surface = chart.querySelector<HTMLDivElement>(".recharts-wrapper")!;
    Object.defineProperties(surface, {
      offsetWidth: { value: 360 },
      offsetHeight: { value: 256 },
    });
    vi.spyOn(surface, "getBoundingClientRect").mockReturnValue(
      DOMRect.fromRect({ width: 360, height: 256 }),
    );
    const clientX = Number(bar.getAttribute("x")) + Number(bar.getAttribute("width")) / 2;
    fireEvent.mouseMove(surface, { clientX, clientY: 120 });
    expect(await within(chart).findByText("1.25 mm")).toBeVisible();
    const mark = within(chart).getByText(/ · Ineligible/).parentElement!;
    const lastX = Number(mark.getAttribute("d")!.split(" ")[1]) + 5;
    fireEvent.touchMove(surface, { touches: [{ clientX: lastX, clientY: 120 }] });
    expect(await within(chart).findByText("Suspect quality")).toBeVisible();

    await userEvent.click(screen.getByText(/^Compared readings table/));
    const table = screen.getByRole("table");
    const rowAt = (time: string) =>
      rows(table).find((row) => row.querySelector("th time")?.getAttribute("datetime") === time)!;
    expect(rowAt(missing)).toHaveTextContent("No reading");
    expect(within(rowAt(zero)).getByText("0")).toBeVisible();
    expect(rowAt(first)).toHaveTextContent("Revision 2 (corrected)");
    expect(rowAt(first)).toHaveTextContent("End label");
    expect(rowAt(unverified)).toHaveTextContent("Timing unverified");
    expect(rowAt(ineligible)).toHaveTextContent("Suspect quality");
  });

  it("lists both series at their exact times in an accessible table", async () => {
    await renderCompare({ a: "ea-colwick-level", b: "ea-shardlow-level" });
    const history = screen.getByRole("region", { name: "History" });
    await within(history).findByRole("group", { name: /^Shared timeline/ });
    await userEvent.click(within(history).getByText(/^Compared readings table/));
    const table = within(history).getByRole("table");
    expect(
      within(table).getByRole("columnheader", { name: "Colwick water level (mASD)" }),
    ).toBeVisible();
    expect(
      within(table).getByRole("columnheader", { name: "Shardlow water level (mASD)" }),
    ).toBeVisible();
    // Colwick's fixture gap falls in this week while Shardlow keeps reading: those times say "No reading".
    expect(rows(history).length).toBeGreaterThan(0);
    await userEvent.click(within(history).getByRole("button", { name: "Older" }));
    const pages = within(history).getByText(/^Times 101–200 of /);
    expect(pages).toHaveAttribute("role", "status");
    expect(rows(history).every((row) => row.querySelector("th time"))).toBe(true);
    const all = [];
    for (;;) {
      all.push(...rows(history).map((row) => row.textContent ?? ""));
      const older = within(history).getByRole("button", { name: "Older" });
      if (older.getAttribute("aria-disabled") === "true") break;
      await userEvent.click(older);
    }
    expect(all.some((text) => text.includes("No reading"))).toBe(true);
  });

  it("keeps one series when the other's history is unavailable", async () => {
    useClient(
      withHistory((body, path) => {
        if (path.includes("ea-shardlow-flow")) throw new RdpError("STORAGE_UNAVAILABLE", 503);
        return body;
      }),
    );
    await renderCompare({ a: "ea-shardlow-level", b: "ea-shardlow-flow" });
    const history = screen.getByRole("region", { name: "History" });
    expect(await within(history).findByRole("alert")).toHaveTextContent(
      "Shardlow flow: history unavailable right now",
    );
    const chart = within(history).getByRole("group", { name: /^Shared timeline/ });
    expect(chart).toHaveAccessibleName(/Shardlow water level/);
    expect(chart.querySelectorAll(".recharts-yAxis")).toHaveLength(1);
  });

  it("says a series has no readings rather than drawing zero", async () => {
    useClient(
      withHistory((body, path) =>
        path.includes("ea-shardlow-flow") ? { ...body, data: [] } : body,
      ),
    );
    await renderCompare({ a: "ea-shardlow-level", b: "ea-shardlow-flow" });
    expect(await screen.findByText("Shardlow flow: no readings in the last 7 days")).toBeVisible();
    expect(screen.getByRole("group", { name: /^Shared timeline/ })).toHaveAccessibleName(
      /Shardlow water level/,
    );
  });

  it("asks for different measurements when a URL repeats an ID", async () => {
    await renderCompare({ a: "ea-shardlow-level", b: "ea-shardlow-level" });
    expect(screen.getByRole("alert")).toHaveTextContent("Choose different measurements.");
    expect(screen.getByRole("combobox", { name: "Add a measurement" })).toHaveAccessibleDescription(
      "Choose different measurements.",
    );
    expect(screen.queryByRole("region", { name: "History" })).toBeNull();
  });

  it("rejects unknown, malformed and repeated IDs", async () => {
    for (const b of ["ea-unknown-level", "../secret", ["ea-shardlow-flow", "ea-colwick-level"]]) {
      await renderCompare({ a: "ea-shardlow-level", b });
      expect(screen.getByRole("alert")).toHaveTextContent(
        "One of those measurements isn’t available to compare.",
      );
      expect(screen.queryByRole("region", { name: "History" })).toBeNull();
      cleanup();
    }
  });

  it("shows unavailable when the catalogue can't be read", async () => {
    useClient(async () => {
      throw new RdpError("STORAGE_UNAVAILABLE", 503);
    });
    await renderCompare({ a: "ea-shardlow-level", b: "ea-shardlow-flow" });
    expect(screen.getByRole("alert")).toHaveTextContent("Measurements are unavailable right now");
    expect(document.body).not.toHaveTextContent(/STORAGE_UNAVAILABLE|503/);
  });

  it("never labels live data as sample data", async () => {
    useClient(
      createFixtureTransport(() => NOW),
      "live",
    );
    await renderCompare({});
    expect(screen.queryByRole("note")).toBeNull();
  });
});
