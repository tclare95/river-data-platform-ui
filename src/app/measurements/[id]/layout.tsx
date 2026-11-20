import { notFound } from "next/navigation";
import { connection } from "next/server";
import { loadPublishedMeasurement } from "@/lib/measurement-detail";

/**
 * Resolves the ID against the cached catalogue before anything streams, outside the page's loading boundary, so an
 * unknown or non-displayable measurement answers with a real 404 rather than a streamed not-found page.
 */
export default async function MeasurementLayout({
  children,
  params,
}: LayoutProps<"/measurements/[id]">) {
  await connection();
  const published = await loadPublishedMeasurement((await params).id);
  if (published.status === "not_found") notFound();
  return children;
}
