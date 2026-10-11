'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';

/**
 * Hero scroll-driven portability story (DELL -> Your STAK -> MacBook across
 * 7 steps) + the rotating hero word ("STAK"/"SKILLS"/"MEMORY"/"AGENT").
 *
 * Ported FAITHFULLY from `STAK-Landing-Layered.dc.html`'s `Component` class
 * (P9 Task 2) - literal scroll-to-step formula, literal 7-step data, literal
 * fan transforms/colors, literal word-rotation width-measuring technique.
 * This is a dedicated component (not a reuse of the prior IntersectionObserver
 * `landing-scroll-reveal.tsx` pattern) because this is pinned/scrubbed
 * scroll-position tracking, not a one-shot reveal - a fundamentally
 * different interaction model that needs its own scroll listener + step
 * state machine.
 */

/** `window.matchMedia` is absent in some test environments (jsdom does not
 * implement it) - guard rather than assume it exists, same spirit as the
 * design's own `window.matchMedia && window.matchMedia(...).matches`. */
function prefersReducedMotion(): boolean {
  if (
    typeof window === 'undefined' ||
    typeof window.matchMedia !== 'function'
  ) {
    return false;
  }
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// ---- Rotating hero word -----------------------------------------------

const WORDS = ['STAK', 'SKILLS', 'MEMORY', 'AGENT'];

/** Letter-stagger flip-in/out rotating word, 4.2s cadence, width-measured so
 * layout never jumps between word lengths (design: `measureWord()` /
 * `data-w` sizer spans). Disabled entirely under reduced motion - renders a
 * static "STAK" with no interval and no animation (Responsive motion table:
 * "Off. Static 'STAK'."). */
export function HeroWord() {
  const [reduced, setReduced] = useState(false);
  const [ready, setReady] = useState(false);
  const [wi, setWi] = useState(0);
  const [wprev, setWprev] = useState<number | null>(null);
  const [hold, setHold] = useState(false);
  const sizeRef = useRef<HTMLSpanElement>(null);
  const widthsRef = useRef<Record<string, number>>({});
  const [, bump] = useState(0);
  const holdTimeout = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );

  useEffect(() => {
    const rm = prefersReducedMotion();
    setReduced(rm);
    setReady(true);
    if (rm) return;
    const interval = setInterval(() => {
      setWi((prevWi) => {
        setWprev(prevWi);
        setHold(true);
        clearTimeout(holdTimeout.current);
        holdTimeout.current = setTimeout(() => setHold(false), 1500);
        return prevWi + 1;
      });
    }, 4200);
    return () => {
      clearInterval(interval);
      clearTimeout(holdTimeout.current);
    };
  }, []);

  // Re-measure the hidden sizer spans after every render (mirrors the
  // design's componentDidUpdate -> measureWord() -> forceUpdate loop).
  useLayoutEffect(() => {
    const box = sizeRef.current;
    if (!box) return;
    let changed = false;
    box.querySelectorAll<HTMLElement>('[data-w]').forEach((n) => {
      const w = n.offsetWidth;
      const k = n.getAttribute('data-w');
      if (!k) return;
      if (w && widthsRef.current[k] !== w) {
        widthsRef.current[k] = w;
        changed = true;
      }
    });
    if (changed) bump((x) => x + 1);
  });

  if (!ready) {
    // SSR / pre-hydration frame: static word, no measuring, no flash.
    return <span className="stak-landing-h1-word">STAK</span>;
  }

  if (reduced) {
    return <span className="stak-landing-h1-word">STAK</span>;
  }

  const cur = WORDS[wi % 4];
  const prev = wprev != null ? WORDS[wprev % 4] : null;
  const wCur = widthsRef.current[cur];
  const wPrev = prev != null ? widthsRef.current[prev] : undefined;
  const boxW =
    wCur == null
      ? undefined
      : hold && wPrev != null
        ? Math.max(wPrev, wCur)
        : wCur;

  const letters = (word: string, anim: 'none' | 'in' | 'out', key: string) => (
    <span
      key={key}
      aria-hidden="true"
      className="stak-word-letters"
      style={{
        position: anim === 'out' ? 'absolute' : 'relative',
        left: anim === 'out' ? 0 : undefined,
        top: 0,
      }}
    >
      {word.split('').map((ch, i) => (
        <span
          key={i}
          className="stak-word-letter"
          style={{
            animation:
              anim === 'none'
                ? 'none'
                : `${
                    anim === 'out'
                      ? 'stkOut .75s cubic-bezier(.6,0,.8,.3)'
                      : 'stkIn 1.25s cubic-bezier(.16,1,.3,1)'
                  } ${i * (anim === 'out' ? 35 : 70) + (anim === 'out' ? 0 : 260)}ms both`,
          }}
        >
          {ch}
        </span>
      ))}
    </span>
  );

  return (
    <span
      className="stak-landing-h1-word stak-word"
      style={{ width: boxW, transition: 'width .8s cubic-bezier(.65,0,.35,1)' }}
    >
      <span ref={sizeRef} aria-hidden="true" className="stak-word-sizer">
        {WORDS.map((w) => (
          <span key={w} data-w={w} className="stak-word-sizer-item">
            {w}
          </span>
        ))}
      </span>
      <span className="stak-word-sr-only">{cur}</span>
      {prev != null && prev !== cur ? letters(prev, 'out', `o${wi}`) : null}
      {letters(cur, wi === 0 ? 'none' : 'in', `i${wi}`)}
      <span
        key={`l${wi}`}
        className="stak-word-line"
        style={{
          animation:
            wi === 0 ? 'none' : 'stkLine 1.6s cubic-bezier(.65,0,.35,1) both',
        }}
      />
    </span>
  );
}

// ---- Scroll-driven portability story ----------------------------------

type Step = [
  machine: string,
  cmd: string,
  output: string,
  cap: string,
  sub: string,
];

const STEPS: Step[] = [
  [
    'DELL',
    'stak scan',
    '',
    'Your agent setup starts on DELL.',
    'Skills, Memory and local setup accumulate as you work.',
  ],
  ['DELL', 'stak status', '', 'STAK makes the portable parts visible.', ''],
  [
    'DELL',
    'stak push\nstak memory backup',
    '',
    'You choose what goes to STAK Cloud, and when.',
    'Your Stack and Memory move only when you tell STAK to move them.',
  ],
  [
    'DELL',
    'stak skill check review-pr',
    '',
    'Check a Skill locally. Review the update on the web.',
    '',
  ],
  [
    'MACBOOK',
    'stak login\nstak pull\nstak memory recover',
    '',
    'On MacBook, pull your Stack and recover your Memory.',
    '',
  ],
  [
    'MACBOOK',
    'stak memory restore',
    '',
    'Restore Memory into the agents that use it.',
    'Recover brings the backup to this machine. Restore puts it back into native agent Memory.',
  ],
  // Design source's step 7 command is the bare `stak run`, which the real
  // CLI doesn't accept (packages/cli/src/commands/run.ts: `run <agent>` is
  // required) - corrected the same way Task 1 corrected the identical
  // phrase in the "Move to another machine" section, rather than
  // reproducing a command that would fail if actually typed.
  [
    'MACBOOK',
    'stak run claude',
    '',
    'When you’re ready to work, STAK applies the approved setup on MacBook.',
    '',
  ],
];

const ORANGE = 'var(--orange)';
const GREEN = 'var(--green)';
const INK = 'var(--ink)';
const FAINT = 'var(--faint)';
const DIM = 'var(--dim)';
const DIM2 = '#5E5A53';
const CHIP = '#3A3934';
const LINE2 = 'var(--line-2)';

type Breakpoint = 'mobile' | 'tablet' | 'desktop';

function computeBreakpoint(): Breakpoint {
  if (typeof window === 'undefined') return 'desktop';
  const w = window.innerWidth;
  if (w < 640) return 'mobile';
  if (w < 1024) return 'tablet';
  return 'desktop';
}

export function ScrollStory() {
  const [step, setStep] = useState(0);
  const [reduced, setReduced] = useState(false);
  const [bp, setBp] = useState<Breakpoint>('desktop');
  const trackRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setReduced(prefersReducedMotion());
    setBp(computeBreakpoint());

    // Literal scroll-to-step mapping from the design source: a step index
    // (0-6) derived from the track's bounding rect relative to the viewport,
    // NOT an IntersectionObserver. Runs even under reduced motion - the
    // story stays scroll-scrubbed, only the per-step transitions become
    // instant (see `trCap`/`trX`/`trCard`/`trFill` below).
    const onScroll = () => {
      const el = trackRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const vh = window.innerHeight;
      const span = Math.max(1, r.height - Math.min(vh, 960));
      const p = Math.min(1, Math.max(0, (-r.top + vh * 0.15) / span));
      const s = Math.min(6, Math.floor(p * 7));
      setStep((prev) => (prev !== s ? s : prev));
    };
    const onResize = () => {
      setBp(computeBreakpoint());
      onScroll();
    };

    document.addEventListener('scroll', onScroll, {
      capture: true,
      passive: true,
    });
    window.addEventListener('resize', onResize);
    const raf = requestAnimationFrame(onScroll);

    return () => {
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
      cancelAnimationFrame(raf);
    };
  }, []);

  const mob = bp === 'mobile';
  const tab = bp === 'tablet';
  const s = step;

  const trCap = reduced
    ? 'none'
    : 'opacity .55s cubic-bezier(.16,1,.3,1),transform .7s cubic-bezier(.16,1,.3,1),filter .55s';
  const trX = reduced ? 'none' : 'left 1.1s cubic-bezier(.65,0,.35,1)';
  const trCard = reduced
    ? 'none'
    : 'transform .8s cubic-bezier(.2,.8,.2,1),border-color .4s';
  const trFill = reduced ? 'none' : 'width 1.1s cubic-bezier(.65,0,.35,1)';

  const fanned = [1, 3, 5, 6].includes(s);
  const zx = mob
    ? ['35%', '50%', '65%']
    : tab
      ? ['24%', '50%', '76%']
      : ['18%', '50%', '82%'];
  const cx = s < 3 ? zx[0] : s === 3 ? zx[1] : zx[2];
  const ang = mob ? 7 : tab ? 10 : 16;
  const tfF = mob
    ? [
        'rotate(-4deg) translateY(-4px)',
        'translateY(-12px)',
        'rotate(4deg) translateY(-4px)',
      ]
    : [
        `rotate(-${ang}deg) translateY(-6px)`,
        'translateY(-14px)',
        `rotate(${ang}deg) translateY(-6px)`,
      ];
  const tfS = ['translate(-8px,8px)', 'translate(0,0)', 'translate(8px,-8px)'];
  const mem =
    s < 4 ? 'on DELL' : s < 5 ? 'local STAK store' : 'Claude Code · Codex';

  const zones = [
    {
      n: 'DELL',
      s: s < 6 ? 'working copy' : 'last reported earlier',
      x: mob ? '14%' : '18%',
      c: s < 3 ? INK : DIM,
    },
    {
      n: 'Your STAK',
      s: s < 2 ? 'empty' : s < 6 ? 'backed up' : 'portable',
      x: '50%',
      c: s === 3 || s === 2 ? ORANGE : DIM,
    },
    {
      n: 'MacBook',
      s:
        s < 4
          ? 'not set up yet'
          : s < 6
            ? 'setup recovered'
            : 'Up to date · just now',
      x: mob ? '86%' : '82%',
      c: s >= 4 ? INK : DIM,
    },
  ];
  const pos = s < 3 ? 0 : s === 3 ? 1 : 2;
  const zonesWithDots = zones.map((z, i) => ({
    ...z,
    dot: i === pos ? ORANGE : i < pos ? DIM2 : 'transparent',
    dbd: i === pos ? ORANGE : i < pos ? DIM2 : CHIP,
  }));

  const cards = [
    {
      t: 'MEMORY',
      n: '27 files',
      role: 'What your agents have remembered.',
      bd: s === 5 ? ORANGE : LINE2,
      tf: fanned ? tfF[0] : tfS[0],
      z: 1,
      ro: fanned ? 1 : 0,
      rows: [
        { a: 'ledger-api', b: '6 files', c: FAINT },
        { a: 'Location', b: mem, c: s >= 5 ? GREEN : FAINT },
        { a: 'Mode', b: 'Standard', c: FAINT },
      ],
    },
    {
      t: 'STACK',
      n: 'main',
      role: 'The approved Skills you want in your environment.',
      bd: s === 6 ? ORANGE : LINE2,
      tf: fanned ? tfF[1] : tfS[1],
      z: 2,
      ro: fanned ? 1 : 0,
      rows: [
        { a: 'Included', b: '30 skills', c: GREEN },
        { a: 'Paused', b: '1 skill', c: DIM },
        {
          a: 'Applied',
          b: s === 6 ? 'on MacBook' : s >= 4 ? 'pulled' : 'on DELL',
          c: s === 6 ? GREEN : FAINT,
        },
      ],
    },
    {
      t: 'SKILLS',
      n: '31',
      role: 'Instructions your agents follow.',
      bd: s === 3 ? ORANGE : LINE2,
      tf: fanned ? tfF[2] : tfS[2],
      z: 3,
      ro: 1,
      rows: [
        {
          a: 'review-pr',
          b: s === 3 ? 'Update available' : 'Ready',
          c: s === 3 ? ORANGE : GREEN,
        },
        { a: 'test-first', b: 'Ready', c: GREEN },
        { a: 'debug-flaky', b: 'Paused', c: DIM },
      ],
    },
  ];

  const D = 'min(148px,16.5svh)';
  const mtf = (i: number) =>
    fanned
      ? `translateY(calc(${i} * ${D}))`
      : `translateY(calc(${D} - 6px + ${i * 6}px)) scale(${(0.94 + i * 0.03).toFixed(2)})`;

  const fill = (pos * 33.333).toFixed(3) + '%';
  const deckH = `calc(2 * ${D} + 140px)`;

  const trackH = mob ? '380vh' : '420vh';
  const stTop = mob ? '61px' : tab ? '69px' : '0';
  const stH = mob
    ? 'calc(100svh - 61px)'
    : tab
      ? 'calc(100vh - 69px)'
      : '100vh';

  return (
    <div
      ref={trackRef}
      className="stak-landing-story-track"
      style={{ height: trackH }}
    >
      <div
        className="stak-landing-story-stage"
        style={{ top: stTop, height: stH }}
      >
        <div className="stak-landing-story-captions">
          {STEPS.map((x, i) => {
            const active = i === s;
            const op = active ? 1 : 0;
            const tf =
              active || reduced
                ? 'none'
                : i < s
                  ? 'translateY(-18px)'
                  : 'translateY(18px)';
            const bl = active || reduced ? 'none' : 'blur(6px)';
            return (
              <div
                key={i}
                className="stak-landing-story-caption"
                style={{
                  opacity: op,
                  transform: tf,
                  filter: bl,
                  transition: trCap,
                }}
                aria-hidden={!active}
              >
                <span className="stak-landing-story-cap">{x[3]}</span>
                {x[4] ? (
                  <span className="stak-landing-story-sub">{x[4]}</span>
                ) : null}
                <div className="stak-landing-story-cmdlines">
                  {x[1].split('\n').map((cm, ci) => (
                    <span key={ci} className="stak-landing-story-cmd">
                      <span className="stak-landing-story-m">{x[0]} $ </span>
                      {cm}
                    </span>
                  ))}
                </div>
              </div>
            );
          })}
        </div>

        {/* Desktop/tablet: horizontal zone row + absolutely-positioned fan
            of cards sliding between the 3 zone x-coordinates. */}
        <div className="stak-landing-story-deck stak-landing-story-deck--desktop">
          <div className="stak-landing-story-zonerow">
            {zonesWithDots.map((z) => (
              <div
                key={z.n}
                className="stak-landing-story-zone"
                style={{ left: z.x, transform: 'translateX(-50%)' }}
              >
                <span
                  className="stak-landing-story-zone-n"
                  style={{ color: z.c }}
                >
                  {z.n}
                </span>
                <span className="stak-landing-story-zone-s">{z.s}</span>
              </div>
            ))}
          </div>
          <div
            className="stak-landing-story-cardsgroup"
            style={{ left: cx, transition: trX }}
          >
            {cards.map((k) => (
              <div
                key={k.t}
                className="stak-landing-story-card"
                style={{
                  borderColor: k.bd,
                  transform: k.tf,
                  zIndex: k.z,
                  transition: trCard,
                }}
              >
                <div className="stak-landing-story-card-head">
                  <span className="stak-landing-story-card-t">{k.t}</span>
                  <span className="stak-landing-story-card-n">{k.n}</span>
                </div>
                <span className="stak-landing-story-card-role">{k.role}</span>
                {k.rows.map((r) => (
                  <div
                    key={r.a}
                    className="stak-landing-story-card-row"
                    style={{ opacity: k.ro, transition: 'opacity .4s' }}
                  >
                    <span>{r.a}</span>
                    <span style={{ color: r.c }}>{r.b}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>

        {/* Mobile: vertical route strip (progress-fill line between the 3
            zone dots) + a vertically fanning card deck. */}
        <div className="stak-landing-story-deck stak-landing-story-deck--mobile">
          <div className="stak-landing-story-routestrip">
            <span className="stak-landing-story-routeline" />
            <span
              className="stak-landing-story-routefill"
              style={{ width: fill, transition: trFill }}
            />
            {zonesWithDots.map((z) => (
              <div key={z.n} className="stak-landing-story-routezone">
                <span
                  className="stak-landing-story-routedot"
                  style={{ background: z.dot, borderColor: z.dbd }}
                />
                <span
                  className="stak-landing-story-zone-n"
                  style={{ color: z.c }}
                >
                  {z.n}
                </span>
                <span className="stak-landing-story-zone-s">{z.s}</span>
              </div>
            ))}
          </div>
          <div
            className="stak-landing-story-mobiledeck"
            style={{ height: deckH }}
          >
            {cards.map((k, i) => (
              <div
                key={k.t}
                className="stak-landing-story-card stak-landing-story-card--mobile"
                style={{
                  borderColor: k.bd,
                  transform: mtf(i),
                  zIndex: k.z,
                  transition: trCard,
                }}
              >
                <div className="stak-landing-story-card-head">
                  <span className="stak-landing-story-card-t">{k.t}</span>
                  <span className="stak-landing-story-card-n">{k.n}</span>
                </div>
                <span className="stak-landing-story-card-role">{k.role}</span>
                {k.rows.map((r) => (
                  <div
                    key={r.a}
                    className="stak-landing-story-card-row"
                    style={{ opacity: k.ro, transition: 'opacity .4s' }}
                  >
                    <span>{r.a}</span>
                    <span style={{ color: r.c }}>{r.b}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
