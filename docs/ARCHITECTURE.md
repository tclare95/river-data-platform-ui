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

Recharts draws the history chart. MapLibre GL JS loads in the browser for the Explorer river map.

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

## River Tracer

`GET /api/river/trace?lon=&lat=&direction=upstream|downstream` accepts WGS84 decimal degrees. It performs one
locate and, when RDP returns a canonical sample, one release-scoped trace. The public response contains the match
status, release ID and digest, snap offset and approved snapped position, route completeness and direction, source
attribution, and a GeoJSON MultiLineString of reaches where publication is enabled. Attribution comes from the trace
response and is absent when locate yields no sample. Ambiguous, unmatched and out-of-coverage locations remain
successful locate outcomes. A retired release returns 410 and the caller can repeat the coordinate query to locate
against the active release. Missing routes or samples return 404, oversized results 413, deadlines 504, and upstream
denials and malformed responses 503.

RDP-UI publication approval covers the pinned `orn-v2-gb` release
(`838c7ed826b26ee16a11ba2b5be9dc4d286bca8cc0159c6f33d540bf04c0155c`). Other releases return trace metadata and
attribution with geometry withheld. The publisher FAQ says OGL v3.0 and the homepage also refers to ODbL and DbCL
below its reference to the points layer. RDP's release evidence still records the terms as unresolved. Maintainer
confirmation for the exact March 2025 v2 GeoPackage reach and sample layers would reconcile the notices and confirm
the required attribution and any database reuse obligations. See the [publisher FAQ](https://openrivers.net/faqs/),
[publisher homepage](https://openrivers.net/) and
[RDP release evidence](https://github.com/tclare95/river-data-platform/blob/main/docs/RIVER-TRACER.md).

Upstream traces preserve the catchment status (`published`, `unavailable` or `not-loaded`), source network
release when recognised, area in km² and `pourPointOffsetM`. The area is from the full-resolution source and
the offset is the distance downstream to the catchment's pour point. The catchment geometry is a GeoJSON
Polygon or MultiPolygon for the pinned release and the March 2025 ORN Catchments layer, which the publisher
licenses separately under OGL v3.0 with attribution. Missing or invalid catchment geometry leaves the reach
trace available. The polygon feature ID must match the trace metadata. The public response includes that ID
with the approved polygon and excludes other source feature properties, sample identifiers and upstream links. See the [publisher catchment report](https://openrivers.net/download/ORN%20Catchment%20Generation%20Document%20%28version%202%29.pdf).

Tracer shares the observation adapter's limiter, OIDC exchange and signed transport. Locate is capped at 128 KiB
and 8 seconds. Release-scoped traces have a 15-second budget and the signed transport's body cap. The private
in-process cache holds up to eight validated release/sample/direction/geometry results for one hour, with failed
reads evicted. Coordinate queries and public responses are uncached. The public JSON cap is 4 MiB. Include the
tracer path in the Vercel Firewall rate-limit rule before enabling live traffic.

Selecting a map point, the map centre or a verified station position starts an upstream trace. Subsequent
direction changes apply to that point. Station markers still open station details. One MapLibre source displays the selected point, any published
snapped sample, independently toggled upstream and downstream reaches, and a toggleable catchment. Directions are
loaded on demand for the current point and only combined within the same release. Changing the trace point or
direction cancels the previous browser request. A zero-offset pour point shares the snapped sample's coordinates.
For a downstream offset, the map describes where the published sample lies along the river because the public
response supplies the distance only. The catchment is modelled drainage and leaves the station comparison untouched.

Live signed access is awaiting verification. The stage needs the River Lambda release that admits the dedicated
UI role and that role's `--ui --river` caller policy applied before a signed smoke from the corresponding Vercel
environment. See the [RDP rollout instructions](https://github.com/tclare95/river-data-platform/blob/main/docs/PRODUCTION-READ-API.md#rdp-ui-caller).

### Catchment measurement discovery

A published catchment boundary triggers release-pinned measurement discovery automatically. Its measurement
list and station highlights are independent of catalogue search filters. Measurement links open the existing
detail page. Comparison actions use the shared selection and compatibility rules.

`GET /api/river/upstream-measurements?lon=&lat=&release=` takes one WGS84 point and an optional
16-character lowercase hex token. Pass the first 16 characters of the displayed River Tracer release
digest to pin discovery to that release. Requests and responses use no-store. Cancel the fetch when the
point or release changes and ignore any result from the previous selection. Display results only when their
release and catchment ID match the displayed polygon. A mismatch offers a refresh of the selected point.

- `data.status` is `available`, `location_not_matched` or `catchment_unavailable`. Keep station browsing
  available in all three cases. An available result can have zero publicly displayable measurements.
- Available results carry the catchment ID (scoped to the release), area and the along-river pour-point
  offset including the canonical snap. A downstream pour point can include river below the selected point.
  Station groups contain `geographicRelationship: "within_catchment"` and approved measurements with
  canonical IDs suitable for detail and comparison. Level and flow have `networkRelationship: "not_assessed"`
  and rainfall has `"not_applicable"`. `networkCoverage.completeness` describes the tracer's upstream
  trace from its canonical sample.
- `meta.complete` and `meta.counts` describe RDP's stage-wide published rainfall, level and flow station
  scope. `unknown`, `ambiguous` and `nearBoundary` stations are excluded from candidates and make that
  scope incomplete. Counts are aggregate station counts. The displayed groups can be fewer because
  the UI requires each measurement to match an approved catalogue entry and its verified position. The
  public response counts non-displayable measurement matches separately from RDP's station counts so
  a partial or undisplayable result is distinguishable from a search with no matches.
- Fixed failures are `INVALID_REQUEST` (400), `DISABLED` (404 from the RDP ReadApi envelope),
  `RELEASE_NOT_AVAILABLE` (410, re-run River Tracer locate), `RESULT_TOO_LARGE` (413),
  `CANCELLED` (499), `UNAVAILABLE` (503) and `TIMEOUT` (504).

Discovery adds one exact signed GET using the shared limiter, retry policy and credential exchange. It reads
the cached published catalogue only for available results. Discovery is uncached and caps incoming and outgoing
JSON at 4 MiB. Both parsers accept the managed RDP publication limit of 500 measurements (#140).
Discovery allows 20 seconds for the signed read and 25 seconds for the application request, including any
catalogue wait. The browser aborts the unshared signed read through the request signal. Shared catalogue
loads retain their own budget.

RDP PR [#150](https://github.com/tclare95/river-data-platform/pull/150) enables
`catchment_measurements` in the committed production config. The staging flag remains off.
A live check needs the pinned River Tracer release, the Read Lambda boundary rendered with `--river-api`,
the UI caller policy rendered with `--ui --river`, and the stage released with discovery enabled. Include this
application route in the Vercel Firewall rate-limit rule. See the
[RDP activation contract](https://github.com/tclare95/river-data-platform/blob/2371698f6cb1ab8a3a9499c26b3efc9f635b667e/docs/READ-API.md#catchment-measurement-discovery).

Run the signed smoke from the Vercel UI Preview against staging and repeat from Production against production
after its separate activation. Using that environment's existing OIDC → STS UI role, sign
`GET /v1/river/locate?lon=-1.07846&lat=52.95344` at Colwick. Take its returned token and sign
`GET /v1/river/upstream-measurements?lon=-1.07846&lat=52.95344&release=<token>`; expect 200
`available` and the same release. Repeat with a well-formed token different from the active one and expect
410 `RELEASE_NOT_AVAILABLE`. Verify the Next.js response shows only approved catalogue IDs and the coverage
counts. The fixture suite uses synthetic RDP responses and does not depend on these stage checks.

## Measurement history

`src/lib/history/` owns the detail page's history read; nothing in it derives freshness or coverage.

- **Ranges** (`range.ts`): 7 and 30 days (`?range=7d|30d`, anything else is 7 days), ending at the latest whole UTC hour, inclusive `from` and exclusive `to`. Detail, comparison and API requests for the same measurement and window share a cached first page.
- **Loader** (`load.ts`, server-only): follows RDP's continuation cursor with the identical window and the 2,000-row limit until `nextCursor` is null. The result is **all or nothing**: any failed page returns `unavailable` (never a shorter history presented as whole); more than four pages returns `too_large` rather than truncating; `CURSOR_EXPIRED`/`CURSOR_STALE` restarts once from a fresh first page (the client evicts the cached first page so the restart gets a new cursor). Pages must carry identical coverage and strictly later rows. The loader assembles rainfall by provider label and keeps RDP's interval boundaries, conventions and eligibility. Across continuation pages RDP's label-window summary is absent (`windowUnavailable: "paginated"`). The application charts use assembled interval rows and calculate each displayed window independently of that summary. Successful assembled windows are cached per client for 60 s (in-flight loads shared, failures never cached), so repeated 30-day views do not re-read continuation pages from the shared throttle.
- **History deadline**: detail and comparison use one 20-second budget per assembled window, including any cursor restart. Expiry shows the existing unavailable state and stops pagination. An in-flight page can finish under its existing adapter deadline, which preserves shared first-page reads.
- **Series** (`series.ts`, pure): readings are plotted at their own source times on a linear time axis. Consecutive readings are joined only when they are at most 1.5 expected intervals apart and no known coverage gap lies between them; otherwise a `null` point breaks the line. Nothing is interpolated, resampled, smoothed or clipped, the y axis never forces zero and negative values are kept. A reading with no joined neighbour is drawn as a dot. The table inserts a "No readings for …" row at each break.
- **Coverage**: RDP's verdict is shown in words. `unknown` (today's honest default) says the record is not verified complete; `partial` lists known gaps by reason, which are also shaded on the chart; only `complete` says complete.
- **Page** (`src/components/history/`): `MeasurementHistory` streams under its own `Suspense` (keyed by range) via a never-rejecting promise and `use`, so the latest reading is never held back. `HistoryChart` and `ObservationTable` are the only client components; the table (newest first, 100 rows per page, values exactly as returned, observed/stored times and revision) sits in a `<details>` disclosure below the chart.
- **Upstream cost**: detail uses latest + health + one chart history page per 2,000 readings (two for 30 days at 15 minutes, including rainfall lookback). Supported measurements also use the bounded summary read below. First reads are cached for 60 s.

### Rainfall chart windows

For detail and shared comparison, the existing loader fetches 7 days before the requested rainfall history start and extends the exclusive query end by 1 ms to obtain a verified period-end label at the read boundary, if present. Native plots and reading counts use the selected source label range. Comparison adds the bounded padding described below. Detail reads and the public single-page history endpoint keep their original windows.

`rainfall-totals.ts` is a pure application transform over one gauge's assembled rows. Exact totals include only eligible, whole periods matching a UTC grid slot and the row's RDP-declared boundaries. A period-end label at the right boundary can count, and a period-start label there belongs to the next window. The UI honours conventions only on rows where RDP supplies evidence. Where labels have unverified timing, an indicative total instead sums eligible labels in the UTC window `[from, to)`. Duplicate labels cannot add depth twice, conflicting versions or overlapping verified periods leave uncovered slots, and no partial interval is prorated. RDP's archival coverage verdict remains distinct from the transform's expected-slot count.

Hourly and daily buckets are UTC calendar buckets. A clipped day uses the expected count for a full day and shows partial coverage. Rolling and cumulative values sample at whole UTC hours, with the first rolling sample at the visible start and the first cumulative sample one hour later. Partial results report the depth actually used and the eligible/expected count. Unavailable results leave gaps. The accessible tables show the UTC bounds and coverage for every derived point. See [RDP's rainfall read contract and evidence](https://github.com/tclare95/river-data-platform/blob/main/docs/RAINFALL.md#read-contract).

### Recent level and flow summaries

The latest published observation anchors the summary. It must be marked fresh by RDP and be within two
expected intervals of now. The detail page reuses its latest reading. Map and catchment disclosures load
on demand via `/api/measurements/{id}/summary`, under the measurement API rate-limit path.
All three surfaces use the same cached RDP history adapter for one page of up to 1,500 readings spanning
just over 24 hours. The chart’s whole-hour window can exclude the latest observations. A continued page
or a conflict between the latest and historical value at the same instant leaves recent changes unavailable.

Comparisons use the closest actual reading to 1, 6 or 24 hours before the latest, within half the expected
interval and at most 15 minutes. A tie uses the earlier reading. Each comparison requires observations
without a known coverage gap or spacing above 1.5 expected intervals through the latest reading. The
24-hour extrema and sparkline use only observations within the window, with the first no more than one
expected interval from the start and the same gap checks. Unknown coverage can coexist with real readings,
and these checks do not establish complete source coverage.

Recent rate uses the 1-hour comparison divided by its actual elapsed time. For levels measured in metres,
rates from −0.01 to +0.01 m/h are broadly stable. For flow measured in cubic metres per second, the
deadband per hour is the larger of 0.01 in the published flow unit or 2% of the larger absolute endpoint.
These are display thresholds for small fluctuations. The remaining rates are rising or falling by sign.

## Comparison

`/compare?a=&b=&c=&d=&range=` compares two to four published measurements in selection order. Existing two-slot URLs still work. A single GET picker adds one measurement at a time and removal links preserve the range.

- **Time** — One Recharts canvas over the same visible time window for every series. Level and flow use their observed timestamps and the detail view’s line-break rules. Rainfall defaults to a 24-hour rolling total. In the native view, bars use verified start/end bounds, including a boundary that straddles the label query window. Unverified timing is marked at the provider label. Ineligible intervals get a cross, reported zero gets a baseline mark, and absent intervals leave gaps.
- **Manual shifts** — Each series can move up to 24 hours in either direction in whole minutes. The display window stays fixed. The chart and table align on displayed timestamps and preserve original times, values and missing data. Rainfall totals use the inverse-shifted source window and the original UTC grid, then move onto the display axis. Offsets belong to the current comparison view.
- **Scales** — The legend names each series, its unit or rainfall period, and its axis. Compatible magnitudes can share a scale. Different parameters, units, rainfall periods or incompatible level datums use independent axes. Station-local levels from different stations and levels on unknown datums each keep their own scale. The picker disables additions that would require a third raw-value axis, and incompatible URLs show an explanation before any history read.
- **Accessible data** — The disclosure table lists the union of exact observation times and rainfall labels or derived window ends, newest first. It shows original values and revision/eligibility in the native view, and depth, timing basis and coverage for derived rainfall. The shared cursor supports pointer, touch and keyboard inspection. It snaps to source times and verified rainfall bar midpoints, shows level values only at their recorded times and includes verified rainfall intervals that contain the inspected time.
- **Availability and upstream cost** — Each series uses the existing independent, all-or-nothing history loader. A failed or empty series has its own state and the available series stay visible. Each view starts at most four history loads using the same cache, limits on pagination and restarts, and deadlines as detail history. Comparison reads start 24 hours before the visible window and end at the latest whole UTC minute, giving a maximum of 31 days plus the elapsed part of the current hour. Rainfall adds its 7-day lookback. Applying and resetting offsets use this bounded data in memory.

## Discovery and detail pages

- **Home** (`src/app/(home)/`): the public catalogue with RDP's latest state, grouped by RDP `stationId`. The home page waits for the catalogue so the station list is visible in the initial HTML without a streaming reveal script. Search and the type filter are pure functions over the already-loaded catalogue (`src/lib/discovery.ts`) in one client component; the view is mirrored in `?q=&type=` with `history.replaceState` and also works as a plain GET form without JavaScript. Search covers station name, verified watercourse, parameter, provider, unit and ID. The type filter appears only when more than one type is published.
- **River map** — The home page mounts the map even with an empty or unavailable catalogue. The default camera fits Great Britain. Valid `?lon=&lat=&zoom=` sets the camera, with zoom 12 when omitted. `?station=` opens a catalogue station with verified coordinates and centres it unless an explicit camera is supplied. The station layer starts hidden and opens automatically for an explicit station. Search updates that layer while preserving the camera, selected station and point trace. The station list includes unlocated stations and works independently of JavaScript, WebGL and tiles. The browser requests the attributed OpenFreeMap Positron basemap directly. [Basemap documentation](https://openfreemap.org/quick_start/)
- **Provider stations** — The river map browses RDP's retained provider inventory after the camera settles for 400 ms. It cancels superseded reads, clips viewport bounds to RDP's Great Britain search area, and asks visitors to zoom in above RDP's 2.5° span limit. Markers group by screen position, with a keyboard-accessible station picker. The existing published catalogue, search and point catchment discovery remain available independently.
- **Inventory read boundary** — `GET /api/discovery/area?bbox=west,south,east,north` validates the clipped bounds and forwards only the exact `GET /v1/discovery/area` contract through the shared SigV4 transport and limiter. It reads up to three 200-station pages in a 20-second budget and restarts once if the snapshot changes. Page-limit truncation, stale inventory and provider coverage gaps are shown on the map. The route returns only approved station metadata and published measurement IDs. Request cancellation is enabled for this Vercel function. Browsing reads retained metadata and performs no ingestion or measurement lifecycle actions. [RDP inventory contract](https://github.com/tclare95/river-data-platform/blob/main/docs/INVENTORY.md)
- **Drainage overview** — The launch fallback uses the basemap. The map's sources and coverage disclosure explains that overview boundaries are unavailable. Selecting a point uses the existing signed River Tracer route and labels the result as a modelled catchment for that point. The overview layer depends on RDP's approved immutable manifest, geometry format and public delivery URL. [RDP overview specification](https://github.com/tclare95/river-data-platform/pull/151)
- **Explorer comparison** — Station markers, the station list and catchment results share the two-axis selection. From two compatible measurements, the explorer shows the same chart, readings table and coverage used by the chart-focused `/compare` page. Changing the selection or range replaces just the inline history request, leaving the map and any open catchment results in place.
- **Inline history boundary** — `GET /api/measurements/comparison?a=&b=&c=&d=&range=` accepts two to four distinct published IDs and a 7- or 30-day range. It validates axis compatibility before loading and sends only public comparison data, capped at 4 MiB. If the aggregate would exceed the cap, the largest histories are marked too large until the remaining complete series fit. Both views use the same visible windows, bounded rainfall lookback, per-series pagination and deadlines, and assembled history cache. The route falls under the existing `/api/measurements/*` firewall rule.
- **Shareable explorer** — The URL stores ordered comparison IDs, range, filters, viewport, selected station and trace point, direction and catchment visibility. Opening a shared link reloads the trace against the active network release and discovers measurements when an approved catchment is available.
- **Detail** (`/measurements/{measurementId}`): RDP's measurement ID is the stable URL. `layout.tsx` resolves the ID against the cached catalogue _before_ any streaming, so unknown, malformed and non-displayable IDs return a real 404 (indistinguishable from each other); the page then reads latest under its own `loading.tsx`.
- Provider quality is shown only when it is a plain word (EA gauge quality arrives as raw JSON text); structured values are omitted, not printed.

## Deployment configuration

Each step is a separately approved operator action ([RDP PRODUCTION-READ-API.md#rdp-ui-caller](https://github.com/tclare95/river-data-platform/blob/main/docs/PRODUCTION-READ-API.md#rdp-ui-caller)):

1. Release the RDP read handler that admits `river-data-platform-<stage>-ui-vercel-<environment>` on the four observation routes.
2. Using operator credentials, render (`read_api_iam.py --ui`) and create that stage's caller stack `river-data-platform-<stage>-read-ui-caller`. It must be in the same Vercel team as the existing OIDC provider.
3. In this Vercel project, enable OIDC (team issuer mode) and set server-only variables per environment: `RDP_DATA_MODE=live`, `RDP_AWS_REGION=eu-west-1`, `RDP_READ_API_URL=https://<api-id>.execute-api.eu-west-1.amazonaws.com/<stage>`, `RDP_ROLE_ARN=<UiRoleArn output>`. Preview binds to staging and Production to production.
4. Add the Vercel Firewall rate-limit rule for `/api/measurements/*`, `/measurements/*` and `/compare` (each page view can make upstream reads).

Status (20 November 2026): steps 1–3 are done for both stages, and signed reads are verified on Preview (staging) and Production (production). Step 4 is not yet configured. See [MVP acceptance](MVP.md). 5. Verify signed reads on a Preview deployment before Production. Until steps 1–3 are done, live mode shows _unavailable_ (403), never sample data.

Production has inventory reads and the UI caller grant. Staging has inventory disabled, so Vercel Preview and local fixture mode show the inventory unavailable state at eligible zooms. The signed production read and production function cancellation still need a deployment smoke check. Include `/api/discovery/area` in the Vercel Firewall rate-limit scope when configuring it. [RDP production enablement evidence](https://github.com/tclare95/river-data-platform/blob/main/docs/evidence/inventory/PRODUCTION-ENABLEMENT.md)

## Backend dependency

Catalogue geography follows [RDP #129's consumer handoff](https://github.com/tclare95/river-data-platform/blob/3c49572/docs/CATALOGUE-GEOGRAPHY.md) (observation read API OpenAPI 1.1.0). The adapter accepts older responses and omits malformed or unrecognised geography. The public projection includes verified river names, verified coordinates with their provider resolution, and allowlisted EA station evidence links. Retrieval time stays in the adapter.
