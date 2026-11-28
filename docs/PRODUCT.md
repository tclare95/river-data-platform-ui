# Product baseline

RDP UI is a **standalone river explorer**, distinct from isHPPOpen. It helps visitors understand what has actually been measured and how it changes over time.

The authoritative requirements live in RDP's [River Explorer OpenSpec](https://github.com/tclare95/river-data-platform/tree/main/openspec/changes/river-explorer-and-analysis) and [product vision](https://github.com/tclare95/river-data-platform/blob/main/docs/PRODUCT_VISION.md). This document guides UI decisions; it is not a second specification.

## First visitor journey

**Explore Great Britain’s rivers → select a station → inspect its measurements, compare them or trace upstream.**

- The map opens in Explore mode with published stations. Pan and zoom to browse regions. Zoom in for provider inventory where coverage is available. Layers filters the map by measurement type and publication status. Stations offers a searchable published list, including stations without verified positions, and works without a map.
- Selecting a marker opens station details at the current zoom and centre. Panning, zooming and inventory refresh keep the selection until the visitor switches or closes it. Map filters can hide markers while the selection remains available. Discoverable-only stations show known measurement types and explain observation availability.
- Add published measurements from station details, the station list or catchment results. Compare shows the selected measurements, removal controls and history. On narrow screens, one workspace panel opens at a time and station details can collapse to reveal the map.
- Trace river arms one map point or map centre selection. Selecting a station exits point-picking. Station details offer a direct upstream trace. A completed trace returns the map to Explore mode and keeps the catchment available until it is cleared or replaced.
- Copy Explorer link in Layers shares the viewport, map filters, selected station or trace, and comparison settings. Back and Forward restore deliberate choices. Map moves update the current history entry.
- Detail: human-readable station name, original unit/datum, last observed time and freshness. Show no-observation, stale, unavailable and error states honestly.
- History: initially a bounded week/month window; preserve gaps, source times and coverage uncertainty. Do not interpolate missing readings.
- Attribution: source and original measurement provenance remain visible without distracting from the data.

## Rainfall

Rainfall station pages open with accumulated depths for the previous 24, 48 and 72 hours and 7 days, ending at the latest whole UTC hour. The history chart opens on daily totals. Both the explorer comparison and the full comparison open on a rolling 24-hour total for each selected rainfall gauge.

The rainfall view selector offers native interval, hourly and daily totals, rolling 6-, 12-, 24-, 48- and 72-hour and 7-day totals, and cumulative depth since the selected chart start. Every view uses millimetres of rainfall. Daily buckets start at midnight UTC, including when UK clocks change.

Totals show how many expected intervals or provider labels contributed. Partial totals show the sum of the eligible readings available, and windows with no usable readings are unavailable. Reported zero remains an observation. Indicative sums group UTC provider labels when the exact interval timing is unverified. Each gauge retains its own series and totals.

## Design direction

- **Simple, clean and calm.** Clear typography and generous but purposeful spacing; restrained river-green/slate palette.
- **No eyebrow or shoulder headings.** No empty marketing copy, redundant justifications, speculative badges, ornamental charts or dense dashboard chrome.
- Real data first. Explain uncertainty in plain language only where necessary for interpreting an observation.
- Mobile-first, keyboard-friendly, and no dependence on maps for core navigation.
- Progressive disclosure for advanced comparisons, derivations and history controls.

## v1 (coding-agent work)

Accessible published-catalogue discovery; genuine latest and bounded history; truthful empty/stale/unknown/partial states; chart plus table; source attribution. A basic two-series comparison may follow once the one-measurement path works.

## Explicit non-goals

No accounts, saved views/playgrounds, alerts, user uploads, public developer API, model execution, universal national GIS index or speculative water-safety guidance. River Tracer and CSO overlays are later independent slices.

The currently published RDP catalogue is small, not a comprehensive GB river coverage claim. [RDP #129](https://github.com/tclare95/river-data-platform/issues/129) tracks optional verified geographic metadata.
