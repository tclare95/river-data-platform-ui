import "server-only";
import { RDP_LIMITS } from "@/lib/rdp/client";
import {
  publicMeasurements,
  toPublicLatest,
  toPublicMeasurement,
  type PublicLatest,
  type PublicMeasurement,
} from "@/lib/rdp/public";
import { getRdpClient } from "@/lib/rdp/server";

export type OverviewItem = {
  measurement: PublicMeasurement;
  /** `null` when RDP's latest read failed for this batch: shown as unavailable, never as a cached value. */
  latest: PublicLatest | null;
};

export type Overview =
  | { status: "ok"; mode: "fixture" | "live"; items: OverviewItem[]; retrievedAt: string | null }
  | { status: "unavailable" };

/** Published, publicly displayable measurements with RDP's latest state, in catalogue order. */
export async function loadOverview(): Promise<Overview> {
  let rdp;
  let catalogue;
  try {
    rdp = getRdpClient();
    catalogue = await rdp.listMeasurements();
  } catch {
    return { status: "unavailable" };
  }
  const measures = publicMeasurements(catalogue.measurements);
  const latest = new Map<string, PublicLatest>();
  let retrievedAt: string | null = null;
  for (let start = 0; start < measures.length; start += RDP_LIMITS.latestBatch) {
    const ids = measures.slice(start, start + RDP_LIMITS.latestBatch).map((m) => m.measurementId);
    try {
      const batch = await rdp.getLatest(ids);
      retrievedAt = batch.retrievedAt;
      for (const item of batch.items) latest.set(item.measurementId, toPublicLatest(item));
    } catch {
      // That batch stays unavailable; other batches and the catalogue still render.
    }
  }
  return {
    status: "ok",
    mode: rdp.mode,
    retrievedAt,
    items: measures.map((m) => ({
      measurement: toPublicMeasurement(m),
      latest: latest.get(m.measurementId) ?? null,
    })),
  };
}
