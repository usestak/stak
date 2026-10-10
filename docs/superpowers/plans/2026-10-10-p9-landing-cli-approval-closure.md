# P9 Landing + CLI Approval Experience Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. This is a continuation on `p9-quality-seo` (base `33891ac`), not a new phase. It rebuilds the public landing onto the authoritative Final Contract design (S.01) — pulled directly from the `STAK Control Center design` DesignSync project (`c7802a6a-cc4f-4ee9-93ea-f4f071d8c832`) — and visually closes out the CLI "Approve this machine?" experience (S.02) using only real backend fields. Both areas require real rendered screenshots before being considered done — the project owner will not accept this pass without seeing them.

**Goal:** Replace the centered-FocusedShell-card landing with the approved full public-page composition (top nav, split hero, illustrative product preview, feature strip, additional truthful sections), add a restrained, meaningful motion system, and build/visually verify all 4 states of the CLI device-approval screen using synthetic fixtures — all while preserving every already-accepted P9 fix (responsive shell, a11y, SEO infrastructure, PublicShell, terminology).

**Architecture:** A new `PublicLandingShell` (distinct from `PublicShell`, `FocusedShell`, `AppSidebar`) owns the full-width landing composition. The CLI approval screen gets a new split layout matching S.02, fed by a new minimal read-only backend query (`getPendingCliAuthSession`) that surfaces only the real `label`/`status`/expiry fields already on `CliAuthSessionRecord` — no fabricated OS/arch. Motion is implemented as small client islands (CSS transforms/opacity + IntersectionObserver, no new dependency unless justified) layered onto server-rendered content, never gating what a crawler or `prefers-reduced-motion` user sees.

## Global Constraints

- Stay on `p9-quality-seo`. No merge, no push, no deploy, no launch/E2E phase.
- Real account (ed4557316@gmail.com / DELL) stays READ-ONLY. No real CLI authorization request may be created against the real account merely for testing — use synthetic/test fixtures only, never a production debug query param or auth bypass that could ship as a real bypass.
- Preserve every already-accepted P9/correction-pass fix: signed-in responsive shell fix, mobile nav, accessibility fixes (skip link, h1s, contrast, underline), `PublicShell` migration for `/[owner]`/`/[owner]/[slug]`, public Stack metadata, SEO infrastructure (`siteOrigin()`, robots, sitemap, canonical/OG/index-matrix), error/not-found, terminology, removed loading cards, robots cleanup.
- Visual language stays STAK's own: near-black/graphite (`#121211`/`#0E0E0D` base per the Final Contract), warm off-white (`#EDEAE3`), restrained orange (`#EE7A3B`), IBM Plex Sans/Mono, fine `#2A2926`-family borders, dense product-UI-as-visual-asset. Skillbox-style density/pacing/motion quality is inspiration only — never its colors, assets, or layout verbatim.
- Frozen status vocabulary (do not touch): Ready / Update available / Paused / Can't check for updates from this source / Backed up / Not backed up yet / Up to date / Updates waiting / Last seen `<time>` / Active / Archived / On this machine / Not on this machine / Needs attention. Never: In sync, Online, Offline, Outdated, Lost, Broken, Unsafe.
- Install command truth: `npm install -g @usestak/cli` then `stak login` — confirmed against `packages/cli/package.json`'s real `name: "@usestak/cli"` and `publishConfig`. Package is not yet published (external launch blocker) — show the intended install UI anyway, note the blocker in the completion report, never silently omit it or invent a different installer.
- CLI-approval truth: `CliAuthSessionRecord` = `{ sessionId, userCode, deviceSecretHash, status, userId?, machineId?, label?, createdAt, expiresAt }` — confirmed via `packages/cloud-server/src/repository.ts`. No platform/arch field exists on the session. `label` is optional, user-supplied via `stak login --label <x>`, never auto-detected. No deny/reject server action exists (`approveCliAuth` in `packages/cloud-server/src/service.ts:378` is the only mutation) — "This wasn't me" must be a client-side cancel with honest copy, never a fabricated server-side denial. Error semantics, confirmed from `approveCliAuth`: unknown code → `not-found` "Unknown authorization code."; expired (checked server-side, auto-transitions session to `expired`) → "This authorization code has expired."; already consumed/non-pending → "This authorization request is no longer pending."
- SEO: all landing text must exist in server-rendered semantic HTML. Motion enhances already-present content; it must never gate indexing, delay content painting, or require JS to read the copy. Preserve existing metadata/canonical/OG/robots/h1-h2 hierarchy from the prior landing work (commit `c9f7c05`) — the content moves to a new shell, the metadata export does not change in substance.
- Motion: prefer CSS transforms/opacity + native Web Animations API/IntersectionObserver. Do not add a new animation dependency without first checking what's already installed and justifying why CSS/WAAPI is insufficient. No animation may cause CLS. All non-essential motion must respect `prefers-reduced-motion: reduce` — content/information must never depend on an animation completing.
- Commands: `pnpm --filter @stack/web typecheck|lint|test|build`, `pnpm format:check` (repo root), `git diff --check`.

---

## Design Source Reference (pulled directly, not re-derived by implementers)

The authoritative markup/data for both screens has already been extracted from the Final Contract (`STAK Final Contract.dc.html` in DesignSync project `c7802a6a-cc4f-4ee9-93ea-f4f071d8c832`) and will be pasted verbatim into each task's dispatch prompt by the controller — implementers do not need DesignSync access themselves. Key structural facts already confirmed:

- **S.01 Landing**: 64px top nav (wordmark + How it works / Memory & privacy / Stacks / CLI docs + Sign in + Install the CLI button) · split hero (540px left column: orange eyebrow "FOR DEVELOPERS WHO WORK WITH AI AGENTS", h1 "Your STAK should survive your laptop." at 58px, supporting prose, 2-line install/login command block with per-line Copy, a one-line note about step 2 opening the browser / right column: illustrative Overview-style product preview card with a status dot + "Your STAK is backed up." sentence, 3 summary rows (SKILLS/MEMORY/MACHINES) matching the real Overview fact-row grammar, a bottom command-dock-style action bar) · below-hero 5-column feature strip (Skills you can inspect / Memory you can recover / Projects that move with you / Machines, honestly / Stacks you can reuse) · closing one-line reassurance bar ("Each machine catches up when you use the STAK CLI there. No daemon. No surprise background changes.").
- **S.02 Sign-in (CLI approval)**: 440px left pane (dark `#0B0B0A`, terminal-style: wordmark, "IN YOUR TERMINAL" eyebrow, `$ stak login`, "Approve this machine in your browser." + the real code + "Waiting…" with a blinking cursor glyph) · right pane (centered 500px column: "Approve this machine?" h1-weight heading, one line of context copy naming the account being connected to, a 3-row fact card — in the mock: Machine / System / Code, in reality must be reduced to only truthful fields, likely just the session's optional `label` (if present) and the code — primary "Approve" button + secondary "This wasn't me" (client-side cancel, not a server deny) + one line of restrained safety copy below.

---

### Task 1: CLI-auth read model — expose the real pending-session fields truthfully

**Files:**

- Modify: `packages/cloud-server/src/service.ts` (add a new read method near `approveCliAuth`, e.g. `getPendingCliAuthSession`)
- Modify: `packages/cloud-server/src/repository.ts` only if a new repository method is genuinely needed (likely not — `findAuthSessionByUserCode` already exists and returns `label`/`status`/`expiresAt`)
- Modify: `apps/web/app/cli/page.tsx`, `apps/web/app/cli/actions.ts` (or a new `apps/web/app/cli/queries.ts`) to call the new read method and pass `label`/expiry info into the page
- Test: `packages/cloud-server/src/service.test.ts` (or sibling), new test file for the web query if one doesn't exist

**Interfaces:**

- Consumes: `CliAuthSessionRecord` as already defined.
- Produces: a read-only function returning `{ status: CliAuthSessionStatus; label?: string; expiresAt: string } | null` for a given `userCode`, WITHOUT mutating session state (unlike `approveCliAuth`, which this is not — this is a peek, used to render the approval card before the user clicks Approve, and also to detect/render the "expired" and "already consumed" states without a failed mutation attempt). Task 4 (CLI approval screen) consumes this directly.

- [ ] **Step 1: Read `packages/cloud-server/src/service.ts` around `approveCliAuth` (line ~378) and `startCliAuth` (line ~292) fully, and `packages/cloud-server/src/repository.ts`'s `findAuthSessionByUserCode` signature, to confirm the exact shape to return.**
- [ ] **Step 2: Add `getPendingCliAuthSession(userCode: string)` to the cloud service** (no auth required — this is a public, code-gated peek, same trust model as the approval page itself, which already requires knowing the exact code shown in a user's own terminal). Returns `null` if no session exists for that code. If expired (`expiresAt` in the past) and still `pending`, transition it to `expired` the same way `approveCliAuth` does (reuse that exact check, do not duplicate divergent logic — consider extracting a shared helper) and return `{ status: 'expired', ... }`. Otherwise return the real `status`/`label`/`expiresAt`.
- [ ] **Step 3: Wire this into `apps/web/app/cli/page.tsx`** so it can render different content for pending (with/without `label`) / expired / already-consumed states BEFORE the user even clicks Approve — this is what makes states B (expired) and the "already consumed" edge case renderable without needing to fake the approval button's error response.
- [ ] **Step 4: Write tests covering**: valid pending session with a label, valid pending session without a label, expired session (including the lazy-expire-on-read transition), already-approved/consumed session, unknown code.
- [ ] **Step 5: Verify (typecheck/lint/test/build across `packages/cloud-server` and `apps/web`), commit, self-review, report.**

**Global constraints specific to this task:** No platform/arch field may be read, returned, or rendered — it does not exist on the session. No new database migration — this reads existing columns only. No deny/reject mutation is added here.

---

### Task 2: Public landing shell + S.01 recomposition (structure + copy, no motion yet)

**Files:**

- Create: `apps/web/app/_components/public-landing-shell.tsx` + `apps/web/app/_components/public-landing-shell.css` (or co-located styles following the project's existing convention — check how `public-shell.tsx`/`.css` and `overview/shell.css` are structured first)
- Modify: `apps/web/app/page.tsx` (replace the `FocusedShell`-based landing from commit `c9f7c05` with the new shell)
- Keep/reuse: the `siteOrigin()`-based metadata export from `apps/web/app/page.tsx` — do not rewrite it, only move where it's attached if the file structure changes
- Test: `apps/web/app/page.test.tsx` or extend `apps/web/app/branding.test.ts` as needed

**Interfaces:**

- Consumes: nothing new from other tasks (motion is layered on top in Task 3; this task is pure structure/copy/responsive).
- Produces: a full-width landing shell distinct from `AppSidebar`/`FocusedShell`/`PublicShell`'s retired-`SiteHeader` lineage, that Task 3 (motion) attaches client islands to without restructuring.

- [ ] **Step 1: Skills first.** Before writing markup, invoke `design-taste-frontend`, `web-design-guidelines`, and `vercel-composition-patterns` to inform composition/hierarchy/component structure decisions. Report in your final report which specific guidance from each you applied (not just that you ran them).
- [ ] **Step 2: Read** `apps/web/app/_components/public-shell.tsx`/`.css` (for the existing `.stak` token scope and conventions — do not duplicate tokens, reuse `overview/shell.css`'s `--bg`/`--ink`/`--orange`/etc.), and the current `apps/web/app/page.tsx` (post-`c9f7c05`, the `FocusedShell` version) to see exactly what copy/metadata must carry forward.
- [ ] **Step 3: Build `PublicLandingShell`** rendering the top nav (STAK wordmark, "How it works" / "Memory & privacy" / "Stacks" / "CLI" as real anchors to same-page sections where no standalone route exists — do NOT link to a nonexistent docs route; confirm which of these have real destinations by checking existing routes first, e.g. "Stacks" could link to the concept section on this same page unless a real public stacks-browsing route exists), a mobile-accessible compact nav (no horizontal overflow, all CTAs reachable), "Sign in" (→ `/auth/login?next=/onboarding`, matching the existing pattern), and "Install the CLI" as a real CTA (scrolls to / reveals the install command section — wire this now, motion/Copy-button interaction polish comes in Task 3).
- [ ] **Step 4: Build the split hero** using the real S.01 markup as structural reference (quoted in full in this task's dispatch prompt) — orange eyebrow, h1 "Your STAK should survive your laptop.", supporting prose establishing "STAK is the control plane for portable AI agent environments" somewhere prominent (the brief is explicit these are two statements with a clear hierarchy, not fighting for the same headline), the real install sequence (`npm install -g @usestak/cli` / `stak login`) with per-line Copy buttons (functional copy-to-clipboard, not decorative — can be a tiny client island), and the illustrative product-preview card on the right using the exact illustrative demo data already extracted (31 ready Skills with 2 updates, Backed up Memory / 27 files across 9 projects / Protected, 2 machines with 1 update waiting) — labelled/framed clearly as illustrative, never sourced from the viewer's real account and never implying live telemetry.
- [ ] **Step 5: Build the 5-column feature strip** (Skills / Memory / Projects / Machines / Stacks) using the real, technically-truthful copy from the Final Contract's feature-strip text (quoted in the dispatch prompt) — adapt wording only if it would otherwise overstate something not yet shipped, and name any such adaptation in the report.
- [ ] **Step 6: Add the additional truthful sections** beyond the single Final Contract frame, per the correction brief's own guidance: How it works (install → login → scan → backup → recover, using only real CLI command names), Memory & privacy (Standard vs Protected, in plain language, matching the frozen `lang` table's real definitions — quoted in the dispatch prompt), Move to a new machine (login → recover → restore → map). Do not add testimonials, pricing, customer logos, or fake social proof.
- [ ] **Step 7: Responsive pass** at 1440/1280/1024/820/768/430/390/360 — real rendering via the dev-server + fresh-profile `agent-browser` method proven to work in the prior correction pass (no auth needed for this page). No body horizontal overflow at any width. Desktop: full split hero with room for the preview. Tablet: intentional composition, not a compressed desktop. Mobile: hero stacks naturally, CTA visible early, command surface readable, feature/section text not overwhelming.
- [ ] **Step 8: Verify (typecheck/lint/test/build), commit, self-review, report** — including real screenshots at desktop/tablet/mobile saved to a location the controller can read and forward to the user.

**Global constraints specific to this task:** Do not add any client-side animation library yet — that's Task 3's job, explicitly sequenced after structure. The Copy-button interactivity needed in Step 3/4 is a minimal client island (`onClick` + `navigator.clipboard`), not "motion" in the Task 3 sense. Report route-size delta against the current landing (commit `c9f7c05`'s build output) and whether any new client component boundary was introduced.

---

### Task 3: Landing motion system (micro + macro animations, reduced motion)

**Files:**

- Modify: `PublicLandingShell` and its sub-components from Task 2, adding motion as additive client islands
- Create: a small shared motion utility/CSS file if a genuine shared vocabulary (fast feedback / standard transition / deliberate reveal) is warranted — check what Task 2 already established before adding new infrastructure

**Interfaces:**

- Consumes: Task 2's completed, structurally-stable landing.
- Produces: the same server-rendered content, now animated — no content exists only after JS runs.

- [ ] **Step 1: Skills first, in sequence.** Before writing any animation code, invoke `animation-vocabulary` and `find-animation-opportunities` against the Task-2 landing to identify which motion communicates meaning (what explains portability) versus which would be merely decorative — report the specific opportunities accepted and rejected, with reasons, before implementing.
- [ ] **Step 2: Implement the one conceptually-truthful macro narrative** the correction brief calls for: hero enters with current-machine state → Skills/Memory/setup facts resolve into the STAK preview → a subtle, restrained transition suggests portability/cloud-backing (NOT a fake upload/sync animation) → as the page is scrolled, the feature strip and additional sections reveal in sequence. Do not animate fake uploads, fake live sync, fake daemon activity, or fake real-time machine presence — STAK is not a live remote-control system.
- [ ] **Step 3: Implement micro-interactions**: nav-link hover/focus feedback, button hover/press/focus states, Copy-command confirmation (e.g., label flips to "Copied" briefly), subtle border/accent response on interactive elements, any disclosure-control transitions actually used. Keep a small, consistent motion vocabulary (e.g., 120ms fast feedback, 200-240ms standard transition, 320-400ms deliberate reveal) — do not let each component invent its own arbitrary timing. Use `transform`/`opacity` only; verify no layout-thrashing property (`width`/`top`/`left`/`margin` animated directly) is used.
- [ ] **Step 4: Implement `prefers-reduced-motion: reduce` handling** — when set: no staged-entrance dependency (content is immediately visible), no scroll-choreography dependency, no looping decorative movement, interaction feedback (button press, copy confirmation) remains but becomes near-instant rather than eased/staged. Add at least one test or manual-verification note confirming content renders correctly with reduced motion simulated.
- [ ] **Step 5: Invoke `improve-animations` and `vercel-react-best-practices`** to audit the implementation — timing/easing/sequencing consistency, whether anything feels gratuitous, Core Web Vitals risk (CLS from animated properties, unnecessary client JS weight), mobile behavior. Report findings and what was changed in response.
- [ ] **Step 6: Re-run the responsive pass from Task 2** to confirm motion doesn't introduce overflow/CLS at any width. Re-screenshot.
- [ ] **Step 7: Verify (typecheck/lint/test/build, bundle-size delta vs. Task 2's number), commit, self-review, report.**

**Global constraints specific to this task:** No SEO-critical text may be animated-in via a mechanism that delays or hides it from initial server-rendered HTML (e.g., no `opacity: 0` with no-JS fallback that never reveals content, no IntersectionObserver gating that could leave content permanently hidden if JS fails). Progressive enhancement only: assume the animation adds to already-visible content, never gates it.

---

### Task 4: CLI approval screen rebuild (S.02 recomposition, real fields only, 4 synthetic states)

**Files:**

- Modify: `apps/web/app/cli/page.tsx`, `apps/web/app/cli/authorize-button.tsx`
- Create: `apps/web/app/_components/cli-approval-shell.tsx` + CSS (the split terminal-pane/approval-pane composition) — or extend `FocusedShell` only if it can do so additively without affecting its other 5 consumers (same constraint pattern as the prior correction pass's landing task; if in doubt, build a dedicated small component instead of touching `FocusedShell`)
- Create: a test-harness-only way to render all 4 states without a real backend session — e.g., a Storybook-less approach via a dedicated test route gated to never exist in production, OR (preferred, simpler, and safer) component-level tests + a manual local-dev harness using `NODE_ENV=development`-only fixture data that cannot ship as a production auth bypass. Decide and justify the approach in the report — this is a real design decision, not mechanical.

**Interfaces:**

- Consumes: Task 1's `getPendingCliAuthSession` for the real pending/expired/consumed states.
- Produces: the 4 required visual states (A: valid pending, B: expired/invalid code, C: approval success, D: approval failure), each screenshot-verified.

- [ ] **Step 1: Read** `apps/web/app/cli/page.tsx`, `apps/web/app/cli/actions.ts`, `apps/web/app/cli/authorize-button.tsx`, Task 1's new read method, and `apps/web/app/_components/focused-shell.tsx` fully before building anything.
- [ ] **Step 2: Build the approval-screen composition** per S.02 (quoted in the dispatch prompt): left pane (dark, terminal-style context — wordmark, "IN YOUR TERMINAL", `$ stak login`, the real code, a real or realistic "Waiting…" indicator) and right pane (centered approval card — "Approve this machine?" heading, one line of context copy, a fact row showing ONLY `label` if the session has one (omit the row entirely if not — do not show an empty "Machine: —" row) and the code, primary "Approve" action wired to the existing `approveCli` server action, secondary "This wasn't me" as a plain client-side navigation away/cancel (confirm exact destination — likely back to `/` or a neutral message — with honest copy, not implying a server-side deny happened), and one line of restrained safety copy below.
- [ ] **Step 3: Render state A (valid pending)** using Task 1's read model against a real code format — verify with a locally-created test fixture (not a real account session).
- [ ] **Step 4: Render state B (expired/invalid code)** — reuse the real expired-copy string ("This authorization code has expired.") and the unknown-code case, both via Task 1's model, not fabricated text.
- [ ] **Step 5: Render state C (approval success)** — what the UI shows immediately after `approveCli` returns `{ ok: true }` (check `authorize-button.tsx`'s current handling; this may already exist and just need visual polish to match the new shell).
- [ ] **Step 6: Render state D (approval failure)** — what the UI shows when `approveCli` returns `{ ok: false, error }`, using the real error strings from Task 1/`approveCliAuth` (never a generic invented failure message).
- [ ] **Step 7: Responsive pass** at 390/360/768/1280 — real rendering. Desktop: split layout. Mobile: context stacks above approval, code easy to read, buttons easy to tap, no horizontal overflow.
- [ ] **Step 8: Restrained microinteractions** — primary button press feedback, a success-state transition, a waiting-state treatment if genuinely useful (not an endless fake terminal animation, and never implying authorization succeeded before the backend confirms it). Respect reduced motion.
- [ ] **Step 9: Verify (typecheck/lint/test/build), commit, self-review, report** — including real screenshots of all 4 states at desktop and the pending state at mobile, saved to a location the controller can read and forward to the user.

**Global constraints specific to this task:** NEVER create a real CLI authorization request against the real account for testing. NEVER add a production-reachable debug query parameter, header, or flag that could bypass real authorization — any test harness must be structurally incapable of shipping as a bypass (e.g., guarded by `process.env.NODE_ENV !== 'production'` at minimum, ideally not even present in the production bundle). No platform/arch/OS field anywhere. No server-side deny action invented.

---

### Task 5: Final validation, accessibility/reduced-motion regression, screenshots, and completion report

**Files:** none created beyond the report itself.

**Interfaces:** consumes everything above.

- [ ] **Step 1: Run the full validation suite**: `pnpm --filter @stack/web typecheck`, `lint`, `test`, `pnpm format:check` (pass-owned files), `git diff --check`, `pnpm --filter @stack/web build`. Report the landing route's bundle-size delta from the pre-pass baseline (commit `c9f7c05`'s build output, recorded in the original correction pass's ledger).
- [ ] **Step 2: Re-verify accessibility survived** — skip link, single `main-content` landmark (now on the new `PublicLandingShell` and the new CLI approval shell too — confirm no duplicate/missing landmark on either), heading hierarchy, focus treatment, reduced-motion behavior, semantic nav.
- [ ] **Step 3: Confirm no regression** to the already-accepted P9 work listed in Global Constraints (spot-check: signed-in shell still fine, PublicShell/`/[owner]` pages untouched, SEO metadata/robots/sitemap untouched in substance).
- [ ] **Step 4: Produce the final screenshot set** for the user: landing at desktop/tablet/mobile, CLI approval at valid-pending-desktop/valid-pending-mobile/expired/success. This is the controller's own job (not delegated) — the project owner explicitly wants to see these, not read a claim that they were produced.
- [ ] **Step 5: Confirm no real-account mutation** occurred across every task in this pass.
- [ ] **Step 6: Write the completion report** covering every item in the correction brief's §31 (architecture, Claude Design elements preserved, P9 copy preserved, install-command audit, install CTA behavior, hero preview behavior, feature sections, additional sections, micro/macro animations, reduced-motion, SEO preservation, performance/bundle impact, landing desktop/tablet/mobile results, approval data audit, approval pending/secondary-action/expired/success design and responsive/animation results, screenshots produced, files changed, tests/build, commit hashes, git status, no-mutation confirmation) plus the Skills-usage report from the second brief (Skills discovered, Skills actually used, how each influenced the result, opportunities accepted/rejected, any Skill advice rejected because it conflicted with STAK product truth). STOP — no merge, no push, no deploy, no launch/E2E phase.
