# P9 — Cross-product Quality + Responsive + Accessibility + SEO Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task's workstream maps to one dispatched subagent; the coordinating session reviews every workstream's diff before merge-readiness, and holds veto over any reinterpretation of frozen product semantics (status vocabulary, backup/generation terminology, Memory/Skill/Machine/Project lifecycle language — see Global Constraints).

**Goal:** Make the existing STAK product (P1–P8, accepted and merged) coherent, responsive, accessible (practical WCAG 2.2 AA), crawlable where public, and technically SEO-ready — without adding product features, migrations, or touching production/real-account state.

**Architecture:** This is an audit-and-harden phase, not a greenfield build. Each task below targets one of the 12 workstreams from the P9 brief, grounded in the reconstruction-gate audit findings (branch `main`, HEAD `13758a5`, clean). Work proceeds shell-first (shared primitives: `AppSidebar`, `FocusedShell`, new mobile nav, new public shell) before route-level fixes, so route tasks consume already-hardened shared components rather than duplicating fixes per route.

**Tech Stack:** Next.js 15.5 (App Router) + React 19, apps/web workspace in a pnpm/turbo monorepo. No new runtime dependencies unless a task explicitly calls for one (e.g., `app/robots.ts` / `app/sitemap.ts` are native Next.js conventions, not a dependency).

## Global Constraints

- Product name is **STAK**, not Stack, in all user-facing copy (internal identifiers may still say "stack" — do not rename those). See prior rebrand phases (R0–R7).
- Frozen status vocabulary (never rephrase, never invent new normal-state words): Skill — `Ready`, `Update available`, `Paused`, `Can't check for updates from this source`. Memory — `Backed up`, `Not backed up yet`. Machine — `Up to date`, `Updates waiting`, `Last seen <time>`. Project — `Active`, `Archived`, `On this machine`, `Not on this machine`. General — `Needs attention`. Banned as normal-state words: `In sync`, `Online`, `Offline`, `Outdated`, `Lost`, `Broken`, `Unsafe`. Audit confirmed zero current drift — do not introduce any.
- User-facing term is **backup**, never **generation**. Internal DB/schema field names (e.g., `h.generation` in `app/memory/(dashboard)/page.tsx:160`) stay unchanged — only user-visible copy is in scope.
- Visual language: near-black/graphite, warm off-white, restrained orange, IBM Plex Sans/Mono, thin borders, dense useful rows, explicit machine context, status sentence pattern. No purple AI aesthetic, no glassmorphism, no generic SaaS cards, no terminal cosplay, no shimmering skeletons unless genuinely useful.
- No new product capability. No speculative features (no ratings/stars/downloads/popularity/trust score on public Stacks).
- No database migration without an explicit STOP-and-report gate (see Task 12).
- Real account (`ed4557316@gmail.com` / DELL machine, 31 Skills, Protected Memory) is **read-only** for the whole phase. Any mutation-state testing (backup, recover, archive, revoke, pause/resume, delete Memory, approve CLI) uses synthetic fixtures, never the real account.
- Do not push, deploy, publish npm, tag a release, or merge to main outside normal commit flow on the feature branch.
- Canonical production origin is `usestak.app`, not yet configured — do not hard-code it as a live assumption; build an environment-driven helper instead (Task 8).
- Package manager note: this machine has had pnpm/turbo native-binary failures before (corepack's `install.js` fix) — if `pnpm` commands fail outright with a native-binary error, run that fix before concluding the task itself is broken.
- Commands (run from repo root unless noted): `pnpm typecheck` → `turbo run typecheck`; `pnpm lint` → `turbo run lint && prettier --check .`; `pnpm test` → `turbo run test`; `pnpm build` → `turbo run build`; `pnpm format:check` → `prettier --check .`. Web-specific equivalents live in `apps/web/package.json` (`next build`, `eslint app lib --max-warnings 0`, `vitest run --passWithNoTests`, `tsc -p tsconfig.json --noEmit`).

---

## Audit Findings Baseline (already completed — do not redo)

- `docs/0.1.0-contract.md` is a data/semantics contract, not a visual spec. It confirms the frozen vocabulary table and the P9 phase boundary, but has no shell/responsive/SEO detail.
- The Final Contract DesignSync source is hosted externally (`/design-login` required); `stak-truth.js` is confirmed deleted repo-wide. Use the accepted P4–P8 code (`AppSidebar`, `FocusedShell`, route CSS) as ground truth per the brief's own instruction (§0.5); only escalate to a DesignSync pull if a workstream hits a genuine ambiguity DesignSync would resolve.
- Route inventory, shell-per-route table, CSS files, and metadata/robots/sitemap gaps are documented in the branch's audit notes (summarized in Global Constraints and per-task Files sections below). Key gaps: zero per-route metadata (only one static `metadata` export in root `app/layout.tsx`), no `app/robots.ts`/`app/sitemap.ts`, no `not-found.tsx`/`error.tsx`/`loading.tsx` anywhere, public `[owner]`/`[owner]/[slug]` pages use an orphaned `SiteHeader` + generic `.page`/`.card` classes (not `AppSidebar`, not `FocusedShell`), no a11y/testing tooling installed (no axe/playwright/lighthouse/jsx-a11y), `apps/web/lib/env.ts` already has a `cloudEnv().appUrl` helper (`STAK_APP_URL` → legacy `STACK_APP_URL` → `http://localhost:3000` fallback) that can be extended for SEO use. `/dashboard` is confirmed fully deleted (only an internal `(dashboard)` route-group under `/memory` remains, which does not affect the URL).

---

### Task 1: Shared responsive shell — mobile/tablet navigation for signed-in surfaces

**Files:**
- Modify: `apps/web/app/_components/app-sidebar.tsx`
- Create: `apps/web/app/_components/app-sidebar-mobile.tsx` (or equivalent collapsed/overlay nav component — name finalized during implementation based on existing component conventions)
- Modify: `apps/web/app/_components/app-sidebar.css` (or wherever its styles live — confirm exact filename at implementation time; audit found CSS colocated per-route, sidebar styles may be in `overview/shell.css` or a dedicated file — check before editing)
- Test: `apps/web/app/_components/app-sidebar.test.tsx` (create if no existing test file for this component)

**Interfaces:**
- Consumes: existing `AppSidebar` props (machine/account/nav-item data shape — read the current component before changing its signature).
- Produces: a `AppSidebar` that renders a full 216px rail at desktop widths (≥1024px reference) and a collapsed/overlay pattern below that, reachable via a visible, keyboard-operable toggle control with an accessible name (e.g., `aria-label="Open navigation"`), exposing all primary routes (`/overview`, `/skills`, `/memory`, `/projects`, `/machines`, `/stacks`, `/settings`), the selected-route indicator (`aria-current="page"`), account identity, and Viewing-as machine context where present. Later tasks (2, 3) consume this hardened component as-is — do not change its external prop contract without updating every route layout that imports it.

- [ ] **Step 1: Read the current `AppSidebar` implementation and its CSS fully**

Read `apps/web/app/_components/app-sidebar.tsx` end to end, and locate its stylesheet (search for the class names it renders, e.g. `grep -rn "app-sidebar" apps/web/app --include=*.css`). Note current breakpoints (if any), the nav item list source, how "selected" is computed, and how account/machine context is rendered.

- [ ] **Step 2: Write a failing render test asserting mobile toggle exists and is keyboard-reachable**

```tsx
// apps/web/app/_components/app-sidebar.test.tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppSidebar } from "./app-sidebar";

const baseProps = {
  activeRoute: "/overview",
  account: { email: "dev@example.com" },
  machine: { name: "DELL", lastCheckIn: new Date().toISOString() },
};

test("exposes a keyboard-reachable navigation toggle below desktop width", async () => {
  render(<AppSidebar {...baseProps} />);
  const toggle = screen.getByRole("button", { name: /open navigation/i });
  expect(toggle).toBeInTheDocument();
  await userEvent.tab();
  expect(toggle).toHaveFocus();
});

test("marks the active route with aria-current", () => {
  render(<AppSidebar {...baseProps} />);
  const link = screen.getByRole("link", { name: /overview/i });
  expect(link).toHaveAttribute("aria-current", "page");
});
```

Note: if `@testing-library/react` and `@testing-library/user-event` are not yet devDependencies of `apps/web`, add them (`pnpm --filter @stack/web add -D @testing-library/react @testing-library/user-event jsdom @testing-library/jest-dom`) and confirm `vitest.config` picks up a jsdom environment — check `apps/web/vitest.config.ts` (or root config) first; this is the one new-dependency exception, since there is currently zero component-test tooling and task 6/11 need it too.

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @stack/web test -- app-sidebar` (adjust to the actual vitest invocation found in `apps/web/package.json`)
Expected: FAIL — no element with accessible name "Open navigation" exists yet.

- [ ] **Step 4: Implement the mobile/tablet nav toggle and overlay/collapse behavior**

Add a button rendered only in the sidebar's root markup (controlled via CSS breakpoints, not JS media-query duplication where avoidable) with `aria-expanded`, `aria-controls` pointing at the nav list's `id`, and `aria-label="Open navigation"` / `"Close navigation"` toggling with state. On activation, the nav becomes reachable (overlay or expand-in-place — choose overlay if the rail would otherwise cover primary content at ≤768px, per brief §7). Ensure: all primary routes present, selected state visible, Settings reachable, account identity visible, Viewing-as machine visible where meaningful, no permanent 216px rail below ~1024px, closes on route navigation and on Escape, traps focus while open (or at minimum returns focus to the toggle on close).

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @stack/web test -- app-sidebar`
Expected: PASS

- [ ] **Step 6: Manual viewport check**

Start `pnpm --filter @stack/web dev`, open `/overview` (or any signed-in route, using dev auth bypass if one exists — check `apps/web/lib/env.ts` / auth setup) at 1440, 1280, 1024, 768, 390, 360px widths. Confirm: no body horizontal scroll, toggle visible below desktop width, overlay/collapse closes predictably, keyboard tab order reaches every nav item and Settings.

- [ ] **Step 7: Commit**

```bash
git add apps/web/app/_components/app-sidebar.tsx apps/web/app/_components/app-sidebar.test.tsx apps/web/app/_components/*.css apps/web/package.json pnpm-lock.yaml
git commit -m "feat(p9): accessible mobile/tablet navigation for signed-in shell"
```

---

### Task 2: Signed-in route responsive fixes (tables, detail pages, Command Dock)

**Files:**
- Modify: `apps/web/app/skills/skills.css`, `apps/web/app/projects/projects.css`, `apps/web/app/machines/machines.css`, `apps/web/app/stacks/stacks.css`, `apps/web/app/memory/(dashboard)/memory.css`, `apps/web/app/settings/settings.css`, `apps/web/app/overview/shell.css`
- Modify: `apps/web/app/_components/command-dock.tsx` and its CSS
- Modify: `apps/web/app/_components/machine-chooser.tsx`, `apps/web/app/_components/machine-selector.tsx`
- Test: extend `apps/web/app/_components/command-dock.test.ts` (logic file already exists per audit — add/confirm a render-level test alongside it) or create `command-dock.test.tsx`

**Interfaces:**
- Consumes: Task 1's hardened `AppSidebar` (routes render inside layouts that already use it — no change needed to layout files unless they hard-code a sidebar width that now conflicts).
- Produces: dense list/table routes (Skills, Projects, Stacks composition, Backup history, Machines) that preserve meaning at ≤768px via stacked rows or priority columns (not uniform text shrinking); a Command Dock that never gains horizontal body overflow and keeps Copy reachable at 360px; a machine chooser/selector usable by keyboard with long names that don't break layout.

- [ ] **Step 1: Read every CSS file listed above and note current fixed widths, `overflow`, and any `white-space: nowrap` that would break at 360–390px**

Grep for literal pixel widths and `overflow: hidden` across the listed CSS files: `grep -rn "overflow: hidden\|white-space: nowrap\|width: [0-9]\{3,\}px" apps/web/app/{skills,projects,machines,stacks,memory,settings,overview}`.

- [ ] **Step 2: Write a failing test asserting Command Dock exposes a reachable Copy control and distinguishes ready-to-run vs template commands**

```tsx
// apps/web/app/_components/command-dock.test.tsx
import { render, screen } from "@testing-library/react";
import { CommandDock } from "./command-dock";

test("ready-to-run command exposes a Copy button with accessible name", () => {
  render(<CommandDock command="stak scan" status="ready" />);
  expect(screen.getByRole("button", { name: /copy/i })).toBeInTheDocument();
});

test("template command is visually and semantically distinguished from a ready command", () => {
  render(<CommandDock command="stak scan --machine <name>" status="template" />);
  expect(screen.getByText(/template/i)).toBeInTheDocument();
});
```

Adjust prop names to match the actual `CommandDock` signature found in Step 1 reading — do not invent a `status` prop if one doesn't exist; add it if the component currently has no way to express "template" vs "ready" (check brief §9's requirement first — this may be a genuine gap to fix, not just a test-writing exercise).

- [ ] **Step 3: Run to verify failure, then implement CSS/markup fixes for narrow widths and the ready/template distinction**

Run: `pnpm --filter @stack/web test -- command-dock` → expect FAIL if the distinction doesn't exist yet, or PASS-with-missing-styles if it does (in which case skip to CSS fixes directly). Apply responsive CSS (stacked layout below 768px for tables; `overflow-x: auto` with a labelled scroll region only where brief §10 allows it — prefer stacked rows first). Add a visible "template" indicator (e.g., a label/badge) if missing.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @stack/web test -- command-dock`
Expected: PASS

- [ ] **Step 5: Manual viewport check across all 8 signed-in routes**

At 1440/1280/1024/768/390/360px, open `/overview`, `/skills`, `/skills/[skillId]`, `/memory`, `/projects`, `/projects/[projectId]`, `/machines`, `/stacks`, `/settings`. Confirm no clipped primary actions, no unreachable bottom content, long machine/identifier names wrap rather than break layout, Technical details sections contain long hashes/paths rather than them leaking into primary layout.

- [ ] **Step 6: Commit**

```bash
git add apps/web/app/skills/skills.css apps/web/app/projects/projects.css apps/web/app/machines/machines.css apps/web/app/stacks/stacks.css "apps/web/app/memory/(dashboard)/memory.css" apps/web/app/settings/settings.css apps/web/app/overview/shell.css apps/web/app/_components/command-dock.tsx apps/web/app/_components/command-dock.test.tsx apps/web/app/_components/machine-chooser.tsx apps/web/app/_components/machine-selector.tsx
git commit -m "fix(p9): responsive table/detail/Command Dock behavior on signed-in routes"
```

---

### Task 3: Focused-flow shell responsiveness verification

**Files:**
- Modify (if gaps found): `apps/web/app/_components/focused-shell.tsx`, `apps/web/app/_components/focused-shell.css`
- No new files expected — this task is verification-first; only touch code if Step 2 finds a real defect.

**Interfaces:**
- Consumes: the P8-accepted `FocusedShell` (centered vertically+horizontally at desktop, natural scroll at small/short viewports — already implemented per commit `13758a5`).
- Produces: confirmation (or a fix) that `/`, `/auth/error`, `/cli`, `/onboarding`, `/memory/protect`, `/memory/recover` all render correctly through this shell at every test width, including a short-height desktop viewport.

- [ ] **Step 1: Read `focused-shell.tsx`/`.css` and the P8 commit that fixed centering (`13758a5`, `05fc618`) to understand the accepted behavior**

`git show 13758a5 -- apps/web/app/_components/focused-shell.css` to see exactly what was fixed, so this task doesn't regress it.

- [ ] **Step 2: Manually render each focused route at 1440/1280/1024/768/390/360px plus a short-height desktop viewport (e.g. 1440x700)**

For each of `/`, `/auth/error`, `/cli`, `/onboarding`, `/memory/protect`, `/memory/recover`: confirm centered with no scroll at normal desktop heights, natural vertical scroll (no clipping, no horizontal scroll) at short/narrow viewports, usable padding, card width constrained to viewport.

- [ ] **Step 3: If any route fails, write the specific CSS/markup fix and re-verify; if none fail, record "no defects found" and proceed**

- [ ] **Step 4: Commit (only if changes were made)**

```bash
git add apps/web/app/_components/focused-shell.tsx apps/web/app/_components/focused-shell.css
git commit -m "fix(p9): focused-shell responsiveness gaps found during verification pass"
```

---

### Task 4: Public Stack pages — visual migration off the orphaned SiteHeader system

**Files:**
- Modify: `apps/web/app/[owner]/page.tsx`, `apps/web/app/[owner]/[slug]/page.tsx`
- Create: `apps/web/app/_components/public-shell.tsx` + `apps/web/app/_components/public-shell.css` (a new shared public shell — not `AppSidebar`, not raw `FocusedShell`, per brief §4)
- Modify or retire: `apps/web/app/_components/site-header.tsx` (retire only once nothing imports it — confirm via grep before deleting, per brief §45)
- Test: `apps/web/app/_components/public-shell.test.tsx`

**Interfaces:**
- Consumes: real public fields already loaded by `[owner]/page.tsx` and `[owner]/[slug]/page.tsx` (owner, slug, Stack composition, Skill requirements — read current data-loading code before changing markup).
- Produces: a `PublicShell` component rendering STAK's current visual language (graphite/off-white/orange, IBM Plex, thin borders) for anonymous viewers, with semantic `<nav>`/`<main>`/`<footer>` landmarks, real `<Link>`/`<a>` navigation (no click-handler-only nav), and no sidebar. Task 8/9 (SEO) consume this shell's markup structure when adding metadata and JSON-LD — do not change its top-level landmark structure after this task without updating those.

- [ ] **Step 1: Read current `[owner]/page.tsx` and `[owner]/[slug]/page.tsx` fully, and `site-header.tsx`, to see what data and markup exist today**

- [ ] **Step 2: Write a failing test asserting the public Stack page renders one `<h1>`, a `<main>` landmark, and no sidebar/account-menu elements**

```tsx
// apps/web/app/_components/public-shell.test.tsx
import { render, screen } from "@testing-library/react";
import { PublicShell } from "./public-shell";

test("renders exactly one h1 and a main landmark", () => {
  render(
    <PublicShell title="demo-stack by alice">
      <p>content</p>
    </PublicShell>
  );
  expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  expect(screen.getByRole("main")).toBeInTheDocument();
});

test("does not render signed-in account affordances", () => {
  render(<PublicShell title="demo-stack by alice"><p>content</p></PublicShell>);
  expect(screen.queryByRole("button", { name: /sign out/i })).not.toBeInTheDocument();
});
```

- [ ] **Step 3: Run to verify failure (component doesn't exist yet)**

Run: `pnpm --filter @stack/web test -- public-shell`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `PublicShell` using the current STAK visual language (reuse tokens/variables from `globals.css` — do not reinvent colors) and wire it into both `[owner]/page.tsx` and `[owner]/[slug]/page.tsx`, replacing `SiteHeader` and the generic `.page`/`.card` classes**

Preserve: anonymous usability, owner/slug display, real reference metadata, real Skill requirements. Do not add: ratings, stars, downloads, popularity, trust score, install counts. Do not expose private snapshot data — re-check the data-loading code from Step 1 for any field that shouldn't be public.

- [ ] **Step 5: Run to verify pass**

Run: `pnpm --filter @stack/web test -- public-shell`
Expected: PASS

- [ ] **Step 6: Grep for remaining `SiteHeader` imports; if none remain outside its own file, delete `site-header.tsx` and its CSS**

Run: `grep -rln "site-header\|SiteHeader" apps/web/app --include=*.tsx`
Expected: only `site-header.tsx` itself. Delete the file and its CSS if confirmed unused.

- [ ] **Step 7: Manual viewport check at all 6 widths for both `/[owner]` and `/[owner]/[slug]`**

- [ ] **Step 8: Commit**

```bash
git add apps/web/app/_components/public-shell.tsx apps/web/app/_components/public-shell.css apps/web/app/_components/public-shell.test.tsx "apps/web/app/[owner]/page.tsx" "apps/web/app/[owner]/[slug]/page.tsx"
git commit -m "feat(p9): migrate public Stack pages onto current STAK visual language"
git add -u  # picks up site-header.tsx deletion if it occurred
git commit -m "chore(p9): retire orphaned SiteHeader after public-shell migration" --allow-empty
```

---

### Task 5: Accessibility sweep — landmarks, headings, forms, focus, keyboard, contrast

**Files:**
- Modify: `apps/web/app/globals.css` (focus-visible treatment, skip-link styles)
- Create: `apps/web/app/_components/skip-link.tsx` + usage in root `apps/web/app/layout.tsx` and in `PublicShell` (Task 4)
- Modify: any interactive component found to use a div-as-button pattern (identify during Step 1 — likely candidates: `machine-chooser.tsx`, `machine-selector.tsx`, `account-menu.tsx`, confirmation dialogs in Settings/Memory)
- Test: `apps/web/app/_components/skip-link.test.tsx`

**Interfaces:**
- Consumes: Task 1's sidebar (needs a `<main id="main-content">` target to skip to) and Task 4's `PublicShell` (needs the same landmark id).
- Produces: a shared skip-link pattern (`Skip to main content`) present once per shell (signed-in, focused, public), targeting a single consistent `id="main-content"` per page — no duplicate main landmarks.

- [ ] **Step 1: Run a manual keyboard-only pass over every interactive control listed in brief §15** (sidebar/mobile nav, machine chooser, search inputs, filters, Copy actions, Pause/Resume, Archive/Unarchive, Revoke confirmation, Delete Cloud Memory confirmation, Sign out, Technical details, auth actions) and record every control that is not keyboard-reachable or uses a non-semantic element (`<div onClick>` instead of `<button>`).

- [ ] **Step 2: Write a failing test for the skip link**

```tsx
// apps/web/app/_components/skip-link.test.tsx
import { render, screen } from "@testing-library/react";
import { SkipLink } from "./skip-link";

test("skip link targets main-content and is the first focusable element", () => {
  render(
    <>
      <SkipLink />
      <nav><a href="/x">x</a></nav>
      <main id="main-content">content</main>
    </>
  );
  const link = screen.getByRole("link", { name: /skip to main content/i });
  expect(link).toHaveAttribute("href", "#main-content");
});
```

- [ ] **Step 3: Run to verify failure, then implement `SkipLink` (visually hidden until focused, STAK-styled focus treatment) and add `id="main-content"` to the single `<main>` in each shell (`AppSidebar`'s layout wrapper, `FocusedShell`, `PublicShell`)**

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @stack/web test -- skip-link`

- [ ] **Step 5: Fix every div-as-button/keyboard gap found in Step 1** — convert to `<button>`/`<a>` as appropriate, add visible `:focus-visible` styles in `globals.css` using STAK's orange accent (must remain visible on the near-black background), verify heading order (one `h1` per page, no skipped levels) on at least `/overview`, `/skills`, `/settings`, `/[owner]/[slug]`, and confirm status is never color-only (pair color with text/icon — check Skill status rows and Machine status rows specifically).

- [ ] **Step 6: Manual check of touch target size (≥24x24px, ideally 44x44px) on mobile nav (Task 1) and Command Dock Copy buttons (Task 2) at 360px width**

- [ ] **Step 7: Commit**

```bash
git add apps/web/app/_components/skip-link.tsx apps/web/app/_components/skip-link.test.tsx apps/web/app/globals.css apps/web/app/layout.tsx
git commit -m "feat(p9): skip link, focus-visible treatment, and keyboard/semantic control fixes"
```

---

### Task 6: Loading, empty, and error state consistency

**Files:**
- Create: `apps/web/app/not-found.tsx` (global 404)
- Create: `apps/web/app/error.tsx` (global error boundary)
- Create per-route `loading.tsx` only where a route performs a genuinely slow data fetch (identify during Step 1 — do not blanket-add to every route)
- Create: `apps/web/app/[owner]/not-found.tsx` and/or in-page not-found handling for `[owner]/[slug]` (public nonexistent Stack must 404 truthfully, no fake content, no indexable error content)
- Modify: empty-state copy/markup in `apps/web/app/skills/page.tsx`, `apps/web/app/projects/page.tsx`, `apps/web/app/machines/page.tsx`, `apps/web/app/stacks/page.tsx`, `apps/web/app/memory/(dashboard)/page.tsx` where real empty states exist (no Skills, no backup, no Projects, no Machines, empty Stack, no recovery method)
- Test: `apps/web/app/not-found.test.tsx`, `apps/web/app/error.test.tsx`

**Interfaces:**
- Consumes: Task 4's `PublicShell` for the public not-found page; Task 1/3 shells for signed-in/focused not-found.
- Produces: a 404 page and error boundary styled in STAK's visual language, reachable test coverage confirming they render without crashing and without leaking internals.

- [ ] **Step 1: Audit every route for current loading/empty/error behavior** — note which routes have zero loading feedback despite real async data fetches (check Supabase calls in each `page.tsx`), and list every realistic empty state per brief §20.

- [ ] **Step 2: Write failing tests for not-found and error pages**

```tsx
// apps/web/app/not-found.test.tsx
import { render, screen } from "@testing-library/react";
import NotFound from "./not-found";

test("renders a clear not-found message with a safe next action", () => {
  render(<NotFound />);
  expect(screen.getByText(/not found/i)).toBeInTheDocument();
  expect(screen.getByRole("link")).toBeInTheDocument();
});
```

```tsx
// apps/web/app/error.test.tsx
import { render, screen } from "@testing-library/react";
import ErrorBoundary from "./error";

test("renders a safe error message without leaking internals", () => {
  render(<ErrorBoundary error={new Error("Supabase: connection refused at 10.0.0.5")} reset={() => {}} />);
  expect(screen.queryByText(/10\.0\.0\.5/)).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
});
```

- [ ] **Step 3: Run to verify failure (files don't exist), implement `not-found.tsx` and `error.tsx` using STAK visual language and the appropriate shell, implement the public not-found path for `[owner]`/`[owner]/[slug]` (real 404 — use Next's `notFound()` call from `next/navigation` when the Stack/owner lookup returns nothing, not a client-rendered "Stack not found" string that still 200s)**

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @stack/web test -- "not-found|error"`

- [ ] **Step 5: Add real loading states only where Step 1 found a genuine gap, using restrained STAK treatment (meaningful structural text, not shimmering skeletons or fake rows)**

- [ ] **Step 6: Fix empty-state copy per route so each answers: what is absent, whether that's a problem, what truthful next action exists — and confirm no unusable search/filter/table chrome renders on a truly empty dataset**

- [ ] **Step 7: Commit**

```bash
git add apps/web/app/not-found.tsx apps/web/app/error.tsx apps/web/app/not-found.test.tsx apps/web/app/error.test.tsx "apps/web/app/[owner]" apps/web/app/skills/page.tsx apps/web/app/projects/page.tsx apps/web/app/machines/page.tsx apps/web/app/stacks/page.tsx "apps/web/app/memory/(dashboard)/page.tsx"
git commit -m "feat(p9): global not-found/error pages, truthful public 404, empty-state consistency"
```

---

### Task 7: Site-origin config, robots, sitemap

**Files:**
- Create: `apps/web/lib/site-origin.ts`
- Modify: `apps/web/lib/env.ts` (extend `cloudEnv()` or add a sibling helper — check Step 1 before deciding)
- Create: `apps/web/app/robots.ts`
- Create: `apps/web/app/sitemap.ts`
- Test: `apps/web/lib/site-origin.test.ts`

**Interfaces:**
- Consumes: nothing new (reads `process.env`).
- Produces: `siteOrigin(): string` — returns the production origin (`https://usestak.app` once `STAK_APP_URL`/equivalent is set) or a safe local fallback, never a bogus `localhost` canonical when `NODE_ENV === "production"` without an explicit env var set (in that case, throw or log a clear error rather than emit a wrong canonical — surfaces as the launch-checklist item in Task 12). Task 9 (per-route metadata) and Task 8's `sitemap.ts`/`robots.ts` consume this function.

- [ ] **Step 1: Read `apps/web/lib/env.ts` fully to see the exact shape of `cloudEnv()` and decide whether `site-origin.ts` wraps it or is independent**

- [ ] **Step 2: Write a failing test for `siteOrigin()`**

```ts
// apps/web/lib/site-origin.test.ts
import { describe, test, expect, vi } from "vitest";
import { siteOrigin } from "./site-origin";

describe("siteOrigin", () => {
  test("returns STAK_APP_URL when set", () => {
    vi.stubEnv("STAK_APP_URL", "https://usestak.app");
    expect(siteOrigin()).toBe("https://usestak.app");
  });

  test("falls back to localhost outside production", () => {
    vi.stubEnv("STAK_APP_URL", "");
    vi.stubEnv("NODE_ENV", "development");
    expect(siteOrigin()).toBe("http://localhost:3000");
  });

  test("throws rather than emit a bogus localhost canonical in production with no origin configured", () => {
    vi.stubEnv("STAK_APP_URL", "");
    vi.stubEnv("NODE_ENV", "production");
    expect(() => siteOrigin()).toThrow();
  });
});
```

- [ ] **Step 3: Run to verify failure, implement `siteOrigin()`**

```ts
// apps/web/lib/site-origin.ts
export function siteOrigin(): string {
  const configured = process.env.STAK_APP_URL || process.env.STACK_APP_URL;
  if (configured) return configured.replace(/\/$/, "");
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "STAK_APP_URL is not set in production — refusing to emit a localhost canonical."
    );
  }
  return "http://localhost:3000";
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @stack/web test -- site-origin`

- [ ] **Step 5: Implement `app/robots.ts` and `app/sitemap.ts` using Next's native `MetadataRoute.Robots` / `MetadataRoute.Sitemap` conventions, allowing crawl of `/`, `/[owner]`, `/[owner]/[slug]`, and disallowing `/overview`, `/skills`, `/memory`, `/projects`, `/machines`, `/stacks`, `/settings`, `/onboarding`, `/auth`, `/cli`. Sitemap includes only the public landing and any genuinely enumerable public pages — do not hard-code fake Stacks; if no safe public-Stack enumeration API exists (confirm by checking `@stack/cloud-server` for a public-listing query), include only `/` and note the enumeration limitation in the Task 12 report**

- [ ] **Step 6: Commit**

```bash
git add apps/web/lib/site-origin.ts apps/web/lib/site-origin.test.ts apps/web/app/robots.ts apps/web/app/sitemap.ts
git commit -m "feat(p9): site-origin config, robots.ts, sitemap.ts"
```

---

### Task 8: Public landing (`/`) SEO content and routing decision

**Files:**
- Modify: `apps/web/app/page.tsx`
- Modify: `apps/web/app/layout.tsx` (title template, root metadata)

**Interfaces:**
- Consumes: Task 4's `PublicShell` if `/` is reclassified as a public landing surface rather than a bare sign-in card (decision made in Step 1); Task 7's `siteOrigin()`.
- Produces: an indexable `/` with real, non-keyword-stuffed prose about STAK, plus a sign-in action, OR a documented STOP if the current auth-routing architecture can't support this without a larger restructure.

- [ ] **Step 1: Read `apps/web/app/page.tsx` fully and determine: is `/` currently (A) a landing surface with a sign-in action, or (B) only a bare sign-in form?** Check how signed-in users are routed when they hit `/` (middleware redirect to `/overview`?) and whether that redirect would also redirect a crawler/anonymous visitor away from indexable content.

- [ ] **Step 2: If `/` can hold real marketing prose without breaking the signed-in redirect (i.e., the redirect only fires for authenticated sessions, anonymous visitors see the full page) — proceed. If not, STOP here and write the exact routing conflict into the Task 12 report instead of restructuring auth routing as part of P9.**

- [ ] **Step 3: Write the landing content** using `PublicShell` (or a minimal variant if full `PublicShell` doesn't fit a pre-auth entry point), covering in natural prose: "STAK is the control plane for portable AI agent environments," "Your STAK should survive your laptop," "Your skills. Your memory. Your setup. Any agent. Any machine," and a plain-language explanation that STAK helps developers carry AI-agent skills, Memory, and environment setup between machines. One `<h1>`, logical `<h2>` structure, a sign-in call to action, no fake claims, no "best/#1/leading" language.

- [ ] **Step 4: Add metadata to `/` via `generateMetadata` or a static `metadata` export** — meaningful title (`"STAK — Portable AI agent environments"` or similar, using the root title template from `layout.tsx`), meta description, canonical via `siteOrigin()`, Open Graph title/description, `robots: { index: true, follow: true }`.

- [ ] **Step 5: Manual viewport + Lighthouse-style manual check (full pass deferred to Task 11) at 1440/390px**

- [ ] **Step 6: Commit**

```bash
git add apps/web/app/page.tsx apps/web/app/layout.tsx
git commit -m "feat(p9): indexable public landing with real STAK product copy and metadata"
```

---

### Task 9: Per-route metadata, index/noindex matrix, dynamic public Stack metadata, structured data

**Files:**
- Modify: every signed-in/focused route's `page.tsx` or `layout.tsx` to add `metadata: { robots: { index: false, follow: false } }` (noindex) — `/overview`, `/skills`, `/skills/[skillId]`, `/memory`, `/projects`, `/projects/[projectId]`, `/machines`, `/stacks`, `/settings`, `/onboarding`, `/auth/error`, `/cli`, `/memory/protect`, `/memory/recover`
- Modify: `apps/web/app/[owner]/page.tsx` — add `generateMetadata` using real public owner data; noindex if thin/empty
- Modify: `apps/web/app/[owner]/[slug]/page.tsx` — add `generateMetadata` using real Stack name/owner/reference data; noindex on private/nonexistent Stack (paired with Task 6's `notFound()` call)
- Create: `apps/web/app/_lib/structured-data.ts` (JSON-LD builder, only if Step 4 below finds truthful fields to populate)

**Interfaces:**
- Consumes: Task 7's `siteOrigin()` for canonical URLs; Task 4's `PublicShell` data-loading for real Stack/owner fields; Task 8's root title template.
- Produces: a complete index/noindex matrix matching brief §24; unique, safe `generateMetadata` output per public Stack page; optional JSON-LD only where every field is real.

- [ ] **Step 1: List every route from the inventory and classify INDEX / NOINDEX / CONDITIONAL, matching brief §24's expected direction exactly**

- [ ] **Step 2: Add `robots: { index: false, follow: false }` metadata to every NOINDEX route listed above** — for App Router, this is a `metadata` export (static routes) or `generateMetadata` return (dynamic routes) in each route's `page.tsx`, or lifted to `layout.tsx` where one layout covers multiple noindex children (e.g., the Memory layout).

- [ ] **Step 3: Implement `generateMetadata` for `[owner]/page.tsx` and `[owner]/[slug]/page.tsx`** — title shape `"<Stack name> by <owner> | STAK"` for the slug page, description from real Stack/reference fields only (no private Skill contents, snapshots, local paths, hashes, credentials — re-verify against Task 4 Step 4's data-loading audit), canonical via `siteOrigin()`, Open Graph using the same real fields, `index: true` only when the Stack/owner genuinely exists and has meaningful public content, `index: false` otherwise (thin/empty owner pages, nonexistent/private Stacks — the latter already returns `notFound()` from Task 6, which Next automatically excludes from indexing).

- [ ] **Step 4: Evaluate whether JSON-LD (`WebSite`, `Organization`, `SoftwareApplication`) would be truthful** — only implement if every field (name, url, description) is a real product fact with no invented ratings/reviews/price/user-count/OS-support. If genuinely nothing adds value beyond what's already in standard metadata, skip and note that decision in Task 12's report rather than force structured data in.

- [ ] **Step 5: Write a lightweight test confirming noindex metadata is present on a representative signed-in route**

```ts
// apps/web/app/settings/metadata.test.ts
import { describe, test, expect } from "vitest";
import { metadata } from "./page";

test("settings route is noindex", () => {
  expect(metadata.robots).toMatchObject({ index: false });
});
```

- [ ] **Step 6: Run the test**

Run: `pnpm --filter @stack/web test -- metadata`

- [ ] **Step 7: Commit**

```bash
git add apps/web/app -A
git commit -m "feat(p9): index/noindex metadata matrix and dynamic public Stack SEO metadata"
```

---

### Task 10: Performance pass and production build size check

**Files:** none pre-determined — this task is diagnostic-first; only modify files where Step 2 finds a concrete, low-risk win (e.g., marking a component `"use client"` unnecessarily, an avoidable fetch waterfall, missing `next/font` usage causing layout shift).

**Interfaces:** none new.

- [ ] **Step 1: Run the production build and capture route sizes**

Run: `pnpm --filter @stack/web build`
Record the route size table Next prints (First Load JS per route).

- [ ] **Step 2: Audit for unnecessary client components** (`grep -rln '"use client"' apps/web/app`) — check each against whether it actually needs interactivity, or could be a server component with a smaller client island. Check font loading uses `next/font` (avoids layout shift) rather than a `<link>` tag to Google Fonts. Check for duplicated CSS across route-specific stylesheets that could share a token file (do not do a large refactor — only extract genuinely duplicated blocks found during this audit).

- [ ] **Step 3: Apply only the fixes that are low-risk and clearly justified by Step 1/2 findings — do not chase micro-optimizations that compromise product clarity**

- [ ] **Step 4: Re-run the production build and compare route sizes to Step 1's baseline**

Run: `pnpm --filter @stack/web build`

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "perf(p9): address unnecessary client-component/font-loading overhead found in build audit"
```

---

### Task 11: Accessibility/Lighthouse tooling check and browser matrix execution

**Files:** none (manual verification task) — may add `apps/web/package.json` devDependency for `@axe-core/react` only if Step 1 determines it's a low-cost, no-new-infra addition; otherwise skip per brief §37's instruction not to install a heavy dependency just for this phase.

**Interfaces:** none new.

- [ ] **Step 1: Determine what's available without new heavy installs** — check if Chrome DevTools Lighthouse (manual, via the browser, no install) can be run against the local dev server; check if `@axe-core/react` (lightweight, dev-only) is acceptable to add given Task 1/4/5/6 already added `@testing-library/react` as the one dependency exception. Prefer manual Chrome DevTools Lighthouse runs over installing new tooling.

- [ ] **Step 2: Run Lighthouse (or equivalent) against the local dev server for the public landing (`/`) and one representative signed-in route (`/overview`)** — record LCP, CLS, INP-proxy, accessibility score, SEO score. If no tooling is available at all, explicitly record "not measured" rather than fabricate numbers.

- [ ] **Step 3: Execute the full manual browser matrix from brief §42** at desktop widths (overview, skills, skill detail, memory, projects, machines, stacks, settings, root/public landing, public Stack, auth error, protect/recover), mobile widths (overview, skills, memory, machines, settings, root/public landing, public Stack, focused flow), and tablet widths (overview, Skills/table-heavy route, Settings, public Stack). Record actual observed issues — do not claim a viewport was tested if it wasn't rendered.

- [ ] **Step 4: File any defects found as fix-forward commits against the relevant task's files (1–9) rather than accumulating them unaddressed** — if a defect doesn't map cleanly to an earlier task, fix it directly here with its own commit.

- [ ] **Step 5: Commit the matrix results as a note in the Task 12 completion report (not a separate file) — no commit needed for this task alone unless Step 4 produced fixes**

---

### Task 12: Final validation, migration gate confirmation, and completion report

**Files:** none created beyond the report itself, which goes into the final chat response per brief §49 — not a new repo file, unless the user asks for one.

**Interfaces:** consumes the output of every prior task.

- [ ] **Step 1: Run the full verification suite**

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm format:check
pnpm build
git diff --check
```

All must pass. Fix any failures by returning to the owning task, not by weakening the check.

- [ ] **Step 2: Confirm the migration gate** — re-check Tasks 1–11 for any point where a schema change seemed necessary. Per brief §47, none should have been needed; if one was flagged during execution, confirm it was STOPPED and reported rather than silently applied, and surface it explicitly in the report.

- [ ] **Step 3: Confirm real-account safety** — grep the session's command history / diff for any call that would have mutated the real account (backup run, recover/restore, privacy change, passkey creation, recovery file creation, DELL revoke, archive/unarchive, Skill pause/resume/approve, Stack composition change, Cloud Memory delete, real CLI approval). Confirm none occurred.

- [ ] **Step 4: Write the completion report** covering every numbered item in brief §49 (branch+HEAD, route inventory, shell changes, mobile nav behavior, signed-in/focused-flow responsive results, public-page migration, accessibility fixes, keyboard/focus result, loading/empty/error results, terminology sweep, landing SEO treatment, index/noindex matrix, canonical strategy, robots/sitemap result, public Stack metadata, owner-page SEO decision, structured-data decision, content/discoverability improvements, performance/build-size result, Lighthouse result, desktop/tablet/mobile browser matrix, real-account read-only confirmation, privacy/security SEO audit, external Google/Search Console launch checklist per brief §40, intentional deferrals, files changed, tests/build status, commit hashes, git status, confirmation of no real mutation, confirmation of no production/deployment changes).

- [ ] **Step 5: Present the report to the user and STOP** — do not start the final launch/E2E phase, do not merge, do not push, do not deploy.

---

## Branch Setup (run before Task 1)

```bash
git checkout -b p9-quality-seo
```
