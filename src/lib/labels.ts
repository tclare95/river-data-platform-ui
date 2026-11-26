import { formatPeriod, sentenceCase } from "@/lib/format";
import type { PublicMeasurement } from "@/lib/rdp/public";

/** Readable names for RDP's published parameters; anything else is shown as published. */
const PARAMETERS: Readonly<Record<string, string>> = Object.freeze({
  level: "Water level",
  flow: "Flow",
  rainfall: "Rainfall",
});

export function parameterLabel(parameter: string): string {
  return Object.hasOwn(PARAMETERS, parameter) ? PARAMETERS[parameter] : sentenceCase(parameter);
}

export function measurementPath(measurementId: string): string {
  return `/measurements/${encodeURIComponent(measurementId)}`;
}

/** How often RDP expects a value, phrased for the measurement's kind. */
export function cadenceLabel(kind: "instantaneous" | "period_total", seconds: number): string {
  if (!(seconds > 0)) return "Not stated";
  return kind === "period_total"
    ? `Totals per ${formatPeriod(seconds)}`
    : `Every ${formatPeriod(seconds)}`;
}

/** RDP's datum string; `unknown` and `none` are stated plainly rather than hidden. */
export function datumLabel(datum: string): string {
  if (datum === "unknown") return "Not known";
  if (datum === "none") return "Not applicable";
  if (datum === "ASD") return "Local gauge datum (ASD)";
  return datum;
}

/**
 * The datum phrase for a measurement's summary, or `null` where a datum doesn't apply: RDP publishes `unknown` for
 * flow, which has no vertical datum, so only a level says its datum is not known.
 */
export function datumSummary(measurement: { parameter: string; datum: string }): string | null {
  if (measurement.datum === "none") return null;
  if (measurement.datum === "unknown")
    return measurement.parameter === "level" ? "Datum not known" : null;
  if (measurement.datum === "ASD") return "Local gauge datum (ASD)";
  return `Datum ${measurement.datum}`;
}

export function measurementSummary(measurement: PublicMeasurement): string {
  const unit = measurement.periodSeconds
    ? `${measurement.unit} per ${formatPeriod(measurement.periodSeconds)}`
    : measurement.unit;
  return [unit, datumSummary(measurement)].filter(Boolean).join(" · ");
}

export function stationPositionLabel(measurement: PublicMeasurement): string {
  if (measurement.position)
    return `Station reference position · ${measurement.position.precisionMetres} m resolution`;
  if (measurement.locationStatus === "ambiguous") return "Station position ambiguous";
  if (measurement.locationStatus === "unknown") return "Station position not recorded";
  return "Station position unknown";
}

export function watercourseLabel(measurement: PublicMeasurement): string | undefined {
  if (measurement.watercourseName) return measurement.watercourseName;
  if (measurement.watercourseStatus === "not_published") return "Watercourse not published";
}

const QUALITY_WORD = /^[A-Za-z][A-Za-z -]{0,39}$/;

/**
 * RDP keeps provider quality verbatim: EA gauge readings carry the raw JSON (`"Good"`), rainfall a plain word.
 * Only a single plain word or phrase is shown; anything structured is left out rather than printed as JSON.
 */
export function qualityLabel(raw: string | null): string | null {
  if (raw === null) return null;
  let text: unknown = raw.trim();
  if (typeof text === "string" && text.startsWith('"')) {
    try {
      text = JSON.parse(text);
    } catch {
      return null;
    }
  }
  return typeof text === "string" && QUALITY_WORD.test(text) ? text : null;
}
