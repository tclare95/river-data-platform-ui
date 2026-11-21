import { act, fireEvent, render, screen, within } from "@testing-library/react";
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

async function renderCompare(params: Record<string, string>) {
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
    const first = screen.getByRole("combobox", { name: "First measurement" });
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

  it("draws level and flow on one timeline and preserves the range links", async () => {
    await renderCompare({ a: "ea-shardlow-level", b: "ea-shardlow-flow", range: "7d" });
    const history = screen.getByRole("region", { name: "History" });
    const chart = within(history).getByRole("img");
    expect(chart).toHaveAccessibleName(
      /Shardlow water level, Left axis · mASD · Local gauge datum.*Shardlow flow, Right axis · m3\/s/,
    );
    expect(chart.querySelectorAll(".recharts-yAxis")).toHaveLength(2);
    expect(within(history).getByRole("link", { name: "30 days" })).toHaveAttribute(
      "href",
      "/compare?a=ea-shardlow-level&b=ea-shardlow-flow&range=30d",
    );
    expect(document.getElementById("compare-status")).toHaveTextContent(
      "Showing 7 days for both measurements",
    );
    expect(screen.getByText(/Environment Agency data/)).toBeVisible();
  });

  it("labels independent local datum scales for levels from different stations", async () => {
    await renderCompare({ a: "ea-colwick-level", b: "ea-shardlow-level" });
    const chart = screen.getByRole("img", { name: /^Shared timeline/ });
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
            [first, zero, missing, unverified, ineligible].includes(row.observedAt as string),
          ),
        };
      }),
    );
    await renderCompare({ a: "ea-colwick-level", b: "ea-stone-rainfall" });
    const chart = screen.getByRole("img", { name: /^Shared timeline/ });
    expect(chart).toHaveAccessibleName(/Left axis · mASD.*Right axis · mm per 15 minutes/);
    const bar = within(chart).getByText(/18 Nov, 11:45 to 18 Nov, 12:00 · 1.25 mm/).parentElement!;
    expect(bar.tagName).toBe("rect");
    expect(Number(bar.getAttribute("width"))).toBeGreaterThan(0);
    expect(
      within(chart).getByText(/12:45 \(provider label, timing unverified\)/).parentElement?.tagName,
    ).toBe("line");
    expect(within(chart).getByText(/ · Ineligible/).parentElement?.tagName).toBe("path");
    expect(within(chart).queryByText(/18 Nov, 12:15 to 18 Nov, 12:30/)).toBeNull();
    expect(
      chart.querySelector('path.recharts-line-curve[stroke="var(--color-accent)"]'),
    ).toBeInTheDocument();

    const surface = chart.querySelector<HTMLDivElement>(".recharts-wrapper")!;
    Object.defineProperties(surface, {
      offsetWidth: { value: 360 },
      offsetHeight: { value: 256 },
    });
    vi.spyOn(surface, "getBoundingClientRect").mockReturnValue(
      DOMRect.fromRect({ width: 360, height: 256 }),
    );
    const clientX = Number(bar.getAttribute("x")) + Number(bar.getAttribute("width"));
    fireEvent.mouseMove(surface, { clientX: clientX - 2, clientY: 120 });
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
    await within(history).findAllByRole("img");
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
    const chart = within(history).getByRole("img");
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
    expect(screen.getByRole("img", { name: /^Shared timeline/ })).toHaveAccessibleName(
      /Shardlow water level/,
    );
  });

  it("asks for two different measurements", async () => {
    await renderCompare({ a: "ea-shardlow-level", b: "ea-shardlow-level" });
    expect(screen.getByRole("alert")).toHaveTextContent("Choose two different measurements.");
    const second = screen.getByRole("combobox", { name: "Second measurement" });
    expect(second).toHaveAttribute("aria-invalid", "true");
    expect(second).toHaveAccessibleDescription("Choose two different measurements.");
    expect(screen.getByRole("combobox", { name: "First measurement" })).not.toHaveAttribute(
      "aria-invalid",
    );
    expect(screen.queryByRole("region", { name: "History" })).toBeNull();
  });

  it("rejects unknown, malformed and repeated IDs", async () => {
    for (const b of ["ea-unknown-level", "../secret", ["ea-shardlow-flow", "ea-colwick-level"]]) {
      await renderCompare({ a: "ea-shardlow-level", b } as Record<string, string>);
      expect(screen.getByRole("alert")).toHaveTextContent(
        "One of those measurements isn’t available to compare.",
      );
      expect(screen.queryByRole("region", { name: "History" })).toBeNull();
      document.body.innerHTML = "";
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
