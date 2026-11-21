import "server-only";
import { errorFromResponse, isRetryable, RdpError } from "./errors";

/** One RDP read: an exact GET path (under the stage URL) and its query. */
export type RdpRequest = {
  path: string;
  query: Readonly<Record<string, string>>;
  /** Whole-call budget including credentials and the single retry. */
  timeoutMs: number;
  maxResponseBytes?: number;
};

/** Resolves a 2xx JSON body or throws an `RdpError`. Fixture and live transports share this shape. */
export type RdpTransport = (request: RdpRequest) => Promise<unknown>;

/** RDP caps a serialized body at 4 MiB; anything larger is refused rather than buffered. */
export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024 + 64 * 1024;

export async function readBoundedJson(
  response: Response,
  maxBytes = MAX_RESPONSE_BYTES,
): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new RdpError("RESPONSE_TOO_LARGE", response.status);
  }
  if (!response.body) return JSON.parse("null");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new RdpError("RESPONSE_TOO_LARGE", response.status);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

export type RetryPolicy = {
  /** Upper bound honoured from `Retry-After` (RDP sends 2 s on 503/504). */
  maxRetryAfterMs: number;
  /** Minimum budget that must remain after the backoff for a retry to be attempted. */
  minRetryBudgetMs: number;
};

export const DEFAULT_RETRY: RetryPolicy = { maxRetryAfterMs: 2000, minRetryBudgetMs: 1500 };

export type AttemptResult = { response: Response };

/**
 * Shared bounded execution: one deadline for the whole call, at most one retry on throttling or a transient
 * upstream failure, jittered backoff that honours a capped Retry-After, and fixed error codes only.
 */
export async function withDeadlineAndRetry(
  timeoutMs: number,
  attempt: (signal: AbortSignal) => Promise<Response>,
  options: {
    retry?: RetryPolicy;
    sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
    random?: () => number;
    now?: () => number;
    maxResponseBytes?: number;
  } = {},
): Promise<unknown> {
  const retry = options.retry ?? DEFAULT_RETRY;
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? abortableSleep;
  const controller = new AbortController();
  const deadline = now() + timeoutMs;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    for (let attemptNumber = 0; ; attemptNumber++) {
      let failure: RdpError;
      let retryAfterMs = 0;
      try {
        const response = await attempt(controller.signal);
        if (response.ok) {
          try {
            return await readBoundedJson(response, options.maxResponseBytes);
          } catch (error) {
            throw error instanceof RdpError
              ? error
              : new RdpError("RESPONSE_CONTRACT_ERROR", response.status);
          }
        }
        let body: unknown = null;
        try {
          body = await readBoundedJson(response, 64 * 1024);
        } catch {
          // Error bodies are optional and AWS-defined at the gateway; the status alone is enough.
        }
        if (controller.signal.aborted) throw new RdpError("TIMEOUT");
        failure = errorFromResponse(response.status, body);
        const header = Number(response.headers.get("retry-after"));
        retryAfterMs =
          Number.isFinite(header) && header > 0
            ? Math.min(retry.maxRetryAfterMs, header * 1000)
            : 0;
      } catch (error) {
        if (controller.signal.aborted) throw new RdpError("TIMEOUT");
        failure = error instanceof RdpError ? error : new RdpError("NETWORK_ERROR");
      }
      const backoff = Math.max(retryAfterMs, 200 + Math.floor(random() * 300));
      if (
        attemptNumber >= 1 ||
        !isRetryable(failure) ||
        deadline - now() - backoff < retry.minRetryBudgetMs
      ) {
        throw failure;
      }
      await sleep(backoff, controller.signal);
    }
  } catch (error) {
    if (controller.signal.aborted && !(error instanceof RdpError && error.code !== "TIMEOUT")) {
      throw new RdpError("TIMEOUT");
    }
    throw error instanceof RdpError ? error : new RdpError("NETWORK_ERROR");
  } finally {
    clearTimeout(timer);
  }
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new RdpError("TIMEOUT"));
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new RdpError("TIMEOUT"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
