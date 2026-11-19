import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const pathname = vi.hoisted(() => ({ current: "/" }));
vi.mock("next/navigation", () => ({ usePathname: () => pathname.current }));

import HomePage from "@/app/page";
import { isActivePath } from "@/components/nav-link";
import { SiteHeader } from "@/components/site-header";

describe("isActivePath", () => {
  it("matches the home route exactly", () => {
    expect(isActivePath("/", "/")).toBe(true);
    expect(isActivePath("/about", "/")).toBe(false);
  });

  it("matches nested routes but not shared prefixes", () => {
    expect(isActivePath("/about", "/about")).toBe(true);
    expect(isActivePath("/about/sources", "/about")).toBe(true);
    expect(isActivePath("/aboutness", "/about")).toBe(false);
  });
});

describe("site header", () => {
  beforeEach(() => {
    pathname.current = "/";
  });

  it("skip link targets the page's main landmark", () => {
    render(
      <>
        <SiteHeader />
        <HomePage />
      </>,
    );
    const href = screen.getByRole("link", { name: "Skip to content" }).getAttribute("href");
    expect(href).toBe("#main");
    expect(document.querySelector(href!)).toBe(screen.getByRole("main"));
  });

  it.each([
    ["/", "Explore"],
    ["/about", "About"],
  ])("on %s marks only %s as the current page", (path, label) => {
    pathname.current = path;
    render(<SiteHeader />);
    const nav = screen.getByRole("navigation", { name: "Main" });
    const current = nav.querySelectorAll('[aria-current="page"]');
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveTextContent(label);
  });
});
