import { connection } from "next/server";
import { PageMain } from "@/components/container";
import { MeasurementExplorer } from "@/components/measurement-explorer";
import { Attribution, FixtureNote } from "@/components/provenance";
import { readExplorerState } from "@/lib/explorer-state";
import { loadOverview } from "@/lib/overview";

export default async function HomePage({ searchParams }: PageProps<"/">) {
  // Rendered per request: never prerender observations into static HTML at build time.
  await connection();
  const [overview, params] = await Promise.all([loadOverview(), searchParams]);
  return (
    <PageMain className="explorer-page max-w-none! px-2! py-2! sm:px-4!">
      <h1 className="sr-only">Explore river data</h1>
      <section aria-label="Measurements" className="flex min-h-0 flex-1 flex-col">
        {overview.status === "ok" && overview.mode === "fixture" && overview.items.length > 0 ? (
          <FixtureNote className="mb-1 shrink-0" />
        ) : null}
        <MeasurementExplorer
          items={overview.status === "ok" ? overview.items : []}
          catalogueUnavailable={overview.status === "unavailable"}
          initialState={readExplorerState(params)}
        />
        {overview.status === "ok" && overview.items.length > 0 ? (
          <Attribution
            className="mt-1! shrink-0"
            measurements={overview.items.map((item) => item.measurement)}
          />
        ) : null}
      </section>
    </PageMain>
  );
}
