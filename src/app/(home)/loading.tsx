import { PageMain } from "@/components/container";
import { PageHeader } from "@/components/page-header";
import { LoadingState } from "@/components/states";

export default function Loading() {
  return (
    <PageMain>
      <PageHeader title="Explore river data" />
      <LoadingState label="Loading published measurements" className="mt-6" />
    </PageMain>
  );
}
