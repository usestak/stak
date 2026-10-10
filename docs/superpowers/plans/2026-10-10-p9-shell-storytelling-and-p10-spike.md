# P9 Product-Shell + Landing Storytelling Closure, and P10 Read-Only Spike — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Continuation on `p9-quality-seo` (base `dc109dc`). Two independent goals in one plan: (A) P9 product-shell quality (persistent sidebar/CommandDock, landing nav/truth/storytelling/motion/footer) — real code; (B) a READ-ONLY P10 architecture spike document — no implementation. Task 8 (the spike) produces only a markdown file and must not touch any product code.

**Goal:** Make the signed-in shell behave as a true persistent viewport app (sidebar + CommandDock fixed, only content scrolls), fix the landing's product-truth regressions against the frozen `docs/0.1.0-contract.md`, give the landing real product-proof visuals and a stronger-but-still-honest motion narrative, replace the current closing banner with a real footer, and separately produce a read-only spike document investigating shareable Skills + named Stacks for a future P10 — without building any of it.

**Architecture:** Shell persistence is a CSS/layout change to the shared signed-in shell (`overview/shell.css` + `AppSidebar`/`CommandDock` consumers), not a per-route patch. Landing truth fixes and storytelling/motion work all land in `public-landing-shell.tsx`/`.css` (already built in the prior sub-pass). The P10 spike is pure investigation against the real schema/CLI, with zero code changes.

## Global Constraints

- Stay on `p9-quality-seo`. No merge, no push, no deploy, no launch/E2E phase. Do not implement any P10 feature.
- Real account (ed4557316@gmail.com / DELL) stays READ-ONLY.
- Claude Design (the Final Contract, already pulled from DesignSync project `c7802a6a-cc4f-4ee9-93ea-f4f071d8c832`) and STAK product truth (`docs/0.1.0-contract.md`) override any Skill recommendation or any inspiration taken from `usequality.app`/`skillbox.so`. Those two sites are references for storytelling/pacing/motion quality only — never clone their branding, layout, copy, or feature set.
- **Frozen, verified-from-contract facts that bind the truth-fix task** (`docs/0.1.0-contract.md`):
  - Protected Memory: `perProject` is **always `null`** — the Cloud never decrypts the bundle. "The final design illustrates Protected with per-project file counts; engineering truth wins... must not reconstruct or fake those values" (contract lines 79-86). The per-project table/counts are **Standard-only**.
  - New-machine sequence is exactly: `install CLI → stak login (approve) → stak memory recover (+passkey/recovery file if Protected) → stak memory restore → stak project map <unavailable projects>` (contract lines 90-100). `stak memory restore` moves the private store into **native agent Memory files** — it does not install or restore Skills. There is no root `stak restore`.
  - The approved phrasing for the no-daemon concept is "No daemon; catches up on next CLI run" (contract line 465) — but this describes **check-in** (best-effort state reporting during any CLI operation), which is a different thing from **reconciliation** (actually installing an approved Skill version, which only happens via `stak skill update`). The landing's current sentence conflates these. Fix the precision, don't just delete the concept.
  - `machine_id`, `name`, `platform`, `arch` ARE part of the real check-in payload (contract §3) — this is different from the CLI-auth-session context (prior sub-pass correctly found no platform/arch on `cli_auth_sessions`). For the landing's illustrative MACHINES preview (which represents Overview/Machines data, not a CLI-auth session), platform/name are legitimate illustrative fields.
  - No daemon, no continuous sync, no live remote connectivity — never imply otherwise in copy or motion.
- Visual language stays STAK's own (near-black/graphite, warm off-white, restrained orange, IBM Plex, fine borders) — reference sites are pacing/storytelling inspiration only, never a palette/asset source.
- Motion: reuse the `--stak-motion-fast/standard/reveal` vocabulary already established in the landing (prior sub-pass, commit `daf96a0`). `transform`/`opacity` only. `prefers-reduced-motion: reduce` must fully disable staged/scroll-dependent motion. Never simulate live sync/daemon/upload/remote-control activity.
- SEO: all landing text must remain server-rendered and crawlable regardless of JS/motion.
- No new illustrative data sourced from the real account. "Illustrative preview, not your account data" notice stays.
- Commands: `pnpm --filter @stack/web typecheck|lint|test|build`, `pnpm format:check` (repo root), `git diff --check`.

---

### Task 1: Reference research — storytelling/pacing/motion lessons from usequality.app and skillbox.so

**Files:** none (research only; findings go in the task report, consumed directly by Tasks 4/5's dispatch prompts).

- [ ] **Step 1:** Try the Chrome extension first (`ToolSearch: select:mcp__claude-in-chrome__tabs_context_mcp,...`) to actually browse `https://usequality.app/homepage` and `https://skillbox.so/` live. If not connected (expected, per this session's history), fall back to `WebFetch` for both URLs to get their rendered/structural content as text, and be explicit in the report about which method was used.
- [ ] **Step 2:** Document specifically: how each site pairs a claim with visual proof (screenshot/UI crop placement relative to copy), page pacing (section rhythm, how much scroll between beats), CTA repetition pattern, how technical density is kept readable, and any micro/macro motion pattern observable from static inspection (even without live interaction, structure often reveals intent — e.g., `data-aos`/animation class names, section structure suggesting staged reveal).
- [ ] **Step 3:** For Skillbox specifically, document how it presents a public/shared Skill or capability — the "capability + its own UI" pairing pattern the correction brief calls out.
- [ ] **Step 4:** Write a short findings summary (in the report, not a new file) organized as: claim→proof pairing patterns, pacing patterns, motion patterns, CTA patterns, what's directly inspirational vs. what's NOT appropriate for STAK (branding/colors/feature-semantics to explicitly avoid copying). This feeds Tasks 4 and 5 directly — be concrete enough that those tasks don't need to re-research.

---

### Task 2: Persistent sidebar + persistent CommandDock shell architecture

**Files:**

- Modify: `apps/web/app/overview/shell.css` (the shared `.stak-frame`/`.stak-side`/`.stak-main` scope already fixed for mobile in the prior correction pass — this task changes the desktop ≥1024px behavior)
- Modify: `apps/web/app/_components/command-dock.tsx` + its CSS (wherever currently defined — audit first)
- Modify: `apps/web/app/_components/app-sidebar.tsx` only if its own internal scroll/height assumptions need adjusting (prefer NOT touching component logic — this should be achievable via CSS/layout alone)
- Test: extend `apps/web/app/_components/app-sidebar.test.tsx` / add a scroll-container test if practical

**Interfaces:**

- Consumes: nothing new.
- Produces: at ≥1024px, `.stak-side` (sidebar) is viewport-height and does not scroll with page content; `.stak-main`'s content area scrolls independently; any `CommandDock` instance stays pinned to the bottom of the viewport (or bottom of the main content region) while that region's content scrolls beneath/behind it. Below 1024px, the existing accepted mobile overlay nav (from the earlier correction pass, commit `b535c35`) is unchanged.

- [ ] **Step 1:** Audit the current `.stak-frame`/`.stak-side`/`.stak-main` box model in `overview/shell.css` (read the whole file) and every current `CommandDock` usage (`grep -rn "CommandDock" apps/web/app`) to see how each route currently renders it (inline in page flow vs. already-fixed).
- [ ] **Step 2:** Implement the three-region viewport shell: a viewport-height (`100dvh`) outer frame → a non-scrolling sidebar region (full height, `position: sticky` or a flex/grid-based non-scrolling column — audit which is more robust for this codebase's existing box model rather than defaulting to `position: fixed`, which can fight with the mobile overlay logic already in place) → a main region that is itself `overflow-y: auto` and contains the scrollable page content, with the `CommandDock` (where present) pinned to the bottom of that same main region (`position: sticky; bottom: 0` within the scroll container, or a grid row that doesn't scroll — again, audit for robustness over defaulting to fixed positioning). Opaque STAK background on the dock (reuse existing `.stak` panel tokens), no glassmorphism, a thin top border, correct `z-index`/stacking so dock content never gets visually confused with page content beneath it.
- [ ] **Step 3:** Ensure the scroll container has adequate bottom padding so the last real content/actions on any page are never permanently obscured by a pinned dock.
- [ ] **Step 4:** Verify the skip link and `id="main-content"` landmark still resolve correctly with the new scroll-container structure (the skip link's target must be the actual scrolling region, not an ancestor that no longer scrolls).
- [ ] **Step 5:** Real-browser verification (dev-server + fresh-profile `agent-browser`, or Chrome extension if connected) on `/skills`, `/memory`, `/stacks`, `/settings` at desktop: sidebar stays visible while scrolling, only main content scrolls, CommandDock (where present) stays visible, no double vertical scrollbar, no body horizontal overflow, keyboard scrolling (Page Down/arrow keys with focus in the content area) still works. Mobile/tablet: confirm no regression to the existing overlay nav, no content trapped beneath a dock.
- [ ] **Step 6:** Verify, commit, self-review, report with screenshots proving the sidebar/dock stay fixed while content scrolls (e.g., two screenshots of the same route at different scroll positions showing identical sidebar/dock placement).

---

### Task 3: Landing nav centering, product-truth fixes, and machine-name swap

**Files:**

- Modify: `apps/web/app/_components/public-landing-shell.tsx` + `.css`
- Test: extend `apps/web/app/_components/public-landing-shell.test.tsx`

**Interfaces:** consumes nothing new; produces a corrected, truthful landing that Tasks 4/5 build storytelling/motion on top of.

- [ ] **Step 1: Nav centering.** Change the top nav from its current flex-row-after-logo layout to a true 3-region layout (CSS grid: `grid-template-columns: 1fr auto 1fr` or equivalent, with the nav-links block in the true center column) so the 4 nav links are geometrically centered in the header regardless of wordmark/CTA widths. Keep the existing mobile `<details>/<summary>` disclosure unchanged below 1024px.
- [ ] **Step 2: Protected Memory per-project counts (contract-verified regression).** The hero preview currently shows "Protected" next to "27 files across 9 projects" — per `docs/0.1.0-contract.md` lines 79-86, Protected Memory's `perProject` is always `null`, and faking per-project counts next to "Protected" is an explicitly-named contract violation. Fix by either: (a) keeping the illustrative preview as Protected and removing the per-project count line (replace with something honest the contract allows — account-wide metadata like last-backup time), or (b) making the illustrative preview's mode Standard instead, if showing a per-project count is considered important to the story (Standard's `perProject` is real/derivable). Choose and justify in the report.
- [ ] **Step 3: "Restore your Skills" mislabel.** Audit the entire "Move to a new machine" section against the real sequence (contract lines 90-100: `install → stak login → stak memory recover → stak memory restore → stak project map <unavailable projects>`). `stak memory restore` restores native agent Memory files, not Skills. Correct the step labels/commands for the whole section, not just this one line — if Skills need separate reinstallation on a new machine, determine the real mechanism (check `packages/cli/src/commands/scan.ts` and `skill-update`-related commands for what actually happens to Skills on a fresh machine) and represent it accurately, or omit a Skills-restoration step entirely if none exists yet.
- [ ] **Step 4: "Catches up" phrasing.** Replace "Each machine catches up when you use the STAK CLI there. No daemon. No surprise background changes." — this conflates check-in (best-effort state reporting, happens on any CLI operation) with reconciliation (actually installing an approved Skill version, only via `stak skill update`). Write truthful replacement copy that keeps the real "no daemon / no continuous sync" idea (contract line 465's approved phrasing: "catches up on next CLI run" IS approved language, but must describe the right thing — reporting, not automatic update installation).
- [ ] **Step 5: Search for other regressions.** Re-read the entire landing copy against the frozen status vocabulary and the contract's resolution table (`docs/0.1.0-contract.md` §12, lines ~459-471) — flag and fix anything else found, or explicitly report "none found."
- [ ] **Step 6: Machine names.** Replace "ATLAS" everywhere in the illustrative preview/sections with "DELL" as the primary illustrative machine; if a second machine is needed for the portability narrative (used by Task 5's motion work), use "MacBook". Keep "Illustrative preview, not your account data." Do not pull from the real account (DELL is used here only because it's a familiar, generic machine-name style — not because it's literally the real account's real machine, though it happens to share a name; this is fine since it's explicitly labeled illustrative and contains no real account data).
- [ ] **Step 7:** Verify, commit, self-review, report — quote the full before/after copy for every changed section.

---

### Task 4: Landing storytelling — product-proof visuals (claim → proof → consequence)

**Files:**

- Modify: `apps/web/app/_components/public-landing-shell.tsx` + `.css`
- Create: small presentational sub-components if a section's proof visual is complex enough to warrant its own file (e.g., a Skill-diff snippet component) — keep each focused.
- Test: extend `public-landing-shell.test.tsx`

**Interfaces:** consumes Task 1's reference-research findings and Task 3's corrected facts/machine names.

- [ ] **Step 1:** Re-read Task 1's report and Task 3's final corrected copy before starting.
- [ ] **Step 2:** For each major section (Skills, Memory, Machines, Stacks, Move to a new machine), add one concrete product-derived visual per the brief's candidates: Skills — a small before/after diff snippet or Approved-vs-incoming-version crop; Memory — a Standard-vs-Protected comparison treatment (honest per Task 3's fix) or a backup-history/status crop; Machines — a DELL last-check-in card showing desired-vs-reported state (no fake live connectivity); Stacks — a real composition UI crop (Included/Paused Skills, matching the real Stacks page's actual visual grammar — check `apps/web/app/stacks/stacks.css`/`page.tsx` for the real pattern to echo, don't invent a new one); Move to a new machine — the DELL → STAK → MacBook narrative using only the real corrected CLI steps from Task 3.
- [ ] **Step 3:** Use deterministic synthetic fixture data for every visual — never real account data. Prefer building these as small React/CSS components styled to look like real STAK product UI (reusing existing `.stak` patterns from the real Skills/Memory/Stacks pages) over static images; if a static image genuinely is the right call for something, use `next/image` with an optimized format and say why in the report.
- [ ] **Step 4:** Do not show functionality that doesn't exist yet (no sharing, no named Stacks beyond `main`, no public Skill Explore — those are explicitly P10, out of scope for this landing).
- [ ] **Step 5:** Responsive pass at the full required width set (1440/1280/1024/820/768/430/390/360) — these added visuals must not introduce overflow or an overwhelming mobile wall of UI; simplify/stack on narrow widths rather than cramming.
- [ ] **Step 6:** Verify, commit, self-review, report with screenshots of each new product-proof visual.

---

### Task 5: Stronger macro + micro motion (DELL → portable STAK → MacBook narrative)

**Files:**

- Modify: `apps/web/app/_components/public-landing-shell.tsx` + `.css`, `landing-scroll-reveal.tsx` (from the prior sub-pass, commit `daf96a0`)

**Interfaces:** consumes Task 4's product-proof visuals (the macro narrative animates between/across them).

- [ ] **Step 1:** Use `animation-vocabulary` and `find-animation-opportunities` against the Task-4 landing to identify where the DELL→portable→MacBook story can be told through scroll-driven or staged motion without becoming noisy. Report opportunities accepted/rejected.
- [ ] **Step 2:** Implement the macro narrative: hero preview begins framed as DELL's reported state → as the visitor scrolls through Skills/Memory/Stacks sections, elements visually suggest collecting into the portable STAK representation (reuse the existing one-shot, non-looping entrance pattern from the prior sub-pass — extend it, don't replace its safety properties) → a later section (Move to a new machine) shows the same setup represented on MacBook. This is explanatory motion about portability, never live sync/daemon/upload/remote-control simulation.
- [ ] **Step 3:** Implement product-proof micro-motion: Skill diff swap (old/new lines transition when the diff snippet is in view), update badge enters only when its diff appears, machine-card transition between DELL/MacBook framing in the portability section, continued Copy-feedback and other already-existing micro-interactions preserved. All source text stays semantically present regardless of motion state (never text-only-after-animation).
- [ ] **Step 4:** Re-verify `prefers-reduced-motion: reduce` fully disables the new staged/scroll-driven elements (content immediately visible, no dependency), reusing and extending the existing reduced-motion CSS block rather than duplicating a parallel system.
- [ ] **Step 5:** Invoke `improve-animations`/`review-animations` (use whichever actually exists in this environment — if `review-animations` isn't installed, use `improve-animations` again as the closest equivalent and say so) to audit timing/sequencing/gratuitousness/CLS risk against the now-larger motion surface.
- [ ] **Step 6:** Responsive + bundle-size re-check.
- [ ] **Step 7:** Verify, commit, self-review, report with screenshots/description of the macro narrative at 2-3 scroll positions.

---

### Task 6: Replace the closing banner with a real STAK footer

**Files:**

- Modify: `apps/web/app/_components/public-landing-shell.tsx` + `.css`

**Interfaces:** consumes Task 3's corrected final-banner copy decision (the "no daemon" idea may move into an earlier product-principles spot per the brief) and real route truth for link destinations.

- [ ] **Step 1:** Audit which of the proposed footer groups have real destinations today: STAK (thesis line — always real, it's just text), PRODUCT (How it works / Memory & privacy / Stacks / CLI — same-page anchors, already real from the nav), ACCOUNT (Sign in / Install the CLI — already real), PROJECT (GitHub — only if a real public repo URL exists; check if one is referenced anywhere in the repo/package.json/README), LEGAL (Privacy/Terms — check if real routes/pages exist; if not, do NOT invent URLs).
- [ ] **Step 2:** Build the footer using only confirmed-real destinations, omitting any group with no real destination rather than inventing one. Report any missing group (e.g., no public GitHub URL, no Privacy/Terms page) as a launch requirement, not something to fake.
- [ ] **Step 3:** If keeping the "no daemon / no surprise background changes" idea is useful, move it into an earlier product-principles moment (e.g., near the "How it works" section) with Task 3's corrected, precise phrasing — the footer itself should read as a real site footer, not end on that banner.
- [ ] **Step 4:** Verify, commit, self-review, report.

---

### Task 7: Final P9 validation, browser verification, and completion report

**Files:** none created beyond the report itself.

- [ ] **Step 1:** Run the full validation suite: typecheck, lint, test, `format:check` (pass-owned files), `git diff --check`, production build. Report bundle/route-size delta.
- [ ] **Step 2:** Browser-test (real rendering): persistent sidebar + CommandDock on `/skills`/`/memory`/`/stacks`/`/settings` at desktop; landing at desktop/tablet/mobile; the motion/reduced-motion states; the footer; confirm no body overflow anywhere.
- [ ] **Step 3:** Re-confirm no regression to anything accepted in earlier sub-passes (mobile shell fix, accessibility, SEO infrastructure, CLI approval screen).
- [ ] **Step 4:** Produce the final screenshot set for the user (this is the controller's own job per established project convention — not delegated).
- [ ] **Step 5:** Confirm no real-account mutation occurred.
- [ ] **Step 6:** Write the P9 completion report covering the correction brief's §23 items 1-17.

---

### Task 8: P10 read-only architecture spike — shareable Skills + named Stacks

**Files:**

- Create: `docs/architecture/shareable-skills-named-stacks-spike.md`

**Interfaces:** none — pure investigation, zero code changes, zero migrations.

- [ ] **Step 1:** Investigate the current schema's assumption about `main`: read `packages/spec/src/*.ts` (environment/stack-related schemas), `packages/cloud-server/src/repository.ts`'s environment/version tables, and any CLI code referencing `stak use <stack>` (`packages/cli/src/commands/*.ts`) to determine whether the current model structurally assumes exactly one owned environment (`main`) per account or could represent multiple named ones without a migration.
- [ ] **Step 2:** Investigate whether any Cloud/public Skill object currently exists independent of a Stack/environment (check `packages/cloud-server/src/product-service.ts` and public-Stack-related code for any standalone Skill publication concept), and whether the existing Git/source-reference identity model (from the P5a skill-review-artifact work) could be reused for sharing a single Skill without full Stack publication.
- [ ] **Step 3:** Answer every question in the correction brief's §17 (named-Stack questions and individual-Skill-sharing questions) with a real, source-cited answer — not a guess. Where the honest answer is "unknown without further investigation," say so explicitly rather than inventing a plausible-sounding answer.
- [ ] **Step 4:** Design (on paper, in the doc — no code) the four user flows from §18 (create named Stack, edit, share Stack, share Skill), clearly marking which steps the current architecture supports today vs. which require new work.
- [ ] **Step 5:** Address every item in §19 (privacy/security for sharing) with specific findings against the real codebase — local-Skill leakage risk, credential leakage, absolute-path leakage, private-repo behavior, snapshot boundaries, malicious-Skill review surface, unpublish/deletion semantics, ownership, identifier stability.
- [ ] **Step 6:** If named Stacks or Skill sharing would require schema work, STOP short of designing a migration — instead write the exact minimal schema proposal (table/column shape, not a runnable migration file) and flag it as requiring separate explicit approval. Do not create any migration file.
- [ ] **Step 7:** Write the full spike document covering §18's item numbers 18-27 from the correction brief's final report structure (architecture findings, Skill-sharing feasibility, named-Stack feasibility, main/named-Stack relationship, public/reference-only implications, CLI implications, migration/schema requirement if any, privacy/security model, recommended P10 scope, open product decisions).
- [ ] **Step 8:** Commit the document only (no other files). Report.
