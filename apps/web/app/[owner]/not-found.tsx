import Link from 'next/link';

import { PublicShell } from '../_components/public-shell';

/**
 * Public 404 for /[owner] and /[owner]/[slug]. Next renders this for any notFound() call
 * from those segments that has no closer not-found.tsx (neither segment defines its own,
 * so this is the closest boundary for both). Styled with PublicShell — the anonymous-
 * facing shell, never the signed-in AppSidebar frame — since these are signed-out-visible
 * surfaces. This is a real 404 (the page.tsx's call to next/navigation's notFound()
 * already makes Next return a true 404 status), not a 200 "not found" string, so Task 9's
 * SEO work can rely on it being excluded from indexing automatically.
 */
export default function OwnerNotFound() {
  return (
    <PublicShell title="Not found">
      <p className="stak-public-muted">
        Memory STAK doesn&apos;t have a public profile or Stack at this address.
        It may have been renamed, made private, or never existed.
      </p>
      <p className="stak-public-muted">
        <Link href="/">Go to Memory STAK home</Link>
      </p>
    </PublicShell>
  );
}
