import type { InventoryStation } from "@/lib/inventory";
import type { PublicMeasurement } from "@/lib/rdp/public";

export const measurementTypes = {
  level: "River level",
  flow: "Flow",
  rainfall: "Rainfall",
  multiple: "Multiple types",
  other: "Other or unknown type",
} as const;

export const stationAvailability = {
  published: "Published by RDP",
  discoverable: "Discoverable only",
  unknown: "Publication unknown",
} as const;

type MeasurementType = keyof typeof measurementTypes;
type Availability = keyof typeof stationAvailability;
type InventoryMeasure = InventoryStation["measures"][number];
type PublishedMeasure = Pick<PublicMeasurement, "measurementId" | "parameter">;

export type StationMarker = {
  type: MeasurementType;
  parameters: string[];
  availability: Availability;
};
export type StationFilters = { type: MeasurementType | ""; availability: Availability | "" };

function parameterType(parameter: string | null, qualifier?: string | null) {
  const type = parameter?.trim().toLowerCase();
  const detail = qualifier?.trim().toLowerCase();
  if (type === "level" && detail && detail !== "stage" && detail !== "downstream stage")
    return detail === "tidal level" || detail === "groundwater" ? detail : "other level";
  return type;
}

export function classifyStation(
  published: readonly PublishedMeasure[],
  inventory: readonly InventoryMeasure[] = [],
): StationMarker {
  const publishedIds = new Set(published.map(({ measurementId }) => measurementId));
  const parameters = [
    ...new Set(
      [
        ...published.map(({ parameter }) => parameterType(parameter)),
        ...inventory
          .filter(({ measurementId }) => !measurementId || !publishedIds.has(measurementId))
          .map(({ parameter, qualifier }) => parameterType(parameter, qualifier)),
      ].filter((parameter): parameter is string => !!parameter),
    ),
  ];
  const [first] = parameters;
  const type =
    parameters.length > 1
      ? "multiple"
      : first === "level" || first === "flow" || first === "rainfall"
        ? first
        : "other";
  const availability =
    published.length || inventory.some(({ status }) => status === "published")
      ? "published"
      : inventory.length && inventory.every(({ status }) => status === "not_published")
        ? "discoverable"
        : "unknown";
  return { type, parameters, availability };
}

export function matchesStation(marker: StationMarker, filters: StationFilters) {
  if (filters.availability && marker.availability !== filters.availability) return false;
  if (!filters.type) return true;
  if (filters.type === "multiple" || filters.type === "other") return marker.type === filters.type;
  return marker.parameters.includes(filters.type);
}
