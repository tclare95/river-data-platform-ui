/**
 * Client-safe discovery over the published catalogue: search, a type filter and grouping by station.
 * Operates only on fields RDP publishes; nothing here infers rivers, places or positions.
 */
import type { OverviewItem } from "@/lib/overview";
import { parameterLabel } from "@/lib/labels";

export type DiscoveryQuery = { q: string; type: string | null };

export const MAX_QUERY_LENGTH = 100;

function fold(text: string): string {
  return text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}

function haystack({ measurement }: OverviewItem): string {
  return fold(
    [
      measurement.name,
      parameterLabel(measurement.parameter),
      measurement.parameter,
      measurement.source.label,
      measurement.unit,
      measurement.measurementId,
    ].join(" "),
  );
}

/** Reads `?q=&type=` defensively: repeated, oversized or unknown values fall back to no filter. */
export function readQuery(params: Record<string, string | string[] | undefined>): DiscoveryQuery {
  const one = (value: string | string[] | undefined) => (typeof value === "string" ? value : "");
  const type = one(params.type).trim();
  return { q: one(params.q).slice(0, MAX_QUERY_LENGTH), type: type || null };
}

/** The distinct measurement types present, in catalogue order. */
export function typeOptions(items: readonly OverviewItem[]): string[] {
  return [...new Set(items.map((item) => item.measurement.parameter))];
}

/** Every search word must appear (accent- and case-insensitive); an unknown type is ignored. */
export function filterItems(items: readonly OverviewItem[], query: DiscoveryQuery): OverviewItem[] {
  const words = fold(query.q).split(/\s+/).filter(Boolean);
  const type = query.type && typeOptions(items).includes(query.type) ? query.type : null;
  return items.filter((item) => {
    if (type && item.measurement.parameter !== type) return false;
    const text = haystack(item);
    return words.every((word) => text.includes(word));
  });
}

export type StationGroup = { stationId: string; name: string; items: OverviewItem[] };

/**
 * Groups measurements under their RDP station, keeping catalogue order for stations and measurements. The heading is
 * the catalogue `name`, which RDP defines as the station label (READ-API.md), so every member shares it.
 */
export function groupByStation(items: readonly OverviewItem[]): StationGroup[] {
  const groups = new Map<string, StationGroup>();
  for (const item of items) {
    const { stationId, name } = item.measurement;
    const group = groups.get(stationId) ?? { stationId, name, items: [] };
    group.items.push(item);
    groups.set(stationId, group);
  }
  return [...groups.values()];
}

export function searchHref(query: DiscoveryQuery): string {
  const params = new URLSearchParams();
  if (query.q.trim()) params.set("q", query.q.trim());
  if (query.type) params.set("type", query.type);
  const search = params.toString();
  return search ? `/?${search}` : "/";
}
