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
- `src/lib/rdp/`: server-only signed transport and typed contract adapters, added with the first live integration
- `tests/`: focused contract/state/UI tests
- `docs/`: concise product/architecture decisions

Use Server Components by default; isolate interactive components. No generic repository/service abstraction until actual duplication justifies it.

MapLibre GL JS and Recharts are **provisional implementation choices** for future map/history features. Do not install them until needed.

## Vercel / AWS integration handoff

1. Create the Vercel project from this repo; deploy the static shell first.
2. Provision a **dedicated, project-scoped OIDC trust and stage-specific read-only role** based on RDP's existing caller-role pattern (see RDP `deploy/read_api_iam.py` and isHPPOpen `libs/rdp/client.js`). Do not reuse isHPPOpen's role or wildcard its project subject.
3. Supply only server-side `RDP_READ_API_URL`, `RDP_AWS_REGION`, `RDP_ROLE_ARN`, as needed by the future adapter. Configure Vercel OIDC per environment. Keep staging/production separate.
4. Sign only existing read-only GET routes; bound history by the backend's 366-day cap and enforce smaller UI defaults. Respect continuation, source freshness and coverage.
5. Confirm source licence/public display policy before exposing a dataset. Preserve original timestamps, parameter and provenance.

The bootstrap **does not provision IAM, deploy Vercel or access live RDP**. The stage-specific AWS binding and end-to-end reads remain for the integration PR.

## Backend dependency

[RDP #129](https://github.com/tclare95/river-data-platform/issues/129) will extend the **existing** published catalogue with verified, optional station geolocation and watercourse information. Until then, do not fabricate positions or maintain an independent canonical list. List-first discovery is the correct fallback.
