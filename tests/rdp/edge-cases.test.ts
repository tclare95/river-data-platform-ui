// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CACHE_TTL_MS, createRdpClient, createTtlCache, type RdpClient } from "@/lib/rdp/client";
import type { LiveConfig } from "@/lib/rdp/config";
import { RdpError } from "@/lib/rdp/errors";
import { createFixtureTransport } from "@/lib/rdp/fixture";
import { createLiveTransport, type Credentials } from "@/lib/rdp/live";
import {
  MAX_RESPONSE_BYTES,
  withDeadlineAndRetry,
  type RdpRequest,
  type RdpTransport,
} from "@/lib/rdp/transport";

let overviewClient: RdpClient;
vi.mock("@/lib/rdp/server", async () => ({
  getRdpClient: () => overviewClient,
  RdpError: (await import("@/lib/rdp/errors")).RdpError,
}));
const { loadOverview } = await import("@/lib/overview");

const NOW = Date.parse("2026-11-19T12:07:00Z");

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** Runs withDeadlineAndRetry over a scripted sequence of responses/errors with a fake clock and sleep. */
function scripted(
  steps: Array<Response | Error>,
  options: { timeoutMs?: number; random?: number } = {},
) {
  const attempt = vi.fn(async () => {
    const next = steps.shift();
    if (!next) throw new Error("unexpected attempt");
    if (next instanceof Error) throw next;
    return next;
  });
  const sleep = vi.fn(async () => undefined);
  const run = () =>
    withDeadlineAndRetry(options.timeoutMs ?? 8000, attempt, {
      sleep,
      now: () => NOW,
      random: () => options.random ?? 0.5,
    });
  return { run, attempt, sleep };
}

const storage503 = (headers: Record<string, string> = {}) =>
  json(503, { error: { code: "STORAGE_UNAVAILABLE", message: "x" } }, headers);

describe("withDeadlineAndRetry", () => {
  it.each([
    ["absent", undefined],
    ["zero", "0"],
    ["non-numeric", "soon"],
    ["negative", "-5"],
    ["an HTTP date", "Wed, 21 Oct 2026 07:28:00 GMT"],
  ])("falls back to jittered backoff when Retry-After is %s", async (_name, header) => {
    const { run, sleep, attempt } = scripted([
      storage503(header === undefined ? {} : { "retry-after": header }),
      json(200, { ok: true }),
    ]);
    await expect(run()).resolves.toEqual({ ok: true });
    expect(attempt).toHaveBeenCalledTimes(2);
    // 200 + floor(0.5 * 300)
    expect(sleep).toHaveBeenCalledWith(350, expect.any(AbortSignal));
  });

  it("uses the larger of a small Retry-After and the jitter", async () => {
    const { run, sleep } = scripted([storage503({ "retry-after": "1" }), json(200, {})], {
      random: 0,
    });
    await run();
    expect(sleep).toHaveBeenCalledWith(1000, expect.any(AbortSignal));
  });

  it("skips the retry when too little budget would remain after the backoff", async () => {
    // 1600 ms budget - 350 ms backoff = 1250 ms < 1500 ms minimum.
    const { run, sleep, attempt } = scripted([storage503(), json(200, {})], { timeoutMs: 1600 });
    await expect(run()).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE", status: 503 });
    expect(attempt).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("counts a honoured Retry-After against the remaining budget", async () => {
    const short = scripted([storage503({ "retry-after": "2" }), json(200, {})], {
      timeoutMs: 3000,
    });
    await expect(short.run()).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
    expect(short.sleep).not.toHaveBeenCalled();
    const enough = scripted([storage503({ "retry-after": "2" }), json(200, { ok: 1 })], {
      timeoutMs: 3500,
    });
    await expect(enough.run()).resolves.toEqual({ ok: 1 });
  });

  it("reports TIMEOUT when the deadline passes during the backoff sleep", async () => {
    const attempt = vi.fn(async () => storage503());
    const result = withDeadlineAndRetry(30, attempt, {
      // Allow a retry regardless of budget so the real abortable sleep is reached.
      retry: { maxRetryAfterMs: 2000, minRetryBudgetMs: -10_000 },
      random: () => 0,
    });
    await expect(result).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(attempt).toHaveBeenCalledOnce();
  });

  it("retries a network error once and then succeeds", async () => {
    const { run, attempt } = scripted([new TypeError("fetch failed"), json(200, { ok: 2 })]);
    await expect(run()).resolves.toEqual({ ok: 2 });
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it("surfaces a repeated network error as NETWORK_ERROR without leaking the message", async () => {
    const { run } = scripted([
      new TypeError("connect ECONNREFUSED 10.0.0.1"),
      new TypeError("connect ECONNREFUSED 10.0.0.1"),
    ]);
    const error = await run().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RdpError);
    expect(error).toMatchObject({ code: "NETWORK_ERROR" });
    expect(String((error as Error).message)).not.toContain("10.0.0.1");
  });

  it.each([
    ["an HTML body", "<html>bad gateway</html>"],
    ["an empty body", ""],
  ])("treats a 5xx with %s as a retryable UPSTREAM_ERROR", async (_name, body) => {
    const { run, attempt } = scripted([
      new Response(body, { status: 502 }),
      new Response(body, { status: 502 }),
    ]);
    await expect(run()).rejects.toMatchObject({ code: "UPSTREAM_ERROR", status: 502 });
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it("ignores an error body over 64 KiB and maps by status alone", async () => {
    const huge = JSON.stringify({
      error: { code: "VALIDATION_ERROR", message: "x".repeat(70 * 1024) },
    });
    const { run, attempt } = scripted([new Response(huge, { status: 400 })]);
    await expect(run()).rejects.toMatchObject({ code: "UPSTREAM_ERROR", status: 400 });
    expect(attempt).toHaveBeenCalledOnce();
  });

  it("refuses a chunked success body over the cap without a content-length", async () => {
    let pulls = 0;
    let cancelled = false;
    const chunk = new Uint8Array(1024 * 1024).fill(0x20);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    const response = new Response(body, { status: 200 });
    expect(response.headers.get("content-length")).toBeNull();
    const { run } = scripted([response]);
    await expect(run()).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });
    expect(cancelled).toBe(true);
    // Stops reading as soon as the cap is crossed rather than buffering the whole stream.
    expect(pulls).toBeLessThanOrEqual(Math.ceil(MAX_RESPONSE_BYTES / chunk.byteLength) + 2);
  });

  it("does not retry an oversized success body", async () => {
    const { run, attempt } = scripted([
      new Response("x", {
        status: 200,
        headers: { "content-length": String(MAX_RESPONSE_BYTES + 1) },
      }),
    ]);
    await expect(run()).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });
    expect(attempt).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------------------------------------
// Live transport

const CONFIG: LiveConfig = {
  mode: "live",
  stage: "staging",
  apiUrl: "https://abc123.execute-api.eu-west-1.amazonaws.com/staging",
  roleArn: "arn:aws:iam::123456789012:role/river-data-platform-staging-ui-vercel-preview",
  region: "eu-west-1",
};

function creds(expiresAt: number, id = "AKIDFIXTURE"): Credentials {
  return {
    accessKeyId: id,
    secretAccessKey: "fixture-secret",
    sessionToken: "fixture-session",
    expiration: new Date(expiresAt),
  };
}

function live(
  overrides: { assumeRole?: (token: string, signal: AbortSignal) => Promise<Credentials> } = {},
) {
  let now = NOW;
  const fetch = vi.fn<typeof globalThis.fetch>(async () => json(200, {}));
  const assumeRole = vi.fn(overrides.assumeRole ?? (async () => creds(now + 15 * 60_000)));
  const getToken = vi.fn(async () => "oidc-token");
  const transport = createLiveTransport(CONFIG, {
    fetch: fetch as never,
    assumeRole,
    getToken,
    sleep: async () => undefined,
    now: () => now,
    random: () => 0,
  });
  return {
    transport,
    fetch,
    assumeRole,
    getToken,
    setNow: (value: number) => (now = value),
  };
}

const latestRequest: RdpRequest = {
  path: "/v1/measurements/latest",
  query: { ids: "ea-colwick-level" },
  timeoutMs: 8000,
};

describe("live transport credentials", () => {
  it("refreshes credentials once fewer than 60 seconds remain", async () => {
    const { transport, assumeRole, setNow } = live({
      assumeRole: async () => creds(NOW + 10 * 60_000),
    });
    await transport(latestRequest);
    setNow(NOW + 10 * 60_000 - 60_001);
    await transport(latestRequest);
    expect(assumeRole).toHaveBeenCalledOnce();
    setNow(NOW + 10 * 60_000 - 60_000);
    // The replacement must itself outlive the margin, so hand back fresh credentials.
    assumeRole.mockImplementationOnce(async () => creds(NOW + 30 * 60_000, "AKIDSECOND"));
    await transport(latestRequest);
    expect(assumeRole).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["already expired", NOW - 1000],
    ["inside the refresh margin", NOW + 30_000],
    ["an invalid date", Number.NaN],
  ])("rejects STS credentials that are %s", async (_name, expiresAt) => {
    const { transport, fetch } = live({ assumeRole: async () => creds(expiresAt) });
    await expect(transport(latestRequest)).rejects.toMatchObject({
      code: "AUTHENTICATION_FAILED",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("maps an OIDC token failure to AUTHENTICATION_FAILED without calling STS or RDP", async () => {
    const { transport, fetch, getToken, assumeRole } = live();
    getToken.mockRejectedValueOnce(new Error("VERCEL_OIDC_TOKEN missing: secret detail"));
    const error = await transport(latestRequest).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "AUTHENTICATION_FAILED" });
    expect(JSON.stringify(error)).not.toContain("secret");
    expect(assumeRole).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not let a shared failed exchange poison later requests", async () => {
    const { transport, assumeRole, fetch } = live();
    assumeRole.mockRejectedValueOnce(new Error("throttled"));
    const results = await Promise.allSettled([transport(latestRequest), transport(latestRequest)]);
    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    expect(assumeRole).toHaveBeenCalledOnce();
    await expect(transport(latestRequest)).resolves.toEqual({});
    expect(assumeRole).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("does not fail a long-budget read because a concurrent short-budget read timed out", async () => {
    const { transport } = live({
      assumeRole: (_token, signal) =>
        new Promise<Credentials>((resolve, reject) => {
          const timer = setTimeout(() => resolve(creds(NOW + 15 * 60_000)), 80);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new Error("aborted"));
          });
        }),
    });
    const short = transport({ ...latestRequest, timeoutMs: 10 });
    const long = transport({ ...latestRequest, timeoutMs: 5000 });
    await expect(short).rejects.toMatchObject({ code: "TIMEOUT" });
    await expect(long).resolves.toEqual({});
  });
});

// Regression: a synchronous throw from the token source once left a rejected exchange cached for the life
// of the process (the async IIFE's `finally` ran before `??=` assigned).
describe("live transport credential recovery", () => {
  it("recovers after a token source that throws synchronously", async () => {
    const { transport, getToken, fetch } = live();
    getToken.mockImplementationOnce(() => {
      throw new Error("token source unavailable");
    });
    await expect(transport(latestRequest)).rejects.toMatchObject({
      code: "AUTHENTICATION_FAILED",
    });
    await expect(transport(latestRequest)).resolves.toEqual({});
    expect(fetch).toHaveBeenCalledOnce();
  });
});

describe("live transport URL building", () => {
  const BASE = "https://abc123.execute-api.eu-west-1.amazonaws.com/staging/v1/measurements";

  it("encodes query values so they cannot add parameters or change the path", async () => {
    const { transport, fetch } = live();
    await transport({
      path: "/v1/measurements/latest",
      query: { ids: "a&cursor=x#frag/../../" },
      timeoutMs: 8000,
    });
    const url = new URL(String(fetch.mock.calls[0][0]));
    expect(url.origin).toBe("https://abc123.execute-api.eu-west-1.amazonaws.com");
    expect(url.pathname).toBe("/staging/v1/measurements/latest");
    expect([...url.searchParams.keys()]).toEqual(["ids"]);
    expect(url.hash).toBe("");
  });

  it.each(["/v1/measurements//evil.example/x", "/v1/measurements@evil.example/x"])(
    "keeps the configured host for %s",
    async (path) => {
      const { transport, fetch } = live();
      await transport({ path, query: {}, timeoutMs: 8000 }).catch(() => undefined);
      for (const [url] of fetch.mock.calls) {
        expect(new URL(String(url)).host).toBe("abc123.execute-api.eu-west-1.amazonaws.com");
      }
    },
  );

  // Regression: URL.pathname resolves dot segments, `%2e%2e` and backslashes, so the transport itself
  // allows only the four exact observation route shapes and never signs anything else.
  it.each([
    "/v1/measurements/../../production/v1/measurements",
    "/v1/measurements/%2e%2e/%2e%2e/production/v1/measurements",
    "/v1/measurements\\..\\..\\production",
  ])("never fetches outside the stage's measurement routes for %s", async (path) => {
    const { transport, fetch } = live();
    await expect(transport({ path, query: {}, timeoutMs: 8000 })).rejects.toMatchObject({
      code: "INVALID_QUERY",
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(BASE).toContain("/staging/");
  });
});

// ---------------------------------------------------------------------------------------------------------
// Client

function clientSetup(wrap?: (fixture: RdpTransport) => RdpTransport) {
  let now = NOW;
  const fixture = createFixtureTransport(() => now);
  const inner = wrap ? wrap(fixture) : fixture;
  const transport = vi.fn((request: RdpRequest) => inner(request));
  const client = createRdpClient({
    mode: "fixture",
    transport,
    now: () => now,
    // The frozen test clock never refills the request budget; rate limiting is covered elsewhere.
    ratePerSecond: Number.POSITIVE_INFINITY,
    log: () => undefined,
  });
  const calls = (suffix: string) => transport.mock.calls.filter(([r]) => r.path.endsWith(suffix));
  return { client, transport, calls, advance: (ms: number) => (now += ms) };
}

describe("RDP client edges", () => {
  it("does not cache a failed catalogue read", async () => {
    let fail = true;
    const { client, calls } = clientSetup((fixture) => async (request) => {
      if (request.path === "/v1/measurements" && fail) throw new RdpError("THROTTLED", 429);
      return fixture(request);
    });
    await expect(client.listMeasurements()).rejects.toMatchObject({ code: "THROTTLED" });
    await expect(client.getMeasurement("ea-colwick-level")).rejects.toMatchObject({
      code: "THROTTLED",
    });
    fail = false;
    await expect(client.getMeasurement("ea-colwick-level")).resolves.toMatchObject({
      measurementId: "ea-colwick-level",
    });
    expect(calls("/v1/measurements")).toHaveLength(3);
  });

  it("caches the catalogue for its TTL only", async () => {
    const { client, calls, advance } = clientSetup();
    await client.listMeasurements();
    advance(CACHE_TTL_MS.catalogue - 1);
    await client.listMeasurements();
    expect(calls("/v1/measurements")).toHaveLength(1);
    advance(2);
    await client.listMeasurements();
    expect(calls("/v1/measurements")).toHaveLength(2);
  });

  it("maps a non-RdpError transport failure to UPSTREAM_ERROR", async () => {
    const { client } = clientSetup(() => async () => {
      throw new Error("internal https://abc123.execute-api detail");
    });
    const error = await client.listMeasurements().catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "UPSTREAM_ERROR" });
    expect(String((error as Error).message)).not.toContain("execute-api");
  });

  it("evicts the oldest entry once the TTL cache is full", async () => {
    const cached = createTtlCache(() => NOW, 2);
    const load = vi.fn(async () => "v");
    await cached("a", 60_000, load);
    await cached("b", 60_000, load);
    await cached("a", 60_000, load);
    expect(load).toHaveBeenCalledTimes(2);
    await cached("c", 60_000, load);
    await cached("b", 60_000, load);
    await cached("c", 60_000, load);
    expect(load).toHaveBeenCalledTimes(3);
    await cached("a", 60_000, load);
    expect(load).toHaveBeenCalledTimes(4);
  });

  it("shares one in-flight load between concurrent callers", async () => {
    const cached = createTtlCache(() => NOW);
    let resolve!: (value: string) => void;
    const load = vi.fn(() => new Promise<string>((r) => (resolve = r)));
    const first = cached("k", 1000, load);
    const second = cached("k", 1000, load);
    resolve("done");
    await expect(Promise.all([first, second])).resolves.toEqual(["done", "done"]);
    expect(load).toHaveBeenCalledOnce();
  });

  it("keys cached first history pages by limit and knownAt", async () => {
    const { client, calls } = clientSetup();
    const window = { from: "2026-11-19T00:00:00Z", to: "2026-11-19T06:00:00Z" };
    await client.getHistory("ea-colwick-level", { ...window, limit: 10 });
    await client.getHistory("ea-colwick-level", { ...window, limit: 10 });
    expect(calls("/observations")).toHaveLength(1);
    await client.getHistory("ea-colwick-level", { ...window, limit: 11 });
    expect(calls("/observations")).toHaveLength(2);
    // Same instant written with an offset normalises to the same key.
    await client.getHistory("ea-colwick-level", {
      from: "2026-11-19T01:00:00+01:00",
      to: "2026-11-19T06:00:00Z",
      limit: 10,
    });
    expect(calls("/observations")).toHaveLength(2);

    await client.getHistory("ea-stone-rainfall", window);
    await client.getHistory("ea-stone-rainfall", { ...window, knownAt: "2026-11-19T10:00:00Z" });
    await client.getHistory("ea-stone-rainfall", { ...window, knownAt: "2026-11-19T11:00:00Z" });
    await client.getHistory("ea-stone-rainfall", { ...window, knownAt: "2026-11-19T11:00:00Z" });
    expect(calls("/observations")).toHaveLength(5);
  });

  it.each([
    ["from", -3_600_000],
    ["to", 3_600_000],
  ] as const)(
    "rejects a page whose echoed meta.%s differs from the query",
    async (field, shift) => {
      const { client } = clientSetup((fixture) => async (request) => {
        const body = (await fixture(request)) as { meta: Record<string, string> };
        if (request.path.endsWith("/observations")) {
          body.meta[field] = new Date(Date.parse(body.meta[field]) + shift).toISOString();
        }
        return body;
      });
      await expect(
        client.getHistory("ea-colwick-level", {
          from: "2026-11-19T00:00:00Z",
          to: "2026-11-19T06:00:00Z",
        }),
      ).rejects.toMatchObject({ code: "RESPONSE_CONTRACT_ERROR" });
    },
  );
});

// ---------------------------------------------------------------------------------------------------------
// Fixture pagination

describe("fixture history pagination", () => {
  const window = { from: "2026-11-18T00:00:00Z", to: "2026-11-19T00:00:00Z" };

  it("covers every row exactly once and in order across cursor pages", async () => {
    const { client } = clientSetup();
    const whole = await client.getHistory("ea-colwick-level", { ...window, limit: 5000 });
    if (whole.kind !== "instantaneous") throw new Error("expected instantaneous");
    expect(whole.nextCursor).toBeNull();
    expect(whole.observations).toHaveLength(96);

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await client.getHistory("ea-colwick-level", { ...window, limit: 7, cursor });
      if (page.kind !== "instantaneous") throw new Error("expected instantaneous");
      expect(page.observations.length).toBeLessThanOrEqual(7);
      seen.push(...page.observations.map((row) => row.observedAt));
      cursor = page.nextCursor ?? undefined;
      pages++;
    } while (cursor && pages < 50);
    expect(pages).toBe(Math.ceil(96 / 7));
    expect(seen).toEqual(whole.observations.map((row) => row.observedAt));
    expect(new Set(seen).size).toBe(seen.length);
  });

  it.each([
    ["a non-JSON payload", "bm90LWpzb24"],
    ["a negative offset", Buffer.from(JSON.stringify({ fixture: -1 })).toString("base64url")],
    ["a fractional offset", Buffer.from(JSON.stringify({ fixture: 1.5 })).toString("base64url")],
    ["a missing offset", Buffer.from(JSON.stringify({ other: 1 })).toString("base64url")],
  ])("rejects %s as INVALID_CURSOR", async (_name, cursor) => {
    const { client } = clientSetup();
    await expect(
      client.getHistory("ea-colwick-level", { ...window, limit: 10, cursor }),
    ).rejects.toMatchObject({ code: "INVALID_CURSOR", status: 400 });
  });

  it("withholds the rainfall window and says why when the window is paginated", async () => {
    const { client } = clientSetup();
    const first = await client.getHistory("ea-stone-rainfall", { ...window, limit: 10 });
    if (first.kind !== "period_total") throw new Error("expected period_total");
    expect(first.window).toBeNull();
    expect(first.windowUnavailable).toBe("paginated");
    const last = await client.getHistory("ea-stone-rainfall", {
      ...window,
      limit: 10,
      cursor: Buffer.from(JSON.stringify({ fixture: 90 })).toString("base64url"),
    });
    if (last.kind !== "period_total") throw new Error("expected period_total");
    expect(last.nextCursor).toBeNull();
    expect(last.window).toBeNull();
    expect(last.windowUnavailable).toBe("paginated");

    const whole = await client.getHistory("ea-stone-rainfall", { ...window, limit: 5000 });
    if (whole.kind !== "period_total") throw new Error("expected period_total");
    expect(whole.windowUnavailable).toBeNull();
    expect(whole.window).toMatchObject({ expectedIntervals: 96, status: "complete" });
  });
});

// ---------------------------------------------------------------------------------------------------------
// Overview batching

function wideCatalogueTransport(count: number, failBatchContaining?: string) {
  const ids = Array.from(
    { length: count },
    (_, i) => `ea-site-${String(i).padStart(2, "0")}-level`,
  );
  const latestCalls: string[][] = [];
  const transport: RdpTransport = async ({ path, query }) => {
    const at = new Date(NOW).toISOString();
    if (path === "/v1/measurements") {
      return {
        data: ids.map((id) => ({
          measurementId: id,
          provider: "environment-agency",
          sourceId: "ea-flood-monitoring",
          stationId: id.replace(/-level$/, ""),
          parameter: "level",
          unit: "mASD",
          datum: "ASD",
          expectedIntervalSeconds: 900,
          name: id,
        })),
        meta: { retrievedAt: at },
      };
    }
    if (path === "/v1/measurements/latest") {
      const requested = query.ids.split(",");
      latestCalls.push(requested);
      if (failBatchContaining && requested.includes(failBatchContaining)) {
        throw new RdpError("STORAGE_UNAVAILABLE", 503);
      }
      return {
        data: requested.map((id) => ({
          measurementId: id,
          status: "available",
          observedAt: "2026-11-19T12:00:00Z",
          value: 1.5,
          unit: "mASD",
          quality: "Good",
          freshness: "fresh",
          errorCode: null,
        })),
        meta: { retrievedAt: at, partial: false },
      };
    }
    throw new RdpError("MEASUREMENT_NOT_FOUND", 404);
  };
  return { ids, transport, latestCalls };
}

describe("overview latest batching", () => {
  beforeEach(() => {
    overviewClient = createRdpClient({
      mode: "fixture",
      transport: createFixtureTransport(() => NOW),
      log: () => undefined,
    });
  });

  it("reads latest for 25 public measurements in batches of at most 20, in catalogue order", async () => {
    const { ids, transport, latestCalls } = wideCatalogueTransport(25);
    overviewClient = createRdpClient({ mode: "live", transport, log: () => undefined });
    const overview = await loadOverview();
    expect(latestCalls.map((batch) => batch.length)).toEqual([20, 5]);
    expect(latestCalls.flat()).toEqual(ids);
    if (overview.status !== "ok") throw new Error("expected ok");
    expect(overview.items.map((item) => item.measurement.measurementId)).toEqual(ids);
    expect(overview.items.every((item) => item.latest?.status === "available")).toBe(true);
  });

  it("marks only the failed batch unavailable", async () => {
    const { ids, transport } = wideCatalogueTransport(25, "ea-site-22-level");
    overviewClient = createRdpClient({ mode: "live", transport, log: () => undefined });
    const overview = await loadOverview();
    if (overview.status !== "ok") throw new Error("expected ok");
    expect(overview.items.slice(0, 20).every((item) => item.latest !== null)).toBe(true);
    expect(overview.items.slice(20).map((item) => item.latest)).toEqual(Array(5).fill(null));
    expect(overview.items).toHaveLength(ids.length);
  });
});
