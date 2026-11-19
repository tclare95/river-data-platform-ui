import { PageMain } from "@/components/container";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/states";

export default function HomePage() {
  return (
    <PageMain>
      <PageHeader title="Explore river data" />
      <section aria-label="Measurements" className="mt-8 sm:mt-10">
        <EmptyState title="No measurements to show yet" />
      </section>
    </PageMain>
  );
}
