import "server-only";
import { AssumeRoleWithWebIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { Hash } from "@smithy/hash-node";
import { SignatureV4 } from "@smithy/signature-v4";
import { getVercelOidcToken } from "@vercel/oidc";
import type { LiveConfig } from "./config";
import { RdpError } from "./errors";
import { RIVER_LOCATE_PATH, RIVER_SAMPLE_PATH } from "./river-tracer";
import { waitForRdp, withDeadlineAndRetry, type RdpTransport } from "./transport";
import { UPSTREAM_MEASUREMENTS_PATH } from "./upstream-measurements";

export type Credentials = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiration: Date;
};

export type LiveDependencies = {
  getToken: () => Promise<string>;
  assumeRole: (token: string, signal: AbortSignal) => Promise<Credentials>;
  fetch: typeof fetch;
  now: () => number;
  random: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
};

/** Credentials are refreshed when fewer than this many milliseconds remain. */
const REFRESH_MARGIN_MS = 60_000;
/** Budget for one shared OIDC → STS exchange, independent of any single request's deadline. */
const EXCHANGE_TIMEOUT_MS = 6_000;
const OBSERVATION_PATH =
  /^\/v1\/measurements(?:\/latest|\/[a-z0-9][a-z0-9-]{0,79}\/(?:health|observations))?$/;

function defaultAssumeRole(config: LiveConfig) {
  // Explicit regional endpoint, no SDK retries and short socket timeouts. No default credential chain is used.
  const sts = new STSClient({
    region: config.region,
    endpoint: `https://sts.${config.region}.amazonaws.com`,
    maxAttempts: 1,
    requestHandler: { connectionTimeout: 3000, requestTimeout: 5000, throwOnRequestTimeout: true },
  });
  return async (token: string, signal: AbortSignal): Promise<Credentials> => {
    const result = await sts.send(
      new AssumeRoleWithWebIdentityCommand({
        RoleArn: config.roleArn,
        RoleSessionName: `rdp-ui-${config.stage}`,
        DurationSeconds: 900,
        WebIdentityToken: token,
      }),
      { abortSignal: signal },
    );
    const value = result.Credentials;
    if (
      !value?.AccessKeyId ||
      !value.SecretAccessKey ||
      !value.SessionToken ||
      !(value.Expiration instanceof Date)
    ) {
      throw new Error("incomplete credentials");
    }
    return {
      accessKeyId: value.AccessKeyId,
      secretAccessKey: value.SecretAccessKey,
      sessionToken: value.SessionToken,
      expiration: value.Expiration,
    };
  };
}

/**
 * Vercel OIDC → STS AssumeRoleWithWebIdentity (RDP-UI's dedicated stage role) → SigV4 over exact GETs.
 * Credentials stay in this closure; nothing here is logged or returned to callers.
 */
export function createLiveTransport(
  config: LiveConfig,
  overrides: Partial<LiveDependencies> = {},
): RdpTransport {
  const deps: LiveDependencies = {
    getToken: () => getVercelOidcToken(),
    assumeRole: overrides.assumeRole ?? defaultAssumeRole(config),
    fetch: (...args) => fetch(...args),
    now: Date.now,
    random: Math.random,
    ...overrides,
  };
  const base = new URL(config.apiUrl);
  let cached: Credentials | undefined;
  let pending: Promise<Credentials> | undefined;

  async function credentials(signal: AbortSignal): Promise<Credentials> {
    if (cached && cached.expiration.getTime() - deps.now() > REFRESH_MARGIN_MS) return cached;
    // One in-flight exchange shared by concurrent requests. It runs on its own budget, so one caller's deadline
    // never fails the exchange for the others; each caller only stops waiting when its own deadline passes.
    pending ??= (async () => {
      // Yield first so `pending` is assigned before any synchronous throw reaches `finally`.
      await Promise.resolve();
      try {
        const token = await deps.getToken();
        const value = await deps.assumeRole(token, AbortSignal.timeout(EXCHANGE_TIMEOUT_MS));
        if (
          !Number.isFinite(value.expiration.getTime()) ||
          value.expiration.getTime() - deps.now() <= REFRESH_MARGIN_MS
        ) {
          throw new Error("credentials already expiring");
        }
        cached = value;
        return value;
      } finally {
        pending = undefined;
      }
    })();
    const exchange = pending;
    try {
      return await waitForRdp(() => exchange, signal);
    } catch (error) {
      if (signal.aborted || (error instanceof RdpError && error.code === "TIMEOUT")) {
        throw new RdpError("TIMEOUT");
      }
      throw new RdpError("AUTHENTICATION_FAILED");
    }
  }

  return async ({ path, query, timeoutMs, maxResponseBytes, signal }) => {
    if (
      !OBSERVATION_PATH.test(path) &&
      path !== RIVER_LOCATE_PATH &&
      path !== UPSTREAM_MEASUREMENTS_PATH &&
      !RIVER_SAMPLE_PATH.test(path)
    )
      throw new RdpError("INVALID_QUERY");
    const url = new URL(base.toString());
    url.pathname = `${base.pathname}${path}`;
    if (url.pathname !== `${base.pathname}${path}` || url.host !== base.host)
      throw new RdpError("INVALID_QUERY");
    url.search = new URLSearchParams(query).toString();
    return withDeadlineAndRetry(
      timeoutMs,
      async (signal) => {
        const signer = new SignatureV4({
          service: "execute-api",
          region: config.region,
          credentials: await credentials(signal),
          sha256: Hash.bind(null, "sha256"),
        });
        const signed = await signer.sign({
          method: "GET",
          protocol: url.protocol,
          hostname: url.hostname,
          path: url.pathname,
          query: Object.fromEntries(url.searchParams),
          headers: { host: url.host },
        });
        return deps.fetch(url.toString(), {
          method: "GET",
          headers: signed.headers,
          // Signed responses never enter Next's shared data cache; the adapter applies its own short TTLs.
          cache: "no-store",
          redirect: "error",
          signal,
        });
      },
      { now: deps.now, random: deps.random, sleep: deps.sleep, maxResponseBytes, signal },
    );
  };
}
