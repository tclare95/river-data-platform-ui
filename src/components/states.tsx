import type { ReactNode } from "react";
import { cx } from "@/lib/cx";

type StateProps = {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
};

const panel = "rounded-lg border px-5 py-6 sm:px-6";

/** Nothing to show: no results, no observations, nothing published. */
export function EmptyState({ title, children, action, className }: StateProps) {
  return (
    <div className={cx(panel, "border-line bg-surface", className)}>
      <p className="font-medium">{title}</p>
      {children ? (
        <div className="mt-1 text-sm leading-relaxed text-ink-muted">{children}</div>
      ) : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

/** Something failed. Never pass raw upstream or exception messages as children. */
export function ErrorState({ title, children, action, className }: StateProps) {
  return (
    <div role="alert" className={cx(panel, "border-danger/25 bg-danger-soft", className)}>
      <p className="font-medium text-danger">{title}</p>
      {children ? <div className="mt-1 text-sm leading-relaxed text-ink">{children}</div> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

type LoadingStateProps = {
  label?: string;
  lines?: number;
  className?: string;
};

/** Placeholder while content loads; announced politely to assistive technology. */
export function LoadingState({ label = "Loading", lines = 3, className }: LoadingStateProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={cx(panel, "border-line bg-surface", className)}
    >
      <span className="sr-only">{label}</span>
      <div aria-hidden="true" className="space-y-3 motion-safe:animate-pulse">
        {Array.from({ length: lines }, (_, index) => (
          <div
            key={index}
            className="h-3 rounded bg-line"
            style={{ width: `${index === lines - 1 ? 55 : 100 - index * 8}%` }}
          />
        ))}
      </div>
    </div>
  );
}
