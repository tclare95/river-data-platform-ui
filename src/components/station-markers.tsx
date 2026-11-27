import {
  measurementTypes,
  stationAvailability,
  type StationFilters,
  type StationMarker,
} from "@/lib/station-markers";

const icons = {
  level: "M12 3v18m-4-14 4-4 4 4m-8 10 4 4 4-4",
  flow: "M3 12h17m-6-6 6 6-6 6",
  rainfall: "M12 3c-2 4-6 7-6 11a6 6 0 0 0 12 0c0-4-4-7-6-11Z",
  multiple: "M12 4v16M4 12h16",
  other: "M9 8a3 3 0 1 1 5 2c-1 .8-2 1.5-2 3m0 4h.01",
};

const colors = {
  level: "text-accent-strong",
  flow: "text-compare-tertiary",
  rainfall: "text-compare-secondary",
  multiple: "text-compare-quaternary",
  other: "text-ink-muted",
};

const borders = {
  published: "bg-current border-transparent",
  discoverable: "bg-surface border-current",
  unknown: "bg-surface border-current border-dotted",
};

const markerClasses = (type: StationMarker["type"], availability: StationMarker["availability"]) =>
  `grid shrink-0 place-items-center rounded-full border-2 ${colors[type]} ${borders[availability]}`;

export const markerButtonClasses =
  "grid size-11 cursor-pointer place-items-center rounded-full focus-visible:bg-accent-soft";

export function stationMarkerButton(
  name: string,
  { type, parameters, availability }: StationMarker,
  catchment = false,
  selected = false,
) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = markerButtonClasses;
  button.setAttribute("aria-pressed", String(selected));
  if (selected) button.style.zIndex = "1";
  const types =
    type === "multiple"
      ? `Multiple types (${parameters.map((parameter) => (parameter === "level" || parameter === "flow" || parameter === "rainfall" ? measurementTypes[parameter] : parameter)).join(", ")})`
      : measurementTypes[type];
  button.title = `${name} · ${types} · ${stationAvailability[availability]}${catchment ? " · Inside the modelled catchment" : ""}`;
  button.setAttribute("aria-label", button.title);

  const symbol = document.createElement("span");
  symbol.className = `size-6 shadow-md ring-1 ring-surface ${markerClasses(type, availability)}`;
  if (selected) {
    symbol.classList.add("outline-3", "outline-offset-3", "outline-ink");
  } else if (catchment) {
    symbol.classList.add("outline-2", "outline-offset-1", "outline-accent-strong");
  }
  symbol.setAttribute("aria-hidden", "true");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", `size-4${availability === "published" ? " text-surface" : ""}`);
  const path = document.createElementNS(svg.namespaceURI, "path");
  path.setAttribute("d", icons[type]);
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "2.5");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  svg.append(path);
  symbol.append(svg);
  button.append(symbol);
  return button;
}

const typeOptions = Object.keys(measurementTypes) as (keyof typeof measurementTypes)[];
const availabilityOptions = Object.keys(
  stationAvailability,
) as (keyof typeof stationAvailability)[];
const selectClasses = "min-h-11 max-w-full rounded-md border border-line-input bg-surface px-2";

export function StationMarkerControls({
  filters,
  onChange,
}: {
  filters: StationFilters;
  onChange: (filters: StationFilters) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Map station filters"
      className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm"
    >
      <select
        aria-label="Map measurement type"
        className={selectClasses}
        value={filters.type}
        onChange={(event) =>
          onChange({ ...filters, type: event.target.value as StationFilters["type"] })
        }
      >
        <option value="">All measurement types</option>
        {typeOptions.map((type) => (
          <option key={type} value={type}>
            {measurementTypes[type]}
          </option>
        ))}
      </select>
      <select
        aria-label="Map station availability"
        className={selectClasses}
        value={filters.availability}
        onChange={(event) =>
          onChange({
            ...filters,
            availability: event.target.value as StationFilters["availability"],
          })
        }
      >
        <option value="">Any station availability</option>
        {availabilityOptions.map((availability) => (
          <option key={availability} value={availability}>
            {stationAvailability[availability]}
          </option>
        ))}
      </select>
      <details className="basis-full text-ink-muted open:basis-full sm:basis-auto">
        <summary className="min-h-11 cursor-pointer content-center underline">Station key</summary>
        <ul className="flex flex-wrap gap-x-3 gap-y-1">
          {typeOptions.map((type) => (
            <li key={type} className="inline-flex items-center gap-1.5">
              <span className={`size-5 ${markerClasses(type, "published")}`} aria-hidden="true">
                <svg viewBox="0 0 24 24" className="size-3.5 text-surface">
                  <path
                    d={icons[type]}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </span>
              {measurementTypes[type]}
            </li>
          ))}
        </ul>
        <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
          {availabilityOptions.map((availability) => (
            <li key={availability} className="inline-flex items-center gap-1.5">
              <span
                className={`size-3.5 ${markerClasses("level", availability)}`}
                aria-hidden="true"
              />
              {stationAvailability[availability]}
            </li>
          ))}
        </ul>
        <p className="mt-1">
          A station is marked published if RDP publishes any of its measurements.
        </p>
      </details>
    </div>
  );
}
