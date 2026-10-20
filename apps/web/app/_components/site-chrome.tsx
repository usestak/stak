import Link from 'next/link';

import { BetaPill } from './beta-pill';
import { NavMenuToggle } from './landing-interactive';

/**
 * Shared public-site nav + footer — the landing page's chrome, extracted so
 * every public-facing page (/, /beta, /feedback) renders the exact same nav
 * and footer rather than each inventing its own. Anchor links are rooted at
 * `/` (e.g. `/#how`) rather than bare `#how` so they resolve correctly from
 * any page, not only when already on the homepage.
 */

const NAV_LINKS = [
  { t: 'How it works', u: '/#how', k: '→' },
  { t: 'Memory & privacy', u: '/#privacy', k: '→' },
  { t: 'Machines', u: '/#machines', k: '→' },
  { t: 'Docs', u: '/docs', k: '→' },
];

export function SiteNav() {
  return (
    <nav className="stak-landing-nav" aria-label="Memory STAK">
      <div className="stak-landing-nav-brand">
        <Link href="/" className="stak-landing-wordmark">
          <img
            src="/brand/stak-symbol-dark.svg"
            alt=""
            width={18}
            height={18}
          />
          Memory STAK
        </Link>
        <BetaPill />
      </div>
      <div className="stak-landing-nav-links">
        <a href="/#how">How it works</a>
        <a href="/#privacy">Memory &amp; privacy</a>
        <a href="/#machines">Machines</a>
        <a href="/docs">Docs</a>
      </div>
      <div className="stak-landing-nav-right">
        <a href="/auth/login?next=/onboarding" className="stak-landing-signin">
          Sign in
        </a>
        <a href="/#install" className="stak-landing-install-cta">
          Install the CLI
        </a>
        <a href="/#install" className="stak-landing-install-cta-mobile">
          Install
        </a>
        <NavMenuToggle links={NAV_LINKS} />
      </div>
    </nav>
  );
}

const FOOTER_GROUPS = [
  {
    h: 'PRODUCT',
    l: [
      { t: 'How it works', u: '/#how' },
      { t: 'Memory & privacy', u: '/#privacy' },
      { t: 'Install Memory STAK', u: '/#install' },
    ],
  },
  {
    h: 'ACCOUNT',
    l: [{ t: 'Sign in', u: '/auth/login?next=/onboarding' }],
  },
  {
    h: 'OPEN SOURCE',
    l: [
      { t: 'GitHub', u: 'https://github.com/usestak/stak' },
      { t: 'Report an issue', u: 'https://github.com/usestak/stak/issues' },
    ],
  },
  {
    h: 'RESOURCES',
    l: [
      { t: 'Docs', u: '/docs' },
      { t: 'CLI Reference', u: '/docs/cli' },
      { t: 'Public Beta', u: '/beta' },
      { t: 'Feedback', u: '/feedback' },
    ],
  },
];

/**
 * Footer. The design's ACCOUNT group also lists "Control center" -> `/app`,
 * which doesn't exist in this app (the real signed-in landing is
 * `/overview`, and it requires auth - there's no safe public link to it for
 * a signed-out visitor). That link is omitted rather than invented.
 */
export function SiteFooter() {
  return (
    <footer className="stak-landing-footer">
      <div className="stak-landing-footer-grid">
        <div className="stak-landing-footer-brand">
          <span className="stak-landing-wordmark">
            <img
              src="/brand/stak-symbol-dark.svg"
              alt=""
              width={18}
              height={18}
            />
            Memory STAK
          </span>
          <span className="stak-landing-footer-thesis">
            Portable Skills, Memory, and setup for AI coding agents.
          </span>
        </div>
        {FOOTER_GROUPS.map((g) => (
          <div key={g.h} className="stak-landing-footer-group">
            <span className="stak-landing-footer-heading">{g.h}</span>
            {g.l.map((l) => (
              <a key={l.t} href={l.u}>
                {l.t}
              </a>
            ))}
          </div>
        ))}
      </div>
      <div className="stak-landing-footer-wm" aria-hidden="true">
        <span>STAK</span>
      </div>
    </footer>
  );
}
