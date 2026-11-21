# MVP acceptance

The MVP lets a visitor, without an account, discover a published RDP measurement, see its latest and historical observations, and compare two measurements. Requirements are RDP's [River Explorer OpenSpec](https://github.com/tclare95/river-data-platform/tree/main/openspec/changes/river-explorer-and-analysis); this file records evidence, not requirements.

## Results (20 November 2026)

| Journey / requirement                                                                         | Evidence                                                                                                                                                                                                     | Result                               |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------ |
| Discovery (list, search, type filter, no-JS GET form)                                         | Production: 12 measurements at 11 stations from live RDP. Preview: 6 at 5 from staging                                                                                                                       | Pass                                 |
| Latest observation with source time, freshness, unit, datum, quality, provenance              | Production `ea-shardlow-flow`: "Last known reading … Not recent · 56 min old when checked", stored/requested/checked times kept separate                                                                     | Pass                                 |
| No observations / stale / unavailable states                                                  | Staging: Church Wilne "No observations collected"; Colwick "31 d 6 h old". Unavailable latest, catalogue and history are covered by tests                                                                    | Pass                                 |
| Bounded history: chart and accessible table, gaps, unknown and partial coverage, continuation | Production 30 d: 2,868 readings over two pages, "missing in 6 places", unknown coverage worded as not verified. Partial, too-large and failed-page cases are covered by tests                                | Pass                                 |
| Two-measurement comparison, aligned times, independent units and datums                       | Fixture and tests: level + flow and level + level (local datum note), with an exact-time aligned table. Preview: live signed reads render both panels and honest empty windows (staging data is a month old) | Pass. Production check pending merge |
| Mobile, keyboard, chart data                                                                  | Independent review: no horizontal scroll at 390 px, full keyboard path with visible focus, distinct chart summaries, tables in focusable regions, contrast ≥ 6:1 for text                                    | Pass                                 |
| Request limits, caching, continuation, errors                                                 | Adapter budgets (4 concurrent, 3 rps per instance), all-or-nothing continuation, assembled-window cache, fixed error codes                                                                                   | Pass                                 |
| Slow upstream                                                                                 | Hung upstream becomes TIMEOUT at its deadline (tested against a real hanging server); the page shows unavailable. History streams separately from latest                                                     | Pass (see limits)                    |
| Fixture data never presented as observations                                                  | Fixture mode is refused on Vercel Production and never defaulted on Vercel. "Sample data" label appeared on 0 of 23 live Preview/Production pages and on every local fixture page                            | Pass                                 |
| No credentials or protected upstream information                                              | `check:bundle` (32 files); build output and live HTML/RSC/headers grepped for AWS hosts, ARNs, account IDs and provider internals: 0 hits. Hostile inputs return fixed codes                                 | Pass                                 |
| Source attribution                                                                            | OGL v3.0 line on every data page; footer "Observations are not safety advice."                                                                                                                               | Pass                                 |

Automated: `npm run check` passes (301 tests, build, bundle scan).

## Minimum remaining production configuration

1. Merge this PR; Production deploys from `main`. Then open `/compare?a=ea-shardlow-level&b=ea-shardlow-flow` on Production to confirm the comparison with real series.
2. Add a Vercel Firewall rate-limit rule (per IP, for example 60/min) on `/api/measurements/*`, `/measurements/*` and `/compare`. This is an operator action in the Vercel dashboard. The per-instance budget already protects RDP's shared throttle.

Everything else is already configured: OIDC (team issuer), the per-environment `RDP_*` variables, per-stage UI caller roles, and functions in `dub1`.

## Known limits (post-MVP)

- **Map:** waits for verified coordinates ([RDP #129](https://github.com/tclare95/river-data-platform/issues/129), open).
- **Rainfall:** detail history shows interval totals. Comparison remains limited to instantaneous measurements.
- **Not-found pages:** a `notFound()` 404 has a correct status and `noindex`, but its HTML body is filled in only by JavaScript. This reproduces with a one-line route on Next 16.4.6; unmatched URLs render fully.
- **Hung upstream:** a page can take more than 40 s to reach "unavailable" (latest 8 s, then up to 20 s per history page). Consider one overall history budget.
- **Charts:** the window ends at the next whole hour, so the right edge of a chart can be up to an hour in the future.
- **Content Security Policy:** a full `script-src` CSP needs per-request nonces.
