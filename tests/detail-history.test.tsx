import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRdpClient, type RdpClient } from "@/lib/rdp/client";
import { RdpError } from "@/lib/rdp/errors";
import { createFixtureTransport } from "@/lib/rdp/fixture";
import type { RdpTransport } from "@/lib/rdp/transport";

let getClient: () => RdpClient;
vi.mock("next/server", () => ({ connection: async () => undefined }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("@/lib/rdp/server", () => ({ getRdpClient: () => getClient() }));
const { default: MeasurementPage } = await import("@/app/measurements/[id]/page");

const NOW = Date.parse("2026-11-19T12:07:00Z");
type Body = { data: Array<Record<string, unknown>>; meta: Record<string, unknown> };

function useClient(transport: RdpTransport) {
  const client = createRdpClient({ mode: "fixture", transport, log: () => undefined });
  getClient = () => client;
}

/** The fixture with its history responses rewritten. */
function withHistory(edit: (body: Body, query: Record<string, string>) => Body | Promise<Body>) {
  const fixture = createFixtureTransport(() => NOW);
  return async (request: Parameters<RdpTransport>[0]) => {
    const body = await fixture(request);
    return request.path.endsWith("/observations")
      ? edit(body as Body, request.query as Record<string, string>)
      : body;
  };
}

async function renderDetail(id: string, range?: string) {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  const page = await MeasurementPage({
    params: Promise.resolve({ id }),
    searchParams: Promise.resolve(range ? { range } : {}),
  } as PageProps<"/measurements/[id]">);
  // The history section suspends on its read; an awaited act lets it resolve.
  await act(async () => {
    render(page);
  });
  vi.useRealTimers();
  return screen.getByRole("region", { name: "History" });
}

describe("measurement history on the detail page", () => {
  beforeEach(() => useClient(createFixtureTransport(() => NOW)));

  it("charts every reading across pages for 30 days, with a table and honest coverage", async () => {
    const history = await renderDetail("ea-colwick-level", "30d");
    expect(await within(history).findByRole("img", { name: /^Water level/ })).toBeInTheDocument();
    const nav = within(history).getByRole("navigation", { name: "History range" });
    expect(within(nav).getByRole("link", { name: "30 days" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(nav).getByRole("link", { name: "7 days" })).not.toHaveAttribute("aria-current");
    // 30 days of 15-minute readings minus the fixture's weekly three-hour gaps: more than one 2,000-row page.
    const summary = within(history).getByText(/^Readings table \(/);
    const count = Number(summary.textContent!.replace(/\D/g, ""));
    expect(count).toBeGreaterThan(2000);
    expect(count).toBeLessThan(30 * 96);
    expect(history).toHaveTextContent(/Readings are missing in \d+ places/);
    expect(history).toHaveTextContent("This record hasn’t been verified as complete.");
    expect(history).not.toHaveTextContent(/verified complete for this period/);
    expect(history).toHaveTextContent(/Retrieved/);
    expect(document.getElementById("history-status")).toHaveTextContent(
      "Showing 30 days of history",
    );
  });

  it("links to a comparison with another measurement at the station", async () => {
    await renderDetail("ea-shardlow-level", "30d");
    expect(screen.getByRole("link", { name: "Compare with another measurement" })).toHaveAttribute(
      "href",
      "/compare?a=ea-shardlow-level&b=ea-shardlow-flow&range=30d",
    );
  });

  it("defaults to 7 days for a missing or unsupported range", async () => {
    const history = await renderDetail("ea-shardlow-level", "365d");
    await within(history).findByRole("img");
    expect(within(history).getByRole("link", { name: "7 days" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("shows nothing rather than a partial history when a later page fails", async () => {
    useClient(
      withHistory((body, query) => {
        if (query.cursor) throw new RdpError("ARCHIVE_INTEGRITY", 503);
        return body;
      }),
    );
    const history = await renderDetail("ea-shardlow-level", "30d");
    const alert = await within(history).findByRole("alert");
    expect(alert).toHaveTextContent("History unavailable right now");
    expect(within(history).queryByRole("img")).toBeNull();
    expect(within(history).queryByRole("table")).toBeNull();
    expect(within(history).getByRole("link", { name: "Try again" })).toHaveAttribute(
      "href",
      "/measurements/ea-shardlow-level?range=30d",
    );
  });

  it("refuses to truncate a window that needs too many pages", async () => {
    useClient(
      withHistory((body, query) => {
        // Every page holds one new row and always continues.
        const offset = query.cursor
          ? (JSON.parse(Buffer.from(query.cursor, "base64url").toString()) as { fixture: number })
              .fixture
          : 0;
        const next = Buffer.from(JSON.stringify({ fixture: offset + 1 })).toString("base64url");
        return { ...body, meta: { ...body.meta, nextCursor: next }, data: body.data.slice(0, 1) };
      }),
    );
    const history = await renderDetail("ea-shardlow-level");
    expect(await within(history).findByText("Too many readings to show for 7 days")).toBeVisible();
    expect(within(history).queryByRole("img")).toBeNull();
  });

  it("says when a window has no readings, keeping coverage unknown", async () => {
    useClient(withHistory((body) => ({ ...body, data: [] })));
    const history = await renderDetail("ea-shardlow-level");
    await within(history).findAllByText("No readings in the last 7 days");
    // The persistent live region announces the loaded state; the empty state shows it.
    expect(document.getElementById("history-status")).toHaveTextContent(
      "No readings in the last 7 days",
    );
    expect(
      within(history).getByText("No readings in the last 7 days", { selector: "p.font-medium" }),
    ).toBeVisible();
    expect(history).toHaveTextContent("This record hasn’t been verified as complete.");
  });

  it("lists known gaps by reason for partial coverage", async () => {
    useClient(
      withHistory((body) => ({
        ...body,
        meta: {
          ...body.meta,
          coverage: {
            status: "partial",
            gaps: [
              {
                from: "2026-11-15T00:00:00Z",
                to: "2026-11-15T06:00:00Z",
                reason: "source_outage",
              },
            ],
          },
        },
      })),
    );
    const history = await renderDetail("ea-shardlow-level");
    await within(history).findByRole("img");
    expect(history).toHaveTextContent("Part of this period has no data.");
    expect(within(history).getByText(/^Source outage:/)).toBeVisible();
  });

  it("only says complete when RDP verifies coverage", async () => {
    useClient(
      withHistory((body) => ({
        ...body,
        meta: { ...body.meta, coverage: { status: "complete", gaps: [] } },
      })),
    );
    const history = await renderDetail("ea-shardlow-level");
    expect(
      await within(history).findByText("Coverage verified complete for this period."),
    ).toBeVisible();
  });

  it("shows original readings in the table: negative values, corrections and storage time", async () => {
    useClient(
      withHistory((body) => ({
        ...body,
        data: body.data.map((row, index, rows) =>
          index === rows.length - 1 ? { ...row, value: -0.125, revision: 3 } : row,
        ),
      })),
    );
    const history = await renderDetail("ea-shardlow-level");
    await within(history).findByRole("img");
    await userEvent.click(within(history).getByText(/^Readings table/));
    const table = within(history).getByRole("table");
    const newest = within(table).getAllByRole("row")[1];
    expect(within(newest).getByRole("rowheader").querySelector("time")).toHaveAttribute("datetime");
    expect(newest).toHaveTextContent("-0.125");
    expect(newest).toHaveTextContent("3 (corrected)");
    expect(within(table).getByRole("columnheader", { name: "Water level (mASD)" })).toBeVisible();
    expect(within(table).getByRole("columnheader", { name: "Stored by RDP" })).toBeVisible();
    expect(within(history).getByText(/^Readings 1–100 of /)).toHaveAttribute("role", "status");
    await userEvent.click(within(history).getByRole("button", { name: "Older" }));
    expect(within(history).getByText(/^Readings 101–200 of /)).toBeVisible();
  });

  it("marks missing readings in the table instead of reading as continuous", async () => {
    const history = await renderDetail("ea-colwick-level", "30d");
    await within(history).findByRole("img");
    // Page through until a gap row appears (the fixture misses three hours every week).
    await userEvent.click(within(history).getByText(/^Readings table/));
    const older = within(history).getByRole("button", { name: "Older" });
    while (
      !within(history).queryByText(/^No readings for 3 h 15 min between/) &&
      older.getAttribute("aria-disabled") !== "true"
    ) {
      await userEvent.click(older);
    }
    expect(within(history).getByText(/^No readings for 3 h 15 min between/)).toBeVisible();
  });

  it("shows fixture rainfall for seven days with a keyboard-accessible readings table", async () => {
    const history = await renderDetail("ea-stone-rainfall");
    expect(
      await within(history).findByRole("img", { name: /^Rainfall interval totals in mm/ }),
    ).toBeVisible();
    expect(within(history).getByRole("link", { name: "7 days" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    const user = userEvent.setup();
    const summary = within(history).getByText(/^Readings table/);
    await user.click(summary);
    await user.tab();
    expect(within(history).getByRole("region", { name: "Rainfall readings" })).toHaveFocus();
    expect(within(history).getByRole("columnheader", { name: "Rainfall (mm)" })).toBeVisible();
    expect(within(history).getByText(/^No reading for/)).toBeVisible();
    expect(within(history).getAllByRole("rowheader")[0].querySelectorAll("time")).toHaveLength(2);
    await user.tab();
    expect(within(history).getByRole("button", { name: "Newer" })).toHaveFocus();
    await user.tab();
    await user.keyboard("{Enter}");
    expect(within(history).getByText(/^Rows 101–200 of/)).toBeVisible();
    expect(within(history).getByRole("button", { name: "Older" })).toHaveFocus();
  });

  it("shows rainfall across continuation pages without a verified total", async () => {
    const history = await renderDetail("ea-stone-rainfall", "30d");
    expect(await within(history).findByRole("img", { name: /last 30 days/ })).toBeVisible();
    expect(within(history).getByRole("link", { name: "30 days" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    const summary = within(history).getByText(/^Readings table/);
    expect(Number(summary.textContent!.replace(/\D/g, ""))).toBeGreaterThan(2000);
    expect(history).toHaveTextContent(
      /\d+ missing · 0 ineligible. No verified total for this range/,
    );
    expect(history).not.toHaveTextContent(/Total across the selected labels/);
  });
});
