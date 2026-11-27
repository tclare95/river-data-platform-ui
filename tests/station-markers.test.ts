import { describe, expect, it } from "vitest";
import type { InventoryStation } from "@/lib/inventory";
import { classifyStation, matchesStation } from "@/lib/station-markers";

function measure(
  parameter: string | null,
  qualifier: string | null = null,
  status: InventoryStation["measures"][number]["status"] = "not_published",
) {
  return { parameter, qualifier, status, measurementId: null };
}

describe("station markers", () => {
  it.each([
    ["level", "Stage", "level"],
    ["LEVEL", "Downstream Stage", "level"],
    ["level", null, "level"],
    ["flow", null, "flow"],
    ["rainfall", null, "rainfall"],
    ["level", "Tidal Level", "other"],
    ["level", "Groundwater", "other"],
    ["Tide Level", null, "other"],
    [null, null, "other"],
  ])("classifies %s with qualifier %s as %s", (parameter, qualifier, type) => {
    expect(classifyStation([], [measure(parameter, qualifier)]).type).toBe(type);
  });

  it("counts distinct types across feeds and trusts the catalogue for linked measures", () => {
    const published = [{ measurementId: "linked", parameter: "level" }];
    const known = { ...measure("obsolete", null, "published"), measurementId: "linked" };
    expect(classifyStation(published, [known, measure("level", "Downstream Stage")])).toEqual({
      type: "level",
      parameters: ["level"],
      availability: "published",
    });
    expect(classifyStation(published, [known, measure("rainfall")])).toEqual({
      type: "multiple",
      parameters: ["level", "rainfall"],
      availability: "published",
    });
  });

  it("keeps unknown publication distinct from explicitly discoverable inventory", () => {
    expect(classifyStation([], []).availability).toBe("unknown");
    expect(classifyStation([], [measure("flow")]).availability).toBe("discoverable");
    expect(
      classifyStation([], [measure("rainfall", null, "unknown"), measure("flow")]).availability,
    ).toBe("unknown");
    expect(
      classifyStation([], [measure("rainfall", null, "published"), measure("flow")]).availability,
    ).toBe("published");
  });

  it("matches each listed type of a multi-type station and combines filters", () => {
    const marker = classifyStation([], [measure("level"), measure("rainfall")]);
    expect(matchesStation(marker, { type: "level", availability: "" })).toBe(true);
    expect(matchesStation(marker, { type: "rainfall", availability: "discoverable" })).toBe(true);
    expect(matchesStation(marker, { type: "multiple", availability: "" })).toBe(true);
    expect(matchesStation(marker, { type: "rainfall", availability: "published" })).toBe(false);
    expect(matchesStation(marker, { type: "flow", availability: "" })).toBe(false);
  });
});
