import { Container } from "./container";

export function SiteFooter() {
  return (
    <footer className="border-t border-line">
      <Container className="py-6 text-sm text-ink-muted">
        Observations are not safety advice.
      </Container>
    </footer>
  );
}
