"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { InlineComparison } from "@/components/compare/inline-comparison";
import { MeasurementList } from "@/components/measurement-list";
import { StationMap } from "@/components/station-map";
import { EmptyState, ErrorState } from "@/components/states";
import { Button } from "@/components/button";
import { COMPARE_SLOTS, compareHref, comparisonLabel, needsMoreCompareAxes } from "@/lib/compare";
import {
  filterItems,
  groupByStation,
  MAX_QUERY_LENGTH,
  typeOptions,
  type DiscoveryQuery,
} from "@/lib/discovery";
import { parameterLabel } from "@/lib/labels";
import { DEFAULT_RANGE } from "@/lib/history/range";
import {
  explorerComparisonParams,
  explorerMapParams,
  explorerSharePath,
  readExplorerState,
  writeExplorerParams,
  type ExplorerState,
} from "@/lib/explorer-state";
import { readMapContext, type MapContext } from "@/lib/map-context";
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

function restoreSelection(state: ExplorerState, items: readonly OverviewItem[]): ExplorerState {
  const selected: PublicMeasurement[] = [];
  for (const id of state.ids) {
    const measurement = items.find(
      ({ measurement }) => measurement.measurementId === id,
    )?.measurement;
    if (measurement && !comparisonBlock(selected, measurement)) selected.push(measurement);
  }
  return {
    ...state,
    ids: selected.map(({ measurementId }) => measurementId),
    invalidSelection: state.invalidSelection || selected.length !== state.ids.length,
    query: {
      ...state.query,
      type: typeOptions(items).includes(state.query.type ?? "") ? state.query.type : null,
    },
  };
}

export function MeasurementExplorer({
  items,
  initialQuery = { q: "", type: null },
  initialState,
  catalogueUnavailable,
}: {
  items: readonly OverviewItem[];
  initialQuery?: DiscoveryQuery;
  initialState?: ExplorerState;
  catalogueUnavailable?: boolean;
}) {
  // The router can restore a cached server payload whose query predates native history updates.
  const [state, setState] = useState(() =>
    restoreSelection(
      typeof window === "undefined"
        ? (initialState ?? { ...readExplorerState({}), query: initialQuery })
        : readExplorerState(new URLSearchParams(window.location.search)),
      items,
    ),
  );
  const {
    query: { q, type },
    ids,
    range,
    presentation,
    invalidSelection,
  } = state;
  const [mapRestore, setMapRestore] = useState({ context: state.map, revision: 0 });
  const currentMap = useRef(JSON.stringify(explorerMapParams(state.map)));
  const shareInput = useRef<HTMLInputElement>(null);
  const [shareResult, setShareResult] = useState({ copied: false, url: "" });
  const sharedRange = range === DEFAULT_RANGE ? undefined : range;
  const selected = useMemo(
    () =>
      ids.flatMap((id) => {
        const item = items.find(({ measurement }) => measurement.measurementId === id);
        return item ? [item.measurement] : [];
      }),
    [ids, items],
  );

  const rememberMap = useCallback((context: MapContext) => {
    currentMap.current = JSON.stringify(explorerMapParams(context));
  }, []);

  useEffect(() => {
    const restore = () => {
      if (location.pathname !== "/") return;
      const next = restoreSelection(readExplorerState(new URLSearchParams(location.search)), items);
      const mapKey = JSON.stringify(explorerMapParams(next.map));
      if (mapKey !== currentMap.current) {
        currentMap.current = mapKey;
        setMapRestore(({ revision }) => ({ context: next.map, revision: revision + 1 }));
      }
      setState(next);
      setShareResult({ copied: false, url: "" });
    };
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, [items]);

  useEffect(() => {
    if (!catalogueUnavailable) writeExplorerParams(explorerComparisonParams(state));
  }, [catalogueUnavailable, state]);

  function updateComparison(
    change: Partial<Pick<ExplorerState, "ids" | "range" | "presentation">>,
  ) {
    const next = { ...state, ...change };
    writeExplorerParams(explorerComparisonParams(next), true);
    setState(next);
  }

  function updateSearch(query: DiscoveryQuery) {
    writeExplorerParams(
      { q: query.q.trim() || undefined, type: query.type ?? undefined },
      query.type !== type,
    );
    setState({ ...state, query });
  }

  async function copyExplorerLink() {
    const map = readMapContext(new URLSearchParams(location.search));
    const url = new URL(explorerSharePath({ ...state, map }), location.origin).href;
    try {
      await navigator.clipboard.writeText(url);
      setShareResult({ copied: true, url: "" });
    } catch {
      setShareResult({ copied: false, url });
    }
  }

  useEffect(() => {
    if (shareResult.url) shareInput.current?.select();
  }, [shareResult.url]);
  const addToComparison = (measurement: PublicMeasurement) => {
    const blocked = items.some(
      ({ measurement: item }) => item.measurementId === measurement.measurementId,
    )
      ? comparisonBlock(selected, measurement)
      : "Measurement unavailable";
    return (
      <Button
        aria-label={`${blocked ?? "Add to comparison"}: ${comparisonLabel(measurement)}`}
        aria-disabled={!!blocked}
        onClick={() => {
          if (!blocked) updateComparison({ ids: [...ids, measurement.measurementId] });
        }}
        className="relative z-10 w-fit [@media(scripting:none)]:hidden"
      >
        {blocked ?? "Add to comparison"}
      </Button>
    );
  };
  const types = useMemo(() => typeOptions(items), [items]);
  const searchId = useId();
  const listId = useId();

  const results = useMemo(() => filterItems(items, { q, type }), [items, q, type]);
  const groups = useMemo(() => groupByStation(results), [results]);
  const catalogueGroups = useMemo(() => groupByStation(items), [items]);
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
      catalogueGroups.flatMap((group) => {
        const location = locations.get(group.stationId);
        return location ? [{ ...group, ...location }] : [];
      }),
    [catalogueGroups, locations],
  );
  const filteredStationIds = useMemo(
    () => new Set(groups.map(({ stationId }) => stationId)),
    [groups],
  );
  const filtered = q.trim() !== "" || type !== null;

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

  return (
    <div className="flex flex-col gap-5 lg:flex-row lg:items-start">
      <div className="min-w-0 lg:w-2/3 lg:shrink-0 [@media(scripting:none)]:hidden">
        <a
          href={`#${listId}`}
          className="link mb-2 inline-block text-sm lg:sr-only lg:focus:not-sr-only"
        >
          Browse stations
        </a>
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <Button onClick={() => void copyExplorerLink()}>Copy Explorer link</Button>
          <span aria-live="polite" className="text-sm">
            {shareResult.copied ? "Link copied" : ""}
          </span>
          {shareResult.url ? (
            <label className="min-w-0 flex-1 text-sm">
              Copy this link
              <input
                ref={shareInput}
                readOnly
                value={shareResult.url}
                className="w-full rounded border border-line-input px-2 py-1"
              />
            </label>
          ) : null}
        </div>
        <StationMap
          key={mapRestore.revision}
          stations={stations}
          items={items}
          filteredStationIds={filteredStationIds}
          initialContext={mapRestore.context}
          onMapUrlChange={rememberMap}
          comparisonAction={addToComparison}
        />
        {invalidSelection && !catalogueUnavailable ? (
          <p className="mt-3 text-sm text-ink-muted">
            Some measurements in this link could not be included.
          </p>
        ) : null}
        {items.length > 0 ? (
          <section
            aria-label="Comparison selection"
            className="mt-5 rounded-lg border border-line bg-surface px-4 py-2"
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
                  href={compareHref(ids, sharedRange)}
                  prefetch={false}
                  className="inline-flex min-h-10 items-center rounded-md bg-accent px-4 text-sm font-semibold text-surface hover:bg-accent-strong"
                >
                  Open full comparison
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
                      onClick={() => {
                        const offsets = { ...presentation.offsets };
                        delete offsets[measurement.measurementId];
                        updateComparison({
                          ids: ids.filter((id) => id !== measurement.measurementId),
                          presentation: { ...presentation, offsets },
                        });
                      }}
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        ) : null}
        {ids.length >= 2 ? (
          <InlineComparison
            ids={ids}
            range={range}
            onRangeChange={(range) => updateComparison({ range })}
            presentation={presentation}
            onPresentationChange={(presentation) => updateComparison({ presentation })}
          />
        ) : null}
      </div>
      <div className="min-w-0 flex-1">
        {items.length > 0 ? (
          <>
            <form
              role="search"
              action="/"
              method="get"
              onSubmit={(event) => event.preventDefault()}
              className="space-y-4 lg:flex lg:flex-wrap lg:items-end lg:gap-x-6 lg:gap-y-4 lg:space-y-0"
            >
              {Object.entries({
                ...explorerComparisonParams(state),
                ...explorerMapParams(mapRestore.context),
              }).map(([name, value]) =>
                value === undefined ? null : (
                  <input key={name} type="hidden" name={name} value={value} />
                ),
              )}
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
                  onChange={(event) => updateSearch({ q: event.target.value, type })}
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
                          onChange={() => updateSearch({ q, type: value })}
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

            <p className="mt-4 text-sm text-ink-muted">{count}</p>
            {/* Announced once typing pauses, not on every keystroke. */}
            <p role="status" className="sr-only">
              {announcement}
            </p>
          </>
        ) : null}
        <section aria-labelledby={listId} className="@container mt-3 min-w-0">
          <h2 id={listId} tabIndex={-1} className="mb-3 text-lg font-semibold">
            Stations
          </h2>
          {ids.length >= 2 ? (
            <a href="#explorer-comparison" className="link mb-3 inline-block text-sm">
              View comparison chart
            </a>
          ) : null}
          {catalogueUnavailable ? (
            <ErrorState title="Measurements are unavailable right now">
              Please try again in a few minutes.
            </ErrorState>
          ) : items.length === 0 ? (
            <EmptyState title="No measurements to show yet" />
          ) : groups.length > 0 ? (
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
                    updateSearch({ q: "", type: null });
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
    </div>
  );
}
