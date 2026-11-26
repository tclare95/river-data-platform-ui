"use client";

import { lazy, Suspense, useEffect, useId, useState } from "react";
import { Button } from "@/components/button";
import { RangeNav } from "@/components/history/history-controls";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { compareParams, type ComparisonHistory } from "@/lib/compare";
import { HISTORY_RANGES, type HistoryRange } from "@/lib/history/range";
import type { ComparisonPresentation } from "@/lib/explorer-state";

const ComparisonBody = lazy(async () => ({
  default: (await import("./comparison-body")).ComparisonBody,
}));

type Result = ComparisonHistory | "unavailable" | "too_large";

type PresentationProps = {
  presentation: ComparisonPresentation;
  onPresentationChange: (presentation: ComparisonPresentation) => void;
};

function InlineHistory({
  query,
  range,
  count,
  statusId,
  ...presentationProps
}: PresentationProps & {
  query: string;
  range: HistoryRange;
  count: number;
  statusId: string;
}) {
  const [result, setResult] = useState<Result>();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch(`/api/measurements/comparison?${query}`, {
          signal: controller.signal,
        });
        const result = response.ok
          ? ((await response.json()) as ComparisonHistory)
          : response.status === 413
            ? "too_large"
            : "unavailable";
        if (!controller.signal.aborted) {
          setResult(
            !result || (typeof result === "object" && (!result.data || !result.window))
              ? "unavailable"
              : result,
          );
        }
      } catch {
        if (!controller.signal.aborted) setResult("unavailable");
      }
    }
    void load();
    return () => controller.abort();
  }, [query, attempt]);

  const loading = (
    <LoadingState
      label={`Loading ${HISTORY_RANGES[range].label} for ${count} measurements`}
      lines={8}
    />
  );
  if (result === "too_large") {
    return (
      <EmptyState title="Too many readings for this comparison">
        Choose a shorter range or remove a measurement.
      </EmptyState>
    );
  }
  if (result === "unavailable") {
    return (
      <ErrorState
        title="Comparison history unavailable right now"
        action={
          <Button
            onClick={() => {
              setResult(undefined);
              setAttempt((current) => current + 1);
            }}
          >
            Try again
          </Button>
        }
      />
    );
  }
  if (!result) return loading;
  return (
    <Suspense fallback={loading}>
      <ComparisonBody
        sides={result.data}
        window={result.window}
        range={range}
        statusId={statusId}
        {...presentationProps}
      />
    </Suspense>
  );
}

export function InlineComparison({
  ids,
  range,
  onRangeChange,
  ...presentationProps
}: PresentationProps & {
  ids: readonly string[];
  range: HistoryRange;
  onRangeChange: (range: HistoryRange) => void;
}) {
  const query = compareParams(ids, range).toString();
  const statusId = useId();
  return (
    <section aria-labelledby="explorer-comparison" className="mt-5 min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="explorer-comparison" tabIndex={-1} className="text-lg font-semibold tracking-tight">
          Comparison history
        </h2>
        <RangeNav range={range} onRangeChange={onRangeChange} />
      </div>
      <p key={query} id={statusId} role="status" className="sr-only" />
      <div className="mt-4">
        <InlineHistory
          key={query}
          query={query}
          range={range}
          count={ids.length}
          statusId={statusId}
          {...presentationProps}
        />
      </div>
    </section>
  );
}
