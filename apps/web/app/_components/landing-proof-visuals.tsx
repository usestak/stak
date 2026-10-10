/**
 * P9 Task 4 (landing storytelling): small, presentational product-proof
 * visuals for the public landing. Each one is a compact, styled-to-look-
 * real crop of an existing STAK surface - built from the ACTUAL visual
 * grammar of that surface (Skills table/detail, Memory page, Machines
 * page, Stacks page), not an invented layout - so the claim next to it is
 * backed by something that looks like the product, not prose or an
 * abstract illustration (Task S1 lesson: claim sits directly beside/below
 * a cropped, POPULATED UI example using believable sample data).
 *
 * Every row here is deterministic synthetic fixture data (never real
 * account data) and every card that could be mistaken for live telemetry
 * carries an explicit "Illustrative example" label, same convention as
 * the hero's PreviewCard. Status words are drawn only from the frozen
 * vocabulary (Ready / Update available / Paused / Backed up / Not backed
 * up yet / Up to date / Updates waiting / Last seen / Active / Archived /
 * On this machine / Not on this machine / Needs attention) - never
 * In sync / Online / Offline / Outdated / Lost / Broken / Unsafe.
 *
 * No functionality is implied beyond what exists today: no sharing, no
 * named Stacks beyond "main", no public Explore. All text here is plain
 * server-rendered markup - no client JS, nothing opacity-hidden - so it's
 * fully indexable, matching the SEO constraint on this page.
 */

/** Skills: "Approved vs incoming version" - echoes the real Skill detail
 *  page's row grammar (skills-table.tsx: name / source / status with a
 *  colored dot) plus its Changes section's before/after <pre> diff
 *  (skills/[skillId]/page.tsx). */
export function SkillDiffProof() {
  return (
    <div className="stak-landing-proof-card">
      <div className="stak-landing-proof-row">
        <span className="stak-landing-proof-name">code-review-checklist</span>
        <span className="stak-landing-proof-source">GitHub · acme/skills</span>
        <span className="stak-landing-proof-status" style={{ color: 'var(--orange)' }}>
          <span className="stak-dot" style={{ background: 'var(--orange)' }} />
          Update available
        </span>
      </div>
      <div className="stak-landing-proof-diff-head">SKILL.md</div>
      <div className="stak-landing-proof-diff">
        <pre className="before">
          {'- Flag missing tests\n- Flag unclear naming'}
        </pre>
        <pre className="after">
          {
            '+ Flag missing tests\n+ Flag unclear naming\n+ Flag missing error handling'
          }
        </pre>
      </div>
      <p className="stak-landing-proof-note">
        Illustrative example, not your account data.
      </p>
    </div>
  );
}

/** Memory: Standard-vs-Protected comparison - echoes the real Memory
 *  page's fact-cell grammar (.stak-sum: k/v/d) for the same PROJECTS
 *  fact under each mode. Protected's copy is the exact honest phrasing
 *  from the real Memory page/contract (Task S3's fix) - no per-project
 *  file count is ever shown next to Protected. */
export function MemoryModeProof() {
  return (
    <div className="stak-landing-proof-modes">
      <div className="stak-landing-proof-mode">
        <span className="k">STANDARD · PROJECTS</span>
        <span className="v">3 projects · 41 files</span>
        <span className="d">
          Per-project detail is available for Standard backups.
        </span>
      </div>
      <div className="stak-landing-proof-mode">
        <span className="k">PROTECTED · PROJECTS</span>
        <span className="v">9 projects known to STAK</span>
        <span className="d">
          Protected backups are encrypted before they leave this machine, so
          STAK can&apos;t compute per-project file counts from their
          contents.
        </span>
      </div>
      <p className="stak-landing-proof-note">
        Illustrative example, not your account data.
      </p>
    </div>
  );
}

/** Machines: DELL last-check-in card - echoes the real Machines page's
 *  card grammar (machine-cards.tsx: name/meta head, status dot+label,
 *  k/v facts grid), reworked as desired-vs-reported so it never implies
 *  a live connection - only what DELL said at its last check-in. */
export function MachineCheckInProof() {
  return (
    <div className="stak-landing-proof-card">
      <div className="stak-landing-proof-machine-head">
        <div>
          <span className="stak-landing-proof-machine-name">DELL</span>
          <span className="stak-landing-proof-machine-meta">
            Last seen 12 min ago
          </span>
        </div>
        <span className="stak-landing-proof-status" style={{ color: 'var(--amber)' }}>
          <span className="stak-dot" style={{ background: 'var(--amber)' }} />
          Needs attention
        </span>
      </div>
      <div className="stak-landing-proof-facts">
        <div className="stak-landing-proof-facts-head">
          <span />
          <span>DESIRED</span>
          <span>REPORTED AT LAST CHECK-IN</span>
        </div>
        <div className="stak-landing-proof-facts-row">
          <span className="k">SKILLS</span>
          <span>31 approved</span>
          <span>29 installed · 2 updates waiting</span>
        </div>
        <div className="stak-landing-proof-facts-row">
          <span className="k">MEMORY</span>
          <span>Protected backups</span>
          <span>Backed up 12 min ago</span>
        </div>
      </div>
      <p className="stak-landing-proof-note">
        Illustrative example, not your account data. STAK reports what a
        machine said at its last check-in - not whether it&apos;s online
        now.
      </p>
    </div>
  );
}

/** Stacks: a real composition crop - echoes stacks/_components/stack-card.tsx
 *  and stacks.css exactly (card head with name/version/skillCount, a
 *  SKILL/IN STACK composition header, and Included/Paused rows) rather
 *  than inventing a new pattern. Only the "main" Stack is shown - named
 *  Stacks beyond "main" are out of scope for this landing. */
export function StackCompositionProof() {
  const skills = [
    { name: 'code-review-checklist', paused: false },
    { name: 'write-tests', paused: false },
    { name: 'legacy-deploy-notes', paused: true },
  ];
  return (
    <div className="stak-landing-proof-card stak-landing-proof-stack">
      <div className="stak-landing-proof-stack-head">
        <div>
          <span className="stak-landing-proof-stack-name">
            Your main Stack
          </span>
          <span className="stak-landing-proof-machine-meta">
            v4 · updated 3 days ago
          </span>
        </div>
        <span className="stak-landing-proof-machine-meta">3 Skills</span>
      </div>
      <div className="stak-landing-proof-stack-comp-head">
        <span>SKILL</span>
        <span>IN STACK</span>
      </div>
      {skills.map((s) => (
        <div key={s.name} className="stak-landing-proof-stack-comp-row">
          <span className="stak-landing-proof-stack-skill">{s.name}</span>
          <span
            style={{ color: s.paused ? 'var(--faint)' : 'var(--ink)' }}
          >
            {s.paused ? 'Paused' : 'Included'}
          </span>
        </div>
      ))}
      <p className="stak-landing-proof-note">
        Illustrative example, not your account data.
      </p>
    </div>
  );
}

/** Move to a new machine: the DELL -> STAK -> MacBook narrative as a
 *  compact 3-node flow sitting above the real 7-step sequence - plain
 *  text/CSS nodes, no live-connectivity implication (DELL's caption uses
 *  "Last seen", STAK's uses "Backed up", both frozen-vocabulary words
 *  already used elsewhere on this page). Stacks vertically on narrow
 *  widths instead of compressing three columns. */
export function MachineMoveFlow() {
  return (
    <div className="stak-landing-proof-flow">
      <div className="stak-landing-proof-flow-node">
        <span className="n">DELL</span>
        <span className="s">Last seen 12 min ago</span>
      </div>
      <span className="stak-landing-proof-flow-arrow" aria-hidden="true">
        →
      </span>
      <div className="stak-landing-proof-flow-node">
        <span className="n">STAK</span>
        <span className="s">Backed up</span>
      </div>
      <span className="stak-landing-proof-flow-arrow" aria-hidden="true">
        →
      </span>
      <div className="stak-landing-proof-flow-node">
        <span className="n">MacBook</span>
        <span className="s">New machine</span>
      </div>
    </div>
  );
}
