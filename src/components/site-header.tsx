import Link from "next/link";
import { Container } from "./container";
import { NavLink } from "./nav-link";

export const navigation = [
  { href: "/", label: "Explore" },
  { href: "/about", label: "About" },
] as const;

export function SiteHeader() {
  return (
    <header className="border-b border-line bg-surface">
      <a
        href="#main"
        className="sr-only rounded-md bg-surface px-3 py-2 text-sm font-medium text-accent shadow-md ring-1 ring-line focus:not-sr-only focus:fixed focus:left-4 focus:top-2 focus:z-50"
      >
        Skip to content
      </a>
      <Container className="flex h-16 items-center justify-between gap-4">
        <Link
          href="/"
          className="flex min-h-10 items-center gap-2.5 rounded-md font-semibold tracking-tight"
        >
          <RiverMark />
          <span>River Data Platform</span>
        </Link>
        <nav aria-label="Main">
          <ul className="flex items-center gap-1">
            {navigation.map((item) => (
              <li key={item.href}>
                <NavLink href={item.href}>{item.label}</NavLink>
              </li>
            ))}
          </ul>
        </nav>
      </Container>
    </header>
  );
}

function RiverMark() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="size-6 shrink-0 text-accent"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    >
      <path d="M3 8c3-2.5 6 2.5 9 0s6 2.5 9 0" />
      <path d="M3 13c3-2.5 6 2.5 9 0s6 2.5 9 0" opacity="0.6" />
      <path d="M3 18c3-2.5 6 2.5 9 0s6 2.5 9 0" opacity="0.3" />
    </svg>
  );
}
