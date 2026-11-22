/**
 * Fixed RDP adapter failure codes. Only a code and an HTTP status cross this boundary: never an SDK error,
 * upstream body, URL, header or credential.
 */
export type RdpErrorCode =
  | "CONFIGURATION_ERROR"
  | "INVALID_QUERY"
  | "MEASUREMENT_NOT_FOUND"
  | "CATCHMENT_DISCOVERY_DISABLED"
  | "RELEASE_NOT_AVAILABLE"
  | "INVALID_CURSOR"
  | "CURSOR_EXPIRED"
  | "CURSOR_STALE"
  | "AUTHENTICATION_FAILED"
  | "AUTHORIZATION_FAILED"
  | "THROTTLED"
  | "STORAGE_UNAVAILABLE"
  | "ARCHIVE_INTEGRITY"
  | "QUERY_TIMEOUT"
  | "TIMEOUT"
  | "NETWORK_ERROR"
  | "UPSTREAM_ERROR"
  | "RESPONSE_CONTRACT_ERROR"
  | "RESPONSE_TOO_LARGE";

export class RdpError extends Error {
  readonly code: RdpErrorCode;
  readonly status: number;

  constructor(code: RdpErrorCode, status = 0) {
    super(`RDP ${code}`);
    this.name = "RdpError";
    this.code = code;
    this.status = status;
  }
}

/** Upstream codes we recognise from RDP's `{error:{code}}` envelope; anything else is UPSTREAM_ERROR. */
const UPSTREAM_CODES: ReadonlyMap<string, RdpErrorCode> = new Map([
  ["VALIDATION_ERROR", "INVALID_QUERY"],
  ["MEASUREMENT_NOT_FOUND", "MEASUREMENT_NOT_FOUND"],
  // RDP's NOT_FOUND is an unknown *route* (wrong base URL or stage), never a missing measurement.
  ["NOT_FOUND", "CONFIGURATION_ERROR"],
  ["INVALID_CURSOR", "INVALID_CURSOR"],
  ["CURSOR_EXPIRED", "CURSOR_EXPIRED"],
  ["CURSOR_STALE", "CURSOR_STALE"],
  ["STORAGE_UNAVAILABLE", "STORAGE_UNAVAILABLE"],
  ["ARCHIVE_INTEGRITY", "ARCHIVE_INTEGRITY"],
  ["QUERY_TIMEOUT", "QUERY_TIMEOUT"],
  ["FORBIDDEN", "AUTHORIZATION_FAILED"],
]);

export function errorFromResponse(status: number, body: unknown): RdpError {
  // Gateway 401/403/429 envelopes are AWS-defined and must never be read as "no observations".
  if (status === 401 || status === 403) return new RdpError("AUTHORIZATION_FAILED", status);
  if (status === 429) return new RdpError("THROTTLED", status);
  const code =
    typeof body === "object" && body !== null && "error" in body
      ? (body as { error?: { code?: unknown } }).error?.code
      : undefined;
  if (status === 410 && code === "RELEASE_NOT_AVAILABLE")
    return new RdpError("RELEASE_NOT_AVAILABLE", status);
  return new RdpError(
    (typeof code === "string" && UPSTREAM_CODES.get(code)) || "UPSTREAM_ERROR",
    status,
  );
}

/**
 * Transient failures that a single bounded retry may resolve. A 429 is not retried: the stage throttle is shared,
 * and retrying would add load exactly when it is saturated.
 */
export function isRetryable(error: RdpError): boolean {
  return (
    error.code === "STORAGE_UNAVAILABLE" ||
    error.code === "QUERY_TIMEOUT" ||
    error.code === "NETWORK_ERROR" ||
    (error.code === "UPSTREAM_ERROR" && error.status >= 500)
  );
}
