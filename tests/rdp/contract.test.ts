// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  parseCatalogue,
  parseHealth,
  parseHistory,
  parseLatest,
  type Measurement,
} from "@/lib/rdp/contract";
import { createFixtureTransport } from "@/lib/rdp/fixture";

const NOW = Date.parse("2026-11-19T12:07:00Z");
const transport = createFixtureTransport(() => NOW);
const read = (path: string, query: Record<string, string> = {}) =>
  transport({ path, query, timeoutMs: 1000 }) as Promise<
    Record<string, unknown> & { data: unknown; meta: Record<string, unknown> }
  >;
const clone = <T>(value: T): T => structuredClone(value);
const contractError = expect.objectContaining({ code: "RESPONSE_CONTRACT_ERROR" });

async function catalogue() {
  return parseCatalogue(await read("/v1/measurements")).measurements;
}
async function measure(id: string): Promise<Measurement> {
  return (await catalogue()).find((m) => m.measurementId === id)!;
}

describe("catalogue", () => {
  it("separates instantaneous measurements from period totals", async () => {
    const items = await catalogue();
    expect(items.find((m) => m.measurementId === "ea-colwick-level")).toMatchObject({
      kind: "instantaneous",
      unit: "mASD",
    });
    expect(items.find((m) => m.measurementId === "ea-stone-rainfall")).toMatchObject({
      kind: "period_total",
      periodSeconds: 900,
    });
  });

  it("projects only contract fields, dropping anything unknown", async () => {
    const body = clone(await read("/v1/measurements"));
    (body.data as Record<string, unknown>[])[0].internalArn = "arn:aws:secret";
    const parsed = parseCatalogue(body);
    expect(JSON.stringify(parsed)).not.toContain("arn:aws");
  });

  it.each([
    ["a duplicate ID", (d: Record<string, unknown>[]) => d.push(clone(d[0]))],
    ["a malformed ID", (d: Record<string, unknown>[]) => (d[0].measurementId = "../health")],
    [
      "a total in another unit",
      (d: Record<string, unknown>[]) => (d.find((m) => m.valueType === "total")!.unit = "m"),
    ],
    ["an unknown value type", (d: Record<string, unknown>[]) => (d[0].valueType = "mean")],
  ])("rejects %s", async (_name, mutate) => {
    const body = clone(await read("/v1/measurements"));
    mutate(body.data as Record<string, unknown>[]);
    expect(() => parseCatalogue(body)).toThrow(contractError);
  });
});

describe("latest", () => {
  const ids = ["ea-colwick-level", "ea-kegworth-level", "ea-shardlow-flow", "ea-stone-rainfall"];

  it("keeps availability and freshness independent", async () => {
    const measures = await Promise.all(ids.map(measure));
    const batch = parseLatest(
      await read("/v1/measurements/latest", { ids: ids.join(",") }),
      measures,
    );
    expect(batch.items.map((i) => [i.status, i.freshness])).toEqual([
      ["available", "fresh"],
      ["no_observations", "unknown"],
      ["available", "stale"],
      ["available", "stale"],
    ]);
  });

  it("reads a period total as a labelled interval with no instantaneous value", async () => {
    const rain = await measure("ea-stone-rainfall");
    const [item] = parseLatest(
      await read("/v1/measurements/latest", { ids: "ea-stone-rainfall" }),
      [rain],
    ).items;
    expect(item.kind).toBe("period_total");
    expect(item).not.toHaveProperty("value");
    expect(item).not.toHaveProperty("observedAt");
    expect(item).toMatchObject({ labelConvention: "period_end", unit: "mm" });
  });

  it.each([
    ["rows out of request order", (d: Record<string, unknown>[]) => d.reverse()],
    [
      "a unit that disagrees with the catalogue",
      (d: Record<string, unknown>[]) => (d[0].unit = "m"),
    ],
    ["a value without availability", (d: Record<string, unknown>[]) => (d[1].value = 1)],
    ["an available row with no value", (d: Record<string, unknown>[]) => (d[0].value = null)],
    ["an unknown freshness", (d: Record<string, unknown>[]) => (d[0].freshness = "current")],
  ])("rejects %s", async (_name, mutate) => {
    const pair = ["ea-colwick-level", "ea-kegworth-level"];
    const body = clone(await read("/v1/measurements/latest", { ids: pair.join(",") }));
    mutate(body.data as Record<string, unknown>[]);
    const measures = [await measure(pair[0]), await measure(pair[1])];
    expect(() => parseLatest(body, measures)).toThrow(contractError);
  });

  it("refuses a period total presented as an instantaneous reading, and vice versa", async () => {
    const rain = await measure("ea-stone-rainfall");
    const level = await measure("ea-colwick-level");
    const rainBody = clone(await read("/v1/measurements/latest", { ids: "ea-stone-rainfall" }));
    (rainBody.data as Record<string, unknown>[])[0].value = 0.2;
    expect(() => parseLatest(rainBody, [rain])).toThrow(contractError);
    const levelBody = clone(await read("/v1/measurements/latest", { ids: "ea-colwick-level" }));
    (levelBody.data as Record<string, unknown>[])[0].measurementId = "ea-stone-rainfall";
    expect(() => parseLatest(levelBody, [rain])).toThrow(contractError);
    const totalBody = await read("/v1/measurements/latest", { ids: "ea-stone-rainfall" });
    expect(() =>
      parseLatest(totalBody, [{ ...level, measurementId: "ea-stone-rainfall" }]),
    ).toThrow(contractError);
  });

  it("refuses period boundaries for an unverified label convention", async () => {
    const rain = await measure("ea-stone-rainfall");
    const body = clone(await read("/v1/measurements/latest", { ids: "ea-stone-rainfall" }));
    (body.data as Record<string, unknown>[])[0].labelConvention = "unverified";
    expect(() => parseLatest(body, [rain])).toThrow(contractError);
  });
});

describe("health", () => {
  it("parses each kind against its own shape", async () => {
    const level = parseHealth(
      await read("/v1/measurements/ea-colwick-level/health"),
      await measure("ea-colwick-level"),
    );
    expect(level).toMatchObject({ kind: "instantaneous", sourceState: "healthy" });
    const rain = parseHealth(
      await read("/v1/measurements/ea-stone-rainfall/health"),
      await measure("ea-stone-rainfall"),
    );
    expect(rain).toMatchObject({ kind: "period_total", labelConvention: "period_end" });
    const levelBody = await read("/v1/measurements/ea-colwick-level/health");
    const flow = await measure("ea-shardlow-flow");
    expect(() => parseHealth(levelBody, flow)).toThrow(contractError);
  });
});

describe("history", () => {
  const window = { from: "2026-11-18T12:00:00Z", to: "2026-11-19T12:00:00Z" };

  it("keeps coverage unknown even when observations are present", async () => {
    const page = parseHistory(
      await read("/v1/measurements/ea-colwick-level/observations", window),
      await measure("ea-colwick-level"),
    );
    expect(page.kind).toBe("instantaneous");
    if (page.kind !== "instantaneous") return;
    expect(page.observations.length).toBeGreaterThan(0);
    expect(page.coverage.status).toBe("unknown");
  });

  it("returns rainfall intervals with their window summary", async () => {
    const page = parseHistory(
      await read("/v1/measurements/ea-stone-rainfall/observations", window),
      await measure("ea-stone-rainfall"),
    );
    expect(page.kind).toBe("period_total");
    if (page.kind !== "period_total") return;
    expect(page.intervals[0]).toMatchObject({ labelConvention: "period_end" });
    expect(page.intervals[0]).not.toHaveProperty("value");
    expect(page.window?.expectedIntervals).toBe(96);
  });

  it.each([
    [
      "unverified pages",
      (b: Record<string, Record<string, unknown>>) => (b.meta.pageIntegrity = "partial"),
    ],
    [
      "another measurement's page",
      (b: Record<string, Record<string, unknown>>) => (b.meta.measurementId = "ea-shardlow-flow"),
    ],
    ["rows out of order", (b: Record<string, unknown>) => (b.data as unknown[]).reverse()],
    [
      "a row outside the window",
      (b: Record<string, unknown>) =>
        ((b.data as Record<string, unknown>[])[0].observedAt = "2026-11-17T00:00:00Z"),
    ],
    [
      "a datum change",
      (b: Record<string, unknown>) => ((b.data as Record<string, unknown>[])[0].datum = "OD"),
    ],
    [
      "a non-numeric value",
      (b: Record<string, unknown>) => ((b.data as Record<string, unknown>[])[0].value = "1.2"),
    ],
    [
      "a rainfall shape for a level",
      (b: Record<string, Record<string, unknown>>) => (b.meta.valueType = "total"),
    ],
  ])("rejects %s", async (_name, mutate) => {
    const body = clone(await read("/v1/measurements/ea-colwick-level/observations", window));
    mutate(body as never);
    const level = await measure("ea-colwick-level");
    expect(() => parseHistory(body, level)).toThrow(contractError);
  });

  it("accepts RDP's seven-digit fractional timestamps", async () => {
    const body = clone(await read("/v1/measurements/ea-colwick-level/observations", window));
    const first = (body.data as Record<string, string>[])[0].observedAt;
    expect(first).toMatch(/\.0000000Z$/);
    const page = parseHistory(body, await measure("ea-colwick-level"));
    // The original timestamp string is preserved, not re-serialised.
    expect(page.kind === "instantaneous" && page.observations[0].observedAt).toBe(first);
  });
});
