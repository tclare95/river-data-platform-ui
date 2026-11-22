"use client";

import Link from "next/link";
import { useEffect, useId, useMemo, useState } from "react";
import { MeasurementList } from "@/components/measurement-list";
import { StationMap } from "@/components/station-map";
import { EmptyState } from "@/components/states";
import { Button } from "@/components/button";
import {
  COMPARE_SLOTS,
  compareHref,
  compareParams,
  comparisonLabel,
  needsMoreCompareAxes,
  readCompareQuery,
} from "@/lib/compare";
import {
  filterItems,
  groupByStation,
  MAX_QUERY_LENGTH,
  readQuery,
  searchHref,
  typeOptions,
  type DiscoveryQuery,
} from "@/lib/discovery";
import { parameterLabel } from "@/lib/labels";
import type { OverviewItem } from "@/lib/overview";
import type { PublicMeasurement } from "@/lib/rdp/public";

export const ANNOUNCE_DELAY_MS = 500;

function plural(count: number, one: string, many: string) {
  return `${count} ${count === 1 ? one : many}`;
}

function comparisonBlock(selected: readonly PublicMeasurement[], candidate: PublicMeasurement) {
  if (selected.some(({ measurementId }) => measurementId === candidate.measurementId)) {
    return "Added to comparison";
  }
  if (selected.length >= COMPARE_SLOTS.length) return "Four measurements selected";
  if (needsMoreCompareAxes([...selected, candidate])) return "Needs a third axis";
}

/**
 * Search and filter over the already-loaded public catalogue. Without JavaScript the form submits `?q=&type=` and
 * the server renders the same filtered result; with it, results update as the visitor types and the URL follows.
 */
export function MeasurementExplorer({
  items,
  initialQuery,
  initialComparison,
}: {
  items: readonly OverviewItem[];
  initialQuery: DiscoveryQuery;
  initialComparison?: ReturnType<typeof readCompareQuery>;
}) {
  // On first load the URL and the server's query are the same. When the router restores this page (Back), it reuses
  // the original server payload, so the current URL is the truth.
  const [start] = useState(() => {
    if (typeof window === "undefined")
      return { query: initialQuery, comparison: initialComparison };
    const params = new URLSearchParams(window.location.search);
    return { query: readQuery(Object.fromEntries(params)), comparison: readCompareQuery(params) };
  });
  const [selected, setSelected] = useState(() => {
    const restored: PublicMeasurement[] = [];
    if (!start.comparison?.repeated) {
      for (const id of start.comparison?.ids ?? []) {
        const measurement = items.find(
          ({ measurement }) => measurement.measurementId === id,
        )?.measurement;
        if (measurement && !comparisonBlock(restored, measurement)) restored.push(measurement);
      }
    }
    return restored;
  });
  const ids = useMemo(() => selected.map(({ measurementId }) => measurementId), [selected]);
  const addToComparison = (measurement: PublicMeasurement) => {
    const blocked = comparisonBlock(selected, measurement);
    return (
      <Button
        aria-label={`${blocked ?? "Add to comparison"}: ${comparisonLabel(measurement)}`}
        aria-disabled={!!blocked}
        onClick={() =>
          setSelected((current) =>
            comparisonBlock(current, measurement) ? current : [...current, measurement],
          )
        }
        className="relative z-10 w-fit [@media(scripting:none)]:hidden"
      >
        {blocked ?? "Add to comparison"}
      </Button>
    );
  };
  const [q, setQ] = useState(start.query.q);
  const types = useMemo(() => typeOptions(items), [items]);
  const [type, setType] = useState(
    start.query.type && types.includes(start.query.type) ? start.query.type : null,
  );
  const searchId = useId();
  const listId = useId();

  const results = useMemo(() => filterItems(items, { q, type }), [items, q, type]);
  const groups = useMemo(() => groupByStation(results), [results]);
  const catalogueGroups = useMemo(() => groupByStation(items), [items]);
  const catalogueByStation = useMemo(
    () => new Map(catalogueGroups.map((group) => [group.stationId, group])),
    [catalogueGroups],
  );
  const locations = useMemo(
    () =>
      new Map(
        items.flatMap(({ measurement: { stationId, position, locationEvidence, source } }) =>
          position ? [[stationId, { position, locationEvidence, source }] as const] : [],
        ),
      ),
    [items],
  );
  const stations = useMemo(
    () =>
      groups.flatMap(({ stationId }) => {
        const location = locations.get(stationId);
        const group = catalogueByStation.get(stationId);
        return location && group ? [{ ...group, ...location }] : [];
      }),
    [catalogueByStation, groups, locations],
  );
  // Once initialized, keep the map and its viewport through filters with no mapped results.
  const [mapStarted, setMapStarted] = useState(stations.length > 0);
  if (!mapStarted && stations.length > 0) setMapStarted(true);
  const filtered = q.trim() !== "" || type !== null;

  useEffect(() => {
    // Keep the current view shareable without adding a history entry per keystroke.
    // Update only the explorer filters and comparison slots.
    const url = new URL(window.location.href);
    const ours = new URL(searchHref({ q, type }), url.origin).searchParams;
    compareParams(ids).forEach((value, name) => ours.set(name, value));
    for (const name of ["q", "type", ...COMPARE_SLOTS]) {
      const value = ours.get(name);
      if (value === null) url.searchParams.delete(name);
      else url.searchParams.set(name, value);
    }
    if (url.href !== window.location.href)
      // `null` state: Next adopts the new URL as canonical (its documented integration), so Back restores it.
      window.history.replaceState(null, "", url);
  }, [q, type, ids]);

  const count = filtered
    ? results.length === 0
      ? "No measurements found"
      : `${plural(results.length, "measurement", "measurements")} found`
    : `${plural(items.length, "measurement", "measurements")} at ${plural(catalogueGroups.length, "station", "stations")}`;
  const [announcement, setAnnouncement] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setAnnouncement(filtered ? count : ""), ANNOUNCE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [count, filtered]);

  const reset = () => {
    setQ("");
    setType(null);
  };

  return (
    <>
      <form
        role="search"
        action="/"
        method="get"
        onSubmit={(event) => event.preventDefault()}
        className="space-y-4 lg:flex lg:flex-wrap lg:items-end lg:gap-x-6 lg:gap-y-4 lg:space-y-0"
      >
        {ids.map((id, index) => (
          <input key={id} type="hidden" name={COMPARE_SLOTS[index]} value={id} />
        ))}
        <div className="lg:w-full lg:max-w-lg">
          <label htmlFor={searchId} className="block text-sm font-medium">
            Search
          </label>
          <input
            id={searchId}
            type="search"
            name="q"
            value={q}
            maxLength={MAX_QUERY_LENGTH}
            onChange={(event) => setQ(event.target.value)}
            placeholder="Station, river or measurement type"
            autoComplete="off"
            spellCheck={false}
            className="mt-1.5 block h-11 w-full max-w-copy rounded-md border border-line-input bg-surface px-3 text-base placeholder:text-ink-muted focus-visible:border-accent"
          />
        </div>
        {/* Shown whenever it can narrow results, or when the URL already applied a type. */}
        {types.length > 1 || type !== null ? (
          <fieldset>
            <legend className="text-sm font-medium">Type</legend>
            <div className="mt-1.5 flex flex-wrap gap-2">
              {[null, ...types].map((value) => (
                <label
                  key={value ?? "all"}
                  className="inline-flex h-10 cursor-pointer items-center rounded-full border border-line-strong bg-surface px-3.5 text-sm has-checked:border-accent has-checked:bg-accent-soft has-checked:font-semibold has-checked:text-accent-strong has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-accent"
                >
                  <input
                    type="radio"
                    name="type"
                    value={value ?? ""}
                    checked={type === value}
                    onChange={() => setType(value)}
                    className="sr-only"
                  />
                  {value === null ? "All" : parameterLabel(value)}
                </label>
              ))}
            </div>
          </fieldset>
        ) : null}
        <noscript>
          <Button type="submit">Search</Button>
        </noscript>
      </form>

      <div className="mt-4 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm">
        <p className="text-ink-muted">{count}</p>
        {mapStarted ? (
          <a
            href={`#${listId}`}
            className="link lg:sr-only lg:focus:not-sr-only [@media(scripting:none)]:hidden"
          >
            Browse stations
          </a>
        ) : null}
      </div>
      {/* Announced once typing pauses, not on every keystroke. */}
      <p role="status" className="sr-only">
        {announcement}
      </p>

      <section
        aria-label="Comparison selection"
        className="sticky top-0 z-20 mt-3 max-h-[40svh] overflow-auto rounded-lg border border-line bg-surface px-4 py-2 [@media(scripting:none)]:hidden"
      >
        <div className="flex min-h-10 flex-wrap items-center justify-between gap-x-3">
          <p aria-live="polite" className="text-sm font-medium">
            {selected.length === 0
              ? "Add measurements to compare"
              : `${selected.length} of ${COMPARE_SLOTS.length} selected`}
            {selected.length === 1 ? " · Add another to compare" : ""}
          </p>
          {selected.length >= 2 ? (
            <Link
              href={compareHref(ids)}
              prefetch={false}
              className="inline-flex min-h-10 items-center rounded-md bg-accent px-4 text-sm font-semibold text-surface hover:bg-accent-strong"
            >
              Compare selected measurements
            </Link>
          ) : null}
        </div>
        {selected.length > 0 ? (
          <ul aria-label="Selected measurements" className="mt-1 flex flex-wrap gap-1.5">
            {selected.map((measurement) => (
              <li
                key={measurement.measurementId}
                className="flex items-center gap-2 rounded-md border border-line px-2 text-sm"
              >
                {comparisonLabel(measurement)}
                <button
                  type="button"
                  aria-label={`Remove ${comparisonLabel(measurement)}`}
                  className="link min-h-10"
                  onClick={() =>
                    setSelected((current) =>
                      current.filter(
                        ({ measurementId }) => measurementId !== measurement.measurementId,
                      ),
                    )
                  }
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <div className="mt-3 flex flex-col gap-5 lg:flex-row lg:items-start">
        {mapStarted ? (
          <div className="min-w-0 lg:w-2/3 lg:shrink-0 [@media(scripting:none)]:hidden">
            <StationMap stations={stations} comparisonAction={addToComparison} />
          </div>
        ) : null}
        <section aria-labelledby={listId} className="@container min-w-0 flex-1">
          <h2 id={listId} tabIndex={-1} className="mb-3 text-lg font-semibold">
            Stations
          </h2>
          {groups.length > 0 ? (
            <MeasurementList groups={groups} comparisonAction={addToComparison} />
          ) : (
            <EmptyState
              title="No matching measurements"
              // A real link, so it also clears a script-free GET search.
              action={
                <Link
                  href="/"
                  onClick={(event) => {
                    event.preventDefault();
                    reset();
                  }}
                  className="inline-flex min-h-10 items-center rounded-md border border-line-strong bg-surface px-3.5 text-sm font-medium transition-colors hover:bg-canvas"
                >
                  Clear search
                </Link>
              }
            >
              Try a station, river or measurement type.
            </EmptyState>
          )}
        </section>
      </div>
    </>
  );
}
