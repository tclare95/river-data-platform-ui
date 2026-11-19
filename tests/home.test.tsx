import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import HomePage from "../src/app/page";

describe("bootstrap shell", () => {
  it("presents the explorer without fabricated measurements", () => {
    const markup = renderToStaticMarkup(createElement(HomePage));
    expect(markup).toContain("Explore river data.");
    expect(markup).toContain("The explorer is being built.");
    expect(markup).not.toContain("live measurements");
  });
});
