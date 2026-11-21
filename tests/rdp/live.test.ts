// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { LiveConfig } from "@/lib/rdp/config";
import { createLiveTransport, type Credentials } from "@/lib/rdp/live";

const CONFIG: LiveConfig = {
  mode: "live",
  stage: "staging",
  apiUrl: "https://abc123.execute-api.eu-west-1.amazonaws.com/staging",
  roleArn: "arn:aws:iam::123456789012:role/river-data-platform-staging-ui-vercel-preview",
  region: "eu-west-1",
};
const NOW = Date.parse("2026-11-19T12:00:00Z");
const CREDENTIALS: Credentials = {
  accessKeyId: "AKIDFIXTURE",
  secretAccessKey: "fixture-secret",
  sessionToken: "fixture-session",
  expiration: new Date(NOW + 15 * 60_000),
};

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function setup(responses: Array<Response | Error>) {
  const fetch = vi.fn(async (...args: Parameters<typeof globalThis.fetch>) => {
    void args;
    const next = responses.shift();
    if (!next) throw new Error("unexpected fetch");
    if (next instanceof Error) throw next;
    return next;
  });
  const assumeRole = vi.fn(async () => CREDENTIALS);
  const getToken = vi.fn(async () => "oidc-token");
  const sleep = vi.fn(async () => undefined);
  const transport = createLiveTransport(CONFIG, {
    fetch: fetch as never,
    assumeRole,
    getToken,
    sleep,
    now: () => NOW,
    random: () => 0,
  });
  return { transport, fetch, assumeRole, getToken, sleep };
}

const request = {
  path: "/v1/measurements/latest",
  query: { ids: "ea-colwick-level" },
  timeoutMs: 8000,
};

describe("live signed transport", () => {
  it("signs an exact GET under the stage path with temporary credentials", async () => {
    const { transport, fetch, getToken, assumeRole } = setup([json(200, { ok: true })]);
    await expect(transport(request)).resolves.toEqual({ ok: true });
    expect(getToken).toHaveBeenCalledOnce();
    expect(assumeRole).toHaveBeenCalledWith("oidc-token", expect.any(AbortSignal));
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(
      "https://abc123.execute-api.eu-west-1.amazonaws.com/staging/v1/measurements/latest?ids=ea-colwick-level",
    );
    expect(init).toMatchObject({ method: "GET", cache: "no-store", redirect: "error" });
    const headers = init!.headers as Record<string, string>;
    expect(headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDFIXTURE\/\d{8}\/eu-west-1\/execute-api\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token, Signature=[0-9a-f]{64}$/,
    );
    expect(headers["x-amz-security-token"]).toBe("fixture-session");
  });

  it("reuses credentials until they near expiry and shares one exchange between concurrent reads", async () => {
    const { transport, assumeRole } = setup([json(200, {}), json(200, {}), json(200, {})]);
    await Promise.all([transport(request), transport(request)]);
    await transport(request);
    expect(assumeRole).toHaveBeenCalledOnce();
  });

  it("retries once on 503 honouring a capped Retry-After", async () => {
    const { transport, fetch, sleep } = setup([
      json(
        503,
        { error: { code: "STORAGE_UNAVAILABLE", message: "x" }, requestId: "r" },
        { "retry-after": "30" },
      ),
      json(200, { ok: 1 }),
    ]);
    await expect(transport(request)).resolves.toEqual({ ok: 1 });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(2000, expect.any(AbortSignal));
  });

  it("gives up after the single retry", async () => {
    const { transport, fetch } = setup([json(503, {}), json(504, {})]);
    await expect(transport(request)).rejects.toMatchObject({ code: "UPSTREAM_ERROR", status: 504 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("never retries a shared-throttle 429", async () => {
    const { transport, fetch } = setup([json(429, {}, { "retry-after": "1" })]);
    await expect(transport(request)).rejects.toMatchObject({ code: "THROTTLED", status: 429 });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("does not let one caller's deadline fail a shared credential exchange for others", async () => {
    let finish!: (value: Credentials) => void;
    const { transport, assumeRole } = setup([json(200, { ok: "long" })]);
    assumeRole.mockImplementationOnce(
      () => new Promise<Credentials>((resolve) => (finish = resolve)),
    );
    const short = transport({ ...request, timeoutMs: 10 });
    const long = transport({ ...request, timeoutMs: 5_000 });
    await expect(short).rejects.toMatchObject({ code: "TIMEOUT" });
    finish(CREDENTIALS);
    await expect(long).resolves.toEqual({ ok: "long" });
    expect(assumeRole).toHaveBeenCalledOnce();
  });

  it.each([
    [403, {}, "AUTHORIZATION_FAILED"],
    [400, { error: { code: "VALIDATION_ERROR", message: "bad" } }, "INVALID_QUERY"],
    [404, { error: { code: "MEASUREMENT_NOT_FOUND", message: "x" } }, "MEASUREMENT_NOT_FOUND"],
    // RDP's NOT_FOUND is an unknown route (misconfigured URL/stage), never a missing measurement.
    [404, { error: { code: "NOT_FOUND", message: "x" } }, "CONFIGURATION_ERROR"],
    [409, { error: { code: "CURSOR_EXPIRED", message: "x" } }, "CURSOR_EXPIRED"],
    [503, { error: { code: "ARCHIVE_INTEGRITY", message: "x" } }, "ARCHIVE_INTEGRITY"],
  ])("does not retry %i and exposes only a fixed code", async (status, body, code) => {
    const { transport, fetch } = setup([json(status, body)]);
    const error = await transport(request).catch((e: unknown) => e);
    expect(error).toMatchObject({ code, status });
    expect(String((error as Error).message)).toBe(`RDP ${code}`);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("maps a failed token exchange to AUTHENTICATION_FAILED without contacting RDP", async () => {
    const { transport, fetch, assumeRole } = setup([]);
    assumeRole.mockRejectedValueOnce(
      new Error("AccessDenied: arn:aws:sts::123456789012 secret detail"),
    );
    const error = await transport(request).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "AUTHENTICATION_FAILED" });
    expect(JSON.stringify(error)).not.toContain("arn:aws");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses an oversized body rather than buffering it", async () => {
    const { transport } = setup([
      new Response("x", { status: 200, headers: { "content-length": String(10 * 1024 * 1024) } }),
    ]);
    await expect(transport(request)).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });
  });

  it("treats a non-JSON success as a contract error", async () => {
    const { transport } = setup([new Response("<html>", { status: 200 })]);
    await expect(transport(request)).rejects.toMatchObject({ code: "RESPONSE_CONTRACT_ERROR" });
  });

  it("times out within the call budget", async () => {
    const hanging = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) =>
          init.signal!.addEventListener("abort", () => reject(new Error("aborted"))),
        ),
    );
    const transport = createLiveTransport(CONFIG, {
      fetch: hanging as never,
      assumeRole: async () => CREDENTIALS,
      getToken: async () => "t",
      now: () => NOW,
    });
    await expect(transport({ ...request, timeoutMs: 20 })).rejects.toMatchObject({
      code: "TIMEOUT",
    });
  });

  it.each([
    "/v1/river/locate",
    "/v1/river/releases/0123456789abcdef/basins/42/samples/123/upstream",
    "/v1/river/releases/0123456789abcdef/basins/42/samples/123/downstream",
  ])("signs %s using the existing role and response bounds", async (path) => {
    const { transport, fetch } = setup([new Response('{"bounded":false}')]);
    await expect(
      transport({ path, query: {}, timeoutMs: 1000, maxResponseBytes: 8 }),
    ).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0];
    expect(new URL(String(url)).pathname).toBe(`/staging${path}`);
    expect(init?.headers).toMatchObject({
      authorization: expect.stringContaining("AWS4-HMAC-SHA256"),
    });
    expect(init).toMatchObject({ method: "GET", redirect: "error", cache: "no-store" });
  });

  it.each([
    "/v1/cso/outfalls",
    "/v1/measurements/x/backfills",
    "/v1/river/upstream",
    "/v1/river/releases/0123456789abcdef/basins/../samples/123/upstream",
    "/v1/river/releases/0123456789abcdef/basins/42/samples/123/upstream-outfalls",
  ])("refuses to sign %s", async (path) => {
    const { transport, fetch } = setup([]);
    await expect(transport({ path, query: {}, timeoutMs: 1000 })).rejects.toMatchObject({
      code: "INVALID_QUERY",
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
