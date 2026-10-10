import Link from 'next/link';

import '../overview/shell.css';
import './public-landing-shell.css';

import { CopyCommand } from './copy-command';

/**
 * Public, signed-out landing page shell (P9 Task 2). Replaces the narrow
 * FocusedShell-based card from commit c9f7c05 with the full public-product
 * composition from the STAK Final Contract design doc (S.01): a real top
 * nav, a split hero with an illustrative product preview, a feature strip,
 * and truthful product-explainer sections. Same `.stak` token scope as every
 * other shell (overview/shell.css) - no new colors are introduced here.
 *
 * Deliberately not parameterized with boolean props (vercel-composition-
 * patterns: avoid boolean-prop proliferation) - this is a single-purpose
 * page shell, not a reusable library component, so it owns its full content
 * rather than accepting flags to toggle sections on/off.
 *
 * No motion/animation here by design - that's P9 Task 3, sequenced after
 * this one. The only interactive leaf is `CopyCommand` (clipboard copy).
 */
export function PublicLandingShell() {
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
        <LandingNav />
        <main id="main-content" className="stak-landing-main">
          <Hero />
          <FeatureStrip />
          <HowItWorks />
          <MemoryAndPrivacy />
          <MoveToNewMachine />
          <ClosingBar />
        </main>
      </div>
    </>
  );
}

function LandingNav() {
  return (
    <nav className="stak-landing-nav" aria-label="STAK">
      <Link href="/" className="stak-landing-wordmark">
        STAK
      </Link>
      <div className="stak-landing-nav-links">
        <a href="#how-it-works">How it works</a>
        <a href="#memory-privacy">Memory &amp; privacy</a>
        <a href="#stacks">Stacks</a>
        <a href="#install">CLI</a>
      </div>
      {/* Below 1024px .stak-landing-nav-links is hidden by CSS; this native
          <details> disclosure (same pattern as account-menu.tsx and
          stack-card.tsx's "Technical details") carries the same 4 links so
          they stay reachable instead of being dropped. Keyboard-operable by
          default, no JS required. */}
      <details className="stak-landing-nav-disclosure">
        <summary aria-label="Navigation">Menu</summary>
        <div className="stak-landing-nav-disclosure-panel">
          <a href="#how-it-works">How it works</a>
          <a href="#memory-privacy">Memory &amp; privacy</a>
          <a href="#stacks">Stacks</a>
          <a href="#install">CLI</a>
        </div>
      </details>
      <div className="stak-landing-nav-actions">
        <a className="stak-landing-signin" href="/auth/login?next=/onboarding">
          Sign in
        </a>
        <a className="stak-landing-install-cta" href="#install">
          Install the CLI
        </a>
      </div>
    </nav>
  );
}

function Hero() {
  return (
    <section className="stak-landing-hero">
      <div className="stak-landing-hero-copy">
        <span className="stak-landing-eyebrow">
          For developers who work with AI agents
        </span>
        {/* The real h1 - required verbatim by branding.test.ts and kept as
            the headline, distinct from the "control plane" statement below
            it (two statements with a clear hierarchy, not competing for the
            same line). */}
        <h1>Your STAK should survive your laptop.</h1>
        <p className="stak-landing-lead">
          STAK is the control plane for portable AI agent environments.
        </p>
        <p>
          You&apos;ve spent months teaching Claude, Codex and Cursor how you
          work. STAK backs up those skills, that Memory and your setup. A new
          machine picks up where the old one left off.
        </p>
        <div className="stak-landing-install" id="install">
          <div className="stak-landing-install-row">
            <span className="stak-landing-install-cmd">
              <span className="stak-landing-install-n">1 $ </span>
              npm install -g @usestak/cli
            </span>
            <CopyCommand command="npm install -g @usestak/cli" />
          </div>
          <div className="stak-landing-install-row">
            <span className="stak-landing-install-cmd">
              <span className="stak-landing-install-n">2 $ </span>
              stak login
            </span>
            <CopyCommand command="stak login" />
          </div>
        </div>
        <p className="stak-landing-caption">
          Step 2 opens your browser to approve the machine. Your setup stays
          on it until you choose to back it up.
        </p>
      </div>
      <PreviewCard />
    </section>
  );
}

function PreviewCard() {
  return (
    <div className="stak-landing-preview" aria-label="Illustrative preview">
      <div className="stak-landing-preview-head">
        <span>OVERVIEW · VIEWING AS ATLAS</span>
        <span>Last backup 12 min ago</span>
      </div>
      <div className="stak-landing-preview-status">
        <span className="stak-dot" style={{ background: 'var(--green)' }} />
        <span>Your STAK is backed up.</span>
      </div>
      <div className="stak-landing-preview-rows">
        <div className="stak-landing-preview-row">
          <span className="k">SKILLS</span>
          <span className="v">
            <span className="v1">31 ready</span>
            <span className="v2">
              Inspect source, files and capabilities.
            </span>
          </span>
          <span className="s" style={{ color: 'var(--orange)' }}>
            2 updates
          </span>
        </div>
        <div className="stak-landing-preview-row">
          <span className="k">MEMORY</span>
          <span className="v">
            <span className="v1">Backed up</span>
            <span className="v2">27 files across 9 projects</span>
          </span>
          <span className="s" style={{ color: 'var(--green)' }}>
            Protected
          </span>
        </div>
        <div className="stak-landing-preview-row">
          <span className="k">MACHINES</span>
          <span className="v">
            <span className="v1">2 machines</span>
            <span className="v2">
              Atlas up to date · Studio 1 update waiting
            </span>
          </span>
          <span className="s" style={{ color: 'var(--amber)' }}>
            1 waiting
          </span>
        </div>
      </div>
      <div className="stak-landing-preview-dock">
        <span className="scope">ON ATLAS</span>
        <span className="cmd">
          <span className="p">$ </span>stak memory backup
        </span>
        <span className="hint">Copy</span>
      </div>
      <p className="stak-landing-preview-note">
        Illustrative preview, not your account data.
      </p>
    </div>
  );
}

function FeatureStrip() {
  const features = [
    {
      title: 'Skills you can inspect',
      body: 'See the source, the files, every version and the exact diff before you approve an update.',
    },
    {
      title: 'Memory you can recover',
      body: 'Back up what your agents learned. Private to your account, or Protected: encrypted on your machine.',
    },
    {
      title: 'Projects that move with you',
      body: 'A project keeps its Memory when the folder or the machine changes. Map it and carry on.',
    },
    {
      title: 'Machines, honestly',
      body: 'See which machine is current, and when each one last checked in.',
    },
    {
      title: 'Stacks you can reuse',
      body: 'Inspect a whole setup, preview what it changes, apply it with one command.',
    },
  ];

  return (
    <section
      id="stacks"
      className="stak-landing-features"
      aria-label="What STAK does"
    >
      {features.map((feature) => (
        <div className="stak-landing-feature" key={feature.title}>
          <span className="t">{feature.title}</span>
          <span className="b">{feature.body}</span>
        </div>
      ))}
    </section>
  );
}

function HowItWorks() {
  return (
    <section id="how-it-works" className="stak-landing-section">
      <h2>How it works</h2>
      <ol className="stak-landing-steps">
        <li>
          <span className="step-name">Install</span>
          <code>npm install -g @usestak/cli</code>
        </li>
        <li>
          <span className="step-name">Log in</span>
          <code>stak login</code>
        </li>
        <li>
          <span className="step-name">Scan your setup</span>
          <code>stak scan</code>
        </li>
        <li>
          <span className="step-name">Back up</span>
          <code>stak memory backup</code>
        </li>
        <li>
          <span className="step-name">Recover on a new machine</span>
          <code>stak memory recover</code>
        </li>
      </ol>
    </section>
  );
}

function MemoryAndPrivacy() {
  return (
    <section id="memory-privacy" className="stak-landing-section">
      <h2>Memory &amp; privacy</h2>
      <div className="stak-landing-privacy-grid">
        <div className="stak-landing-privacy-card">
          <span className="t">Standard</span>
          <span className="b">
            Account-wide: private to your account; STAK&apos;s service can
            read it to deliver it.
          </span>
        </div>
        <div className="stak-landing-privacy-card">
          <span className="t">Protected</span>
          <span className="b">
            Account-wide: encrypted on your machine before upload; STAK
            stores ciphertext and can&apos;t read it.
          </span>
        </div>
      </div>
    </section>
  );
}

function MoveToNewMachine() {
  return (
    <section id="move" className="stak-landing-section">
      <h2>Move to a new machine</h2>
      <ol className="stak-landing-steps">
        <li>
          <span className="step-name">Log in</span>
          <code>stak login</code>
        </li>
        <li>
          <span className="step-name">Recover your Memory</span>
          <code>stak memory recover</code>
        </li>
        <li>
          <span className="step-name">Restore your Skills</span>
          <code>stak memory restore</code>
        </li>
        <li>
          <span className="step-name">Map your projects</span>
          <code>stak project map &lt;project&gt; &lt;directory&gt;</code>
        </li>
      </ol>
    </section>
  );
}

function ClosingBar() {
  return (
    <div className="stak-landing-closing">
      <span>Each machine catches up when you use the STAK CLI there.</span>
      <span className="stak-landing-closing-muted">
        No daemon. No surprise background changes.
      </span>
    </div>
  );
}
