'use client';

import { useState, type ReactNode } from 'react';

/**
 * Interactive leaf components for the public landing page (P9 "Task 1":
 * structure/copy/static+interactive sections, rebuilt against the approved
 * STAK-Landing-Layered design doc). Isolated here per vercel-composition-
 * patterns (interactivity lives in leaf Client Components; the surrounding
 * section markup in public-landing-shell.tsx stays a Server Component so
 * all copy is server-rendered and crawlable without JS).
 *
 * Every piece of state here is local useState - no global state is needed,
 * each control is a self-contained island (design doc fields: setStd/setPro,
 * viewDell/viewMac, objTab, copy/copied, menu).
 */

/** Copy-on-click-anywhere-in-row command bar. Used for the hero install
 * command and the Close/CTA section's two command rows (design: `copyInstall`
 * / `copyLogin`, "Copy targets" Responsive note - the whole row is the
 * target, 52px min height, feedback flips to "Copied" for ~1.6s). */
export function CopyRow({
  command,
  prefix,
  className,
}: {
  command: string;
  prefix?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  const onCopy = () => {
    try {
      void navigator.clipboard?.writeText(command);
    } catch {
      // Clipboard API can be unavailable (insecure context, denied
      // permission). The command text is still visible to copy by hand.
    }
    // The "Copied" confirmation reflects the user's intent, not whether the
    // async clipboard write actually landed - same as the design's own
    // `copy()` helper, which sets `copied` unconditionally after a
    // best-effort `navigator.clipboard.writeText`.
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div
      className={
        className ? `stak-landing-cmdrow ${className}` : 'stak-landing-cmdrow'
      }
      role="button"
      tabIndex={0}
      onClick={onCopy}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onCopy();
        }
      }}
      aria-label={`Copy command: ${command}`}
    >
      <span className="stak-landing-cmdrow-cmd">
        {prefix ? (
          <span className="stak-landing-cmdrow-n">{prefix}</span>
        ) : null}
        <span className="stak-landing-cmdrow-p">$ </span>
        {command}
      </span>
      <span
        className={
          copied
            ? 'stak-landing-cmdrow-copy stak-landing-cmdrow-copy--done'
            : 'stak-landing-cmdrow-copy'
        }
      >
        {copied ? 'Copied ✓' : 'Copy'}
      </span>
    </div>
  );
}

/** Mobile/tablet nav menu toggle - 44px hamburger, opens a 52px-row panel
 * "in place" with no slide animation (Responsive motion table: "Icon morphs
 * to × in .25s; sheet appears without sliding"). Desktop never renders this
 * (CSS hides it via container query; the links row shows instead). */
export function NavMenuToggle({
  links,
}: {
  links: { t: string; u: string; k: string }[];
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="stak-landing-navmenu">
      <button
        type="button"
        aria-label="Menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="stak-landing-navmenu-btn"
      >
        <span
          className="stak-landing-navmenu-bar"
          style={{
            transform: open ? 'translateY(2.75px) rotate(45deg)' : 'none',
          }}
        />
        <span
          className="stak-landing-navmenu-bar"
          style={{
            transform: open ? 'translateY(-2.75px) rotate(-45deg)' : 'none',
          }}
        />
      </button>
      {open ? (
        <div className="stak-landing-navmenu-panel">
          {links.map((l) => (
            <a key={l.t} href={l.u} onClick={() => setOpen(false)}>
              {l.t}
              <span className="stak-landing-navmenu-k">{l.k}</span>
            </a>
          ))}
          <a href="/auth/login?next=/onboarding" onClick={() => setOpen(false)}>
            Sign in
          </a>
        </div>
      ) : null}
    </div>
  );
}

export type ObjCard = {
  k: string;
  s: string;
  statusTone: 'green' | 'faint';
  big: string;
  d: string;
  rows: { a: string; b: string; tone: 'green' | 'orange' | 'faint' }[];
};

/** "This Is Your STAK" object grid (design: `objs`/`objTabs`/`objsShown`).
 * All 4 cards are always server-rendered (so every row of real content is
 * crawlable); the 4-way tab control only exists to pick which ONE card is
 * visible below the tablet breakpoint - the CSS for that visibility switch
 * lives in public-landing-shell.css and is itself width-gated via container
 * query, so JS only ever narrows (never widens) what a crawler already has. */
export function ObjectsGrid({ objs }: { objs: ObjCard[] }) {
  const [active, setActive] = useState(0);

  return (
    <>
      <div
        role="tablist"
        aria-label="Choose what to view"
        className="stak-landing-objtabs"
      >
        {objs.map((o, i) => (
          <button
            key={o.k}
            role="tab"
            type="button"
            aria-selected={active === i}
            onClick={() => setActive(i)}
            className={
              active === i
                ? 'stak-landing-objtab stak-landing-objtab--active'
                : 'stak-landing-objtab'
            }
          >
            {o.k}
          </button>
        ))}
      </div>
      <div className="stak-landing-objgrid">
        {objs.map((o, i) => (
          <div
            key={o.k}
            className="stak-landing-objcard"
            data-active={active === i}
          >
            <div className="stak-landing-objcard-head">
              <span className="stak-landing-objcard-k">{o.k}</span>
              <span className={`stak-landing-tone-${o.statusTone}`}>{o.s}</span>
            </div>
            <span className="stak-landing-objcard-big">{o.big}</span>
            <span className="stak-landing-objcard-d">{o.d}</span>
            <div className="stak-landing-objcard-rows">
              {o.rows.map((r) => (
                <div key={r.a} className="stak-landing-objcard-row">
                  <span>{r.a}</span>
                  <span className={`stak-landing-tone-${r.tone}`}>{r.b}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

export type PrivacyMode = {
  key: 'standard' | 'protected';
  label: string;
  title: string;
  desc: string;
  rec: string;
  cloudLabel: string;
  cloudText: string;
  cloudWho: string;
  tone: 'green' | 'muted';
};

/** Standard/Protected privacy tabs (design: `setStd`/`setPro`, `pv`). The
 * "ON WINDOWS" panel never changes; only the "IN STAK CLOUD" panel and the
 * copy block beside the tabs swap with mode.
 *
 * Design source (`STAK-Landing-Layered.dc.html:187`) makes `#privacy` a
 * top-level 2-column grid with two SIBLING children: the copy+tabs column
 * and a separate comparison-cards column. Both need the same mode state, so
 * this single client component renders a Fragment of the two sibling grid
 * items directly (no extra wrapper DOM node), letting the parent's
 * `.stak-landing-privacy-grid` lay them out as real grid siblings - at
 * <1024px container width the grid is a single column (copy row, then the
 * panels row beneath it, per the Responsive doc's tablet note), and at
 * >=1024px it becomes the original side-by-side 2-column layout. */
export function PrivacyPanel({
  intro,
  modes,
}: {
  intro: ReactNode;
  modes: [PrivacyMode, PrivacyMode];
}) {
  const [modeKey, setModeKey] = useState<PrivacyMode['key']>('standard');
  const mode = modes.find((m) => m.key === modeKey) ?? modes[0];

  return (
    <>
      <div className="stak-landing-privacy-copy">
        {intro}
        <div
          role="tablist"
          aria-label="Memory mode"
          className="stak-landing-pvtabs"
        >
          {modes.map((m) => (
            <button
              key={m.key}
              role="tab"
              type="button"
              aria-selected={modeKey === m.key}
              onClick={() => setModeKey(m.key)}
              className={
                modeKey === m.key
                  ? 'stak-landing-pvtab stak-landing-pvtab--active'
                  : 'stak-landing-pvtab'
              }
            >
              {m.label}
            </button>
          ))}
        </div>
        <div className="stak-landing-pvcopy">
          <span className="stak-landing-pvcopy-title">{mode.title}</span>
          <span className="stak-landing-pvcopy-desc">{mode.desc}</span>
        </div>
        <span className="stak-landing-pvcopy-rec">{mode.rec}</span>
      </div>
      <div className="stak-landing-privacy-panels">
        <div className="stak-landing-pvgrid">
          <div className="stak-landing-pvcard">
            <span className="stak-landing-pvcard-k">ON WINDOWS</span>
            <span className="stak-landing-pvcard-text">
              Migrations must run inside a transaction. CI uses Postgres 15.
            </span>
          </div>
          <div
            className="stak-landing-pvcard"
            data-protected={mode.key === 'protected'}
          >
            <span
              className={
                mode.tone === 'green'
                  ? 'stak-landing-pvcard-k stak-landing-tone-green'
                  : 'stak-landing-pvcard-k'
              }
            >
              IN STAK CLOUD
            </span>
            <span className="stak-landing-pvcard-text stak-landing-pvcard-text--mono">
              {mode.cloudText}
            </span>
            <span className="stak-landing-pvcard-who">{mode.cloudWho}</span>
          </div>
        </div>
      </div>
    </>
  );
}

export type MachineCard = {
  name: 'Windows' | 'macOS' | 'Linux';
  kind: string;
  status: string;
  tone: 'green' | 'amber' | 'faint';
  rows: { a: string; b: string }[];
};

/** Machines "Viewing as" Windows/macOS/Linux toggle (design: `viewDell`/
 * `viewMac`, `vw`, originally a 2-way DELL/MacBook toggle). All cards are
 * always rendered (desktop/tablet show them side by side per the
 * Responsive notes); the toggle only highlights which one is "being
 * viewed", it never hides the others - the design's own `card()` helper
 * only changes background/the "· viewing" suffix, not visibility. */
export function MachinesPanel({
  cards,
}: {
  cards: [MachineCard, MachineCard, MachineCard];
}) {
  const [viewing, setViewing] = useState<MachineCard['name']>(cards[0].name);

  return (
    <>
      <div className="stak-landing-viewas">
        <span className="stak-landing-viewas-label">Viewing as</span>
        {cards.map((c) => (
          <button
            key={c.name}
            type="button"
            onClick={() => setViewing(c.name)}
            aria-pressed={viewing === c.name}
            className={
              viewing === c.name
                ? 'stak-landing-viewas-btn stak-landing-viewas-btn--active'
                : 'stak-landing-viewas-btn'
            }
          >
            {c.name}
          </button>
        ))}
      </div>
      <div className="stak-landing-machinegrid">
        {cards.map((m) => (
          <div
            key={m.name}
            className="stak-landing-machinecard"
            data-viewing={viewing === m.name}
          >
            <div className="stak-landing-machinecard-head">
              <div>
                <div className="stak-landing-machinecard-name">
                  {m.name}{' '}
                  {viewing === m.name ? (
                    <span className="stak-landing-machinecard-viewing">
                      · viewing
                    </span>
                  ) : null}
                </div>
                <div className="stak-landing-machinecard-kind">{m.kind}</div>
              </div>
              <span
                className={`stak-landing-machinecard-status stak-landing-tone-${m.tone}`}
              >
                <span className="stak-landing-dot" data-tone={m.tone} />
                {m.status}
              </span>
            </div>
            <div className="stak-landing-machinecard-rows">
              {m.rows.map((r) => (
                <div key={r.a} className="stak-landing-machinecard-row">
                  <span className="stak-landing-tone-faint">{r.a}</span>
                  <span>{r.b}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
