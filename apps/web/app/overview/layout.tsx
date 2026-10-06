import type { ReactNode } from 'react';

import './shell.css';

/**
 * Signed-in shell layout: the Final Contract's dark instrument-panel frame + IBM Plex. Fonts
 * load via a stylesheet <link> (as the design source does) rather than next/font, so the
 * production build never depends on a build-time font fetch.
 */
export default function OverviewLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link
        rel="preconnect"
        href="https://fonts.gstatic.com"
        crossOrigin="anonymous"
      />
      <link
        rel="stylesheet"
        href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap"
      />
      <div className="stak">{children}</div>
    </>
  );
}
