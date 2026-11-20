import { describe, expect, it } from "vitest";
import { DEFAULT_RANGE, HISTORY_RANGES, parseRange, rangeWindow } from "@/lib/history/range";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ISO_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe("parseRange", () => {
  it.each([
    ["missing", undefined],
    ["repeated", ["30d", "7d"]],
    ["unsupported", "90d"],
    ["empty", ""],
    ["differently cased", "30D"],
    ["an inherited key", "toString"],
    ["a number", 30],
  ])("falls back to 7 days when %s", (_name, value) => {
    expect(parseRange(value)).toBe("7d");
  });

  it("accepts each supported range", () => {
    expect(DEFAULT_RANGE).toBe("7d");
    expect(parseRange("7d")).toBe("7d");
    expect(parseRange("30d")).toBe("30d");
    expect(Object.keys(HISTORY_RANGES)).toEqual(["7d", "30d"]);
  });
});

describe("rangeWindow", () => {
  it("ends at the next whole UTC hour", () => {
    expect(rangeWindow("7d", Date.parse("2026-11-19T12:07:42.123Z"))).toEqual({
      from: "2026-11-12T13:00:00.000Z",
      to: "2026-11-19T13:00:00.000Z",
    });
  });

  it("ends at now when now is exactly on the hour", () => {
    expect(rangeWindow("7d", Date.parse("2026-11-19T12:00:00.000Z")).to).toBe(
      "2026-11-19T12:00:00.000Z",
    );
    expect(rangeWindow("7d", Date.parse("2026-11-19T12:00:00.001Z")).to).toBe(
      "2026-11-19T13:00:00.000Z",
    );
  });

  it("gives every load within one hour the same window", () => {
    const first = rangeWindow("30d", Date.parse("2026-11-19T12:00:00.001Z"));
    const last = rangeWindow("30d", Date.parse("2026-11-19T12:59:59.999Z"));
    expect(last).toEqual(first);
  });

  it.each([
    ["7d", 7],
    ["30d", 30],
  ] as const)("spans exactly %s with from before to, as UTC ISO strings", (range, days) => {
    const window = rangeWindow(range, Date.parse("2026-03-29T00:30:00Z"));
    const from = Date.parse(window.from);
    const to = Date.parse(window.to);
    expect(from).toBeLessThan(to);
    expect(to - from).toBe(days * DAY);
    expect(from % HOUR).toBe(0);
    expect(to % HOUR).toBe(0);
    expect(window.from).toMatch(ISO_Z);
    expect(window.to).toMatch(ISO_Z);
  });

  it("crosses a month boundary for 30 days", () => {
    expect(rangeWindow("30d", Date.parse("2026-11-19T12:07:00Z"))).toEqual({
      from: "2026-10-20T13:00:00.000Z",
      to: "2026-11-19T13:00:00.000Z",
    });
  });
});
