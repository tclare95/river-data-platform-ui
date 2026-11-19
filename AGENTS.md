# Agent instructions — River Data Platform UI

This repository owns a **distinct, visitor-facing application**, not the RDP ingestion or data model. Keep changes small and independently testable. Prioritise a complete discovery → measurement → history experience before building feature frameworks.

## Read these first

- [Product baseline](docs/PRODUCT.md)
- [Architecture](docs/ARCHITECTURE.md)
- [RDP product vision](https://github.com/tclare95/river-data-platform/blob/main/docs/PRODUCT_VISION.md)
- [RDP standalone plan](https://github.com/tclare95/river-data-platform/blob/main/docs/STANDALONE_PRODUCT_PLAN.md)
- [Canonical explorer OpenSpec](https://github.com/tclare95/river-data-platform/tree/main/openspec/changes/river-explorer-and-analysis)
- [Actual observation read contract](https://github.com/tclare95/river-data-platform/blob/main/docs/READ-API.md) and [OpenAPI](https://github.com/tclare95/river-data-platform/blob/main/docs/openapi.json)

Consult current code/contracts in RDP before making integration assumptions.

## Boundaries

- The UI **may have its own Next.js application API** for UI-specific operations, access checks or browser-facing bounded data responses. This is *not* a generic upstream proxy or a new canonical backend.
- Access the AWS_IAM/SigV4 RDP read service **server-side only**, using dedicated Vercel-project OIDC → STS → read-only role. No browser AWS credentials, private API hostnames, archive access or `NEXT_PUBLIC_` server secrets.
- Reuse published measurement IDs, units, timestamps, quality, datum, provenance, freshness and coverage semantics. Do not invent locations, live values, continuous data or new domain rules.
- The RDP measurement catalogue does not yet guarantee river/geolocation metadata; see [RDP #129](https://github.com/tclare95/river-data-platform/issues/129). Make discovery usable as a list without a map.
- Never modify isHPPOpen production behaviour, RDP ingestion/selection or canonical observations from this repository.
- User accounts, alerts, playgrounds, custom datasets, developer APIs and model execution are deferred.

## Design

Simple, clean and river-first. Keep copy short and useful. **No eyebrows, shoulders, pre-headings, redundant explanatory/justification text, ornamental badges or dashboard clutter.** Use real content hierarchy, measured spacing, clear states and mobile-friendly layouts.

Design for different kinds of visitors. Start with a searchable list; let detail and analysis progressively reveal more. Distinguish unavailable, not collected, stale and unknown states. Never present an observation as a safety recommendation.

## Working practice

- Next.js App Router, TypeScript, Tailwind. Prefer Server Components; isolate interactivity as client components.
- Add `src/app/api` routes only when they solve a real UI need. Validate inputs and bound query windows and response sizes.
- Use map/chart libraries only when implementing those views; MapLibre GL JS and Recharts are preferred, not compulsory.
- Add focused tests for behaviour, missing data and provenance. Run lint, typecheck, tests and build; maintain a committed lockfile when dependencies are installed.
- Update these concise docs for material architectural decisions. **Do not create duplicate OpenSpecs** for what RDP already specifies.
- Submit small PRs with changes, verification and any outstanding integration/deployment configuration identified.
