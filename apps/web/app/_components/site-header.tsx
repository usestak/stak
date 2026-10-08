import { displayNameOf, type WebUser } from '@/lib/session';

import { AccountMenu } from './account-menu';

/**
 * Shared top bar. Public pages render just the wordmark; authenticated product
 * pages pass the session `user` to get the compact nav + account menu.
 */
export function SiteHeader({ user }: { user?: WebUser | null }) {
  return (
    <header className="site-header">
      <div className="site-header-inner">
        <a href={user ? '/overview' : '/'} className="wordmark">
          STAK
        </a>
        {user ? (
          <nav className="site-nav">
            <a href="/overview">Overview</a>
            <a href="/settings">Settings</a>
            <AccountMenu
              name={displayNameOf(user)}
              {...(user.githubUsername ? { handle: user.githubUsername } : {})}
            />
          </nav>
        ) : null}
      </div>
    </header>
  );
}
