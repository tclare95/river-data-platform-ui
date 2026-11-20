import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import type { ReactNode } from "react";
import { PageMain } from "@/components/container";
import { describeLatest, FRESHNESS_LABEL, NO_DEPTH, Time } from "@/components/latest-reading";
import { PageHeader } from "@/components/page-header";
import { Attribution, FixtureNote } from "@/components/provenance";
import { EmptyState, ErrorState } from "@/components/states";
import { sentenceCase } from "@/lib/format";
import {
  cadenceLabel,
  datumLabel,
  measurementPath,
  parameterLabel,
  qualityLabel,
} from "@/lib/labels";
import { loadMeasurementDetail } from "@/lib/measurement-detail";
import type { PublicLatest, PublicMeasurement } from "@/lib/rdp/public";

type Props = PageProps<"/measurements/[id]">;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  await connection();
  const detail = await loadMeasurementDetail((await params).id);
  if (detail.status !== "ok") return { title: "Measurement" };
  const { name, parameter } = detail.measurement;
  return { title: `${name} ${parameterLabel(parameter).toLowerCase()}` };
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
        <EmptyState title="No observations collected" className="mt-3">
          This measurement is published, but no readings have been collected yet.
        </EmptyState>
      </section>
    );
  }

  const stale = view.freshness === "stale";
  const quality = qualityLabel(view.quality);
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
        {view.freshness !== "fresh" ? (
          <p className="mt-3 font-medium">
            {FRESHNESS_LABEL[view.freshness]}
            {stale ? (
              <span className="font-normal text-ink-muted">
                {" "}
                · No newer reading has been collected.
              </span>
            ) : null}
          </p>
        ) : null}
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

export default async function MeasurementPage({ params }: Props) {
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

  const { measurement, latest, checkedAt, related, mode } = detail;
  const type = parameterLabel(measurement.parameter);
  return (
    <PageMain>
      {back}
      <div className="mt-4">
        <PageHeader
          title={measurement.name}
          description={`${type} · ${measurement.source.label}`}
        />
      </div>
      {mode === "fixture" ? <FixtureNote className="mt-4" /> : null}

      <div className="mt-8 grid gap-10 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:gap-12">
        <LatestSection measurement={measurement} latest={latest} checkedAt={checkedAt} />

        <section aria-labelledby="details">
          <h2 id="details" className="text-lg font-semibold tracking-tight">
            Details
          </h2>
          <dl className="mt-1 divide-y divide-line">
            <Fact term="Type">{type}</Fact>
            <Fact term="Unit">{measurement.unit}</Fact>
            <Fact term="Datum">{datumLabel(measurement.datum)}</Fact>
            <Fact term="Reporting">
              {cadenceLabel(
                measurement.kind,
                measurement.periodSeconds ?? measurement.expectedIntervalSeconds,
              )}
            </Fact>
            <Fact term="Source">{measurement.source.label}</Fact>
            <Fact term="Measurement ID">
              <code className="text-sm break-all">{measurement.measurementId}</code>
            </Fact>
          </dl>
        </section>
      </div>

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
