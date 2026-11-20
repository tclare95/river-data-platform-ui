import { render, screen, within } from "@testing-library/react";
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
const { default: MeasurementPage, generateMetadata } = await import("@/app/measurements/[id]/page");
const { default: MeasurementLayout } = await import("@/app/measurements/[id]/layout");

const NOW = Date.parse("2026-11-19T12:07:00Z");
const READING = /\d\s*(mASD|mm|m3\/s)\b/;

function useClient(mode: "fixture" | "live" = "fixture", transport?: RdpTransport) {
  const client = createRdpClient({
    mode,
    transport: transport ?? createFixtureTransport(() => NOW),
    log: () => undefined,
  });
  getClient = () => client;
}

function props(id: string) {
  return {
    params: Promise.resolve({ id }),
    searchParams: Promise.resolve({}),
  } as PageProps<"/measurements/[id]">;
}

async function renderDetail(id: string) {
  render(await MeasurementPage(props(id)));
}

function fact(term: string) {
  return screen.getByText(term, { selector: "dt" }).nextElementSibling;
}

describe("measurement detail page", () => {
  beforeEach(() => useClient());

  it("shows a fresh reading with observed and checked times, unit, datum and source", async () => {
    await renderDetail("ea-colwick-level");
    expect(screen.getByRole("heading", { level: 1, name: "Colwick" })).toBeInTheDocument();
    expect(screen.getByText("Water level · mASD · Datum ASD")).toBeInTheDocument();
    const latest = screen.getByRole("region", { name: "Latest reading" });
    expect(latest).toHaveTextContent(/\d+(\.\d+)? mASD/);
    expect(latest).toHaveTextContent(/Observed at/);
    expect(latest).toHaveTextContent(/Checked/);
    expect(latest).toHaveTextContent(/Quality\s*Good/);
    expect(latest).not.toHaveTextContent('"Good"');
    expect(latest).not.toHaveTextContent("Not recent");
    expect(latest.querySelector("time")).toHaveAttribute("datetime");
    expect(fact("Unit")).toHaveTextContent("mASD");
    expect(fact("Datum")).toHaveTextContent("ASD");
    expect(fact("Reporting")).toHaveTextContent("Every 15 minutes");
    expect(fact("Measurement ID")).toHaveTextContent("ea-colwick-level");
    expect(screen.getByRole("link", { name: "All measurements" })).toHaveAttribute("href", "/");
    expect(screen.getByText(/Open Government Licence v3.0/)).toBeInTheDocument();
  });

  it("labels fixture data as sample data", async () => {
    await renderDetail("ea-colwick-level");
    expect(screen.getByRole("note")).toHaveTextContent("not real observations");
  });

  it("does not show the sample label for live data", async () => {
    useClient("live");
    await renderDetail("ea-colwick-level");
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("calls a stale value the last known reading", async () => {
    await renderDetail("ea-shardlow-flow");
    const latest = screen.getByRole("region", { name: "Last known reading" });
    expect(latest).toHaveTextContent(/m3\/s/);
    expect(latest).toHaveTextContent("Not recent");
    expect(fact("Datum")).toHaveTextContent("Not known");
  });

  it("links to the other measurements at the same station", async () => {
    await renderDetail("ea-shardlow-flow");
    const related = screen.getByRole("region", { name: "Also at Shardlow" });
    expect(within(related).getByRole("link", { name: "Water level" })).toHaveAttribute(
      "href",
      "/measurements/ea-shardlow-level",
    );
  });

  it("says no observations rather than showing zero", async () => {
    await renderDetail("ea-kegworth-level");
    const latest = screen.getByRole("region", { name: "Latest reading" });
    expect(latest).toHaveTextContent("No observations collected");
    expect(latest.textContent).not.toMatch(READING);
    expect(screen.queryByRole("region", { name: /Also at/ })).toBeNull();
  });

  it("describes a rainfall period total by its period", async () => {
    await renderDetail("ea-stone-rainfall");
    const latest = screen.getByRole("region", { name: /reading$/ });
    expect(latest).toHaveTextContent(/Total in the 15 minutes to/);
    expect(latest).not.toHaveTextContent(/Observed at/);
    expect(fact("Reporting")).toHaveTextContent("Totals per 15 minutes");
    expect(fact("Datum")).toHaveTextContent("Not applicable");
  });

  it("shows the reading as unavailable, not a value, when the latest read fails", async () => {
    const fixture = createFixtureTransport(() => NOW);
    useClient("live", async (request) => {
      if (request.path.endsWith("/latest")) throw new RdpError("STORAGE_UNAVAILABLE", 503);
      return fixture(request);
    });
    await renderDetail("ea-colwick-level");
    const latest = screen.getByRole("region", { name: "Latest reading" });
    expect(within(latest).getByRole("alert")).toHaveTextContent(
      "Latest reading unavailable right now",
    );
    expect(latest.textContent).not.toMatch(READING);
    expect(fact("Unit")).toHaveTextContent("mASD");
  });

  it("shows an error page, not values, when the catalogue is unavailable", async () => {
    getClient = () => {
      throw new RdpError("CONFIGURATION_ERROR");
    };
    await renderDetail("ea-colwick-level");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Measurement unavailable");
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("is not found for unknown, malformed and non-displayable IDs", async () => {
    await expect(renderDetail("ea-nowhere-level")).rejects.toThrow("NEXT_NOT_FOUND");

    const calls: string[] = [];
    const fixture = createFixtureTransport(() => NOW);
    useClient("live", async (request) => {
      calls.push(request.path);
      const body = (await fixture(request)) as { data: Array<Record<string, unknown>> };
      if (request.path === "/v1/measurements")
        body.data.forEach((row) => {
          if (row.measurementId === "ea-colwick-level") row.provider = "unlicensed";
        });
      return body;
    });
    await expect(renderDetail("../health")).rejects.toThrow("NEXT_NOT_FOUND");
    expect(calls).toEqual([]);
    await expect(renderDetail("ea-colwick-level")).rejects.toThrow("NEXT_NOT_FOUND");
    expect(calls).not.toContain("/v1/measurements/latest");
  });

  it("titles the page by station and type", async () => {
    expect(await generateMetadata(props("ea-shardlow-flow"))).toEqual({
      title: "Shardlow flow",
    });
    expect(await generateMetadata(props("ea-nowhere"))).toEqual({
      title: "Measurement",
    });
  });

  it("resolves the ID in the layout, before streaming, so unknown IDs get a real 404", async () => {
    const layout = (id: string) =>
      MeasurementLayout({
        children: "page",
        params: Promise.resolve({ id }),
      } as LayoutProps<"/measurements/[id]">);
    await expect(layout("ea-nowhere-level")).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(layout("ea-colwick-level")).resolves.toBe("page");
    // An outage is not a 404: the page renders its own unavailable state.
    const failing = vi.fn(() => {
      throw new RdpError("CONFIGURATION_ERROR");
    });
    getClient = failing;
    await expect(layout("ea-colwick-level")).resolves.toBe("page");
    expect(failing).toHaveBeenCalled();
  });

  it("does not repeat the total for a rainfall label of unverified convention", async () => {
    const fixture = createFixtureTransport(() => NOW);
    useClient("fixture", async (request) => {
      const body = (await fixture(request)) as { data: Array<Record<string, unknown>> };
      if (request.path.endsWith("/latest"))
        body.data.forEach((row) => {
          if ("labelConvention" in row)
            Object.assign(row, {
              labelConvention: "unverified",
              periodStart: null,
              periodEnd: null,
            });
        });
      return body;
    });
    await renderDetail("ea-stone-rainfall");
    const latest = screen.getByRole("region", { name: /reading$/ });
    expect(latest).toHaveTextContent(/Total in the 15 minutes labelled/);
    expect(latest).not.toHaveTextContent(/Total 15 minutes/);
  });
});
