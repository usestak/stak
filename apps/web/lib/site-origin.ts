/**
 * Resolve the canonical public origin for this deployment (e.g. for SEO
 * canonical URLs, robots.ts, sitemap.ts). Prefers `STAK_APP_URL`, accepts the
 * legacy `STACK_APP_URL` alias, and falls back to localhost outside
 * production. In production with neither variable set, throws rather than
 * silently emitting a bogus `localhost` canonical — a wrong canonical URL is
 * worse than a crashed build/server, and the failure is loud by design.
 */
export function siteOrigin(): string {
  const configured = process.env.STAK_APP_URL || process.env.STACK_APP_URL;
  if (configured) return configured.replace(/\/+$/, "");
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "STAK_APP_URL is not set in production — refusing to emit a localhost canonical.",
    );
  }
  return "http://localhost:3000";
}
