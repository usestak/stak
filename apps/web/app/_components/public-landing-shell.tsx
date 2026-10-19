import Link from 'next/link';

import '../overview/shell.css';
import './public-landing-shell.css';

import {
  CopyRow,
  MachinesPanel,
  NavMenuToggle,
  ObjectsGrid,
  PrivacyPanel,
  type MachineCard,
  type ObjCard,
  type PrivacyMode,
} from './landing-interactive';
import { HeroWord, ScrollStory } from './landing-scroll-story';

/**
 * Public, signed-out landing page shell - P9 "Task 1" (structure, copy, and
 * static/interactive non-scroll-story sections), rebuilt FAITHFULLY against
 * the approved design doc (`STAK-Landing-Layered.dc.html` for content/
 * interaction/desktop intent, `STAK-Landing-Responsive.dc.html` for width-
 * specific recomposition) - this is a from-scratch rebuild superseding the
 * prior "Final Contract" based composition, not an iteration on it.
 *
 * Breakpoints follow the design's own thresholds, driven by CONTAINER width
 * (not viewport media queries, not user-agent sniffing): < 640 mobile,
 * 640-1023 tablet, >= 1024 desktop. `.stak-landing` below sets
 * `container-type: inline-size` and every width-specific rule in
 * public-landing-shell.css is a `@container` rule keyed to that container -
 * per the Responsive doc's own explicit note ("In production use CSS
 * container queries on the landing root"). JS state is used ONLY for the
 * handful of truly *structural* recompositions CSS can't express on its own
 * (which single object card shows on mobile, which machine is "being
 * viewed", which privacy mode's copy/cloud panel renders) - see
 * landing-interactive.tsx; every one of those is a leaf Client Component so
 * this file and all its copy stay a plain Server Component, fully
 * crawlable without JS.
 *
 * The hero's pinned Windows -> STAK -> macOS scroll story and the rotating
 * hero word are intentionally left as a static "frame 0" stub here - P9
 * Task 2 implements the actual scroll-scrubbing/rotation motion on top of
 * this same markup (design doc's own "STATIC FRAMES" note: "A fixed step
 * renders one frame with no pinning; use it for previews").
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
        <main id="main-content">
          <Hero />
          <ProblemSection />
          <YourStakSection />
          <MoveSection />
          <PrivacySection />
          <MachinesSection />
          <CloseSection />
        </main>
        <SiteFooter />
      </div>
    </>
  );
}

const NAV_LINKS = [
  { t: 'How it works', u: '#how', k: '→' },
  { t: 'Memory & privacy', u: '#privacy', k: '→' },
  { t: 'Machines', u: '#machines', k: '→' },
  { t: 'Docs', u: '/docs', k: '→' },
];

function LandingNav() {
  return (
    <nav className="stak-landing-nav" aria-label="Memory STAK">
      <Link href="/" className="stak-landing-wordmark">
        <img src="/brand/stak-symbol-dark.svg" alt="" width={18} height={18} />
        Memory STAK
      </Link>
      <div className="stak-landing-nav-links">
        <a href="#how">How it works</a>
        <a href="#privacy">Memory &amp; privacy</a>
        <a href="#machines">Machines</a>
        <a href="/docs">Docs</a>
      </div>
      <div className="stak-landing-nav-right">
        <a href="/auth/login?next=/onboarding" className="stak-landing-signin">
          Sign in
        </a>
        <a href="#install" className="stak-landing-install-cta">
          Install the CLI
        </a>
        <a href="#install" className="stak-landing-install-cta-mobile">
          Install
        </a>
        <NavMenuToggle links={NAV_LINKS} />
      </div>
    </nav>
  );
}

function Hero() {
  return (
    <section className="stak-landing-hero" aria-label="Memory STAK">
      {/* Two distinct compositions (design: separate `mob`/`notMob` markup,
          not just a reflow of the same lines) - desktop groups "Your [WORD]
          should" on one line and "survive your laptop." on the next; mobile
          stacks four lines so the rotating word never shifts "Your"/
          "should". Both render; CSS shows exactly one per container width. */}
      <h1
        className="stak-landing-h1 stak-landing-h1--desktop"
        aria-label="Your STAK should survive your laptop."
      >
        <span className="stak-landing-h1-row" aria-hidden="true">
          <span className="stak-landing-h1-your">Your</span>
          <span className="stak-landing-h1-wordrow">
            <HeroWord />
            <span>should</span>
          </span>
        </span>
        <span className="stak-landing-h1-line2" aria-hidden="true">
          survive your laptop.
        </span>
      </h1>
      <h1
        className="stak-landing-h1 stak-landing-h1--mobile"
        aria-label="Your STAK should survive your laptop."
      >
        <span className="stak-landing-h1-line" aria-hidden="true">
          Your
        </span>
        <span aria-hidden="true" className="stak-landing-h1-word-row">
          <HeroWord />
        </span>
        <span className="stak-landing-h1-line" aria-hidden="true">
          should survive
        </span>
        <span className="stak-landing-h1-line" aria-hidden="true">
          your laptop.
        </span>
      </h1>
      <p className="stak-landing-lead">
        Carry your Skills, Memory, and setup as one portable STAK. Inspect it on
        one machine, bring it back on the next.
      </p>
      <div id="install" className="stak-landing-install-anchor" />
      <CopyRow command="npm install -g @memstk/cli" />
      {/* Pinned, scroll-scrubbed Windows -> Your STAK -> macOS portability
          story across 7 steps (P9 Task 2). See landing-scroll-story.tsx for
          the scroll-to-step formula and the exact per-step data/transforms,
          ported faithfully from the design source. */}
      <ScrollStory />
    </section>
  );
}

function ProblemSection() {
  return (
    <section className="stak-landing-section" aria-label="The problem">
      <div className="stak-landing-problem-grid">
        <div className="stak-landing-problem-copy">
          <span className="stak-landing-eyebrow">THE PROBLEM</span>
          <h2>Your agent setup is stuck on this machine.</h2>
          <p>
            Every week your agents get better. You add Skills, they build
            Memory, and your workflow starts to feel like yours. Move to a new
            machine, and too much of that setup doesn&apos;t come with you.
          </p>
          <div className="stak-landing-problem-rule">
            <span>New laptop</span>
            <span className="stak-landing-tone-orange">→</span>
            <span className="stak-landing-tone-orange">
              rebuild what you already taught your agents.
            </span>
          </div>
        </div>
        <div className="stak-landing-dellcard">
          <div className="stak-landing-dellcard-head">
            <span className="stak-landing-dellcard-name">Windows</span>
            <span className="stak-landing-dellcard-sub">
              What your agents rely on
            </span>
          </div>
          <DellRow label="SKILLS">
            <DellLine a="Claude Code" b="24" />
            <DellLine a="Codex" b="9" />
            <DellLine a="Shared across both" b="2" faint />
          </DellRow>
          <DellRow label="MEMORY">
            <DellLine a="Claude Code" b="local" faint />
            <DellLine a="Codex" b="local" faint />
          </DellRow>
          <DellRow label="PROJECT">
            <DellLine a="ledger-api" b="present" faint />
          </DellRow>
          <DellRow label="SETUP">
            <DellLine a="Agent setup" b="spread across tools" faint />
          </DellRow>
          <div className="stak-landing-dellcard-foot">
            <span className="stak-landing-dot" data-tone="faint" />
            Still tied to Windows.
          </div>
        </div>
      </div>
    </section>
  );
}

function DellRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="stak-landing-dellrow">
      <span className="stak-landing-dellrow-label">{label}</span>
      <div className="stak-landing-dellrow-lines">{children}</div>
    </div>
  );
}

function DellLine({ a, b, faint }: { a: string; b: string; faint?: boolean }) {
  return (
    <div className="stak-landing-dellline">
      <span className={faint ? 'stak-landing-tone-faint' : undefined}>{a}</span>
      <span
        className={
          faint
            ? 'stak-landing-dellline-b stak-landing-tone-faint'
            : 'stak-landing-dellline-b'
        }
      >
        {b}
      </span>
    </div>
  );
}

const OBJS: ObjCard[] = [
  {
    k: 'SKILLS',
    s: '31 ready',
    statusTone: 'green',
    big: 'The instructions they follow',
    d: 'Reusable instructions that shape how your agents work.',
    rows: [
      { a: 'review-pr', b: 'Ready', tone: 'green' },
      { a: 'test-first', b: 'Update available', tone: 'orange' },
      { a: 'debug-flaky', b: 'Paused', tone: 'faint' },
    ],
  },
  {
    k: 'MEMORY',
    s: 'Backed up',
    statusTone: 'green',
    big: 'What they remember',
    d: 'Context your agents build as you work.',
    rows: [
      { a: 'ledger-api', b: '6 files', tone: 'faint' },
      { a: 'stak-cli', b: '5 files', tone: 'faint' },
      { a: 'history', b: '14 backups', tone: 'faint' },
    ],
  },
  {
    k: 'PROJECTS',
    s: '9',
    statusTone: 'faint',
    big: 'Where the work belongs',
    d: 'Keep the right Memory connected to the right project.',
    rows: [
      { a: 'ledger-api', b: 'On this machine', tone: 'green' },
      { a: 'mobile-app', b: 'Not on this machine', tone: 'faint' },
      { a: 'infra', b: 'Archived', tone: 'faint' },
    ],
  },
  {
    k: 'STACK',
    s: 'main',
    statusTone: 'faint',
    big: 'What you take with you',
    d: 'The Skills you want together in your portable setup.',
    rows: [
      { a: 'Included', b: '30 skills', tone: 'green' },
      { a: 'Paused', b: '1 skill', tone: 'faint' },
      { a: 'Agents', b: 'Claude · Codex · Cursor', tone: 'faint' },
    ],
  },
];

function YourStakSection() {
  return (
    <section className="stak-landing-section">
      <div className="stak-landing-section-head">
        <div>
          <span className="stak-landing-eyebrow">THIS IS YOUR STAK</span>
          <h2>The parts of your agent setup, in one place.</h2>
        </div>
        <p>
          Memory STAK gives you one view of the Skills, Memory, Projects, and
          setup you want to carry with you.
        </p>
      </div>
      <ObjectsGrid objs={OBJS} />
      <div className="stak-landing-strip">
        <span className="stak-landing-strip-cmd">
          <span className="stak-landing-tone-dim">$ </span>stak scan
        </span>
        <span className="stak-landing-strip-note">
          Start by seeing what Memory STAK can carry.
        </span>
      </div>
    </section>
  );
}

const MOVES = [
  {
    n: '1',
    t: 'CONNECT THIS MACHINE',
    cmd: 'stak login',
    d: 'Approve it in your browser.',
  },
  {
    n: '2',
    t: 'GET YOUR SETUP',
    cmd: 'stak pull',
    d: 'Pull down the STAK you already approved.',
  },
  {
    n: '3',
    t: 'BRING YOUR MEMORY BACK',
    cmd: 'stak memory recover',
    d: 'Recover the Memory you backed up from your other machine.',
  },
  {
    n: '4',
    t: 'PUT IT BACK WHERE YOUR AGENTS USE IT',
    cmd: 'stak memory restore',
    d: 'Restore recovered Memory into your agents.',
  },
];

function MoveSection() {
  return (
    <section
      id="how"
      className="stak-landing-section stak-landing-section--panel"
    >
      <div className="stak-landing-section-head stak-landing-section-head--narrow">
        <div>
          <span className="stak-landing-eyebrow">MOVE TO ANOTHER MACHINE</span>
          <h2>Bring your STAK to a new machine.</h2>
        </div>
        <p>You choose when it moves. Nothing happens in the background.</p>
      </div>
      <ol className="stak-landing-moves">
        {MOVES.map((m, i) => (
          <li key={m.n} className="stak-landing-move">
            <div className="stak-landing-move-rail">
              <span className="stak-landing-move-n">{m.n}</span>
              {i < MOVES.length - 1 ? (
                <span className="stak-landing-move-line" />
              ) : null}
            </div>
            <div className="stak-landing-move-body">
              <span className="stak-landing-move-t">
                <span className="stak-landing-move-n-inline">{m.n} · </span>
                {m.t}
              </span>
              <span className="stak-landing-move-cmd">
                <span className="stak-landing-tone-dim">$ </span>
                {m.cmd}
              </span>
              <span className="stak-landing-move-d">{m.d}</span>
            </div>
          </li>
        ))}
      </ol>
      <div className="stak-landing-notes">
        <div className="stak-landing-note stak-landing-note--dashed">
          <span>
            Projects usually resolve on their own. If one doesn&apos;t:
          </span>
          <span className="stak-landing-note-cmd">
            <span className="stak-landing-tone-dim">$ </span>
            stak project map &lt;project&gt; &lt;directory&gt;
          </span>
        </div>
        <div className="stak-landing-note stak-landing-note--solid">
          <span className="stak-landing-note-cmd">
            <span className="stak-landing-tone-orange">$ </span>
            stak run claude
          </span>
          <span>
            Set up Claude Code (or Codex / Cursor) with your approved setup and
            launch it on this machine.
          </span>
        </div>
      </div>
    </section>
  );
}

const PRIVACY_MODES: [PrivacyMode, PrivacyMode] = [
  {
    key: 'standard',
    label: 'Standard',
    title: 'Easy recovery',
    desc: 'Private to your account. Sign in on a new machine and bring your Memory back.',
    rec: 'On Standard, sign in on a new machine and recover.',
    cloudLabel: 'IN STAK CLOUD',
    cloudText: 'Migrations must run inside a transaction. CI uses Postgres 15.',
    cloudWho: 'Readable by Memory STAK to recover it for you.',
    tone: 'muted',
  },
  {
    key: 'protected',
    label: 'Protected',
    title: 'Only you can unlock it',
    desc: "Memory STAK can store your backup, but can't read it. You'll need your passkey or recovery file on a new machine.",
    rec: 'On Protected, use your passkey or recovery file to unlock it.',
    cloudLabel: 'IN STAK CLOUD',
    cloudText: 'b64:9QeX2kT0vR+aLw7mYc1Zp4Hs…Nf8uE3jQ0bD6tVyK2oPq==',
    cloudWho: 'Encrypted before it leaves Windows. Memory STAK can’t read it.',
    tone: 'green',
  },
];

function PrivacySection() {
  return (
    <section id="privacy" className="stak-landing-section">
      <div className="stak-landing-privacy-grid">
        <PrivacyPanel
          intro={
            <>
              <span className="stak-landing-eyebrow">PRIVACY IS A CHOICE</span>
              <h2>Choose who can read your Memory.</h2>
              <p>
                Memory mode applies to your whole account. Standard keeps
                recovery simple. Protected keeps your Memory unreadable to
                Memory STAK.
              </p>
            </>
          }
          modes={PRIVACY_MODES}
        />
      </div>
    </section>
  );
}

const MACHINE_CARDS: [MachineCard, MachineCard, MachineCard] = [
  {
    name: 'Windows',
    kind: 'XPS 15 · Windows 11',
    status: 'Up to date · 12 min ago',
    tone: 'green',
    rows: [
      { a: 'Skills', b: '31 of 31 approved' },
      { a: 'Projects', b: '7 of 9 on this machine' },
      { a: 'Memory', b: 'Backed up here' },
    ],
  },
  {
    name: 'macOS',
    kind: 'MacBook Air · macOS 15',
    status: 'Updates waiting · 3 hours ago',
    tone: 'amber',
    rows: [
      { a: 'Skills', b: '30 of 31 approved' },
      { a: 'Projects', b: '7 of 9 on this machine' },
      { a: 'Memory', b: 'Backed up here' },
    ],
  },
  {
    name: 'Linux',
    kind: 'ThinkPad X1 · Ubuntu 24.04',
    status: 'Last seen 2 days ago',
    tone: 'faint',
    rows: [
      { a: 'Skills', b: '28 of 31 approved' },
      { a: 'Projects', b: '5 of 9 on this machine' },
      { a: 'Memory', b: 'Backed up here' },
    ],
  },
];

function MachinesSection() {
  return (
    <section id="machines" className="stak-landing-section">
      <div className="stak-landing-section-head">
        <div>
          <span className="stak-landing-eyebrow">YOUR MACHINES</span>
          <h2>Know where each machine left off.</h2>
        </div>
        <div className="stak-landing-section-head-copy">
          <p>
            When you use Memory STAK on a machine, it reports what it saw. You
            can see what&apos;s ready, what&apos;s waiting, and how old that
            picture is.
          </p>
          <p className="stak-landing-small">
            Nothing runs in the background just to keep this page current.
          </p>
        </div>
      </div>
      <div className="stak-landing-machinepanel">
        <div className="stak-landing-machinepanel-head">
          <span className="stak-landing-tone-dim">MACHINES</span>
          <MachinesPanel cards={MACHINE_CARDS} />
        </div>
        <div className="stak-landing-machinepanel-strip">
          <span className="stak-landing-tone-amber stak-landing-small">
            ON MACOS
          </span>
          <span className="stak-landing-strip-cmd">
            <span className="stak-landing-tone-dim">$ </span>
            stak skill update
          </span>
          <span className="stak-landing-tone-dim">
            Install the approved Skill versions on this machine.
          </span>
        </div>
      </div>
    </section>
  );
}

function CloseSection() {
  return (
    <section id="install-cta" className="stak-landing-close">
      <h2>Change the laptop. Keep your STAK.</h2>
      <p>
        Install Memory STAK, sign in, and keep working the way you already do.
      </p>
      <div className="stak-landing-close-cmds">
        <CopyRow command="npm install -g @memstk/cli" prefix="1 " />
        <CopyRow command="stak login" prefix="2 " />
      </div>
    </section>
  );
}

const FOOTER_GROUPS = [
  {
    h: 'PRODUCT',
    l: [
      { t: 'How it works', u: '#how' },
      { t: 'Memory & privacy', u: '#privacy' },
      { t: 'Install Memory STAK', u: '#install' },
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
    ],
  },
];

/**
 * Footer. The design's ACCOUNT group also lists "Control center" -> `/app`,
 * which doesn't exist in this app (the real signed-in landing is
 * `/overview`, and it requires auth - there's no safe public link to it for
 * a signed-out visitor). Per the task brief this link is omitted rather
 * than invented; see the task report for the full mismatch writeup.
 */
function SiteFooter() {
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
