import { describe, expect, it } from "vitest";
import { explorerSharePath, readExplorerState, writeExplorerParams } from "@/lib/explorer-state";

describe("Explorer links", () => {
  it("round-trips public map and comparison state through the server and browser parsers", () => {
    const state = readExplorerState({
      q: "private free text",
      type: "level",
      station: "ea-shardlow",
      lon: "-1.3",
      lat: "52.8",
      zoom: "8.5",
      traceLon: "-1.25",
      traceLat: "52.5",
      direction: "upstream",
      routes: "both",
      catchment: "hide",
      hide: "downstream",
      stations: "show",
      a: "ea-shardlow-level",
      b: "ea-stone-rainfall",
      oa: "-1440",
      ob: "30",
      range: "30d",
      rain: "hourly",
      token: "private query parameter",
    });
    const path = explorerSharePath(state);
    expect(path).not.toContain("private");
    const params = new URL(path, "https://explorer.example").searchParams;
    expect(readExplorerState(params)).toEqual({
      ...state,
      query: { q: "", type: "level" },
    });
  });

  it("leaves the destination URL alone if Explorer is still mounted during navigation", () => {
    history.replaceState(null, "", "/about?range=original#main");
    try {
      writeExplorerParams({ range: "30d" }, true);
      expect(location.pathname + location.search + location.hash).toBe(
        "/about?range=original#main",
      );
    } finally {
      history.replaceState(null, "", "/");
    }
  });

  it("bounds all fields and keeps offsets attached to their measurements when a slot is dropped", () => {
    const params = new URLSearchParams({
      a: "x".repeat(81),
      b: "ea-shardlow-level",
      c: "ea-stone-rainfall",
      d: "ea-stone-rainfall",
      oa: "20",
      ob: "-1441",
      oc: "45",
      od: "50",
      range: "366d",
      rain: "constructor",
      station: "s".repeat(129),
      inventory: "not a key",
      lon: "-181",
      lat: "52",
      zoom: "999",
      traceLon: "1e-5",
      traceLat: "52",
      direction: "upstream",
    });
    params.append("b", "ea-duplicate");
    const state = readExplorerState(params);
    expect(state).toMatchObject({
      invalidSelection: true,
      map: { station: undefined, inventory: undefined, view: undefined, trace: undefined },
      ids: ["ea-stone-rainfall"],
      range: "7d",
      presentation: { mode: "24h", offsets: { "ea-stone-rainfall": 45 } },
    });
    expect(explorerSharePath(state)).toBe("/?a=ea-stone-rainfall&oa=45");
  });
});
