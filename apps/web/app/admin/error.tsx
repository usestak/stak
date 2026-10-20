'use client';

/**
 * Catches thrown errors from any /admin/* page (e.g. a Supabase query
 * returning an error, which the admin data loaders now throw on rather than
 * silently reporting zero). Shown only to signed-in admins, since every
 * page's own getAdminUser()/notFound() gate runs before this could render.
 */
export default function AdminError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="stak-admin-main">
      <h1>Something went wrong loading this page</h1>
      <p>The underlying data query failed. Try again, or check the server logs for details.</p>
      <button onClick={reset}>Retry</button>
    </div>
  );
}
