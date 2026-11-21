import { connection } from "next/server";
import { PageMain } from "@/components/container";
import { MeasurementExplorer } from "@/components/measurement-explorer";
import { PageHeader } from "@/components/page-header";
import { Attribution, FixtureNote } from "@/components/provenance";
import { EmptyState, ErrorState } from "@/components/states";
import { readQuery } from "@/lib/discovery";
import { loadOverview } from "@/lib/overview";

export default async function HomePage({ searchParams }: PageProps<"/">) {
  // Rendered per request: never prerender observations into static HTML at build time.
  await connection();
  const [overview, params] = await Promise.all([loadOverview(), searchParams]);
  return (
    <PageMain>
      <PageHeader title="Explore river data" />
      <section aria-label="Measurements" className="mt-6">
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
