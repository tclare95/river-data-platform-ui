# River Data Platform UI

The standalone, river-first web application for [River Data Platform](https://github.com/tclare95/river-data-platform).

This repository is the **UI/application layer**. RDP remains the source of measurement identity, observations, rainfall, CSO events and river-network data.

## Develop

Requires Node.js 22 or newer.

```bash
npm install
npm run dev
```

Open http://localhost:3000.

```bash
npm run lint
npm run typecheck
npm run test
npm run build
npm run format
```

This bootstrap deliberately contains **no live RDP integration, chart, map or fabricated data**. The next coding agent will deliver the first explorer journey against the existing read API.

## Next steps

1. Implement accessible discovery using the published `GET /v1/measurements` catalogue.
2. Open a measurement to see actual latest readings, freshness, provenance and bounded history.
3. Introduce the server-side RDP adapter and, where useful, Next.js application API routes. Never expose IAM credentials or upstream private endpoints to browsers.
4. Add a map only for verified positions when [RDP #129](https://github.com/tclare95/river-data-platform/issues/129) makes them available.

Follow [AGENTS.md](AGENTS.md), [product guidance](docs/PRODUCT.md) and [architecture](docs/ARCHITECTURE.md).

## Deployment

Import this repository into Vercel as a **Next.js** project. No framework-specific configuration is needed for the shell. This shell is safe to deploy without RDP credentials.

Live data integration **requires separate setup**: a dedicated Vercel-project OIDC trust, stage-scoped AWS role and exact IAM read-route grants. Do not reuse isHPPOpen's role. See [architecture](docs/ARCHITECTURE.md).

The default `main` branch remains unchanged until the bootstrap PR is reviewed.
