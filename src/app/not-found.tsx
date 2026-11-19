import Link from "next/link";
import { PageMain } from "@/components/container";
import { PageHeader } from "@/components/page-header";

export default function NotFound() {
  return (
    <PageMain>
      <PageHeader title="Page not found" description="This page does not exist or has moved." />
      <Link href="/" className="link mt-6 inline-block">
        Back to home
      </Link>
    </PageMain>
  );
}
