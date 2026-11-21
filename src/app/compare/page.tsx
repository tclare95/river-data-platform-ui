import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Comparison } from "@/components/compare/comparison";
import { PageMain } from "@/components/container";
import { PageHeader } from "@/components/page-header";
import { Attribution, FixtureNote } from "@/components/provenance";
import { EmptyState, ErrorState } from "@/components/states";
import {
  COMPARE_SLOTS,
  MAX_COMPARE_AXES,
  compareHref,
  comparisonAxes,
  readCompareQuery,
} from "@/lib/compare";
import { loadComparable } from "@/lib/compare-load";
import { parameterLabel } from "@/lib/labels";
import type { PublicMeasurement } from "@/lib/rdp/public";

export const metadata: Metadata = { title: "Compare" };

function optionLabel(measurement: PublicMeasurement) {
  return `${measurement.name} · ${parameterLabel(measurement.parameter)} (${measurement.unit})`;
}

const ERROR_ID = "compare-error";

/** A first pair to try: two measurements at one station, else the first two listed. */
function suggestion(options: readonly PublicMeasurement[]) {
  for (const first of options) {
    const second = options.find(
      (other) => other.stationId === first.stationId && other.measurementId !== first.measurementId,
    );
    if (second) return [first, second] as const;
  }
  return options.length >= 2 ? ([options[0], options[1]] as const) : null;
}

export default async function ComparePage({ searchParams }: PageProps<"/compare">) {
  // Rendered per request: never prerender observations into static HTML at build time.
  await connection();
  const [catalogue, params] = await Promise.all([loadComparable(), searchParams]);
  const query = readCompareQuery(params);

  if (catalogue.status === "unavailable") {
    return (
      <PageMain>
        <PageHeader title="Compare measurements" />
        <ErrorState title="Measurements are unavailable right now" className="mt-8">
          Please try again in a few minutes.
        </ErrorState>
      </PageMain>
    );
  }

  const options = catalogue.measurements;
  const uniqueIds = new Set(query.ids);
  const selected = [...uniqueIds].flatMap((id) => {
    const measurement = options.find((item) => item.measurementId === id);
    return measurement ? [measurement] : [];
  });
  const ids = selected.map(({ measurementId }) => measurementId);
  const { range } = query;
  const tooManyAxes = (measurements: PublicMeasurement[]) =>
    comparisonAxes(measurements, (item) => item).length > MAX_COMPARE_AXES;
  const error =
    query.repeated || selected.length < uniqueIds.size
      ? "One of those measurements isn’t available to compare. Choose another."
      : selected.length < query.ids.length
        ? "Choose different measurements."
        : tooManyAxes(selected)
          ? "These measurements need more than two separate axes because of their types, units, level datums or rainfall periods. Remove a measurement to compare them."
          : null;
  const ready = selected.length >= 2 && !error;
  const candidates = options
    .filter(({ measurementId }) => !ids.includes(measurementId))
    .map((measurement) => ({
      measurement,
      incompatible: tooManyAxes([...selected, measurement]),
    }));
  const hasIncompatible = candidates.some(({ incompatible }) => incompatible);
  const canAdd = candidates.some(({ incompatible }) => !incompatible);

  const example = suggestion(options);

  return (
    <PageMain>
      <PageHeader title="Compare measurements" />
      {catalogue.mode === "fixture" ? <FixtureNote className="mt-4" /> : null}

      {options.length < 2 ? (
        <EmptyState title="Not enough measurements to compare yet" className="mt-8" />
      ) : (
        <>
          {selected.length ? (
            <ul aria-label="Selected measurements" className="mt-6 flex flex-wrap gap-2">
              {selected.map((measurement, index) => (
                <li
                  key={measurement.measurementId}
                  className="flex items-center gap-2 rounded-md border border-line bg-surface px-3 text-sm"
                >
                  {optionLabel(measurement)}
                  <Link
                    href={compareHref(
                      ids.filter((_, i) => i !== index),
                      range,
                    )}
                    prefetch={false}
                    aria-label={`Remove ${optionLabel(measurement)}`}
                    className="link inline-flex min-h-11 items-center"
                  >
                    Remove
                  </Link>
                </li>
              ))}
            </ul>
          ) : null}

          {error ? (
            <p id={ERROR_ID} role="alert" className="mt-4 text-sm font-medium text-danger">
              {error}
            </p>
          ) : null}

          {selected.length < COMPARE_SLOTS.length && candidates.length ? (
            <form action="/compare" method="get" aria-label="Choose measurements" className="mt-4">
              {ids.map((id, index) => (
                <input key={id} type="hidden" name={COMPARE_SLOTS[index]} value={id} />
              ))}
              <label htmlFor="compare-add" className="block text-sm font-medium">
                {selected.length ? "Add a measurement" : "Choose a measurement"}
              </label>
              <div className="mt-1.5 flex max-w-copy gap-2">
                <select
                  id="compare-add"
                  name={COMPARE_SLOTS[selected.length]}
                  defaultValue=""
                  required
                  aria-describedby={
                    [error && ERROR_ID, hasIncompatible && "compare-scales"]
                      .filter(Boolean)
                      .join(" ") || undefined
                  }
                  className="h-11 min-w-0 flex-1 rounded-md border border-line-input bg-surface px-2 text-base"
                >
                  <option value="" disabled>
                    Choose a measurement
                  </option>
                  {candidates.map(({ measurement, incompatible }) => (
                    <option
                      key={measurement.measurementId}
                      value={measurement.measurementId}
                      disabled={incompatible}
                    >
                      {optionLabel(measurement)}
                      {incompatible ? " · Needs a third axis" : ""}
                    </option>
                  ))}
                </select>
                <button
                  type="submit"
                  disabled={!canAdd}
                  className="h-11 rounded-md bg-accent px-4 text-sm font-semibold text-surface hover:bg-accent-strong disabled:opacity-50"
                >
                  Add
                </button>
              </div>
              <input type="hidden" name="range" value={range} />
              {hasIncompatible ? (
                <p id="compare-scales" className="mt-2 text-sm text-ink-muted">
                  The chart supports two axes. Measurements that need a third have a different type,
                  unit, level datum or rainfall period.
                </p>
              ) : null}
            </form>
          ) : selected.length === COMPARE_SLOTS.length ? (
            <p className="mt-3 text-sm text-ink-muted">Four measurements selected.</p>
          ) : null}

          {ready ? (
            <Comparison measurements={selected} range={range} />
          ) : example && !error && selected.length === 0 ? (
            <p className="mt-6 text-sm text-ink-muted">
              For example,{" "}
              <Link
                className="link"
                href={compareHref(example.map(({ measurementId }) => measurementId))}
                prefetch={false}
              >
                {example[0].stationId === example[1].stationId
                  ? `${example[0].name} ${parameterLabel(example[0].parameter).toLowerCase()} and ${parameterLabel(example[1].parameter).toLowerCase()}`
                  : `${example[0].name} and ${example[1].name}`}
              </Link>
              .
            </p>
          ) : null}
        </>
      )}

      <Attribution measurements={ready ? selected : options} />
    </PageMain>
  );
}
