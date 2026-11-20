import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

/**
 * Baseline headers for every response. Framing, plugins, base and form targets are locked down; a script-src CSP
 * needs per-request nonces and is left for later.
 */
const securityHeaders = [
  {
    key: "Content-Security-Policy",
    value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
  },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // Pin the project root so a lockfile in a parent directory is never mistaken for a workspace.
  turbopack: { root: fileURLToPath(new URL(".", import.meta.url)) },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
