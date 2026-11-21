# Architecture

## Decision (approved 19 November 2026)

A **separate Next.js App Router + TypeScript + Tailwind** application hosted on Vercel. This repository owns UI presentation, navigation, user interaction and an optional **Next.js application API**, but not canonical measurements, ingestion or river-network business rules.

RDP remains the backend of record. Reference its [read API](https://github.com/tclare95/river-data-platform/blob/main/docs/READ-API.md), [OpenAPI](https://github.com/tclare95/river-data-platform/blob/main/docs/openapi.json) and [River Explorer OpenSpec](https://github.com/tclare95/river-data-platform/tree/main/openspec/changes/river-explorer-and-analysis), rather than duplicating contracts.

## Request boundary

```text
Browser
  ├── Next.js pages and interactive components
  └── optional /api/* application endpoints (bounded, UI-specific)
        |
        v
Next.js server-side typed RDP adapter
        | Vercel OIDC -> AWS STS AssumeRoleWithWebIdentity
        | Signature V4 over exact GET requests
        v
Existing RDP AWS_IAM read service (published catalogue/latest/health/history)
```

Server Components can fetch RDP data directly for HTML rendering; add Route Handlers for justified client-side interactions. Do not build a generic forwarding proxy or require RDP's future external developer API to run this website.

**Server boundary:** no AWS access keys, role credentials, RDP private hostnames or unsanitised upstream failures in browser bundles, HTML, logs or public configuration. Read only permitted published/redistributable datasets. App routes must validate IDs/window/limits and return only minimal approved data.

## Layout as the implementation grows

- `src/app/`: pages, route handlers, loading/error boundaries
- `src/components/`: accessible shared presentation, later `charts/` and `maps/`
- `src/lib/rdp/`: server-only signed transport and typed contract adapter (see below)
- `tests/`: focused contract/state/UI tests
- `docs/`: concise product/architecture decisions

Use Server Components by default; isolate interactive components. No generic repository/service abstraction until actual duplication justifies it.

Recharts draws the history chart. MapLibre GL JS loads in the browser when a visitor opens the station map.

## RDP adapter

`src/lib/rdp/` is the only code that talks to RDP. `server.ts` (`import "server-only"`) exposes one process-wide `RdpClient` with `listMeasurements`, `getLatest`, `getHealth` and `getHistory`.

- **Contract** (`contract.ts`): typed parsers for the four observation routes. Each parser validates the fields the UI uses and copies only those, so unknown upstream fields never pass through. Instantaneous readings and rainfall period totals are separate `kind`s: a period total has `totalMm`, a label and its convention, never `value`/`observedAt`. Availability, freshness and coverage are RDP's verdicts, passed through unchanged; `unknown` coverage alongside rows is normal.
- **Validation** (`client.ts`): IDs must be in RDP's published catalogue before any per-measurement request; latest batches are 1–20 unique IDs; history windows need explicit offsets, are normalised to UTC, and are at most 366 days and 5,000 rows; `knownAt` is accepted only for period totals.
- **Caching**: in-process TTLs (catalogue 5 min in its own slot, latest/health/first history pages 60 s) with in-flight de-duplication. Failures are never cached, and an expired entry is never served when a refresh fails: the page shows _unavailable_ instead of an old reading. Signed fetches use `cache: "no-store"`.
- **Transport** (`live.ts`, `transport.ts`): Vercel OIDC token → STS `AssumeRoleWithWebIdentity` (900 s, cached until 60 s before expiry, one shared exchange on its own 6 s budget) → SigV4 over exact GETs. One deadline per call (8 s, history 20 s), at most one retry on 503/504/network errors with jitter and `Retry-After` capped at 2 s (never on 429), and a 4 MiB body cap.
- **Upstream budget**: the RDP stage throttle (10 rps, burst 20) is shared with isHPPOpen and the predictor. Each instance allows at most 4 concurrent upstream reads and 3 requests/s (burst 6), waits at most 2 s for either, and otherwise fails fast as _unavailable_ without calling RDP. Across instances, add a Vercel Firewall rate-limit rule on `/api/measurements/*` (for example 60 requests/min per IP). Only fixed error codes leave the adapter; logs carry route templates and codes, never URLs, cursors, tokens or bodies.
- **Modes** (`config.ts`): `fixture` (synthetic, labelled on the page, refused on Vercel Production; also the default for a non-Vercel `next start`) or `live` (Vercel Preview → staging, Production → production, and only RDP-UI's own role and the matching stage URL). Every module holding config, credentials or transport imports `server-only`.
- **Public display** (`public.ts`): only providers whose licence allows public display with attribution (currently the Environment Agency, OGL v3.0) are shown, and only minimal projections leave the server. The three provenance times stay distinct and may be shown: when a value was **observed** (source time), when RDP **stored** it (`ingestedAt`, health `lastPersistedAt`) and when RDP **answered** (`retrievedAt`, history `requestAsOf`), plus health `lastAttemptAt`/`sourceState`. Source references, provider measure IDs, error codes, lags, request IDs and upstream errors never leave the server.

`/api/measurements/{id}/history` returns one bounded page of a fixed 2,000 rows with the adapter's per-call deadline. Windows use whole UTC hours, span at most 31 days and end at or before now. The default is the 7 days ending at the latest whole UTC hour. Continue with `nextCursor` and the original explicit window. The route returns fixed error codes (`INVALID_REQUEST`, `INVALID_CURSOR`, `RESTART_REQUIRED`, `NOT_FOUND`, `UNAVAILABLE`) and caches successful responses with `s-maxage=60`. Server Components read through the adapter directly.

## Measurement history

`src/lib/history/` owns the detail page's history read; nothing in it derives freshness or coverage.

- **Ranges** (`range.ts`): 7 and 30 days (`?range=7d|30d`, anything else is 7 days), ending at the latest whole UTC hour, inclusive `from` and exclusive `to`. Detail, comparison and API requests for the same measurement and window share a cached first page.
- **Loader** (`load.ts`, server-only): follows RDP's continuation cursor with the identical window and the 2,000-row limit until `nextCursor` is null. The result is **all or nothing**: any failed page returns `unavailable` (never a shorter history presented as whole); more than four pages returns `too_large` rather than truncating; `CURSOR_EXPIRED`/`CURSOR_STALE` restarts once from a fresh first page (the client evicts the cached first page so the restart gets a new cursor). Pages must carry identical coverage and strictly later rows. The loader assembles rainfall by provider label and keeps RDP's interval boundaries, conventions and eligibility. RDP supplies a rainfall window summary only for a single-page response. Across continuation pages, the loader retains `windowUnavailable: "paginated"` and leaves the summary absent. Rainfall detail and comparison reuse the assembled periods. Successful assembled windows are cached per client for 60 s (in-flight loads shared, failures never cached), so repeated 30-day views do not re-read continuation pages from the shared throttle.
- **History deadline**: detail and comparison use one 20-second budget per assembled window, including any cursor restart. Expiry shows the existing unavailable state and stops pagination. An in-flight page can finish under its existing adapter deadline, which preserves shared first-page reads.
- **Series** (`series.ts`, pure): readings are plotted at their own source times on a linear time axis. Consecutive readings are joined only when they are at most 1.5 expected intervals apart and no known coverage gap lies between them; otherwise a `null` point breaks the line. Nothing is interpolated, resampled, smoothed or clipped, the y axis never forces zero and negative values are kept. A reading with no joined neighbour is drawn as a dot. The table inserts a "No readings for …" row at each break.
- **Coverage**: RDP's verdict is shown in words. `unknown` (today's honest default) says the record is not verified complete; `partial` lists known gaps by reason, which are also shaded on the chart; only `complete` says complete.
- **Page** (`src/components/history/`): `MeasurementHistory` streams under its own `Suspense` (keyed by range) via a never-rejecting promise and `use`, so the latest reading is never held back. `HistoryChart` and `ObservationTable` are the only client components; the table (newest first, 100 rows per page, values exactly as returned, observed/stored times and revision) sits in a `<details>` disclosure below the chart.
- **Upstream cost**: a detail view makes at most latest + health + one history page per 2,000 readings (two for 30 days at 15 minutes), each first read cached for 60 s.

## Comparison

`/compare?a=&b=&c=&d=&range=` compares two to four published measurements in selection order. Existing two-slot URLs still work. A single GET picker adds one measurement at a time and removal links preserve the range.

- **Time** — One Recharts canvas over the same bounded history query for every series. Level and flow use their observed timestamps and the detail view’s line-break rules. Rainfall bars use verified start/end bounds, including a boundary that straddles the label query window. Unverified timing is marked at the provider label. Ineligible intervals get a cross, reported zero gets a baseline mark, and absent intervals leave gaps.
- **Scales** — The legend names each series, its unit or rainfall period, and its axis. Compatible magnitudes can share a scale. Different parameters, units, rainfall periods or incompatible level datums use independent axes. Station-local levels from different stations and levels on unknown datums each keep their own scale. The picker disables additions that would require a third raw-value axis, and incompatible URLs show an explanation before any history read.
- **Accessible data** — The disclosure table lists the union of exact observation times and rainfall labels, newest first, with original values, rainfall timing and eligibility, and any corrected revisions. The chart cursor uses those same source rows.
- **Availability and upstream cost** — Each series uses the existing independent, all-or-nothing history loader. A failed or empty series has its own state and the available series stay visible. Each view starts at most four history loads using the same cache, limits on pagination and restarts, and deadlines as detail history. Comparison selection and range links avoid speculative history loads.

## Discovery and detail pages

- **Home** (`src/app/(home)/`): the public catalogue with RDP's latest state, grouped by RDP `stationId`. Search and the type filter are pure functions over the already-loaded catalogue (`src/lib/discovery.ts`) in one client component; the view is mirrored in `?q=&type=` with `history.replaceState` and also works as a plain GET form without JavaScript. Search covers station name, verified watercourse, parameter, provider, unit and ID. The type filter appears only when more than one type is published.
- **Station map**: the disclosure uses those same filtered station groups and plots verified catalogue coordinates, one marker per station ID. The selected station shows the matching measurement links, provider position resolution and public station record where available. The browser requests the attributed [OpenFreeMap Positron basemap](https://openfreemap.org/quick_start/) directly. Basemap errors leave the station markers usable, and the list works independently of WebGL and tiles.
- **Detail** (`/measurements/{measurementId}`): RDP's measurement ID is the stable URL. `layout.tsx` resolves the ID against the cached catalogue _before_ any streaming, so unknown, malformed and non-displayable IDs return a real 404 (indistinguishable from each other); the page then reads latest under its own `loading.tsx`. The home route group owns the only other loading boundary, because a root `loading.tsx` would stream every route and turn `notFound()` into a 200.
- Provider quality is shown only when it is a plain word (EA gauge quality arrives as raw JSON text); structured values are omitted, not printed.

## Deployment configuration

Each step is a separately approved operator action ([RDP PRODUCTION-READ-API.md#rdp-ui-caller](https://github.com/tclare95/river-data-platform/blob/main/docs/PRODUCTION-READ-API.md#rdp-ui-caller)):

1. Release the RDP read handler that admits `river-data-platform-<stage>-ui-vercel-<environment>` on the four observation routes.
2. Using operator credentials, render (`read_api_iam.py --ui`) and create that stage's caller stack `river-data-platform-<stage>-read-ui-caller`. It must be in the same Vercel team as the existing OIDC provider.
3. In this Vercel project, enable OIDC (team issuer mode) and set server-only variables per environment: `RDP_DATA_MODE=live`, `RDP_AWS_REGION=eu-west-1`, `RDP_READ_API_URL=https://<api-id>.execute-api.eu-west-1.amazonaws.com/<stage>`, `RDP_ROLE_ARN=<UiRoleArn output>`. Preview binds to staging and Production to production.
4. Add the Vercel Firewall rate-limit rule for `/api/measurements/*`, `/measurements/*` and `/compare` (each page view can make upstream reads).

Status (20 November 2026): steps 1–3 are done for both stages, and signed reads are verified on Preview (staging) and Production (production). Step 4 is not yet configured. See [MVP acceptance](MVP.md). 5. Verify signed reads on a Preview deployment before Production. Until steps 1–3 are done, live mode shows _unavailable_ (403), never sample data.

## Backend dependency

Catalogue geography follows [RDP #129's consumer handoff](https://github.com/tclare95/river-data-platform/blob/3c49572/docs/CATALOGUE-GEOGRAPHY.md) (observation read API OpenAPI 1.1.0). The adapter accepts older responses and omits malformed or unrecognised geography. The public projection includes verified river names, verified coordinates with their provider resolution, and allowlisted EA station evidence links. Retrieval time stays in the adapter.
