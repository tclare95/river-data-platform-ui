import type { ComponentPropsWithoutRef } from "react";
import { cx } from "@/lib/cx";

/** Secondary action button. */
export function Button({
  className,
  type = "button",
  ...props
}: ComponentPropsWithoutRef<"button">) {
  return (
    <button
      type={type}
      className={cx(
        "inline-flex min-h-10 items-center rounded-md border border-line-strong bg-surface px-3.5 text-sm font-medium transition-colors hover:bg-canvas disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-disabled:hover:bg-surface",
        className,
      )}
      {...props}
    />
  );
}
