import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import ErrorPage from "@/app/error";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";

describe("state presentation", () => {
  it("announces loading without exposing placeholder shapes", () => {
    render(<LoadingState label="Loading measurements" />);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Loading measurements");
    expect(status.querySelector('[aria-hidden="true"]')).not.toBeNull();
  });

  it("renders errors as alerts and empty states as plain content", () => {
    render(
      <>
        <ErrorState title="Readings unavailable" />
        <EmptyState title="No observations" />
      </>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Readings unavailable");
    expect(screen.getAllByRole("alert")).toHaveLength(1);
  });
});

describe("route error boundary", () => {
  it("never renders the underlying error message and lets the visitor retry", async () => {
    const reset = vi.fn();
    render(<ErrorPage error={new Error("upstream 503: arn:aws:iam::123:role/x")} reset={reset} />);

    expect(screen.getByRole("alert")).not.toHaveTextContent(/arn:aws|upstream/);
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(reset).toHaveBeenCalledOnce();
  });
});
