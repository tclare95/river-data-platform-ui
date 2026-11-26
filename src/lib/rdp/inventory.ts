import "server-only";
import { type InventoryBounds, type InventoryCoverage, type InventoryStation } from "../inventory";
import { epochMs, isMeasurementId } from "./contract";
import { RdpError } from "./errors";
import { PUBLIC_SOURCES } from "./public";

export const DISCOVERY_AREA_PATH = "/v1/discovery/area";
export const INVENTORY_PAGE_SIZE = 200;

const validInventoryCursor = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,512}$/.test(value);

function invalid(): never {
  throw new RdpError("RESPONSE_CONTRACT_ERROR");
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function text(value: unknown, limit = 200) {
  return typeof value === "string" && value.trim() && value.length <= limit ? value : null;
}

function publicSource(provider: string) {
  return Object.hasOwn(PUBLIC_SOURCES, provider) ? PUBLIC_SOURCES[provider] : undefined;
}

function coverageRow(input: unknown): InventoryCoverage {
  const row = record(input);
  const providerId = text(row.providerId) ?? invalid();
  const source = publicSource(providerId);
  const knownLabels: Record<string, string> = {
    "natural-resources-wales": "Natural Resources Wales",
    sepa: "Scottish Environment Protection Agency",
  };
  const status = row.status;
  return {
    providerId,
    label:
      source?.label ??
      (Object.hasOwn(knownLabels, providerId) ? knownLabels[providerId] : providerId),
    status:
      status === "not_integrated"
        ? status
        : source &&
            (status === "fresh" ||
              status === "stale" ||
              status === "expired" ||
              status === "unavailable" ||
              status === "failed")
          ? status
          : "unknown",
    lastVerifiedAt:
      typeof row.lastVerifiedAt === "string" && Number.isFinite(epochMs(row.lastVerifiedAt))
        ? row.lastVerifiedAt
        : null,
    unpositioned:
      typeof row.unpositioned === "number" &&
      Number.isSafeInteger(row.unpositioned) &&
      row.unpositioned >= 0
        ? row.unpositioned
        : null,
    measureDetailPartial: row.measureDetail === "partial",
    attribution: source?.attribution,
  };
}

export function parseInventoryPage(body: unknown, bounds: InventoryBounds) {
  const page = record(body);
  if (
    page.mode !== "area" ||
    page.view !== "consumer" ||
    page.complete !== false ||
    !Array.isArray(page.stations) ||
    page.stations.length > INVENTORY_PAGE_SIZE ||
    !Array.isArray(page.coverage) ||
    page.coverage.length === 0 ||
    (page.continuation !== null &&
      (!validInventoryCursor(page.continuation) || !page.stations.length))
  )
    invalid();

  const coverage = page.coverage.map(coverageRow);
  const [west, south, east, north] = bounds;
  const stations: InventoryStation[] = [];
  for (const input of page.stations) {
    const row = record(input);
    const provider = text(row.providerId) ?? invalid();
    if (!publicSource(provider)) continue;
    const key = text(row.key) ?? invalid();
    if (
      !coverage.some(
        (entry) =>
          entry.providerId === provider && (entry.status === "fresh" || entry.status === "stale"),
      )
    )
      continue;
    const { longitude, latitude, precisionMetres, status, crs } = record(row.location);
    if (
      !key.startsWith(provider + ":") ||
      row.relationship !== "within_bounding_box" ||
      status !== "verified" ||
      crs !== "EPSG:4326" ||
      typeof longitude !== "number" ||
      typeof latitude !== "number" ||
      !(longitude >= west && longitude <= east && latitude >= south && latitude <= north) ||
      typeof precisionMetres !== "number" ||
      ![1, 10, 100, 1000].includes(precisionMetres) ||
      !Array.isArray(row.measures)
    )
      invalid();

    const measures = new Map<string, InventoryStation["measures"][number]>();
    for (const input of row.measures) {
      const measure = record(input);
      const { status, measurementId } = record(measure.rdp);
      if (status === "published" && !isMeasurementId(measurementId)) invalid();
      const item: InventoryStation["measures"][number] = {
        status: status === "published" || status === "not_published" ? status : "unknown",
        parameter: text(measure.parameter, 80),
        qualifier: text(measure.qualifier, 80),
        measurementId:
          status === "published" && isMeasurementId(measurementId) ? measurementId : null,
      };
      measures.set(JSON.stringify(item), item);
    }
    const watercourse = record(row.watercourse);
    stations.push({
      key,
      name: text(row.label) ?? text(row.stationReference) ?? "Unnamed station",
      watercourse:
        watercourse.status === "provider_stated"
          ? (text(watercourse.name) ?? undefined)
          : undefined,
      position: { longitude, latitude, precisionMetres },
      measures: [...measures.values()],
    });
  }
  return { stations, coverage, continuation: page.continuation };
}
