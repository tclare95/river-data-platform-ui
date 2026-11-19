"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { cx } from "@/lib/cx";

type NavLinkProps = {
  href: string;
  children: ReactNode;
};

export function isActivePath(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function NavLink({ href, children }: NavLinkProps) {
  const active = isActivePath(usePathname() ?? "", href);

  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cx(
        "inline-flex min-h-10 items-center rounded-md px-3 text-sm font-medium transition-colors",
        active ? "bg-accent-soft text-accent-strong" : "text-ink-muted hover:text-ink",
      )}
    >
      {children}
    </Link>
  );
}
