import { PageMain } from "@/components/container";
import { LoadingState } from "@/components/states";

export default function Loading() {
  return (
    <PageMain>
      <LoadingState label="Loading page" />
    </PageMain>
  );
}
