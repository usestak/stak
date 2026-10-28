import type { Metadata } from 'next';
import Link from 'next/link';

import '../overview/shell.css';
import '../_components/public-landing-shell.css';

import { CopyRow } from '../_components/landing-interactive';
import { SiteFooter, SiteNav } from '../_components/site-chrome';
import {
  PUBLIC_BETA_INSTALL_COMMAND,
  PUBLIC_BETA_LABEL,
  PUBLIC_BETA_VERSION,
} from '../../lib/beta';
import {
  WHY_NOT_GIT_EYEBROW,
  WHY_NOT_GIT_HEADING,
  WHY_NOT_GIT_ITEMS,
} from '../../lib/why-not-git';

export const metadata: Metadata = {
  title: 'Public Beta',
  description:
    'What to expect from the STAK Public Beta — what works, what we want tested, and known limitations.',
};

const READY: { k: string; big: string; d: string; d2?: string }[] = [
  {
    k: 'DAILY WORKFLOW',
    big: 'Git-like workflow',
    d: 'stak status → stak add . → stak push.',
  },
  {
    k: 'AGENTS',
    big: 'Skills across agents',
    d: 'Claude Code · Cursor · Codex.',
  },
  {
    k: 'MACHINES',
    big: 'Move between machines',
    d: 'Push here, pull there.',
  },
  {
    k: 'MEMORY & PROJECTS',
    big: 'Project Memory',
    d: 'During the public beta, Project Memory portability supports Claude Code.',
    d2: 'Memory follows logical Project identity.',
  },
];

const FLOW: {
  n: string;
  k: string;
  t: string;
  d: string;
  cmd?: string;
}[] = [
  {
    n: '1',
    k: 'MACHINE',
    t: 'What exists here',
    d: 'Skills, Memory, and local setup — as you work.',
  },
  {
    n: '2',
    k: 'MAIN',
    t: 'What you intentionally keep',
    d: 'Stage it.',
    cmd: 'stak add',
  },
  {
    n: '3',
    k: 'STAK CLOUD',
    t: 'What follows you',
    d: 'Sync it.',
    cmd: 'stak push',
  },
];

const TESTED = [
  'First setup',
  'Daily workflow',
  'Second-machine recovery',
  'Memory restoration',
  'Project mapping',
  'try / use',
];

const LIMITATIONS = [
  'Project Memory portability currently targets Claude Code, not Cursor or Codex.',
  "Some Projects can require explicit stak project map when identity can't be proven automatically.",
  'STAK deliberately fails closed on a conflicting Memory restore rather than overwriting it.',
  'CLI and Cloud semantics may continue evolving during the beta.',
];

export default function BetaPage() {
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
      <div className="stak stak-landing">
        <SiteNav />
        <main id="main-content">
          <section className="stak-landing-hero" aria-label="Public Beta">
            <div className="stak-focuspage-badgerow">
              <span className="stak-landing-beta-pill">
                {PUBLIC_BETA_LABEL}
              </span>
              <span className="stak-focuspage-version">
                {PUBLIC_BETA_VERSION}
              </span>
            </div>
            <h1 className="stak-focuspage-h1">
              Your AI coding environment should move with you.
            </h1>
            <p className="stak-landing-lead">
              STAK carries portable Skills and Project Memory across machines
              with a familiar Git-like workflow — we&apos;re opening it to
              developers while we refine the experience.
            </p>
            <div id="install" className="stak-landing-install-anchor" />
            <CopyRow command={PUBLIC_BETA_INSTALL_COMMAND} />
            <div className="stak-focuspage-ctas">
              <a href="#install" className="stak-landing-cta-primary">
                Install STAK
              </a>
              <Link href="/docs" className="stak-landing-cta-secondary">
                Read the docs
              </Link>
            </div>
          </section>

          <section className="stak-landing-section" aria-label="What's ready">
            <div className="stak-landing-section-head">
              <div>
                <span className="stak-landing-eyebrow">WHAT&apos;S READY</span>
                <h2>Built for the everyday loop.</h2>
              </div>
            </div>
            <div className="stak-landing-objgrid">
              {READY.map((r) => (
                <div key={r.k} className="stak-landing-objcard">
                  <div className="stak-landing-objcard-head">
                    <span className="stak-landing-objcard-k">{r.k}</span>
                  </div>
                  <span className="stak-landing-objcard-big">{r.big}</span>
                  <span className="stak-landing-objcard-d">{r.d}</span>
                  {r.d2 ? (
                    <span className="stak-landing-objcard-d">{r.d2}</span>
                  ) : null}
                </div>
              ))}
            </div>
          </section>

          <section
            className="stak-landing-section stak-landing-section--panel"
            aria-label="How it works"
          >
            <div className="stak-landing-section-head stak-landing-section-head--narrow">
              <div>
                <span className="stak-landing-eyebrow">HOW IT WORKS</span>
                <h2>Machine → Main → STAK Cloud.</h2>
              </div>
              <p>
                You choose when it moves. Nothing happens in the background.
              </p>
            </div>
            <ol className="stak-landing-moves">
              {FLOW.map((f, i) => (
                <li key={f.n} className="stak-landing-move">
                  <div className="stak-landing-move-rail">
                    <span className="stak-landing-move-n">{f.n}</span>
                    {i < FLOW.length - 1 ? (
                      <span className="stak-landing-move-line" />
                    ) : null}
                  </div>
                  <div className="stak-landing-move-body">
                    <span className="stak-beta-flow-label">
                      <span className="stak-landing-move-n-inline">
                        {f.n} ·{' '}
                      </span>
                      {f.k}
                    </span>
                    <span className="stak-beta-flow-subtitle">{f.t}</span>
                    {f.cmd ? (
                      <span className="stak-landing-move-cmd">
                        <span className="stak-landing-tone-dim">$ </span>
                        {f.cmd}
                      </span>
                    ) : null}
                    <span className="stak-landing-move-d">{f.d}</span>
                  </div>
                </li>
              ))}
            </ol>
          </section>

          <section
            className="stak-landing-section"
            aria-label="What we particularly want tested"
          >
            <div className="stak-landing-section-head">
              <div>
                <span className="stak-landing-eyebrow">
                  WHAT WE PARTICULARLY WANT TESTED
                </span>
                <h2>Help us find the rough edges.</h2>
              </div>
            </div>
            <div className="stak-beta-testgrid">
              {TESTED.map((item, i) => (
                <div key={item} className="stak-beta-testitem">
                  <span className="stak-beta-testitem-n">
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  <span>{item}</span>
                </div>
              ))}
            </div>
          </section>

          <section
            className="stak-landing-section"
            aria-label="Known limitations"
          >
            <div className="stak-landing-section-head">
              <div>
                <span className="stak-landing-eyebrow">KNOWN LIMITATIONS</span>
                <h2>Transparent, not dominant.</h2>
              </div>
            </div>
            <div className="stak-landing-note stak-landing-note--dashed">
              <ul className="stak-landing-limitations-list">
                {LIMITATIONS.map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
            </div>
          </section>

          <section
            className="stak-landing-section"
            aria-label="Why not just use Git?"
          >
            <div className="stak-landing-section-head">
              <div>
                <span className="stak-landing-eyebrow">
                  {WHY_NOT_GIT_EYEBROW}
                </span>
                <h2>{WHY_NOT_GIT_HEADING}</h2>
              </div>
            </div>
            <div className="stak-landing-objgrid">
              {WHY_NOT_GIT_ITEMS.map((item) => (
                <div key={item.lead} className="stak-landing-objcard">
                  <span className="stak-landing-objcard-big">{item.lead}</span>
                  <span className="stak-landing-objcard-d">{item.body}</span>
                </div>
              ))}
            </div>
          </section>

          <section className="stak-landing-close" aria-label="Feedback">
            <h2>Help shape STAK.</h2>
            <p>
              Tell us what confused you, broke, or behaved differently from what
              you expected.
            </p>
            <div className="stak-focuspage-ctas">
              <Link href="/feedback" className="stak-landing-cta-primary">
                Share feedback
              </Link>
            </div>
          </section>
        </main>
        <SiteFooter />
      </div>
    </>
  );
}
