import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import HomePage from "@/app/page";

describe("home page", () => {
  it("has a single page heading and one main landmark", () => {
    render(<HomePage />);
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("main")).toHaveAttribute("id", "main");
  });

  it("shows an honest empty state instead of fabricated measurements", () => {
    render(<HomePage />);
    const section = screen.getByRole("region", { name: "Measurements" });
    expect(section).toHaveTextContent("No measurements to show yet");
    // No numeric readings with units may appear before the live adapter exists.
    expect(section.textContent).not.toMatch(/\d\s*(m|mm|m³\/s|m3\/s)\b/);
  });
});
