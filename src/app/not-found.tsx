import Link from "next/link";

export default function NotFound() {
  return (
    <main id="main" className="mx-auto max-w-6xl px-6 py-24 sm:px-10">
      <h1 className="text-4xl font-semibold tracking-tight">Page not found.</h1>
      <Link href="/" className="mt-8 inline-block text-[#176c5c] underline underline-offset-4">
        Back to explorer
      </Link>
    </main>
  );
}
