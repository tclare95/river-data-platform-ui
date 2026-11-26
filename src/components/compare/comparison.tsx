import { Suspense, use } from "react";
import { ComparisonBody } from "@/components/compare/comparison-body";
import { RangeNav } from "@/components/history/history-controls";
import { LoadingState } from "@/components/states";
import { compareHref, type ComparisonHistory } from "@/lib/compare";
import { loadComparison } from "@/lib/compare-load";
import { HISTORY_RANGES, type HistoryRange } from "@/lib/history/range";
import type { PublicMeasurement } from "@/lib/rdp/public";

const STATUS_ID = "compare-status";

function LoadedComparison({
  range,
  results,
}: {
  range: HistoryRange;
  results: Promise<ComparisonHistory>;
}) {
  const { data, window } = use(results);
  return <ComparisonBody range={range} sides={data} window={window} statusId={STATUS_ID} />;
}

export function Comparison({
  measurements,
  range,
}: {
  measurements: PublicMeasurement[];
  range: HistoryRange;
}) {
  const results = loadComparison(measurements, range);
  const ids = measurements.map(({ measurementId }) => measurementId);
  return (
    <section aria-labelledby="comparison" className="mt-10">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="comparison" className="text-lg font-semibold tracking-tight">
          History
        </h2>
        <RangeNav range={range} hrefFor={(key) => compareHref(ids, key)} prefetch={false} />
      </div>
      <p id={STATUS_ID} role="status" className="sr-only" />
      <div className="mt-4">
        <Suspense
          key={compareHref(ids, range)}
          fallback={
            <LoadingState
              label={`Loading ${HISTORY_RANGES[range].label} for ${ids.length} measurements`}
              lines={8}
            />
          }
        >
          <LoadedComparison range={range} results={results} />
        </Suspense>
      </div>
    </section>
  );
}
