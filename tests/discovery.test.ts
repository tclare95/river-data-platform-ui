import { describe, expect, it } from "vitest";
import {
  filterItems,
  groupByStation,
  readQuery,
  searchHref,
  typeOptions,
  MAX_QUERY_LENGTH,
} from "@/lib/discovery";
import type { OverviewItem } from "@/lib/overview";
import type { PublicMeasurement } from "@/lib/rdp/public";

const source = { label: "Environment Agency", attribution: "OGL" };

function item(
  measurementId: string,
  stationId: string,
  name: string,
  parameter: string,
  unit = "mASD",
): OverviewItem {
  const measurement: PublicMeasurement = {
    measurementId,
    stationId,
    name,
    parameter,
    unit,
    datum: "ASD",
    kind: "instantaneous",
    expectedIntervalSeconds: 900,
    periodSeconds: null,
    source,
  };
  return { measurement, latest: null };
}

const ITEMS = [
  item("ea-colwick-level", "ea-colwick", "Colwick", "level"),
  item("ea-shardlow-level", "ea-shardlow", "Shardlow", "level"),
  item("ea-shardlow-flow", "ea-shardlow", "Shardlow", "flow", "m3/s"),
  item("x-ynys-level", "x-ynys", "Ynys-y-Bŵl", "level"),
];

const ids = (items: OverviewItem[]) => items.map((entry) => entry.measurement.measurementId);

describe("filterItems", () => {
  it("returns everything for an empty query", () => {
    expect(ids(filterItems(ITEMS, { q: "  ", type: null }))).toHaveLength(4);
  });

  it("matches every word across station, type and provider, ignoring case", () => {
    expect(ids(filterItems(ITEMS, { q: "SHARD flow", type: null }))).toEqual(["ea-shardlow-flow"]);
    expect(ids(filterItems(ITEMS, { q: "water level", type: null }))).toHaveLength(3);
    expect(ids(filterItems(ITEMS, { q: "environment agency colwick", type: null }))).toEqual([
      "ea-colwick-level",
    ]);
  });

  it("ignores accents so names are findable from a plain keyboard", () => {
    expect(ids(filterItems(ITEMS, { q: "bwl", type: null }))).toEqual(["x-ynys-level"]);
  });

  it("filters by a published type and ignores one that is not present", () => {
    expect(ids(filterItems(ITEMS, { q: "", type: "flow" }))).toEqual(["ea-shardlow-flow"]);
    expect(ids(filterItems(ITEMS, { q: "", type: "turbidity" }))).toHaveLength(4);
  });

  it("finds nothing rather than guessing", () => {
    expect(filterItems(ITEMS, { q: "trent", type: null })).toEqual([]);
  });
});

describe("groupByStation", () => {
  it("groups by RDP station identity in catalogue order", () => {
    expect(groupByStation(ITEMS).map((group) => [group.name, group.items.length])).toEqual([
      ["Colwick", 1],
      ["Shardlow", 2],
      ["Ynys-y-Bŵl", 1],
    ]);
  });
});

describe("query parameters", () => {
  it("reads single values, bounds length and drops repeated or empty ones", () => {
    expect(readQuery({ q: "colwick", type: "level" })).toEqual({ q: "colwick", type: "level" });
    expect(readQuery({ q: ["a", "b"], type: "" })).toEqual({ q: "", type: null });
    expect(readQuery({ q: "x".repeat(500) }).q).toHaveLength(MAX_QUERY_LENGTH);
  });

  it("builds a minimal shareable URL", () => {
    expect(searchHref({ q: "", type: null })).toBe("/");
    expect(searchHref({ q: " shardlow ", type: "flow" })).toBe("/?q=shardlow&type=flow");
  });

  it("lists distinct types in catalogue order", () => {
    expect(typeOptions(ITEMS)).toEqual(["level", "flow"]);
  });
});

describe("qualityLabel", () => {
  it("shows plain or JSON-quoted words and hides structured or odd values", async () => {
    const { qualityLabel } = await import("@/lib/labels");
    expect(qualityLabel('"Good"')).toBe("Good");
    expect(qualityLabel("Suspect")).toBe("Suspect");
    expect(qualityLabel('{"quality":"Good","qcode":"X"}')).toBeNull();
    expect(qualityLabel('"<script>"')).toBeNull();
    expect(qualityLabel('"unterminated')).toBeNull();
    expect(qualityLabel(null)).toBeNull();
  });
});
