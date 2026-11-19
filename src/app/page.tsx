import { connection } from "next/server";
import { PageMain } from "@/components/container";
import { MeasurementList } from "@/components/measurement-list";
import { PageHeader } from "@/components/page-header";
import { EmptyState, ErrorState } from "@/components/states";
import { loadOverview } from "@/lib/overview";

export default async function HomePage() {
  // Rendered per request: never prerender observations into static HTML at build time.
  await connection();
  const overview = await loadOverview();
  return (
    <PageMain>
      <PageHeader title="Explore river data" />
      <section aria-label="Measurements" className="mt-8 sm:mt-10">
        {overview.status === "unavailable" ? (
          <ErrorState title="Measurements are unavailable right now" />
        ) : overview.items.length === 0 ? (
          <EmptyState title="No measurements to show yet" />
        ) : (
          <>
            {overview.mode === "fixture" ? (
              <p role="note" className="mb-4 text-sm text-ink-muted">
                Sample data for development. These are not real observations.
              </p>
            ) : null}
            <MeasurementList items={overview.items} />
          </>
        )}
      </section>
    </PageMain>
  );
}
