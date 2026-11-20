import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Comparison } from "@/components/compare/comparison";
import { PageMain } from "@/components/container";
import { PageHeader } from "@/components/page-header";
import { Attribution, FixtureNote } from "@/components/provenance";
import { EmptyState, ErrorState } from "@/components/states";
import { compareHref, readCompareQuery } from "@/lib/compare";
import { loadComparable } from "@/lib/compare-load";
import type { HistoryRange } from "@/lib/history/range";
import { parameterLabel } from "@/lib/labels";
import type { PublicMeasurement } from "@/lib/rdp/public";

export const metadata: Metadata = { title: "Compare" };

function optionLabel(measurement: PublicMeasurement) {
  return `${measurement.name} · ${parameterLabel(measurement.parameter)} (${measurement.unit})`;
}

function MeasurementSelect({
  name,
  label,
  options,
  value,
}: {
  name: "a" | "b";
  label: string;
  options: readonly PublicMeasurement[];
  value: string | null;
}) {
  const id = `compare-${name}`;
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
      </label>
      <select
        id={id}
        name={name}
        defaultValue={value ?? ""}
        className="mt-1.5 block h-11 w-full rounded-md border border-line-input bg-surface px-3 text-base focus-visible:border-accent"
      >
        <option value="">Choose a measurement</option>
        {options.map((measurement) => (
          <option key={measurement.measurementId} value={measurement.measurementId}>
            {optionLabel(measurement)}
          </option>
        ))}
      </select>
    </div>
  );
}

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
  const find = (id: string | null) => options.find((item) => item.measurementId === id) ?? null;
  const a = find(query.a);
  const b = find(query.b);
  // An unknown, restricted or uncomparable ID is treated as not chosen, without saying which it was.
  const unknown = (query.a !== null && !a) || (query.b !== null && !b);
  const same = a !== null && b !== null && a.measurementId === b.measurementId;
  const ready = a !== null && b !== null && !same;
  const range: HistoryRange = query.range;
  const example = suggestion(options);

  return (
    <PageMain>
      <PageHeader
        title="Compare measurements"
        description="Two measurements over the same period, each in its own unit."
      />
      {catalogue.mode === "fixture" ? <FixtureNote className="mt-4" /> : null}

      {options.length < 2 ? (
        <EmptyState title="Not enough measurements to compare yet" className="mt-8" />
      ) : (
        <>
          <form
            action="/compare"
            method="get"
            aria-label="Choose measurements"
            className="mt-8 grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end"
          >
            <MeasurementSelect
              name="a"
              label="First measurement"
              options={options}
              value={a?.measurementId ?? null}
            />
            <MeasurementSelect
              name="b"
              label="Second measurement"
              options={options}
              value={same ? null : (b?.measurementId ?? null)}
            />
            <input type="hidden" name="range" value={range} />
            <button
              type="submit"
              className="inline-flex h-11 items-center justify-center rounded-md bg-accent px-5 text-sm font-semibold text-surface transition-colors hover:bg-accent-strong"
            >
              Compare
            </button>
          </form>

          {unknown || same ? (
            <p role="alert" className="mt-4 text-sm font-medium text-danger">
              {same
                ? "Choose two different measurements."
                : "One of those measurements isn’t available to compare. Choose another."}
            </p>
          ) : null}

          {ready ? (
            <Comparison a={a} b={b} range={range} />
          ) : example && !unknown && !same ? (
            <p className="mt-6 text-sm text-ink-muted">
              For example,{" "}
              <Link
                className="link"
                href={compareHref({ a: example[0].measurementId, b: example[1].measurementId })}
              >
                {example[0].stationId === example[1].stationId
                  ? `${example[0].name} ${parameterLabel(example[0].parameter).toLowerCase()} and ${parameterLabel(example[1].parameter).toLowerCase()}`
                  : `${example[0].name} and ${example[1].name}`}
              </Link>
              .
            </p>
          ) : null}
          {catalogue.excluded ? (
            <p className="mt-6 text-sm text-ink-muted">Rainfall can’t be compared yet.</p>
          ) : null}
        </>
      )}

      <Attribution measurements={ready ? [a, b] : options} />
    </PageMain>
  );
}
