import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "River Data Platform",
  description: "Explore river observations and history.",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-[#f8faf8] text-[#193b36] antialiased">
        <a
          href="#main"
          className="sr-only rounded bg-white px-3 py-2 text-[#135e52] focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50"
        >
          Skip to content
        </a>
        <header className="border-b border-[#dbe5e0]">
          <div className="mx-auto flex h-20 max-w-6xl items-center px-6 sm:px-10">
            <Link href="/" className="text-lg font-semibold tracking-tight">
              River Data Platform
            </Link>
          </div>
        </header>
        {children}
      </body>
    </html>
  );
}
