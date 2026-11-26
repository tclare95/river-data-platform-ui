import Loading from "@/app/(home)/loading";
import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRdpClient, type RdpClient } from "@/lib/rdp/client";
import { RdpError } from "@/lib/rdp/errors";
import { createFixtureTransport } from "@/lib/rdp/fixture";

let getClient: () => RdpClient;
vi.mock("next/server", () => ({ connection: async () => undefined }));
vi.mock("@/lib/rdp/server", () => ({ getRdpClient: () => getClient() }));
const { default: HomePage } = await import("@/app/(home)/page");

const NOW = Date.parse("2026-11-19T12:07:00Z");

function fixtureClient(
  mode: "fixture" | "live" = "fixture",
  transport = createFixtureTransport(() => NOW),
) {
  return createRdpClient({ mode, transport, log: () => undefined });
}

async function renderHome(searchParams: Record<string, string | string[]> = {}) {
  render(
    await HomePage({
      params: Promise.resolve({}),
      searchParams: Promise.resolve(searchParams),
    } as PageProps<"/">),
  );
  return screen.getByRole("region", { name: "Measurements" });
}

/** A measurement row, found by its link's accessible name ("<station> <type>"). */
function row(station: string, type: string) {
  return screen.getByRole("link", { name: `${station} ${type}` }).closest("li")!;
}

const READING = /\d\s*(mASD|mm|m3\/s)\b/;

describe("home page", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/");
    const client = fixtureClient();
    getClient = () => client;
  });

  it("has a single page heading, one main landmark and a search", async () => {
    await renderHome();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("main")).toHaveAttribute("id", "main");
    expect(screen.getByRole("searchbox", { name: "Search" })).toBeInTheDocument();
  });

  it("announces catalogue loading before measurements arrive", () => {
    render(<Loading />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading published measurements");
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("counts published measurements and stations", async () => {
    await renderHome();
    expect(screen.getByText("7 measurements at 6 stations")).toBeInTheDocument();
  });

  it("groups measurements under their station", async () => {
    const section = await renderHome();
    const list = within(section).getByRole("region", { name: "Stations" });
    const stations = within(list)
      .getAllByRole("heading", { level: 3 })
      .map((heading) => heading.textContent);
    expect(stations).toEqual([
      "Colwick",
      "Shardlow",
      "Clifton Bridge",
      "Church Wilne",
      "Kegworth",
      "Stone",
    ]);
    const shardlow = within(section).getByRole("heading", { name: "Shardlow" }).closest("li")!;
    expect(
      within(shardlow)
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(["Shardlow Water level", "Shardlow Flow"]);
  });

  it("links every measurement to its stable RDP-identified detail page", async () => {
    await renderHome();
    expect(screen.getByRole("link", { name: "Shardlow Flow" })).toHaveAttribute(
      "href",
      "/measurements/ea-shardlow-flow",
    );
    expect(screen.getByRole("link", { name: "Stone Rainfall" })).toHaveAttribute(
      "href",
      "/measurements/ea-stone-rainfall",
    );
  });

  it("labels fixture data and distinguishes every latest state", async () => {
    const section = await renderHome();
    expect(within(section).getByRole("note")).toHaveTextContent("not real observations");
    expect(row("Colwick", "Water level")).toHaveTextContent(/mASD at/);
    expect(within(row("Colwick", "Water level")).getByText("Recent")).toBeVisible();
    expect(row("Colwick", "Water level").querySelector("time")).toHaveAttribute("datetime");
    expect(row("Kegworth", "Water level")).toHaveTextContent("No latest observation on record");
    expect(row("Kegworth", "Water level").textContent).not.toMatch(READING);
    expect(row("Shardlow", "Flow")).toHaveTextContent("Not recent");
    expect(row("Shardlow", "Water level")).not.toHaveTextContent("Not recent");
    // A period total states its period; it is never phrased as a reading "at" a time.
    expect(row("Stone", "Rainfall")).toHaveTextContent(/mm in the 15 minutes to/);
    expect(row("Stone", "Rainfall")).not.toHaveTextContent(/mm at/);
    expect(section).toHaveTextContent("Open Government Licence v3.0");
  });

  it("does not label live data as sample data", async () => {
    const client = fixtureClient("live");
    getClient = () => client;
    const section = await renderHome();
    expect(within(section).queryByRole("note")).toBeNull();
  });

  it("renders the filter from the URL so a shared or script-free search works", async () => {
    window.history.replaceState(null, "", "/?q=shardlow&type=flow");
    const section = await renderHome({ q: "shardlow", type: "flow" });
    expect(screen.getByRole("searchbox")).toHaveValue("shardlow");
    expect(screen.getByRole("radio", { name: "Flow" })).toBeChecked();
    expect(
      within(within(section).getByRole("region", { name: "Stations" }))
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(["Shardlow Flow"]);
    expect(screen.getByText("1 measurement found")).toBeInTheDocument();
  });

  it("ignores an unknown type and repeated query values", async () => {
    await renderHome({ q: ["a", "b"], type: "turbidity" });
    expect(screen.getByRole("searchbox")).toHaveValue("");
    expect(screen.getByRole("radio", { name: "All" })).toBeChecked();
    expect(screen.getByText("7 measurements at 6 stations")).toBeInTheDocument();
  });

  it("shows an error state, not values, when the catalogue or configuration fails", async () => {
    getClient = () => {
      throw new RdpError("CONFIGURATION_ERROR");
    };
    const section = await renderHome();
    expect(within(section).getByRole("alert")).toHaveTextContent(
      "Measurements are unavailable right now",
    );
    expect(section.textContent).not.toMatch(READING);
    expect(screen.queryByRole("searchbox")).toBeNull();
    expect(screen.getByRole("region", { name: "River map" })).toBeInTheDocument();
  });

  it("keeps the catalogue but marks latest unavailable when the latest read fails", async () => {
    const fixture = createFixtureTransport();
    const client = fixtureClient("live", async (request) => {
      if (request.path.endsWith("/latest")) throw new RdpError("STORAGE_UNAVAILABLE", 503);
      return fixture(request);
    });
    getClient = () => client;
    const section = await renderHome();
    expect(within(section).getAllByText("Latest reading unavailable")).toHaveLength(7);
    expect(section).toHaveTextContent("Latest readings are unavailable for these results.");
    expect(section.textContent).not.toMatch(READING);
  });

  it("keeps successful results and their metadata when some latest readings fail", async () => {
    const fixture = createFixtureTransport(() => NOW);
    const client = fixtureClient("live", async (request) => {
      const body = (await fixture(request)) as {
        data: Record<string, unknown>[];
        meta: Record<string, unknown>;
      };
      if (request.path === "/v1/measurements") {
        for (const item of body.data.filter(({ name }) => name === "Shardlow")) {
          item.name = "Shardlow Weir";
          item.watercourse = { name: "River Trent", status: "verified" };
        }
      }
      if (request.path.endsWith("/latest")) {
        body.meta.partial = true;
        Object.assign(
          body.data.find(({ measurementId }) => measurementId === "ea-shardlow-level")!,
          {
            status: "unavailable",
            observedAt: null,
            value: null,
            quality: null,
            freshness: "unknown",
            errorCode: "STORAGE_UNAVAILABLE",
          },
        );
      }
      return body;
    });
    getClient = () => client;
    await renderHome();
    expect(screen.getByText("Some latest readings are unavailable.")).toHaveAttribute(
      "role",
      "status",
    );
    const station = screen.getByRole("heading", { name: "Shardlow Weir" }).closest("li")!;
    expect(station).toHaveTextContent("River Trent");
    expect(station).toHaveTextContent("Environment Agency");
    expect(row("Shardlow Weir", "Water level")).toHaveTextContent("mASD · Local gauge datum (ASD)");
    expect(row("Shardlow Weir", "Water level")).toHaveTextContent("Latest reading unavailable");
    expect(row("Shardlow Weir", "Flow")).toHaveTextContent("Not recent");
    expect(row("Kegworth", "Water level")).toHaveTextContent("No latest observation on record");
  });

  it("shows an honest empty state when nothing publicly displayable is published", async () => {
    const fixture = createFixtureTransport();
    const client = fixtureClient("live", async (request) => {
      const body = (await fixture(request)) as { data: Array<Record<string, unknown>> };
      if (request.path === "/v1/measurements")
        body.data.forEach((item) => (item.provider = "unlicensed"));
      return body;
    });
    getClient = () => client;
    const section = await renderHome();
    expect(section).toHaveTextContent("No measurements to show yet");
    expect(screen.queryByRole("searchbox")).toBeNull();
    expect(screen.getByRole("region", { name: "River map" })).toBeInTheDocument();
  });
});
