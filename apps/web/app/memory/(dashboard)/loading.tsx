/**
 * Loading UI for /memory (Next.js special file): same genuine gap as Overview's — a
 * sequential waterfall (getMachinesReadModel, then getBackupHistory + getProjectsReadModel
 * together) with no Suspense boundary, backing the account's most safety-critical page
 * (backup/recovery state). Plain structural text, not a shimmering skeleton.
 */
export default function MemoryLoading() {
  return (
    <div className="stak-frame">
      <main id="main-content" className="stak-main">
        <div className="stak-notice">
          <h1>Loading your Memory…</h1>
          <p>Fetching your backup and recovery state from Cloud.</p>
        </div>
      </main>
    </div>
  );
}
