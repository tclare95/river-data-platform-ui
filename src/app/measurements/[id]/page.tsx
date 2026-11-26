import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import type { ReactNode } from "react";
import { PageMain } from "@/components/container";
import { MeasurementHistory } from "@/components/history/measurement-history";
import {
  describeLatest,
  FRESHNESS_LABEL,
  NO_DEPTH,
  NO_OBSERVATIONS,
  Time,
} from "@/components/latest-reading";
import { PageHeader } from "@/components/page-header";
import { Attribution, FixtureNote } from "@/components/provenance";
import { EmptyState, ErrorState } from "@/components/states";
import { sentenceCase } from "@/lib/format";
import {
  cadenceLabel,
  datumLabel,
  datumSummary,
  measurementPath,
  measurementSummary,
  parameterLabel,
  qualityLabel,
  stationPositionLabel,
  watercourseLabel,
} from "@/lib/labels";
import { compareHref } from "@/lib/compare";
import { parseRange } from "@/lib/history/range";
import { loadMeasurementDetail, loadPublishedMeasurement } from "@/lib/measurement-detail";
import { epochMs } from "@/lib/rdp/contract";
import type { PublicHealth, PublicLatest, PublicMeasurement } from "@/lib/rdp/public";

type Props = PageProps<"/measurements/[id]">;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  await connection();
  const detail = await loadPublishedMeasurement((await params).id);
  if (detail.status !== "ok") return { title: "Measurement" };
  const { name, parameter } = detail.measurement;
  return { title: `${name} ${parameterLabel(parameter).toLowerCase()}` };
}

/** Whole hours and minutes, or days and hours past two days: "3 h 10 min", "4 d 2 h". */
function ageText(ms: number): string | null {
  if (!(ms > 0)) return null;
  const minutes = Math.floor(ms / 60_000);
  if (minutes >= 2 * 1440)
    return `${Math.floor(minutes / 1440)} d ${Math.floor((minutes % 1440) / 60)} h`;
  if (minutes >= 60) return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
  return `${minutes} min`;
}

const SOURCE_STATE: Record<PublicHealth["sourceState"], string> = {
  healthy: "Responding",
  failed: "Last request failed",
  unknown: "Not known",
};

function Provenance({
  measurement,
  latest,
  checkedAt,
  health,
}: {
  measurement: PublicMeasurement;
  latest: PublicLatest | null;
  checkedAt: string | null;
  health: PublicHealth | null;
}) {
  const observedAt =
    latest?.status === "available"
      ? latest.kind === "instantaneous"
        ? latest.observedAt
        : latest.label
      : null;
  const notAvailable = <span className="text-ink-muted">Not available</span>;
  return (
    <details className="mt-4">
      <summary className="cursor-pointer py-2 font-medium text-accent">
        Source and collection
      </summary>
      <dl className="mt-1 divide-y divide-line">
        <Fact term={latest?.kind === "period_total" ? "Latest period label" : "Latest observed"}>
          {observedAt ? <Time value={observedAt} /> : notAvailable}
        </Fact>
        <Fact term="Latest stored by RDP">
          {health?.lastPersistedAt ? <Time value={health.lastPersistedAt} /> : notAvailable}
        </Fact>
        <Fact term="Last source request">
          {health?.lastAttemptAt ? (
            <>
              <Time value={health.lastAttemptAt} /> · {SOURCE_STATE[health.sourceState]}
            </>
          ) : (
            notAvailable
          )}
        </Fact>
        <Fact term="Checked">{checkedAt ? <Time value={checkedAt} /> : notAvailable}</Fact>
        {measurement.locationEvidence ? (
          <Fact term="Station record">
            <a className="link" href={measurement.locationEvidence}>
              {measurement.source.label}
            </a>
          </Fact>
        ) : null}
        <Fact term="Measurement ID">
          <code className="text-sm break-all">{measurement.measurementId}</code>
        </Fact>
      </dl>
    </details>
  );
}

function LatestSection({
  measurement,
  latest,
  checkedAt,
}: {
  measurement: PublicMeasurement;
  latest: PublicLatest | null;
  checkedAt: string | null;
}) {
  const view = describeLatest(measurement, latest);
  const heading = (text: string) => (
    <h2 id="latest" className="text-lg font-semibold tracking-tight">
      {text}
    </h2>
  );

  if (view.state === "unavailable") {
    return (
      <section aria-labelledby="latest">
        {heading("Latest reading")}
        <ErrorState title="Latest reading unavailable right now" className="mt-3">
          Please try again in a few minutes.
        </ErrorState>
      </section>
    );
  }
  if (view.state === "no_observations") {
    return (
      <section aria-labelledby="latest">
        {heading("Latest reading")}
        <EmptyState title={NO_OBSERVATIONS} className="mt-3" />
      </section>
    );
  }

  const stale = view.freshness === "stale";
  const quality = qualityLabel(view.quality);
  const age =
    stale && latest?.kind === "instantaneous" && latest.observedAt && checkedAt
      ? ageText(epochMs(checkedAt) - epochMs(latest.observedAt))
      : null;
  return (
    <section aria-labelledby="latest">
      {heading(stale ? "Last known reading" : "Latest reading")}
      <div className="mt-3 rounded-lg border border-line bg-surface px-5 py-5 sm:px-6">
        <p className="text-4xl font-semibold tracking-tight tabular-nums">
          {view.value ?? <span className="text-xl font-medium text-ink-muted">{NO_DEPTH}</span>}
        </p>
        <p className="mt-2 text-ink-muted">
          {view.lead}
          {view.when}
        </p>
        <p className="mt-3 font-medium">
          {FRESHNESS_LABEL[view.freshness]}
          {age ? (
            <span className="font-normal text-ink-muted"> · {age} old when checked</span>
          ) : null}
        </p>
        <dl className="mt-4 flex flex-wrap gap-x-6 gap-y-1 border-t border-line pt-3 text-sm text-ink-muted">
          {quality ? (
            <div className="flex gap-1.5">
              <dt>Quality</dt>
              <dd className="text-ink">{sentenceCase(quality)}</dd>
            </div>
          ) : null}
          {checkedAt ? (
            <div className="flex gap-1.5">
              <dt>Checked</dt>
              <dd className="text-ink">
                <Time value={checkedAt} />
              </dd>
            </div>
          ) : null}
        </dl>
      </div>
    </section>
  );
}

function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="py-3 sm:grid sm:grid-cols-3 sm:gap-4">
      <dt className="text-sm text-ink-muted">{term}</dt>
      <dd className="mt-0.5 sm:col-span-2 sm:mt-0">{children}</dd>
    </div>
  );
}

export default async function MeasurementPage({ params, searchParams }: Props) {
  await connection();
  const detail = await loadMeasurementDetail((await params).id);
  if (detail.status === "not_found") notFound();

  const back = (
    <Link href="/" className="link text-sm">
      All measurements
    </Link>
  );

  if (detail.status === "unavailable") {
    return (
      <PageMain>
        {back}
        <div className="mt-4">
          <PageHeader title="Measurement unavailable" />
        </div>
        <ErrorState title="This measurement can’t be loaded right now" className="mt-8">
          Please try again in a few minutes.
        </ErrorState>
      </PageMain>
    );
  }

  const { measurement, latest, checkedAt, health, related, mode } = detail;
  const type = parameterLabel(measurement.parameter);
  const range = parseRange((await searchParams).range);
  const datum = datumSummary(measurement);
  const summary = [watercourseLabel(measurement), measurementSummary(measurement)]
    .filter(Boolean)
    .join(" · ");
  return (
    <PageMain>
      {back}
      <div className="mt-4">
        <PageHeader title={`${measurement.name} ${type.toLowerCase()}`} description={summary} />
      </div>
      {mode === "fixture" ? <FixtureNote className="mt-4" /> : null}

      <div className="mt-8 max-w-copy">
        <LatestSection measurement={measurement} latest={latest} checkedAt={checkedAt} />
      </div>

      <div className="mt-10">
        <MeasurementHistory measurement={measurement} range={range} />
        <p className="mt-4">
          <Link
            href={compareHref(
              [measurement, ...related.slice(0, 1)].map(({ measurementId }) => measurementId),
              range,
            )}
            prefetch={false}
            className="link text-sm"
          >
            Compare with another measurement
          </Link>
        </p>
      </div>

      <section aria-labelledby="details" className="mt-10 max-w-copy">
        <h2 id="details" className="text-lg font-semibold tracking-tight">
          Details
        </h2>
        <dl className="mt-1 divide-y divide-line">
          <Fact term="Type">{type}</Fact>
          <Fact term="Unit">{measurement.unit}</Fact>
          {datum ? <Fact term="Datum">{datumLabel(measurement.datum)}</Fact> : null}
          <Fact term="Reporting">
            {cadenceLabel(
              measurement.kind,
              measurement.periodSeconds ?? measurement.expectedIntervalSeconds,
            )}
          </Fact>
          <Fact term="Source">{measurement.source.label}</Fact>
          <Fact term="Position">{stationPositionLabel(measurement)}</Fact>
        </dl>
        <Provenance
          measurement={measurement}
          latest={latest}
          checkedAt={checkedAt}
          health={health}
        />
      </section>

      {related.length > 0 ? (
        <section aria-labelledby="related" className="mt-10">
          <h2 id="related" className="text-lg font-semibold tracking-tight">
            Also at {measurement.name}
          </h2>
          <ul className="mt-3 flex flex-wrap gap-2">
            {related.map((other) => (
              <li key={other.measurementId}>
                <Link
                  href={measurementPath(other.measurementId)}
                  className="inline-flex min-h-10 items-center rounded-md border border-line-strong bg-surface px-3.5 text-sm font-medium text-accent hover:bg-canvas"
                >
                  {parameterLabel(other.parameter)}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <Attribution measurements={[measurement]} />
    </PageMain>
  );
}
