import { connection } from "next/server";
import { PageMain } from "@/components/container";
import { MeasurementExplorer } from "@/components/measurement-explorer";
import { PageHeader } from "@/components/page-header";
import { Attribution, FixtureNote } from "@/components/provenance";
import { EmptyState, ErrorState } from "@/components/states";
import { readQuery, typeOptions } from "@/lib/discovery";
import { listJoin } from "@/lib/format";
import { parameterLabel } from "@/lib/labels";
import { loadOverview, type OverviewItem } from "@/lib/overview";

/** One line describing what is actually published: its types and providers, from the catalogue itself. */
function summary(items: readonly OverviewItem[]): string {
  const types = typeOptions(items).map((type, index) => {
    const label = parameterLabel(type);
    return index === 0 ? label : label.toLowerCase();
  });
  const sources = [...new Set(items.map((item) => item.measurement.source.label))];
  return `${listJoin(types)} measurements from the ${listJoin(sources)}.`;
}

export default async function HomePage({ searchParams }: PageProps<"/">) {
  // Rendered per request: never prerender observations into static HTML at build time.
  await connection();
  const [overview, params] = await Promise.all([loadOverview(), searchParams]);
  const ok = overview.status === "ok" && overview.items.length > 0;
  return (
    <PageMain>
      <PageHeader
        title="Explore river data"
        description={ok ? summary(overview.items) : undefined}
      />
      <section aria-label="Measurements" className="mt-8 sm:mt-10">
        {overview.status === "unavailable" ? (
          <ErrorState title="Measurements are unavailable right now">
            Please try again in a few minutes.
          </ErrorState>
        ) : overview.items.length === 0 ? (
          <EmptyState title="No measurements to show yet" />
        ) : (
          <>
            {overview.mode === "fixture" ? <FixtureNote className="mb-6" /> : null}
            <MeasurementExplorer items={overview.items} initialQuery={readQuery(params)} />
            <Attribution measurements={overview.items.map((item) => item.measurement)} />
          </>
        )}
      </section>
    </PageMain>
  );
}
