"use client";

import Link from "next/link";
import { useEffect, useId, useMemo, useState } from "react";
import { MeasurementList } from "@/components/measurement-list";
import { EmptyState } from "@/components/states";
import { Button } from "@/components/button";
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

export const ANNOUNCE_DELAY_MS = 500;

function plural(count: number, one: string, many: string) {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * Search and filter over the already-loaded public catalogue. Without JavaScript the form submits `?q=&type=` and
 * the server renders the same filtered result; with it, results update as the visitor types and the URL follows.
 */
export function MeasurementExplorer({
  items,
  initialQuery,
}: {
  items: readonly OverviewItem[];
  initialQuery: DiscoveryQuery;
}) {
  // On first load the URL and the server's query are the same. When the router restores this page (Back), it reuses
  // the original server payload, so the current URL is the truth.
  const [start] = useState(() =>
    typeof window === "undefined"
      ? initialQuery
      : readQuery(Object.fromEntries(new URLSearchParams(window.location.search))),
  );
  const [q, setQ] = useState(start.q);
  const types = useMemo(() => typeOptions(items), [items]);
  const [type, setType] = useState(start.type && types.includes(start.type) ? start.type : null);
  const searchId = useId();

  const results = useMemo(() => filterItems(items, { q, type }), [items, q, type]);
  const groups = useMemo(() => groupByStation(results), [results]);
  const filtered = q.trim() !== "" || type !== null;

  useEffect(() => {
    // Keep the current view shareable without adding a history entry per keystroke.
    // Only `q` and `type` are ours: other parameters and the fragment are kept.
    const url = new URL(window.location.href);
    const ours = new URL(searchHref({ q, type }), url.origin).searchParams;
    for (const name of ["q", "type"]) {
      const value = ours.get(name);
      if (value === null) url.searchParams.delete(name);
      else url.searchParams.set(name, value);
    }
    if (url.href !== window.location.href)
      // `null` state: Next adopts the new URL as canonical (its documented integration), so Back restores it.
      window.history.replaceState(null, "", url);
  }, [q, type]);

  const count = filtered
    ? results.length === 0
      ? "No measurements found"
      : `${plural(results.length, "measurement", "measurements")} found`
    : `${plural(items.length, "measurement", "measurements")} at ${plural(groupByStation(items).length, "station", "stations")}`;
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
        className="space-y-4"
      >
        <div>
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
            placeholder="Station name or measurement type"
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

      <p className="mt-6 text-sm text-ink-muted">{count}</p>
      {/* Announced once typing pauses, not on every keystroke. */}
      <p role="status" className="sr-only">
        {announcement}
      </p>

      <div className="mt-3">
        {groups.length > 0 ? (
          <MeasurementList groups={groups} />
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
            Try a station name, or a type such as level, flow or rainfall.
          </EmptyState>
        )}
      </div>
    </>
  );
}
