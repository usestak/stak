import type { ReactNode } from 'react';

import { AppSidebar, type SidebarActiveKey } from './app-sidebar';

export const PLACEHOLDER_COUNTS = {
  overview: { n: '', tone: 'neutral' as const },
  skills: '',
  memory: { n: '', tone: 'neutral' as const },
  projects: '',
  machines: '',
  stacks: '',
};

/** Shared error/empty-state wrapper (P4 §Notice): keeps the full signed-in shell/sidebar
 *  visible even when the page's own data couldn't load, rather than a bare error page. */
export function ShellNotice({
  active,
  handle,
  title,
  children,
}: {
  active: SidebarActiveKey;
  handle: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="stak-frame">
      <AppSidebar
        active={active}
        handle={handle}
        counts={PLACEHOLDER_COUNTS}
        viewing={null}
        machines={[]}
      />
      <main id="main-content" className="stak-main">
        <div className="stak-notice">
          <h1>{title}</h1>
          {children}
        </div>
      </main>
    </div>
  );
}
