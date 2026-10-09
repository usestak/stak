/**
 * Loading UI for /overview (Next.js special file): shown instantly on navigation while the
 * page's Server Component resolves its real async gap — a sequential waterfall of Supabase-
 * backed calls (getMachinesReadModel, then getOverview + getProjectsReadModel together) with
 * no Suspense boundary of its own. Overview is also the first page most sessions land on
 * after sign-in, so it is worth the real content here rather than leaving the previous route
 * frozen on screen. Deliberately plain structural text, not a shimmering skeleton — nothing
 * here claims to represent real data shapes that haven't loaded yet.
 */
export default function OverviewLoading() {
  return (
    <div className="stak-frame">
      <main id="main-content" className="stak-main">
        <div className="stak-notice">
          <h1>Loading your Overview…</h1>
          <p>Fetching your latest STAK state from Cloud.</p>
        </div>
      </main>
    </div>
  );
}
