import "server-only";
import {
  epochMs,
  isMeasurementId,
  parseCatalogue,
  parseHealth,
  parseHistory,
  parseLatest,
  type Catalogue,
  type Health,
  type HistoryPage,
  type LatestBatch,
  type Measurement,
} from "./contract";
import { RdpError } from "./errors";
import {
  isRiverCoordinate,
  isRiverDirection,
  parseRiverLocation,
  parseRiverRoute,
  RIVER_LOCATE_PATH,
  riverSamplePath,
  type RiverDirection,
  type RiverGeometry,
  type RiverLocation,
  type RiverRoute,
} from "./river-tracer";
import type { RdpRequest, RdpTransport } from "./transport";

/** RDP's own bounds (READ-API.md). UI routes apply smaller defaults on top. */
export const RDP_LIMITS = Object.freeze({
  latestBatch: 20,
  historyMaxDays: 366,
  historyDefaultLimit: 2000,
  historyMaxLimit: 5000,
  cursorMaxLength: 7000,
});

/**
 * Cache lifetimes. Short enough that RDP's freshness verdict stays meaningful (fresh = within 30 minutes), and a
 * failed refresh is never answered from an expired entry: stale readings are not disguised as current.
 */
export const CACHE_TTL_MS = Object.freeze({
  catalogue: 5 * 60_000,
  latest: 60_000,
  health: 60_000,
  history: 60_000,
});
const TIMEOUT_MS = Object.freeze({ short: 8_000, history: 20_000 });

export type HistoryQuery = {
  /** Inclusive; full ISO timestamp with `Z` or numeric offset. */
  from: string;
  /** Exclusive. */
  to: string;
  limit?: number;
  cursor?: string;
  /** Period totals only. */
  knownAt?: string;
};

export type RdpClient = {
  mode: "fixture" | "live";
  listMeasurements(): Promise<Catalogue>;
  getMeasurement(id: string): Promise<Measurement>;
  getLatest(ids: readonly string[]): Promise<LatestBatch>;
  getHealth(id: string): Promise<Health>;
  getHistory(id: string, query: HistoryQuery): Promise<HistoryPage>;
  locateRiver(lon: string, lat: string): Promise<RiverLocation>;
  getRiverRoute(
    location: RiverLocation,
    direction: RiverDirection,
    geometry?: RiverGeometry,
  ): Promise<RiverRoute>;
};

type Entry = { expires: number; value: Promise<unknown> };

/** Small TTL cache with in-flight de-duplication. Rejections are evicted immediately and never served again. */
export function createTtlCache(now: () => number, maxEntries = 256) {
  const entries = new Map<string, Entry>();
  return Object.assign(cached, {
    clear: () => entries.clear(),
    evict: (key: string) => entries.delete(key),
  });
  function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const hit = entries.get(key);
    if (hit && hit.expires > now()) return hit.value as Promise<T>;
    entries.delete(key);
    const value = load();
    const entry: Entry = { expires: now() + ttlMs, value };
    entries.set(key, entry);
    value.catch(() => {
      if (entries.get(key) === entry) entries.delete(key);
    });
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value as string);
    return value;
  }
}

export type LimiterOptions = {
  maxConcurrent: number;
  maxQueued: number;
  /** Longest a call may wait for a slot or rate token before failing fast with THROTTLED. */
  maxWaitMs: number;
  ratePerSecond: number;
  burst: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

/**
 * Per-instance upstream budget: a concurrency cap plus a token bucket well under the RDP stage throttle (10 rps,
 * burst 20), which is shared with isHPPOpen. Waiting is bounded; excess load is shed locally, never sent upstream.
 * Across instances, a Vercel Firewall rate limit on `/api/*` is the outer bound (see ARCHITECTURE.md).
 */
export function createLimiter(options: LimiterOptions) {
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let active = 0;
  let tokens = options.burst;
  let refilled = now();
  const queue: Array<{ resolve: () => void; timer: ReturnType<typeof setTimeout> }> = [];

  function waitForToken(): number {
    if (options.ratePerSecond === Number.POSITIVE_INFINITY) return 0;
    const at = now();
    tokens = Math.min(options.burst, tokens + ((at - refilled) / 1000) * options.ratePerSecond);
    refilled = at;
    if (tokens >= 1) {
      tokens -= 1;
      return 0;
    }
    return Math.ceil(((1 - tokens) / options.ratePerSecond) * 1000);
  }

  function release() {
    const next = queue.shift();
    if (next) {
      // Hand the slot straight to the next waiter so no new caller can slip past the cap.
      clearTimeout(next.timer);
      next.resolve();
    } else {
      active--;
    }
  }

  return async function limit<T>(run: () => Promise<T>): Promise<T> {
    const deadline = now() + options.maxWaitMs;
    if (active >= options.maxConcurrent) {
      if (queue.length >= options.maxQueued) throw new RdpError("THROTTLED");
      await new Promise<void>((resolve, reject) => {
        const waiter = {
          resolve,
          timer: setTimeout(() => {
            queue.splice(queue.indexOf(waiter), 1);
            reject(new RdpError("THROTTLED"));
          }, options.maxWaitMs),
        };
        queue.push(waiter);
      });
    } else {
      active++;
    }
    try {
      let waited = 0;
      for (let wait = waitForToken(); wait > 0; wait = waitForToken()) {
        waited += wait;
        if (now() + wait > deadline || waited > options.maxWaitMs) throw new RdpError("THROTTLED");
        await sleep(wait);
      }
      return await run();
    } finally {
      release();
    }
  };
}

const OFFSET_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?(?:Z|[+-]\d{2}:\d{2})$/;

/** Accepts a full ISO timestamp with an explicit offset and returns it as UTC `Z`, or throws INVALID_QUERY. */
export function normaliseTimestamp(value: unknown): string {
  if (typeof value !== "string" || value.length > 40 || !OFFSET_TIMESTAMP.test(value)) {
    throw new RdpError("INVALID_QUERY");
  }
  const ms = Date.parse(value.replace(/(\.\d{3})\d+(?=Z|[+-])/, "$1"));
  if (!Number.isFinite(ms)) throw new RdpError("INVALID_QUERY");
  return new Date(ms).toISOString();
}

export type ClientOptions = {
  mode: "fixture" | "live";
  transport: RdpTransport;
  now?: () => number;
  maxConcurrent?: number;
  /** Per-instance upstream request budget (default 3/s, burst 6). */
  ratePerSecond?: number;
  log?: (event: { route: string; code: string; status: number }) => void;
};

export function createRdpClient(options: ClientOptions): RdpClient {
  const now = options.now ?? Date.now;
  // The catalogue has its own slot so request-derived keys can never evict it.
  const catalogueCache = createTtlCache(now, 1);
  const cached = createTtlCache(now);
  // Route bodies can be much larger than observation pages. Keep their own small cache.
  const riverRoutes = createTtlCache(now, 8);
  const limit = createLimiter({
    maxConcurrent: options.maxConcurrent ?? 4,
    maxQueued: 16,
    maxWaitMs: 2_000,
    ratePerSecond: options.ratePerSecond ?? 3,
    burst: 6,
    now,
  });
  const log =
    options.log ??
    ((event) => {
      // Fixed route templates and codes only: never the URL, host, query, cursor, token or body.
      console.warn(JSON.stringify({ event: "rdp_read_failed", ...event }));
    });

  async function call<T>(
    route: string,
    request: RdpRequest,
    parse: (body: unknown) => T,
  ): Promise<T> {
    try {
      return parse(await limit(() => options.transport(request)));
    } catch (error) {
      const failure = error instanceof RdpError ? error : new RdpError("UPSTREAM_ERROR");
      log({ route, code: failure.code, status: failure.status });
      // RDP unpublished something our cached catalogue still lists: re-read the catalogue next time.
      if (failure.code === "MEASUREMENT_NOT_FOUND") catalogueCache.clear();
      throw failure;
    }
  }

  function listMeasurements(): Promise<Catalogue> {
    return catalogueCache("catalogue", CACHE_TTL_MS.catalogue, () =>
      call(
        "/v1/measurements",
        { path: "/v1/measurements", query: {}, timeoutMs: TIMEOUT_MS.short },
        parseCatalogue,
      ),
    );
  }

  async function locateRiver(lon: string, lat: string): Promise<RiverLocation> {
    if (!isRiverCoordinate(lon, 180) || !isRiverCoordinate(lat, 90))
      throw new RdpError("INVALID_QUERY");
    return call(
      RIVER_LOCATE_PATH,
      {
        path: RIVER_LOCATE_PATH,
        query: { lon, lat },
        timeoutMs: TIMEOUT_MS.short,
        maxResponseBytes: 128 * 1024,
      },
      parseRiverLocation,
    );
  }

  async function getRiverRoute(
    location: RiverLocation,
    direction: RiverDirection,
    geometry: RiverGeometry = "reaches",
  ): Promise<RiverRoute> {
    if (
      !location.sample ||
      location.status !== "Matched" ||
      !isRiverDirection(direction) ||
      (geometry !== "reaches" && geometry !== "none")
    )
      throw new RdpError("INVALID_QUERY");
    const path = riverSamplePath(
      location.token,
      location.sample.basinId,
      location.sample.sampleId,
      direction,
    );
    const result = await riverRoutes(
      `${location.release.version}:${path}:${geometry}`,
      60 * 60_000,
      () =>
        call(
          "/v1/river/releases/{release}/basins/{basin}/samples/{sample}/{direction}",
          { path, query: { geometry }, timeoutMs: 15_000 },
          (body) => parseRiverRoute(body, location, direction, geometry),
        ),
    );
    if (
      result.sample.position[0] !== location.sample.position[0] ||
      result.sample.position[1] !== location.sample.position[1]
    )
      throw new RdpError("RESPONSE_CONTRACT_ERROR");
    return result;
  }

  /** IDs are resolved against RDP's published catalogue before any per-measurement request. */
  async function getMeasurement(id: string): Promise<Measurement> {
    if (!isMeasurementId(id)) throw new RdpError("INVALID_QUERY");
    const measure = (await listMeasurements()).measurements.find(
      (item) => item.measurementId === id,
    );
    if (!measure) throw new RdpError("MEASUREMENT_NOT_FOUND", 404);
    return measure;
  }

  async function getLatest(ids: readonly string[]): Promise<LatestBatch> {
    if (
      !Array.isArray(ids) ||
      ids.length < 1 ||
      ids.length > RDP_LIMITS.latestBatch ||
      new Set(ids).size !== ids.length ||
      !ids.every(isMeasurementId)
    ) {
      throw new RdpError("INVALID_QUERY");
    }
    const measures = await Promise.all(ids.map(getMeasurement));
    return cached(`latest:${ids.join(",")}`, CACHE_TTL_MS.latest, () =>
      call(
        "/v1/measurements/latest",
        {
          path: "/v1/measurements/latest",
          query: { ids: ids.join(",") },
          timeoutMs: TIMEOUT_MS.short,
        },
        (body) => parseLatest(body, measures),
      ),
    );
  }

  async function getHealth(id: string): Promise<Health> {
    const measure = await getMeasurement(id);
    return cached(`health:${id}`, CACHE_TTL_MS.health, () =>
      call(
        "/v1/measurements/{id}/health",
        { path: `/v1/measurements/${id}/health`, query: {}, timeoutMs: TIMEOUT_MS.short },
        (body) => parseHealth(body, measure),
      ),
    );
  }

  async function getHistory(id: string, query: HistoryQuery): Promise<HistoryPage> {
    const from = normaliseTimestamp(query.from);
    const to = normaliseTimestamp(query.to);
    const span = epochMs(to) - epochMs(from);
    const pageLimit = query.limit ?? RDP_LIMITS.historyDefaultLimit;
    if (
      !(span > 0) ||
      span > RDP_LIMITS.historyMaxDays * 86_400_000 ||
      !Number.isInteger(pageLimit) ||
      pageLimit < 1 ||
      pageLimit > RDP_LIMITS.historyMaxLimit ||
      (query.cursor !== undefined &&
        (typeof query.cursor !== "string" || !/^[A-Za-z0-9_-]{1,7000}$/.test(query.cursor)))
    ) {
      throw new RdpError("INVALID_QUERY");
    }
    const measure = await getMeasurement(id);
    const knownAt = query.knownAt === undefined ? undefined : normaliseTimestamp(query.knownAt);
    if (knownAt !== undefined && measure.kind !== "period_total")
      throw new RdpError("INVALID_QUERY");
    const wire: Record<string, string> = { from, to, limit: String(pageLimit) };
    if (query.cursor !== undefined) wire.cursor = query.cursor;
    if (knownAt !== undefined) wire.knownAt = knownAt;
    const load = () =>
      call(
        "/v1/measurements/{id}/observations",
        { path: `/v1/measurements/${id}/observations`, query: wire, timeoutMs: TIMEOUT_MS.history },
        (body) => {
          const page = parseHistory(body, measure);
          // RDP echoes the normalised window; a mismatch means the page is not for this query.
          if (epochMs(page.from) !== epochMs(from) || epochMs(page.to) !== epochMs(to)) {
            throw new RdpError("RESPONSE_CONTRACT_ERROR");
          }
          return page;
        },
      );
    // Cursor continuations are single-use in practice and bound to RDP's 30-minute expiry; only first pages cache.
    const firstPageKey = `history:${id}:${from}:${to}:${pageLimit}:${knownAt ?? ""}`;
    if (query.cursor === undefined) return cached(firstPageKey, CACHE_TTL_MS.history, load);
    try {
      return await load();
    } catch (error) {
      // A restart must fetch a new first page (and cursor), not the cached one whose continuation just failed.
      if (
        error instanceof RdpError &&
        (error.code === "CURSOR_EXPIRED" || error.code === "CURSOR_STALE")
      ) {
        cached.evict(firstPageKey);
      }
      throw error;
    }
  }

  return Object.freeze({
    mode: options.mode,
    listMeasurements,
    getMeasurement,
    getLatest,
    getHealth,
    getHistory,
    locateRiver,
    getRiverRoute,
  });
}
