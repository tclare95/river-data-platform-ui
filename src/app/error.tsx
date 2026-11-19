"use client";

import { Button } from "@/components/button";
import { PageMain } from "@/components/container";
import { ErrorState } from "@/components/states";

type ErrorPageProps = {
  error: Error & { digest?: string };
  reset: () => void;
};

// The error message is deliberately not rendered: it may carry upstream or internal detail.
export default function ErrorPage({ reset }: ErrorPageProps) {
  return (
    <PageMain>
      <ErrorState
        title="This page could not be loaded"
        action={<Button onClick={() => reset()}>Try again</Button>}
      />
    </PageMain>
  );
}
