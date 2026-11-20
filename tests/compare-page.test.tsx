import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRdpClient, type RdpClient } from "@/lib/rdp/client";
import { RdpError } from "@/lib/rdp/errors";
import { createFixtureTransport } from "@/lib/rdp/fixture";
import type { RdpTransport } from "@/lib/rdp/transport";

let getClient: () => RdpClient;
vi.mock("next/server", () => ({ connection: async () => undefined }));
vi.mock("@/lib/rdp/server", () => ({ getRdpClient: () => getClient() }));
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
    expect(options.some((text) => text?.includes("Rainfall"))).toBe(false);
    expect(screen.getByText("Rainfall can’t be compared yet.")).toBeVisible();
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

  it("charts level and flow separately over one window with independent scales", async () => {
    await renderCompare({ a: "ea-shardlow-level", b: "ea-shardlow-flow", range: "7d" });
    const history = screen.getByRole("region", { name: "History" });
    const charts = await within(history).findAllByRole("img");
    expect(charts).toHaveLength(2);
    expect(charts[0]).toHaveAccessibleName(/^Shardlow water level, .* to .*\./);
    expect(charts[1]).toHaveAccessibleName(/^Shardlow flow, .* to .*\./);
    // Both summaries describe exactly the same window.
    const window = (name: string) => name.split(".")[0].replace(/^[^,]+, /, "");
    expect(window(charts[0].getAttribute("aria-label")!)).toBe(
      window(charts[1].getAttribute("aria-label")!),
    );
    expect(history).toHaveTextContent(
      "Different kinds of measurement, so each chart has its own scale.",
    );
    expect(within(history).getByRole("region", { name: "Shardlow water level" })).toHaveTextContent(
      "mASD · Local gauge datum (ASD)",
    );
    expect(within(history).getByRole("region", { name: "Shardlow flow" })).toHaveTextContent(
      "m3/s · Environment Agency",
    );
    expect(within(history).getByRole("link", { name: "30 days" })).toHaveAttribute(
      "href",
      "/compare?a=ea-shardlow-level&b=ea-shardlow-flow&range=30d",
    );
    expect(document.getElementById("compare-status")).toHaveTextContent(
      "Showing 7 days for both measurements",
    );
    expect(screen.getByText(/Environment Agency data/)).toBeVisible();
  });

  it("explains station-local datums for two levels", async () => {
    await renderCompare({ a: "ea-colwick-level", b: "ea-shardlow-level" });
    const history = screen.getByRole("region", { name: "History" });
    await within(history).findAllByRole("img");
    expect(history).toHaveTextContent(
      "Each gauge measures level from its own local datum, so the heights aren’t directly comparable.",
    );
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
    const flow = within(history).getByRole("region", { name: "Shardlow flow" });
    expect(await within(flow).findByRole("alert")).toHaveTextContent(
      "History unavailable right now",
    );
    expect(within(flow).queryByRole("img")).toBeNull();
    const level = within(history).getByRole("region", { name: "Shardlow water level" });
    expect(within(level).getByRole("img")).toBeInTheDocument();
  });

  it("says a series has no readings rather than drawing zero", async () => {
    useClient(
      withHistory((body, path) =>
        path.includes("ea-shardlow-flow") ? { ...body, data: [] } : body,
      ),
    );
    await renderCompare({ a: "ea-shardlow-level", b: "ea-shardlow-flow" });
    const flow = screen.getByRole("region", { name: "Shardlow flow" });
    expect(await within(flow).findByText("No readings in the last 7 days")).toBeVisible();
    expect(flow).toHaveTextContent("This record hasn’t been verified as complete.");
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

  it("treats unknown and rainfall IDs alike, without revealing which", async () => {
    for (const b of [
      "ea-unknown-level",
      "ea-stone-rainfall",
      "../secret",
      ["ea-shardlow-flow", "ea-colwick-level"],
    ]) {
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
