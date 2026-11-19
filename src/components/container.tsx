import type { ReactNode } from "react";
import { cx } from "@/lib/cx";

type ContainerProps = {
  children: ReactNode;
  className?: string;
};

/** Page-width wrapper with the shared horizontal gutters. */
export function Container({ children, className }: ContainerProps) {
  return (
    <div className={cx("mx-auto w-full max-w-page px-4 sm:px-6 lg:px-8", className)}>
      {children}
    </div>
  );
}

/** The single `main` landmark for a page; the skip link targets it. */
export function PageMain({ children, className }: ContainerProps) {
  return (
    <main id="main" tabIndex={-1} className="flex-1 outline-none">
      <Container className={cx("py-10 sm:py-14", className)}>{children}</Container>
    </main>
  );
}
