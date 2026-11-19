import type { Metadata } from "next";
import { PageMain } from "@/components/container";
import { PageHeader } from "@/components/page-header";

export const metadata: Metadata = { title: "About" };

export default function AboutPage() {
  return (
    <PageMain>
      <PageHeader title="About" />
      <div className="mt-6 max-w-copy space-y-4 leading-relaxed">
        <p>
          This site shows river measurements as recorded, with their source, unit and observation
          time.
        </p>
        <p>
          Where a reading is missing, out of date or unknown, the site says so rather than filling
          the gap.
        </p>
      </div>
    </PageMain>
  );
}
