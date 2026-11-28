import Link from "next/link";
import { useId, type ReactNode, type Ref } from "react";
import { Button } from "@/components/button";
import { LatestLine } from "@/components/latest-reading";
import { EmptyState } from "@/components/states";
import { measurementPath } from "@/lib/labels";
import type { PublicLatest, PublicMeasurement } from "@/lib/rdp/public";
import { ObservationSummaryDisclosure } from "./observation-summary-disclosure";

type StationMeasure = {
  key: string;
  label: string;
  measurementId?: string;
  measurement?: PublicMeasurement;
  latest?: PublicLatest | null;
  availability?: string;
};

export function StationSelection({
  selectionKey,
  name,
  river,
  measures,
  discoverable,
  headingRef,
  collapsed,
  onToggle,
  onClose,
  comparisonAction,
  summary,
  children,
}: {
  selectionKey: string;
  name: string;
  river?: string | null;
  measures: StationMeasure[];
  discoverable?: boolean;
  headingRef: Ref<HTMLHeadingElement>;
  collapsed: boolean;
  onToggle: () => void;
  onClose: () => void;
  comparisonAction: (measurement: PublicMeasurement) => ReactNode;
  summary?: ReactNode;
  children: ReactNode;
}) {
  const headingId = useId();
  const bodyId = useId();
  return (
    <section
      aria-labelledby={headingId}
      className="pointer-events-auto flex max-h-full flex-col overflow-hidden rounded-lg border border-line bg-surface text-sm shadow-md"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.defaultPrevented) onClose();
      }}
    >
      <header className="flex shrink-0 flex-wrap items-center gap-x-2 px-2 py-1.5 sm:px-3">
        <div className="min-w-0 flex-1 py-1">
          <h2 id={headingId} ref={headingRef} tabIndex={-1} className="font-semibold wrap-anywhere">
            {name}
          </h2>
          {river && <p className="text-ink-muted wrap-anywhere">{river}</p>}
        </div>
        <Button aria-controls={bodyId} aria-expanded={!collapsed} onClick={onToggle}>
          {collapsed ? "Expand" : "Collapse"}
        </Button>
        <Button aria-label="Close station details" onClick={onClose}>
          Close
        </Button>
      </header>
      <div
        key={selectionKey}
        id={bodyId}
        hidden={collapsed}
        className="min-h-0 overflow-y-auto overscroll-contain border-t border-line"
      >
        {discoverable && (
          <EmptyState
            title="Observations are currently unavailable in RDP."
            className="m-2 border-0 px-2 py-1 sm:px-2"
          />
        )}
        {summary && <div className="border-b border-line px-3 py-2">{summary}</div>}
        {measures.length ? (
          <ul className="divide-y divide-line">
            {measures.map(({ key, label, measurementId, measurement, latest, availability }) => (
              <li key={key} className="space-y-1 px-3 py-2">
                {measurementId ? (
                  <Link
                    className="link font-semibold"
                    href={measurementPath(measurementId)}
                    prefetch={false}
                  >
                    {label}
                  </Link>
                ) : (
                  <p className="font-semibold">{label}</p>
                )}
                {measurement ? (
                  <>
                    <p>
                      <LatestLine measurement={measurement} latest={latest ?? null} showFreshness />
                    </p>
                    {comparisonAction(measurement)}
                    <ObservationSummaryDisclosure measurement={measurement} />
                  </>
                ) : (
                  <p className="text-ink-muted">{availability}</p>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-3 py-2 text-ink-muted">
            Measurement types are unavailable for this station.
          </p>
        )}
        <div className="space-y-2 border-t border-line px-3 py-2">{children}</div>
      </div>
    </section>
  );
}
