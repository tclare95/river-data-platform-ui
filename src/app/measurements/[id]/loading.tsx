import { PageMain } from "@/components/container";
import { LoadingState } from "@/components/states";

export default function Loading() {
  return (
    <PageMain>
      <div aria-hidden="true" className="h-9 w-48 rounded bg-line motion-safe:animate-pulse" />
      <LoadingState label="Loading measurement" className="mt-8" />
    </PageMain>
  );
}
