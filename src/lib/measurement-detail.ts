import "server-only";
import { cache } from "react";
import { isMeasurementId } from "@/lib/rdp/contract";
import {
  publicMeasurements,
  toPublicLatest,
  toPublicMeasurement,
  type PublicLatest,
  type PublicMeasurement,
} from "@/lib/rdp/public";
import { getRdpClient } from "@/lib/rdp/server";

export type PublishedMeasurement =
  | {
      status: "ok";
      mode: "fixture" | "live";
      measurement: PublicMeasurement;
      /** Other publicly displayable measurements at the same RDP station, in catalogue order. */
      related: PublicMeasurement[];
    }
  | { status: "not_found" }
  | { status: "unavailable" };

export type MeasurementDetail =
  | (Extract<PublishedMeasurement, { status: "ok" }> & {
      /** `null` when RDP's latest read failed: shown as unavailable, never as an older value. */
      latest: PublicLatest | null;
      /** When RDP answered the latest read; distinct from when the value was observed. */
      checkedAt: string | null;
    })
  | { status: "not_found" }
  | { status: "unavailable" };

/**
 * A published, publicly displayable measurement from the (cached) catalogue. Unknown, malformed and
 * non-displayable IDs are indistinguishable (`not_found`), so restricted measurements are never revealed.
 * Malformed IDs are rejected before any upstream call. Memoised per request.
 */
export const loadPublishedMeasurement = cache(async (id: string): Promise<PublishedMeasurement> => {
  if (!isMeasurementId(id)) return { status: "not_found" };
  let rdp;
  let measures;
  try {
    rdp = getRdpClient();
    measures = publicMeasurements((await rdp.listMeasurements()).measurements);
  } catch {
    return { status: "unavailable" };
  }
  const measure = measures.find((item) => item.measurementId === id);
  if (!measure) return { status: "not_found" };
  return {
    status: "ok",
    mode: rdp.mode,
    measurement: toPublicMeasurement(measure),
    related: measures
      .filter((item) => item.stationId === measure.stationId && item.measurementId !== id)
      .map(toPublicMeasurement),
  };
});

/** The measurement with RDP's latest state. A failed latest read leaves the catalogue entry intact. */
export const loadMeasurementDetail = cache(async (id: string): Promise<MeasurementDetail> => {
  const published = await loadPublishedMeasurement(id);
  if (published.status !== "ok") return published;
  let latest: PublicLatest | null = null;
  let checkedAt: string | null = null;
  try {
    const batch = await getRdpClient().getLatest([id]);
    const item = batch.items.find((entry) => entry.measurementId === id);
    if (item) {
      latest = toPublicLatest(item);
      checkedAt = batch.retrievedAt;
    }
  } catch {
    // Shown as unavailable.
  }
  return { ...published, latest, checkedAt };
});
