# P9 Real-Browser Correction Pass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. This is a correction pass on the `p9-quality-seo` branch (base `5afafb9`), not a new phase — real browser dogfood by the project owner found that P9's signed-in shell has a systemic mobile/tablet breakpoint defect, and that the landing page's visual composition diverges from the approved design even though its copy is good.

**Goal:** Fix the systemic mobile/tablet signed-in shell breakpoint defect at its root (shared shell, not per-page), recompose the landing page to use the approved pre-P9 visual composition while preserving P9's copy and SEO infrastructure, remove P9-invented custom loading cards, and clean up the inert robots.ts entries — all verified with real rendered-width numbers, not static CSS reasoning.

**Architecture:** Root-cause the shared shell geometry first (one task), then re-verify every signed-in route against the fixed shell, then separately recompose the landing (content preserved, composition restored), then remove invented loading UI, then clean robots.ts, then a final validation + full browser acceptance matrix.

## Global Constraints

- Stay on `p9-quality-seo`. No merge, no push, no deploy, no launch/E2E phase.
- Real account (ed4557316@gmail.com / DELL) remains READ-ONLY. No backup/recover/restore/privacy-change/passkey/recovery-file/revoke/Project-mutation/Skill-approve-pause-resume/Stack-mutation/Cloud-Memory-delete/CLI-approval.
- Preserve all valid P9 SEO infrastructure: `siteOrigin()`, metadata framework, canonical/OG, robots/noindex policy (cleaned, not removed), sitemap, public Stack metadata, semantic headings.
- Preserve all valid P9 accessibility work: skip link, main landmark, h1 fixes, contrast fix, link-underline fix, sr-only table labels, semantic controls, focus treatment — re-verify after the shell fix, don't just assume it survived.
- Do NOT throw away the P9 landing copy ("STAK is the control plane for portable AI agent environments," "Your STAK should survive your laptop," "Your skills. Your memory. Your setup. Any agent. Any machine," Skills/Memory/cross-machine/Claude Code+Codex themes). The defect is visual composition, not content.
- Do NOT invent new loading skeletons/cards to replace the removed ones. Prefer plain Next.js route-transition behavior unless an approved treatment already exists.
- No global `overflow: hidden` as a fix for horizontal overflow — fix the actual box-model/geometry.
- For every viewport claimed tested, it must be actually rendered (real `window.innerWidth`/`document.documentElement.scrollWidth` numbers where feasible) — no static-CSS-reasoning-only claims for this correction pass's core defect.
- Commands: `pnpm --filter @stack/web typecheck|lint|test|build`, `pnpm format:check` (repo root), `git diff --check`.

---

### Task A: Root-cause the signed-in shell mobile/tablet breakpoint defect and fix it at the shared-shell level

**Files:**
- Investigate first (read, do not assume): `apps/web/app/_components/app-sidebar.tsx`, `apps/web/app/_components/app-sidebar.css` or wherever its styles live, `apps/web/app/overview/shell.css` (the shared `.stak` scope and signed-in frame geometry), any signed-in `layout.tsx` that wraps `AppSidebar` + page content, `apps/web/app/globals.css` (body/html root rules).
- Fix: whichever of the above actually contains the defect — do not guess, report the exact root cause first.

**Interfaces:**
- Consumes: nothing new.
- Produces: a signed-in shell that, below the desktop-sidebar breakpoint, gives the main canvas the full viewport width with no reserved 216px column, no horizontal body overflow, and a coherent transition through tablet widths (not a "half mobile, half desktop" state). Task B (per-route re-review) and Task C/D depend on this being genuinely fixed before they proceed.

- [ ] **Step 1: Reproduce and diagnose.** Render a signed-in route (whichever is reachable — try the Chrome extension first since the user just dogfooded with their own session, which may mean it's connected now; otherwise use the `agent-browser` CLI with a fresh `--user-data-dir` against the real Chrome binary, as used successfully in a prior task — but that path cannot reach signed-in content without a real session, so if the extension isn't connected, diagnose from code reading + the user's reported symptom instead of guessing a fix blind) at 360, 390, 430, 600, 768, 820, 1024, 1280px. At minimum, read the actual CSS rules governing: grid/flex parent geometry, `grid-template-columns`, fixed sidebar width, main width, `min-width`/`max-width`, `margin-left`/`padding-left`, any `width: calc(...)`, position fixed/absolute rules, the mobile drawer/overlay positioning added in the earlier P9 pass, breakpoint media query values, `CommandDock` width/positioning, body/html root overflow rules, and whether any desktop-only geometry rule is still active once the nav becomes an overlay (e.g., a `margin-left: 216px` or `padding-left` on the main content that never gets removed at the overlay breakpoint).

- [ ] **Step 2: Report the exact root cause** before writing any fix — which rule(s), which file(s), which breakpoint the rule's condition doesn't match the overlay breakpoint's condition (a classic version of this bug: the sidebar's own breakpoint for "become an overlay" and the main content's breakpoint for "stop reserving sidebar width" are set to different widths, so there's a range where the sidebar is already an overlay but the main content still thinks it needs to leave room for it — or vice versa).

- [ ] **Step 3: Fix the geometry** so the two breakpoints are driven by the same value (ideally one CSS custom property or one shared media query boundary, not two independent magic numbers), and so main content has no stale desktop reservation once the overlay nav is active.

- [ ] **Step 4: Verify with real rendered numbers** at every required width (360/390/430/600/768/820/1024/1280 + one short-height viewport) wherever reachable: confirm `document.documentElement.scrollWidth <= window.innerWidth`, no giant blank column, no squeezed content strip.

- [ ] **Step 5: Re-test the mobile nav itself** after the geometry fix (per brief §5): trigger visible, opens as overlay, opening it does not resize/squeeze main content, all primary routes + Settings reachable, Viewing-as visible where meaningful, selected route visible, Escape closes it, clicking a nav item closes it, focus returns to trigger, keyboard-only operation works, no background-interaction leak while the overlay is open.

- [ ] **Step 6: Run `apps/web` tests + typecheck + lint, then commit** with a message describing the actual root cause (not just "fix responsive bug").

---

### Task B: Per-route responsive re-review after the shared shell fix

**Files:** no fixed list — re-render `/overview`, `/skills`, `/memory`, `/projects`, `/machines`, `/stacks`, `/settings` at mobile/tablet widths against Task A's fixed shell; fix only what's actually broken in each (route-specific CSS files from the earlier P9 pass).

**Interfaces:** consumes Task A's fixed shell geometry.

- [ ] **Step 1:** Re-render each of the 7 routes (to the extent reachable — see Task A's note on signed-in reachability) at mobile/tablet widths and check the specific per-route concerns listed in the correction brief §6 (Overview: headline readable, facts stack without word-by-word wrapping; Skills: responsive rows preserve field meaning, search/filter usable, no name collisions; Memory: fact strip/history usable, no dock overlap; Projects: empty/populated both sensible; Machines: facts wrap cleanly, revoke reachable but not dominant; Stacks: composition readable, Included/Paused clear; Settings: sections readable, destructive action reachable, no fake Viewing-as selector).
- [ ] **Step 2:** Fix only genuine defects found — do not refactor anything that already works.
- [ ] **Step 3:** Run tests, typecheck, lint; commit.

---

### Task C: Landing page — design audit and recomposition (preserve P9 copy, restore approved composition)

**Files:**
- Investigate: `main@5afafb9` vs. `main` pre-P9 root page (`git show 13758a5:apps/web/app/page.tsx` and its then-current CSS), `docs/0.1.0-contract.md`, any locally available Final Contract/Claude Design landing source (if DesignSync access via `/design-login` is genuinely unavailable, do not invent a new design — use the pre-P9 implementation and the approved P4-P8 visual language as structural truth, and say exactly which source was used).
- Modify: `apps/web/app/page.tsx` (current P9 landing, commit `80a92a3`) — recompose, do not discard the copy.

**Interfaces:** consumes `siteOrigin()` (unchanged), the `.stak` token scope (unchanged).

- [ ] **Step 1:** Diff the pre-P9 landing (`13758a5:apps/web/app/page.tsx` + its CSS) against the current P9 landing to identify exactly what visual/structural elements the approved design had that P9's version dropped or replaced (e.g., `FocusedShell`-style centered card composition vs. P9's full-bleed public-page layout).
- [ ] **Step 2:** Report which source was used as structural truth (pre-P9 code, contract doc, or an available design artifact) and why.
- [ ] **Step 3:** Recompose `/` so the approved visual composition/structure is restored while retaining every piece of P9's explanatory copy — redistribute the copy into the approved section structure, do not delete it, and do not invent new unrelated marketing sections. Keep one real `<h1>`, logical heading structure, crawlable server-rendered text, the sign-in CTA, and all existing P9 SEO infrastructure (metadata, canonical, OG, robots index:true) untouched unless an actual bug is found in it.
- [ ] **Step 4:** Render the recomposed landing at 1440/1280/1024/768/390/360px — confirm no body horizontal overflow, headline strong, copy readable, sign-in action obvious, no wall-of-text on mobile, same current STAK visual language.
- [ ] **Step 5:** Run tests (including `branding.test.ts`, which asserts specific landing copy strings — update it if the recomposition changes exact markup location but not content), typecheck, lint, build; commit.

---

### Task D: Remove P9-invented custom loading cards; audit for other made-up loading UI

**Files:**
- Remove: `apps/web/app/overview/loading.tsx`, `apps/web/app/memory/(dashboard)/loading.tsx` (added in the original P9 Task 6, commit `11b8cd5`) — unless investigation finds an approved Final Contract loading treatment already exists for these routes, in which case use that instead of removing.
- Audit: every other `loading.tsx` added anywhere during the original P9 pass (should be none beyond these two, per the Task 6 ledger record, but confirm).

**Interfaces:** none new.

- [ ] **Step 1:** Confirm no approved Final Contract loading treatment exists for `/overview`/`/memory` (check `docs/0.1.0-contract.md` and any locally available design source — same sourcing rule as Task C).
- [ ] **Step 2:** Delete the two `loading.tsx` files. Do not replace them with another invented skeleton/card.
- [ ] **Step 3:** If removing them surfaces a concrete technical UX problem (e.g., a genuinely long blank-white flash with no feedback at all), report it plainly rather than inventing a new design to paper over it.
- [ ] **Step 4:** Confirm no other route gained made-up loading UI during P9 (grep for `loading.tsx` across `apps/web/app`).
- [ ] **Step 5:** Run tests, typecheck, lint, build; commit.

---

### Task E: Robots.ts cleanup

**Files:** `apps/web/app/robots.ts` (added in original P9 Task 7, commit `41f1a68`).

**Interfaces:** none new — `siteOrigin()` usage unchanged.

- [ ] **Step 1:** Remove the inert bracket-literal `allow` entries (`/[owner]`, `/[owner]/[slug]`) — these never match a real crawled URL and are not valid crawler policy.
- [ ] **Step 2:** Confirm the resulting policy is simple and crawler-valid: public content crawlable (implicitly, via default-allow — no need for a redundant explicit allow of real public paths unless the disallow list would otherwise catch them), private route trees disallowed as before.
- [ ] **Step 3:** Run tests, typecheck, lint, build; confirm `/robots.txt` output is sane; commit.

---

### Task F: Accessibility regression check after the shell fix

**Files:** none pre-determined — verification task.

**Interfaces:** consumes Task A/B/C's changes.

- [ ] **Step 1:** Re-verify (don't just assume) that the skip link, single `main-content` landmark, h1 fixes, contrast fix, link-underline fix, sr-only responsive table labels, semantic controls, and focus treatment from the original P9 pass all still work after the shell/landing changes — re-run the relevant component tests and, wherever the shell geometry changed enough to plausibly affect it, a targeted manual/browser check.
- [ ] **Step 2:** Fix any genuine regression found. Do not add new accessibility features beyond re-confirming what already existed.
- [ ] **Step 3:** Run tests, typecheck, lint; commit (only if a fix was needed).

---

### Task G: Final validation and browser acceptance matrix

**Files:** none created beyond the report itself.

**Interfaces:** consumes everything above.

- [ ] **Step 1:** Run the full validation suite: `pnpm --filter @stack/web typecheck`, `lint`, `test`, `pnpm format:check` (correction-pass files only), `git diff --check`, `pnpm --filter @stack/web build`.
- [ ] **Step 2:** Execute the real browser acceptance matrix from the correction brief §19 to the extent reachable in this environment: `/overview` at 360/390/430/600/768/820/1024/1280; `/skills` at 390/768/1024; `/memory` at 390/768; `/machines` at 390/768; `/settings` at 390/768/1024; spot-check Projects and Stacks; public landing at 360/390/768/1024/1280/1440. For every width claimed tested, actually render it — report plainly which routes/widths could not be reached (same reachability constraint noted throughout this plan) rather than inferring success.
- [ ] **Step 3:** Confirm no real-account mutation occurred across every task in this correction pass.
- [ ] **Step 4:** Write the completion report covering all 26 items from the correction brief's §20, and STOP — no merge, no push, no deploy, no launch/E2E phase.
