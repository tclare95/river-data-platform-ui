import { connection } from "next/server";
import { PageMain } from "@/components/container";
import { MeasurementExplorer } from "@/components/measurement-explorer";
import { PageHeader } from "@/components/page-header";
import { Attribution, FixtureNote } from "@/components/provenance";
import { readCompareQuery } from "@/lib/compare";
import { readQuery } from "@/lib/discovery";
import { readMapContext } from "@/lib/map-context";
import { loadOverview } from "@/lib/overview";

export default async function HomePage({ searchParams }: PageProps<"/">) {
  // Rendered per request: never prerender observations into static HTML at build time.
  await connection();
  const [overview, params] = await Promise.all([loadOverview(), searchParams]);
  return (
    <PageMain>
      <PageHeader title="Explore river data" />
      <section aria-label="Measurements" className="mt-6">
        {overview.status === "ok" && overview.mode === "fixture" && overview.items.length > 0 ? (
          <FixtureNote className="mb-6" />
        ) : null}
        <MeasurementExplorer
          items={overview.status === "ok" ? overview.items : []}
          catalogueUnavailable={overview.status === "unavailable"}
          initialQuery={readQuery(params)}
          initialComparison={readCompareQuery(params)}
          initialMapContext={readMapContext(params)}
        />
        {overview.status === "ok" && overview.items.length > 0 ? (
          <Attribution measurements={overview.items.map((item) => item.measurement)} />
        ) : null}
      </section>
    </PageMain>
  );
}
