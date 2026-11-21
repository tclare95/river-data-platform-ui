# Product baseline

RDP UI is a **standalone river explorer**, distinct from isHPPOpen. It helps visitors understand what has actually been measured and how it changes over time.

The authoritative requirements live in RDP's [River Explorer OpenSpec](https://github.com/tclare95/river-data-platform/tree/main/openspec/changes/river-explorer-and-analysis) and [product vision](https://github.com/tclare95/river-data-platform/blob/main/docs/PRODUCT_VISION.md). This document guides UI decisions; it is not a second specification.

## First visitor journey

**Discover a published measurement → open a detail page → see the latest actual observation → inspect a bounded historical chart and accessible table.**

- Discovery: simple list/search by available station, parameter and river metadata. An accessible list always works without a map.
- Detail: human-readable station name, original unit/datum, last observed time and freshness. Show no-observation, stale, unavailable and error states honestly.
- History: initially a bounded week/month window; preserve gaps, source times and coverage uncertainty. Do not interpolate missing readings.
- Attribution: source and original measurement provenance remain visible without distracting from the data.

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
