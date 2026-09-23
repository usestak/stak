'use client';

export function AccountMenu({
  name,
  handle,
}: {
  name: string;
  handle?: string;
}) {
  return (
    <details className="account">
      <summary aria-label="Account menu">
        {name}
        <span className="account-caret" aria-hidden>
          ▾
        </span>
      </summary>
      <div className="account-panel">
        <div className="account-id">
          <div className="account-name">{name}</div>
          {handle ? <div className="muted">@{handle}</div> : null}
        </div>
        <a href="/settings">Settings</a>
        <form method="post" action="/auth/signout">
          <button type="submit" className="account-signout">
            Sign out
          </button>
        </form>
      </div>
    </details>
  );
}
