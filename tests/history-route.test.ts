// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRdpClient, type RdpClient } from "@/lib/rdp/client";
import { RdpError } from "@/lib/rdp/errors";
import { createFixtureTransport } from "@/lib/rdp/fixture";

let client: RdpClient;
vi.mock("@/lib/rdp/server", async () => ({
  getRdpClient: () => client,
  RdpError: (await import("@/lib/rdp/errors")).RdpError,
}));
const { GET } = await import("@/app/api/measurements/[id]/history/route");

function call(id: string, query = "") {
  return GET(new Request(`https://ui.test/api/measurements/${id}/history${query}`), {
    params: Promise.resolve({ id }),
  } as never);
}

beforeEach(() => {
  client = createRdpClient({
    mode: "fixture",
    transport: createFixtureTransport(),
    log: () => undefined,
  });
});

describe("GET /api/measurements/{id}/history", () => {
  it("returns one bounded public page with no internal provenance", async () => {
    const response = await call("ea-colwick-level");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("s-maxage=60");
    const body = await response.json();
    expect(body.mode).toBe("fixture");
    expect(body.data.measurement).toMatchObject({
      measurementId: "ea-colwick-level",
      unit: "mASD",
    });
    expect(body.data.history.coverage.status).toBe("unknown");
    expect(Object.keys(body.data.history.observations[0]).sort()).toEqual([
      "observedAt",
      "quality",
      "revision",
      "value",
    ]);
    const text = JSON.stringify(body);
    for (const hidden of [
      "ingestedAt",
      "sourceReference",
      "requestAsOf",
      "cutoff",
      "execute-api",
      "arn:aws",
    ]) {
      expect(text).not.toContain(hidden);
    }
  });

  it("returns rainfall as labelled period totals, never as instantaneous values", async () => {
    const body = await (await call("ea-stone-rainfall")).json();
    expect(body.data.history.kind).toBe("period_total");
    expect(body.data.history.intervals[0]).toHaveProperty("totalMm");
    expect(body.data.history.intervals[0]).not.toHaveProperty("value");
    expect(body.data.history).not.toHaveProperty("observations");
  });

  it.each([
    ["an unknown parameter", "ea-colwick-level", "?ids=x"],
    [
      "a duplicated parameter",
      "ea-colwick-level",
      "?from=2026-11-01T00:00Z&from=2026-11-01T00:00Z&to=2026-11-02T00:00Z",
    ],
    ["a window over 31 days", "ea-colwick-level", "?from=2026-09-01T00:00Z&to=2026-11-01T00:00Z"],
    ["only one bound", "ea-colwick-level", "?from=2026-11-01T00:00Z"],
    [
      "an offset timestamp",
      "ea-colwick-level",
      "?from=2026-11-01T00:00+01:00&to=2026-11-02T00:00Z",
    ],
    ["any limit (the page size is fixed)", "ea-colwick-level", "?limit=100"],
    [
      "a window off the hour grid",
      "ea-colwick-level",
      "?from=2026-11-01T00:00:00.001Z&to=2026-11-02T00:00Z",
    ],
    ["minute precision", "ea-colwick-level", "?from=2026-11-01T00:30Z&to=2026-11-02T00:00Z"],
    [
      "a malformed cursor",
      "ea-colwick-level",
      "?from=2026-11-01T00:00Z&to=2026-11-02T00:00Z&cursor=%2F%2F",
    ],
    ["a cursor without its explicit window", "ea-colwick-level", "?cursor=abc"],
    ["a malformed ID", "EA_COLWICK", ""],
  ])("rejects %s", async (_name, id, query) => {
    const response = await call(id, query);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: "INVALID_REQUEST" } });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("returns 404 for an unpublished measurement", async () => {
    const response = await call("ea-unpublished-level");
    expect(response.status).toBe(404);
  });

  it.each([
    ["CURSOR_EXPIRED", 409, "RESTART_REQUIRED"],
    ["AUTHORIZATION_FAILED", 503, "UNAVAILABLE"],
    ["CONFIGURATION_ERROR", 503, "UNAVAILABLE"],
    ["ARCHIVE_INTEGRITY", 503, "UNAVAILABLE"],
  ] as const)("maps %s to a fixed public error", async (code, status, publicCode) => {
    client = { ...client, getHistory: async () => Promise.reject(new RdpError(code, 0)) };
    const response = await call("ea-colwick-level");
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: { code: publicCode } });
  });

  it("does not expose measurements whose provider is not cleared for public display", async () => {
    const base = client;
    client = {
      ...base,
      getMeasurement: async (id) => ({
        ...(await base.getMeasurement(id)),
        provider: "private-provider",
      }),
    };
    expect((await call("ea-colwick-level")).status).toBe(404);
  });
});
