import type { ReactNode } from "react";

type PageHeaderProps = {
  title: string;
  description?: ReactNode;
};

export function PageHeader({ title, description }: PageHeaderProps) {
  return (
    <header className="max-w-copy">
      <h1 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">{title}</h1>
      {description ? (
        <p className="mt-3 text-base leading-relaxed text-ink-muted sm:text-lg">{description}</p>
      ) : null}
    </header>
  );
}
