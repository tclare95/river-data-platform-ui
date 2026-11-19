import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRdpClient, type RdpClient } from "@/lib/rdp/client";
import { RdpError } from "@/lib/rdp/errors";
import { createFixtureTransport } from "@/lib/rdp/fixture";

let getClient: () => RdpClient;
vi.mock("next/server", () => ({ connection: async () => undefined }));
vi.mock("@/lib/rdp/server", () => ({ getRdpClient: () => getClient() }));
const { default: HomePage } = await import("@/app/page");

function fixtureClient(
  mode: "fixture" | "live" = "fixture",
  transport = createFixtureTransport(() => Date.parse("2026-11-19T12:07:00Z")),
) {
  return createRdpClient({ mode, transport, log: () => undefined });
}

async function renderHome() {
  render(await HomePage());
  return screen.getByRole("region", { name: "Measurements" });
}

const READING = /\d\s*(mASD|mm|m3\/s)\b/;

describe("home page", () => {
  beforeEach(() => {
    const client = fixtureClient();
    getClient = () => client;
  });

  it("has a single page heading and one main landmark", async () => {
    await renderHome();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("main")).toHaveAttribute("id", "main");
  });

  it("labels fixture data and distinguishes every latest state", async () => {
    const section = await renderHome();
    expect(within(section).getByRole("note")).toHaveTextContent("not real observations");
    const item = (name: string) =>
      within(section)
        .getByRole("heading", { level: 2, name: new RegExp(`^${name}`) })
        .closest("li")!;
    expect(item("Colwick")).toHaveTextContent(/mASD at/);
    expect(item("Colwick")).not.toHaveTextContent("Not recent");
    expect(item("Kegworth")).toHaveTextContent("No observations collected");
    expect(item("Shardlow")).toHaveTextContent("Not recent");
    // A period total states its period; it is never phrased as a reading "at" a time.
    expect(item("Stone")).toHaveTextContent(/mm in the 15 minutes to/);
    expect(item("Stone")).not.toHaveTextContent(/mm at/);
    expect(section).toHaveTextContent("Open Government Licence v3.0");
  });

  it("does not label live data as sample data", async () => {
    const client = fixtureClient("live");
    getClient = () => client;
    const section = await renderHome();
    expect(within(section).queryByRole("note")).toBeNull();
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
  });

  it("keeps the catalogue but marks latest unavailable when the latest read fails", async () => {
    const fixture = createFixtureTransport();
    const client = fixtureClient("live", async (request) => {
      if (request.path.endsWith("/latest")) throw new RdpError("STORAGE_UNAVAILABLE", 503);
      return fixture(request);
    });
    getClient = () => client;
    const section = await renderHome();
    expect(within(section).getAllByText("Latest reading unavailable")).toHaveLength(4);
    expect(section.textContent).not.toMatch(READING);
  });

  it("shows an honest empty state when nothing publicly displayable is published", async () => {
    const fixture = createFixtureTransport();
    const client = fixtureClient("live", async (request) => {
      const body = (await fixture(request)) as { data: Array<Record<string, unknown>> };
      if (request.path === "/v1/measurements")
        body.data.forEach((row) => (row.provider = "unlicensed"));
      return body;
    });
    getClient = () => client;
    const section = await renderHome();
    expect(section).toHaveTextContent("No measurements to show yet");
  });
});
