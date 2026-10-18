export interface DocsNavEntry {
  title: string;
  href: string;
}

/**
 * Single source of truth for the `/docs` sidebar. Consumed by `layout.tsx`
 * (renders these as `<Link>`s) and `docs.test.ts` (asserts each `href`
 * resolves to a real `page.tsx`). Keep this list and the actual route tree
 * under `apps/web/app/docs/` in sync — adding an entry here without a
 * matching page is a failing test, not a TODO.
 */
export const DOCS_NAV: DocsNavEntry[] = [
  { title: 'Getting Started', href: '/docs' },
  { title: 'Core Concepts', href: '/docs/concepts' },
  { title: 'Workflows', href: '/docs/workflows' },
  { title: 'Sharing', href: '/docs/sharing' },
  { title: 'Memory & Projects', href: '/docs/memory' },
  { title: 'Agents', href: '/docs/agents' },
  { title: 'Security & Privacy', href: '/docs/security' },
  { title: 'Troubleshooting', href: '/docs/troubleshooting' },
  { title: 'Open Source', href: '/docs/open-source' },
  { title: 'CLI Reference', href: '/docs/cli' },
];
