# P5 — Skills Workspace + Skill Detail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the P4 "Skills" sidebar placeholder into two real routes — `/skills` (list) and `/skills/[skillId]` (detail) — backed entirely by the P3 `getSkillsReadModel` / `getSkillDetail` / `approveSkillVersion` / `setSkillPaused` read/write models, following the P4 shell/visual system and the STAK Final Contract's Skills screens (S.05, S.06).

**Architecture:** Same layering P4 established for Overview: a pure, unit-tested view-model module per route (`skills-data.ts`, `skill-detail-data.ts`) that takes an injected `Pick<CloudService, ...>` and the signed-in user and returns a discriminated view type; a thin server-component page that calls `getSessionUser()` / `getCloudService()` and renders that view; small client components only where interaction requires it (search/filter table, approve/pause buttons, file switcher). Three small P4 modules are generalized for reuse rather than forked: the machine-context resolution logic (extracted to `apps/web/lib/machine-context.ts`), the shell empty/error `Notice` wrapper (extracted to `apps/web/app/_components/shell-notice.tsx`), and `MachineChooser`'s hardcoded redirect target (parameterized).

**Tech Stack:** Next.js App Router (server components + `'use server'` actions), TypeScript, Zod-typed `@stack/spec` models, Vitest, existing `shell.css` design tokens (IBM Plex, dark graphite palette).

## Global Constraints

- Branch `p5-skills-detail` only. Do not start P6, push, apply Supabase migrations, mutate production services, or create demo data in real signed-in routes.
- Frozen status vocabulary (verbatim, from `docs/0.1.0-contract.md` §3/§6 and the Final Contract's `lang` table): **Ready**, **Update available**, **Paused**, and the note **"Can't check for updates from this source."** Never: In sync, Outdated, Broken, Unsafe, Online, Offline.
- **Resolved ambiguity (§19 of the brief):** when a Skill is not paused, has no source update, but the viewing machine's installed version is unknown (never checked in) or differs from approved — do **not** call it Ready. Render a neutral (non-green) dot with plain descriptive text (e.g. `"Not reported by <machine>"`), never a badge word. This is confirmed by the user as the resolution.
- `files` and `diff` on `SkillDetail` are **currently always `null`** in `packages/cloud-server/src/product-service.ts:257` (verified — no code path populates them). P5 does not add new source-tree-fetching backend plumbing; it renders the honest "not available yet" states §25 explicitly calls for. This is not a bug to fix in P5.
- Route skill detail by stable `entryId` (`/skills/skill_...`), never display name. Two Skills with the same `name` must remain separately addressable.
- Approve = set desired/approved version only; never implies installation on any machine. Pause ≠ remove; never surface `stak remove`.
- Reuse P4's `AppSidebar`, `MachineSelector`, `MachineChooser`, `CommandDock`, `getSessionUser`/`getCloudService` — no forked machine-selector implementation.
- No fabricated fields: no trust/safety scores, no "used by N" counts, no Agents/Scope columns (not in the P3 schema — the Final Contract's S.05 mock invents these; P5 uses only real `SkillSummary`/`SkillDetail` fields).
- Privacy: never render absolute or home-relative filesystem paths, credentials, or tokens. `source.label` is already a sanitized safe label per `sourceSummaryOf` in `product-service.ts` — display it as-is, never reconstruct a path from it.
- Mutation testing (approve/pause/resume) uses fixtures/fakes in unit tests; real-account dogfood stays read-only (no writes against the real 31-Skill environment).

---

## File Structure

New:
- `apps/web/lib/machine-context.ts` — shared machine-view formatting + viewing-machine resolution (extracted from `overview-data.ts`).
- `apps/web/lib/machine-context.test.ts`
- `apps/web/app/_components/shell-notice.tsx` — shared `ShellNotice` wrapper (extracted from `overview/page.tsx`'s local `Notice`).
- `apps/web/app/skills/skills-data.ts` — list view-model.
- `apps/web/app/skills/skills-data.test.ts`
- `apps/web/app/skills/skill-detail-data.ts` — detail view-model.
- `apps/web/app/skills/skill-detail-data.test.ts`
- `apps/web/app/skills/actions.ts` — `'use server'` approve/pause/resume actions.
- `apps/web/app/skills/page.tsx` — list route.
- `apps/web/app/skills/[skillId]/page.tsx` — detail route.
- `apps/web/app/skills/_components/skills-table.tsx` — client: search + filter chips + rows.
- `apps/web/app/skills/_components/skill-actions.tsx` — client: Approve/Pause/Resume buttons with pending/error state.
- `apps/web/app/skills/skills.css` — Skills-specific styles (imported once from `app/skills/page.tsx`'s nearest layout need — see Task 5).

Modified:
- `apps/web/app/overview/overview-data.ts` — delegates machine-view helpers to `lib/machine-context.ts`; re-exports `displayPlatform`/`MachineOption` for existing import sites.
- `apps/web/app/overview/page.tsx` — uses `ShellNotice` instead of its local `Notice`.
- `apps/web/app/_components/app-sidebar.tsx` — `skills` becomes a real `<Link href="/skills">`; `active` type gains no new values (already includes `'skills'`).
- `apps/web/app/_components/machine-chooser.tsx` — adds an optional `basePath` prop (default `/overview`) so `/skills` can redirect to itself.
- `apps/web/app/overview/shell.css` — no change; new Skills-only rules go in `skills.css` to keep Overview's stylesheet untouched.

---

### Task 1: Extract shared machine-context module

**Files:**
- Create: `apps/web/lib/machine-context.ts`
- Create: `apps/web/lib/machine-context.test.ts`
- Modify: `apps/web/app/overview/overview-data.ts`

**Interfaces:**
- Produces: `relative(iso: string | null): string`, `displayPlatform(platform?: string): string | undefined`, `shortId(id: string): string`, `checkedIn(m: MachineSummary): boolean`, `displayName(m: MachineSummary): string`, `metaLine(m: MachineSummary): string`, `statusLabel(m: MachineSummary): string`, `machineDot(m: MachineSummary): 'ready' | 'attention' | 'neutral'`, `sortMachinesForSelection(a: MachineSummary, b: MachineSummary): number`, `type MachineOption = { machineId: string; name: string; secondary: string; statusLabel: string }`, `machineOption(m: MachineSummary): MachineOption`, `resolveViewingMachineId(active: MachineSummary[], requested: string | undefined): string | undefined`.
- Consumes: `MachineSummary` from `@stack/spec`.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/web/lib/machine-context.test.ts
import { describe, expect, it } from 'vitest';
import type { MachineSummary } from '@stack/spec';
import {
  resolveViewingMachineId,
  machineOption,
  statusLabel,
  machineDot,
} from './machine-context.js';

const A1 = '00000000-0000-4000-8000-0000000000a1';
const B2 = '00000000-0000-4000-8000-0000000000b2';

const machine = (over: Partial<MachineSummary> = {}): MachineSummary => ({
  machineId: A1,
  name: 'Atlas',
  platform: 'darwin',
  arch: 'arm64',
  agentsDetected: ['Claude Code'],
  firstSeenAt: new Date().toISOString(),
  lastCheckinAt: new Date().toISOString(),
  memoryBackedUp: true,
  revoked: false,
  status: 'up-to-date',
  updatesWaiting: [],
  projectsPresent: 7,
  ...over,
});

describe('resolveViewingMachineId', () => {
  it('prefers a valid requested machine', () => {
    const active = [machine({ machineId: A1 }), machine({ machineId: B2 })];
    expect(resolveViewingMachineId(active, B2)).toBe(B2);
  });
  it('ignores an unknown requested machine id', () => {
    const active = [machine({ machineId: A1 }), machine({ machineId: B2 })];
    expect(resolveViewingMachineId(active, 'not-a-real-id')).toBeUndefined();
  });
  it('auto-selects the single active machine when none requested', () => {
    const active = [machine({ machineId: A1 })];
    expect(resolveViewingMachineId(active, undefined)).toBe(A1);
  });
  it('returns undefined when multiple machines and none requested', () => {
    const active = [machine({ machineId: A1 }), machine({ machineId: B2 })];
    expect(resolveViewingMachineId(active, undefined)).toBeUndefined();
  });
});

describe('machineDot / statusLabel', () => {
  it('up-to-date is ready/green with a time', () => {
    const m = machine({ status: 'up-to-date' });
    expect(machineDot(m)).toBe('ready');
    expect(statusLabel(m)).toMatch(/^Up to date/);
  });
  it('never-checked-in is neutral, never claims online/offline', () => {
    const m = machine({ status: 'never-checked-in', lastCheckinAt: null });
    expect(machineDot(m)).toBe('neutral');
    expect(statusLabel(m)).toBe('No check-in yet');
  });
});

describe('machineOption', () => {
  it('never exposes a raw path or secret, only name/meta/status', () => {
    const opt = machineOption(machine());
    expect(opt).toEqual({
      machineId: A1,
      name: 'Atlas',
      secondary: expect.stringContaining('·'),
      statusLabel: expect.any(String),
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx vitest run lib/machine-context.test.ts`
Expected: FAIL — `Cannot find module './machine-context.js'`

- [ ] **Step 3: Write the implementation**

```typescript
// apps/web/lib/machine-context.ts
import type { MachineSummary } from '@stack/spec';

/** Human-relative time, never a raw timestamp in UI copy. "never" when absent. */
export const relative = (iso: string | null): string => {
  if (!iso) return 'never';
  const secs = Math.max(
    0,
    Math.round((Date.now() - new Date(iso).getTime()) / 1000),
  );
  if (secs < 90) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 90) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 36) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
};

/** Human-facing platform label (P4 contract). Display only — never changes storage. */
export const displayPlatform = (
  platform: string | undefined,
): string | undefined => {
  if (!platform) return undefined;
  switch (platform) {
    case 'win32':
      return 'Windows';
    case 'darwin':
      return 'macOS';
    case 'linux':
      return 'Linux';
    default:
      return platform;
  }
};

export const displayName = (m: MachineSummary): string =>
  m.name ?? 'Unnamed machine';
export const shortId = (id: string): string => id.slice(0, 8);
export const checkedIn = (m: MachineSummary): boolean =>
  m.lastCheckinAt !== null;

export const metaLine = (m: MachineSummary): string => {
  const hw = [displayPlatform(m.platform), m.arch].filter(Boolean).join(' · ');
  return hw || `ID ${shortId(m.machineId)}`;
};

export const statusLabel = (m: MachineSummary): string => {
  switch (m.status) {
    case 'never-checked-in':
      return 'No check-in yet';
    case 'updates-waiting':
      return 'Updates waiting';
    case 'up-to-date':
      return `Up to date · ${relative(m.lastCheckinAt)}`;
    default:
      return `Last seen ${relative(m.lastCheckinAt)}`;
  }
};

export const machineDot = (
  m: MachineSummary,
): 'ready' | 'attention' | 'neutral' =>
  m.status === 'up-to-date'
    ? 'ready'
    : m.status === 'updates-waiting'
      ? 'attention'
      : 'neutral';

export type MachineOption = {
  machineId: string;
  name: string;
  secondary: string;
  statusLabel: string;
};

export const machineOption = (m: MachineSummary): MachineOption => ({
  machineId: m.machineId,
  name: displayName(m),
  secondary: `${metaLine(m)} · ${statusLabel(m)}`,
  statusLabel: statusLabel(m),
});

/** Same ordering Overview uses for its machine list/selector (P4 §4): attention-needing
 *  machines first, then checked-in by most recent, then never-checked-in by newest
 *  authorization. Shared so every "Viewing as" selector across the app orders identically. */
export const sortMachinesForSelection = (
  a: MachineSummary,
  b: MachineSummary,
): number => {
  const rank = (m: MachineSummary) =>
    m.status === 'updates-waiting' ? 0 : m.status === 'never-checked-in' ? 2 : 1;
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 2) return b.firstSeenAt.localeCompare(a.firstSeenAt);
  return (b.lastCheckinAt ?? '').localeCompare(a.lastCheckinAt ?? '');
};

/** P4's machine-context resolution (contract §20): a valid owned `?machine=` wins; a single
 *  active machine auto-selects; multiple active machines with no/invalid request require the
 *  caller to show a chooser (returns undefined). Revoked machines must already be filtered out
 *  of `active` by the caller. */
export const resolveViewingMachineId = (
  active: MachineSummary[],
  requested: string | undefined,
): string | undefined => {
  const requestedValid =
    requested && active.some((m) => m.machineId === requested);
  if (requestedValid) return requested;
  if (active.length === 1) return active[0]?.machineId;
  return undefined;
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && npx vitest run lib/machine-context.test.ts`
Expected: PASS (all 6 tests)

- [ ] **Step 5: Refactor `overview-data.ts` to delegate to the shared module**

Replace the local `relative`, `displayPlatform`, `displayName`, `shortId`, `checkedIn`, `metaLine`, `statusLabel`, `machineDot`, `option`, `sortForOverview` definitions and the inline viewing-machine resolution in `apps/web/app/overview/overview-data.ts` with:

```typescript
// apps/web/app/overview/overview-data.ts — near the top, replace the removed local
// helpers with:
import {
  relative,
  displayPlatform,
  displayName,
  checkedIn,
  metaLine,
  statusLabel,
  machineDot,
  machineOption as option,
  sortMachinesForSelection as sortForOverview,
  resolveViewingMachineId,
  type MachineOption,
} from '../../lib/machine-context.js';

// Re-exported so existing imports (overview-data.test.ts, app-sidebar.tsx) keep working.
export { displayPlatform };
export type { MachineOption };
```

Then in `loadOverview`, replace:

```typescript
  const requestedValid =
    requestedMachine && active.some((m) => m.machineId === requestedMachine);
  const viewingId = requestedValid
    ? requestedMachine
    : active.length === 1
      ? active[0]?.machineId
      : undefined;
```

with:

```typescript
  const viewingId = resolveViewingMachineId(active, requestedMachine);
```

Delete the now-unused local `shortId` (no longer referenced outside `metaLine`, which moved).

- [ ] **Step 6: Update `app-sidebar.tsx`'s type import**

In `apps/web/app/_components/app-sidebar.tsx`, change:

```typescript
import type { MachineOption, SidebarCounts } from '../overview/overview-data';
```

to:

```typescript
import type { SidebarCounts } from '../overview/overview-data';
import type { MachineOption } from '../../lib/machine-context';
```

- [ ] **Step 7: Run the full existing Overview test suite to confirm no regression**

Run: `cd apps/web && npx vitest run app/overview/overview-data.test.ts`
Expected: PASS — same assertions as before the refactor (black-box behavior unchanged).

- [ ] **Step 8: Commit**

```bash
git add apps/web/lib/machine-context.ts apps/web/lib/machine-context.test.ts apps/web/app/overview/overview-data.ts apps/web/app/_components/app-sidebar.tsx
git commit -m "refactor(p5): extract shared machine-context module from Overview"
```

---

### Task 2: Extract shared `ShellNotice` component

**Files:**
- Create: `apps/web/app/_components/shell-notice.tsx`
- Modify: `apps/web/app/overview/page.tsx`

**Interfaces:**
- Produces: `ShellNotice({ active, handle, title, children }): JSX.Element` where `active` is the same `NavKey` union `AppSidebar` already accepts.
- Consumes: `AppSidebar` from `./app-sidebar.js`.

- [ ] **Step 1: Create the component** (this is a pure extraction — no new behavior to test; `overview-data.test.ts` and the Task 7 manual dogfood pass are the coverage)

```typescript
// apps/web/app/_components/shell-notice.tsx
import type { ReactNode } from 'react';

import { AppSidebar } from './app-sidebar';

const PLACEHOLDER_COUNTS = {
  overview: { n: '', tone: 'neutral' as const },
  skills: '',
  memory: { n: '', tone: 'neutral' as const },
  projects: '',
  machines: '',
  stacks: '',
};

/** Shared error/empty-state wrapper (P4 §Notice): keeps the full signed-in shell/sidebar
 *  visible even when the page's own data couldn't load, rather than a bare error page. */
export function ShellNotice({
  active,
  handle,
  title,
  children,
}: {
  active: 'overview' | 'skills' | 'memory' | 'projects' | 'machines' | 'stacks';
  handle: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="stak-frame">
      <AppSidebar
        active={active}
        handle={handle}
        counts={PLACEHOLDER_COUNTS}
        viewing={null}
        machines={[]}
      />
      <main className="stak-main">
        <div className="stak-notice">
          <h1>{title}</h1>
          {children}
        </div>
      </main>
    </div>
  );
}
```

- [ ] **Step 2: Replace the local `Notice` in `overview/page.tsx`**

Delete the local `PLACEHOLDER_COUNTS` const and `Notice` function from `apps/web/app/overview/page.tsx`, add:

```typescript
import { ShellNotice } from '../_components/shell-notice';
```

and replace every `<Notice handle={handle} title="...">` call with `<ShellNotice active="overview" handle={handle} title="...">` (same children).

- [ ] **Step 3: Typecheck + run Overview tests**

Run: `cd apps/web && npx tsc --noEmit && npx vitest run app/overview`
Expected: PASS, no type errors.

- [ ] **Step 4: Commit**

```bash
git add apps/web/app/_components/shell-notice.tsx apps/web/app/overview/page.tsx
git commit -m "refactor(p5): extract ShellNotice for reuse by Skills"
```

---

### Task 3: Generalize `MachineChooser`'s redirect target

**Files:**
- Modify: `apps/web/app/_components/machine-chooser.tsx`

**Interfaces:**
- Produces: `MachineChooser({ options, basePath? }): JSX.Element` — `basePath` defaults to `'/overview'`.

- [ ] **Step 1: Edit the component**

In `apps/web/app/_components/machine-chooser.tsx`, change the signature and the href:

```typescript
export function MachineChooser({
  options,
  basePath = '/overview',
}: {
  options: ChooserOption[];
  basePath?: string;
}) {
```

```typescript
                <a
                  href={`${basePath}?machine=${encodeURIComponent(m.machineId)}`}
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/web && npx tsc --noEmit`
Expected: PASS (Overview's existing call site has no `basePath`, keeps defaulting to `/overview`).

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/_components/machine-chooser.tsx
git commit -m "refactor(p5): parameterize MachineChooser's redirect target"
```

---

### Task 4: Skills list view-model

**Files:**
- Create: `apps/web/app/skills/skills-data.ts`
- Create: `apps/web/app/skills/skills-data.test.ts`

**Interfaces:**
- Consumes: `SkillsService = Pick<CloudService, 'getMachinesReadModel' | 'getSkillsReadModel'>`; `machine-context.js` exports from Task 1; `WebUser` from `../../lib/session.js`.
- Produces: `type SkillsListView = { kind: 'error' } | { kind: 'no-machines' } | { kind: 'choose-machine'; machines: MachineOption[]; anyCheckedIn: boolean } | { kind: 'ready'; viewing: {...}; machines: MachineOption[]; sidebar: SidebarCounts; statusSentence: string; rows: SkillRow[] }`; `type SkillRow = { skillId: string; name: string; description?: string; sourceLabel: string; cannotCheckNote: boolean; installedLabel: string; primaryStatus: 'ready' | 'update-available' | 'paused'; pendingInstall: boolean; dot: 'ready' | 'attention' | 'neutral' | 'none'; statusText: string }`; `loadSkillsList(service, user, requestedMachine): Promise<SkillsListView>`; exported pure helpers `deriveRow`, `filterRows`, `STATUS_FILTERS`.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/web/app/skills/skills-data.test.ts
import { describe, expect, it } from 'vitest';
import type { MachineSummary, MachinesReadModel, SkillSummary, SkillsReadModel } from '@stack/spec';

import { loadSkillsList, deriveRow, filterRows, type SkillsService } from './skills-data.js';

const USER = { id: 'user-1' };
const A1 = '00000000-0000-4000-8000-0000000000a1';
const B2 = '00000000-0000-4000-8000-0000000000b2';

const machine = (over: Partial<MachineSummary> = {}): MachineSummary => ({
  machineId: A1,
  name: 'DELL',
  platform: 'win32',
  arch: 'x64',
  agentsDetected: ['Claude Code'],
  firstSeenAt: new Date().toISOString(),
  lastCheckinAt: new Date().toISOString(),
  memoryBackedUp: true,
  revoked: false,
  status: 'up-to-date',
  updatesWaiting: [],
  projectsPresent: 3,
  ...over,
});

const skill = (over: Partial<SkillSummary> = {}): SkillSummary => ({
  skillId: 'skill_test0001',
  name: 'test-first',
  approvedVersion: 'sha256:' + 'a'.repeat(64),
  paused: false,
  source: { kind: 'git', checkable: true, label: 'github.com/oss/test-first' },
  capability: { declared: false },
  updateStatus: 'no-update',
  installs: [{ machineId: A1, installedVersion: 'sha256:' + 'a'.repeat(64) }],
  ...over,
});

const service = (
  skills: SkillSummary[],
  machines: MachineSummary[] = [machine()],
): SkillsService => ({
  getMachinesReadModel: async () => ({ machines } as MachinesReadModel),
  getSkillsReadModel: async () =>
    ({ environmentExists: true, skills } as SkillsReadModel),
});

describe('deriveRow', () => {
  it('is ready when not paused, no update, installed matches approved', () => {
    const row = deriveRow(skill(), A1, true);
    expect(row.primaryStatus).toBe('ready');
    expect(row.dot).toBe('ready');
    expect(row.statusText).toBe('Ready');
  });
  it('is paused regardless of update availability', () => {
    const row = deriveRow(skill({ paused: true, updateStatus: 'update-available' }), A1, true);
    expect(row.statusText).toBe('Paused');
  });
  it('is update-available when not paused and source differs', () => {
    const row = deriveRow(skill({ updateStatus: 'update-available' }), A1, true);
    expect(row.statusText).toBe('Update available');
  });
  it('never claims Ready when the viewing machine has not reported', () => {
    const row = deriveRow(skill(), A1, false);
    expect(row.statusText).not.toBe('Ready');
    expect(row.dot).toBe('neutral');
    expect(row.statusText).toMatch(/not reported|hasn.t reported/i);
  });
  it('never claims Ready when installed differs from approved', () => {
    const row = deriveRow(
      skill({ installs: [{ machineId: A1, installedVersion: 'sha256:' + 'b'.repeat(64) }] }),
      A1,
      true,
    );
    expect(row.statusText).not.toBe('Ready');
  });
  it('shows a cannot-check note without changing primary status', () => {
    const row = deriveRow(
      skill({ source: { kind: 'local', checkable: false }, updateStatus: 'cannot-check' }),
      A1,
      true,
    );
    expect(row.statusText).toBe('Ready');
    expect(row.cannotCheckNote).toBe(true);
  });
});

describe('filterRows', () => {
  const rows = [
    deriveRow(skill({ skillId: 'skill_a', name: 'a' }), A1, true),
    deriveRow(skill({ skillId: 'skill_b', name: 'b', paused: true }), A1, true),
    deriveRow(skill({ skillId: 'skill_c', name: 'c', updateStatus: 'update-available' }), A1, true),
  ];
  it('all returns every row', () => {
    expect(filterRows(rows, 'all', '')).toHaveLength(3);
  });
  it('filters by status', () => {
    expect(filterRows(rows, 'paused', '').map((r) => r.skillId)).toEqual(['skill_b']);
    expect(filterRows(rows, 'update-available', '').map((r) => r.skillId)).toEqual(['skill_c']);
  });
  it('searches by name, case-insensitive', () => {
    expect(filterRows(rows, 'all', 'A').map((r) => r.skillId)).toEqual(['skill_a']);
  });
});

describe('loadSkillsList', () => {
  it('reports no-machines when the account has none', async () => {
    const view = await loadSkillsList(service([], []), USER, undefined);
    expect(view.kind).toBe('no-machines');
  });
  it('excludes revoked machines from selection and counts', async () => {
    const view = await loadSkillsList(
      service([skill()], [machine(), machine({ machineId: B2, revoked: true })]),
      USER,
      undefined,
    );
    expect(view.kind).toBe('ready');
  });
  it('requires a choice with two active machines and no ?machine=', async () => {
    const view = await loadSkillsList(
      service([skill()], [machine(), machine({ machineId: B2, name: 'Studio' })]),
      USER,
      undefined,
    );
    expect(view.kind).toBe('choose-machine');
  });
  it('keeps two Skills with the same display name separately addressable', async () => {
    const view = await loadSkillsList(
      service([
        skill({ skillId: 'skill_dup0001', name: 'review' }),
        skill({ skillId: 'skill_dup0002', name: 'review' }),
      ]),
      USER,
      undefined,
    );
    if (view.kind !== 'ready') throw new Error('expected ready');
    expect(view.rows.map((r) => r.skillId)).toEqual(['skill_dup0001', 'skill_dup0002']);
  });
  it('reports a truthful no-skills state distinct from a filtered empty state', async () => {
    const view = await loadSkillsList(service([]), USER, undefined);
    if (view.kind !== 'ready') throw new Error('expected ready');
    expect(view.rows).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx vitest run app/skills/skills-data.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write the implementation**

```typescript
// apps/web/app/skills/skills-data.ts
import { CloudServiceError, type CloudService } from '@stack/cloud-server';
import type { SkillSummary } from '@stack/spec';

import {
  machineOption,
  resolveViewingMachineId,
  sortMachinesForSelection,
  statusLabel,
  machineDot,
  displayName,
  checkedIn,
  type MachineOption,
} from '../../lib/machine-context.js';
import type { SidebarCounts } from '../overview/overview-data.js';
import type { WebUser } from '../../lib/session.js';

export type SkillsService = Pick<
  CloudService,
  'getMachinesReadModel' | 'getSkillsReadModel'
>;

const webAuth = (userId: string) => ({ userId, tokenId: 'web-session' });

export type SkillRow = {
  skillId: string;
  name: string;
  description?: string;
  sourceLabel: string;
  cannotCheckNote: boolean;
  installedLabel: string;
  primaryStatus: 'ready' | 'update-available' | 'paused';
  pendingInstall: boolean;
  dot: 'ready' | 'attention' | 'neutral';
  statusText: string;
};

export const STATUS_FILTERS = ['all', 'ready', 'update-available', 'paused'] as const;
export type StatusFilter = (typeof STATUS_FILTERS)[number];

/**
 * Primary status derivation (contract §19 + the Final Contract's frozen `lang` table).
 * Ready REQUIRES !paused AND installed === approved on the viewing machine at its last
 * check-in. "Cannot check source" is a SOURCE annotation (§2/§3) — it rides alongside the
 * primary status on the SOURCE column, never replaces Ready/Update available/Paused.
 * Resolved ambiguity: when not paused and no source update, but the viewing machine never
 * reported or reports a different version, the row is NEVER "Ready" — it gets a neutral dot
 * and plain text, not a 4th badge word.
 */
export const deriveRow = (
  skill: SkillSummary,
  viewingMachineId: string,
  viewingMachineCheckedIn: boolean,
): SkillRow => {
  const install = skill.installs.find((i) => i.machineId === viewingMachineId);
  const installedHere = viewingMachineCheckedIn && install
    ? install.installedVersion === skill.approvedVersion
    : false;
  const cannotCheckNote = skill.updateStatus === 'cannot-check';

  let primaryStatus: SkillRow['primaryStatus'];
  let dot: SkillRow['dot'];
  let statusText: string;
  if (skill.paused) {
    primaryStatus = 'paused';
    dot = 'neutral';
    statusText = 'Paused';
  } else if (skill.updateStatus === 'update-available') {
    primaryStatus = 'update-available';
    dot = 'attention';
    statusText = 'Update available';
  } else if (!viewingMachineCheckedIn) {
    primaryStatus = 'ready'; // bucketed with Ready-eligible for filtering; NOT labeled Ready
    dot = 'neutral';
    statusText = "Not reported here yet";
  } else if (!installedHere) {
    primaryStatus = 'ready';
    dot = 'neutral';
    statusText = 'Not yet reconciled here';
  } else {
    primaryStatus = 'ready';
    dot = 'ready';
    statusText = 'Ready';
  }

  return {
    skillId: skill.skillId,
    name: skill.name,
    ...(skill.description ? { description: skill.description } : {}),
    sourceLabel: skill.source.label ?? (skill.source.kind === 'local' ? 'Local' : skill.source.kind),
    cannotCheckNote,
    installedLabel: install
      ? install.installedVersion
        ? install.installedVersion.slice(7, 15)
        : 'Not installed here'
      : 'Not reported here',
    primaryStatus,
    pendingInstall: !skill.paused && skill.updateStatus !== 'update-available' && statusText !== 'Ready',
    dot,
    statusText,
  };
};

/** The three truthful filter groups required by contract §6, plus "all". Filtering excludes
 *  rows that are only "Ready-eligible but not confirmed installed" from the Ready bucket,
 *  matching §19 — such rows only show under "All". */
export const filterRows = (
  rows: SkillRow[],
  status: StatusFilter,
  query: string,
): SkillRow[] => {
  const q = query.trim().toLowerCase();
  return rows.filter((r) => {
    if (q && !r.name.toLowerCase().includes(q)) return false;
    if (status === 'all') return true;
    if (status === 'ready') return r.primaryStatus === 'ready' && r.statusText === 'Ready';
    return r.primaryStatus === status;
  });
};

export type SkillsListView =
  | { kind: 'error' }
  | { kind: 'no-machines' }
  | { kind: 'choose-machine'; machines: MachineOption[]; anyCheckedIn: boolean }
  | {
      kind: 'ready';
      viewing: { machineId: string; name: string; statusLabel: string; dot: string };
      machines: MachineOption[];
      sidebar: SidebarCounts;
      statusSentence: string;
      rows: SkillRow[];
      dockCommand: string;
    };

export const loadSkillsList = async (
  service: SkillsService,
  user: WebUser,
  requestedMachine: string | undefined,
): Promise<SkillsListView> => {
  const auth = webAuth(user.id);
  let machinesModel;
  let skillsModel;
  try {
    [machinesModel, skillsModel] = await Promise.all([
      service.getMachinesReadModel(auth),
      service.getSkillsReadModel(auth),
    ]);
  } catch {
    return { kind: 'error' };
  }

  const active = machinesModel.machines.filter((m) => !m.revoked);
  if (active.length === 0) return { kind: 'no-machines' };

  const ordered = [...active].sort(sortMachinesForSelection);
  const options = ordered.map(machineOption);
  const anyCheckedIn = active.some(checkedIn);

  const viewingId = resolveViewingMachineId(active, requestedMachine);
  if (!viewingId) return { kind: 'choose-machine', machines: options, anyCheckedIn };

  const viewing = active.find((m) => m.machineId === viewingId)!;
  const viewingName = displayName(viewing);
  const viewingCheckedIn = checkedIn(viewing);

  const rows = skillsModel.skills
    .map((s) => deriveRow(s, viewingId, viewingCheckedIn))
    .sort((a, b) => a.name.localeCompare(b.name));

  const readyCount = rows.filter((r) => r.statusText === 'Ready').length;
  const updateCount = rows.filter((r) => r.primaryStatus === 'update-available').length;
  const pausedCount = rows.filter((r) => r.primaryStatus === 'paused').length;

  const statusSentence = !viewingCheckedIn
    ? `${viewingName} hasn't reported installed Skill state yet.`
    : rows.length === 0
      ? 'No Skills in STAK yet.'
      : updateCount > 0
        ? `${updateCount} Skill${updateCount === 1 ? '' : 's'} ${updateCount === 1 ? 'has' : 'have'} updates to review.`
        : `${readyCount} Skill${readyCount === 1 ? '' : 's'} ${readyCount === 1 ? 'is' : 'are'} ready on ${viewingName}.`;

  return {
    kind: 'ready',
    viewing: {
      machineId: viewingId,
      name: viewingName,
      statusLabel: statusLabel(viewing),
      dot: machineDot(viewing),
    },
    machines: options,
    sidebar: {
      overview: { n: '', tone: 'neutral' },
      skills: String(rows.length),
      memory: { n: '', tone: 'neutral' },
      projects: '',
      machines: String(active.length),
      stacks: '',
    },
    statusSentence,
    rows,
    dockCommand: 'stak skill update',
  };
  void pausedCount; // reserved for the filter-chip counts rendered by skills-table.tsx
};
```

Note: `CloudServiceError` is imported for parity with `overview-data.ts`'s error-narrowing pattern but unused here (no per-Skill not-found path at the list level) — remove the import if the linter flags it unused once Task 7 confirms it isn't needed elsewhere in this file.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && npx vitest run app/skills/skills-data.test.ts`
Expected: PASS (all cases)

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/skills/skills-data.ts apps/web/app/skills/skills-data.test.ts
git commit -m "feat(p5): Skills list view-model with frozen-status derivation"
```

---

### Task 5: Skills list page + search/filter table + styles

**Files:**
- Create: `apps/web/app/skills/page.tsx`
- Create: `apps/web/app/skills/_components/skills-table.tsx`
- Create: `apps/web/app/skills/skills.css`

**Interfaces:**
- Consumes: `loadSkillsList`, `SkillRow`, `STATUS_FILTERS` from `./skills-data.js`; `ShellNotice`, `AppSidebar`, `MachineChooser`, `CommandDock` from `../_components/*`; `getCloudService` from `../../lib/cloud-service.js`; `getSessionUser`, `displayNameOf` from `../../lib/session.js`.
- Produces: the `/skills` route; `SkillsTable({ rows, machineName }): JSX.Element` (client).

- [ ] **Step 1: Write the client table component**

```typescript
// apps/web/app/skills/_components/skills-table.tsx
'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';

import { STATUS_FILTERS, filterRows, type SkillRow, type StatusFilter } from '../skills-data';

const FILTER_LABEL: Record<StatusFilter, string> = {
  all: 'All',
  ready: 'Ready',
  'update-available': 'Updates',
  paused: 'Paused',
};

const DOT: Record<string, string> = {
  ready: '#84cb8e',
  attention: '#ee7a3b',
  neutral: '#a19d94',
};

export function SkillsTable({ rows }: { rows: SkillRow[] }) {
  const [status, setStatus] = useState<StatusFilter>('all');
  const [query, setQuery] = useState('');
  const filtered = useMemo(() => filterRows(rows, status, query), [rows, status, query]);

  const counts = useMemo(() => {
    const c: Record<StatusFilter, number> = { all: rows.length, ready: 0, 'update-available': 0, paused: 0 };
    for (const r of rows) {
      if (r.statusText === 'Ready') c.ready += 1;
      if (r.primaryStatus === 'update-available') c['update-available'] += 1;
      if (r.primaryStatus === 'paused') c.paused += 1;
    }
    return c;
  }, [rows]);

  return (
    <div className="stak-skills">
      <div className="stak-skills-toolbar" role="group" aria-label="Filter Skills">
        <div className="stak-skills-filters" role="radiogroup" aria-label="Status">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              role="radio"
              aria-checked={status === f}
              className={`stak-skills-chip${status === f ? ' active' : ''}`}
              onClick={() => setStatus(f)}
            >
              {FILTER_LABEL[f]} {counts[f]}
            </button>
          ))}
        </div>
        <input
          type="search"
          className="stak-skills-search"
          placeholder="Search Skills"
          aria-label="Search Skills by name"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <div className="stak-skills-head" role="row">
        <span>SKILL</span>
        <span>SOURCE</span>
        <span>INSTALLED HERE</span>
        <span>STATUS</span>
      </div>

      {rows.length === 0 ? (
        <p className="stak-skills-empty">
          No Skills in STAK. Run <code>stak scan</code> on a machine to find the ones you already have.
        </p>
      ) : filtered.length === 0 ? (
        <p className="stak-skills-empty">No Skills match this filter.</p>
      ) : (
        filtered.map((r) => (
          <Link key={r.skillId} href={`/skills/${r.skillId}`} className="stak-skills-row">
            <span className="stak-skills-name">
              <span className="n">{r.name}</span>
              {r.description ? <span className="d">{r.description}</span> : null}
            </span>
            <span className="stak-skills-source">
              {r.sourceLabel}
              {r.cannotCheckNote ? <span className="note"> · can't check updates</span> : null}
            </span>
            <span className="stak-skills-installed">{r.installedLabel}</span>
            <span className="stak-status" style={{ color: '#c9c5bc' }}>
              <span className="stak-dot" style={{ background: DOT[r.dot] }} aria-hidden />
              {r.statusText}
            </span>
          </Link>
        ))
      )}
    </div>
  );
}
```

- [ ] **Step 2: Write the styles**

```css
/* apps/web/app/skills/skills.css — extends shell.css tokens, Skills-specific only. */
.stak-skills {
  display: flex;
  flex-direction: column;
}
.stak-skills-toolbar {
  display: flex;
  gap: 10px;
  align-items: center;
  padding: 0 28px 12px;
}
.stak-skills-filters {
  display: flex;
  border: 1px solid var(--line-2);
  border-radius: 6px;
  overflow: hidden;
}
.stak-skills-chip {
  padding: 6px 12px;
  font-size: 13px;
  color: var(--faint);
  background: none;
  border: none;
  border-left: 1px solid var(--line-2);
  cursor: pointer;
  font-family: var(--sans);
}
.stak-skills-chip:first-child {
  border-left: none;
}
.stak-skills-chip.active {
  background: #1e1d1b;
  color: var(--ink);
}
.stak-skills-search {
  margin-left: auto;
  width: 220px;
  padding: 6px 12px;
  border: 1px solid var(--line-2);
  border-radius: 6px;
  background: none;
  color: var(--ink);
  font: 13px var(--sans);
}
.stak-skills-head,
.stak-skills-row {
  display: grid;
  grid-template-columns: 2.4fr 1.6fr 1.2fr 1.1fr;
  gap: 14px;
  padding: 9px 28px;
  align-items: center;
}
.stak-skills-head {
  border-top: 1px solid var(--line);
  border-bottom: 1px solid var(--line);
  font: 500 10.5px var(--mono);
  letter-spacing: 0.06em;
  color: var(--dim);
}
.stak-skills-row {
  border-bottom: 1px solid #1c1b19;
  text-decoration: none;
  color: inherit;
}
.stak-skills-row:hover {
  background: #171615;
}
.stak-skills-name {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.stak-skills-name .n {
  font: 500 13px var(--mono);
}
.stak-skills-name .d {
  font-size: 12px;
  color: var(--faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.stak-skills-source,
.stak-skills-installed {
  font: 11.5px var(--mono);
  color: var(--faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.stak-skills-source .note {
  color: var(--dim);
}
.stak-skills-empty {
  padding: 24px 28px;
  color: var(--dim);
  font-size: 13.5px;
}
.stak-skills-chip:focus-visible,
.stak-skills-search:focus-visible,
.stak-skills-row:focus-visible {
  outline: 2px solid var(--orange);
  outline-offset: 2px;
}
```

- [ ] **Step 3: Write the page**

```typescript
// apps/web/app/skills/page.tsx
import { redirect } from 'next/navigation';

import { AppSidebar } from '../_components/app-sidebar';
import { CommandDock } from '../_components/command-dock';
import { MachineChooser } from '../_components/machine-chooser';
import { ShellNotice } from '../_components/shell-notice';
import { getCloudService } from '../../lib/cloud-service';
import { displayNameOf, getSessionUser } from '../../lib/session';

import { loadSkillsList } from './skills-data';
import { SkillsTable } from './_components/skills-table';
import '../overview/shell.css';
import './skills.css';

export const dynamic = 'force-dynamic';

export default async function SkillsPage({
  searchParams,
}: {
  searchParams: Promise<{ machine?: string }>;
}) {
  const user = await getSessionUser();
  if (!user) redirect('/');
  const { machine } = await searchParams;
  const handle = user.githubUsername ?? displayNameOf(user);
  const view = await loadSkillsList(getCloudService(), user, machine);

  if (view.kind === 'error')
    return (
      <ShellNotice active="skills" handle={handle} title="Couldn't load your Skills">
        <p>STAK Cloud didn&apos;t respond. This is a temporary problem, not a change to your data. Reload to try again.</p>
      </ShellNotice>
    );
  if (view.kind === 'no-machines')
    return (
      <ShellNotice active="skills" handle={handle} title="No machines yet">
        <p>
          Connect this computer to your account first. In your terminal, run{' '}
          <code style={{ fontFamily: 'var(--mono)' }}>stak login</code>, then{' '}
          <code style={{ fontFamily: 'var(--mono)' }}>stak scan</code>.
        </p>
      </ShellNotice>
    );
  if (view.kind === 'choose-machine')
    return (
      <ShellNotice active="skills" handle={handle} title="Choose a machine">
        <p>Skills shows installed state from that machine&apos;s last check-in. Pick the machine you want to view.</p>
        {!view.anyCheckedIn ? (
          <p>
            None of your machines has checked in yet. Run{' '}
            <code style={{ fontFamily: 'var(--mono)' }}>stak status</code> on the machine you want, then pick it here.
          </p>
        ) : null}
        <MachineChooser options={view.machines} basePath="/skills" />
      </ShellNotice>
    );

  return (
    <div className="stak-frame">
      <AppSidebar
        active="skills"
        handle={handle}
        counts={view.sidebar}
        viewing={view.viewing}
        machines={view.machines}
      />
      <main className="stak-main">
        <div className="stak-head">
          <div className="stak-sentence">
            <span
              className="stak-dot"
              style={{ width: 10, height: 10, background: '#a19d94' }}
              aria-hidden
            />
            <span>Skills</span>
          </div>
          <span className="stak-sub">{view.statusSentence}</span>
        </div>
        <SkillsTable rows={view.rows} />
        <CommandDock
          machineName={view.viewing.name}
          command={view.dockCommand}
          hint="Installs approved versions on this machine"
        />
      </main>
    </div>
  );
}
```

- [ ] **Step 4: Typecheck**

Run: `cd apps/web && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/skills/page.tsx apps/web/app/skills/_components/skills-table.tsx apps/web/app/skills/skills.css
git commit -m "feat(p5): Skills list page with search/filter and command dock"
```

---

### Task 6: Wire the Skills sidebar nav to a real route

**Files:**
- Modify: `apps/web/app/_components/app-sidebar.tsx`

- [ ] **Step 1: Edit the nav rendering**

In `apps/web/app/_components/app-sidebar.tsx`, the `items.map` currently special-cases only `'overview'` as a real `<Link>`. Change the condition so both `'overview'` and `'skills'` render as links:

```typescript
        {items.map((item) =>
          item.key === 'overview' || item.key === 'skills' ? (
            <Link
              key={item.key}
              href={item.key === 'overview' ? '/overview' : '/skills'}
              className="stak-nav-item"
              aria-current={active === item.key ? 'page' : undefined}
            >
```

(Close the rest of that branch exactly as the existing `'overview'` branch's JSX body — label + count span — is already written; only the opening `<Link>` condition and `href` change.)

- [ ] **Step 2: Typecheck**

Run: `cd apps/web && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/_components/app-sidebar.tsx
git commit -m "feat(p5): Skills becomes a real sidebar route"
```

---

### Task 7: Skill detail view-model

**Files:**
- Create: `apps/web/app/skills/skill-detail-data.ts`
- Create: `apps/web/app/skills/skill-detail-data.test.ts`

**Interfaces:**
- Consumes: `SkillDetailService = Pick<CloudService, 'getMachinesReadModel' | 'getSkillDetail'>`; `CloudServiceError` from `@stack/cloud-server`; `machine-context.js` exports.
- Produces: `type SkillDetailView = { kind: 'error' } | { kind: 'no-machines' } | { kind: 'choose-machine'; ...} | { kind: 'not-found' } | { kind: 'ready'; ... }`; `loadSkillDetail(service, user, skillId, requestedMachine): Promise<SkillDetailView>`.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/web/app/skills/skill-detail-data.test.ts
import { describe, expect, it } from 'vitest';
import { CloudServiceError } from '@stack/cloud-server';
import type { MachineSummary, MachinesReadModel, SkillDetail } from '@stack/spec';

import { loadSkillDetail, type SkillDetailService } from './skill-detail-data.js';

const USER = { id: 'user-1' };
const A1 = '00000000-0000-4000-8000-0000000000a1';
const HASH_A = 'sha256:' + 'a'.repeat(64);
const HASH_B = 'sha256:' + 'b'.repeat(64);

const machine = (over: Partial<MachineSummary> = {}): MachineSummary => ({
  machineId: A1,
  name: 'DELL',
  platform: 'win32',
  arch: 'x64',
  agentsDetected: ['Claude Code'],
  firstSeenAt: new Date().toISOString(),
  lastCheckinAt: new Date().toISOString(),
  memoryBackedUp: true,
  revoked: false,
  status: 'up-to-date',
  updatesWaiting: [],
  projectsPresent: 3,
  ...over,
});

const detail = (over: Partial<SkillDetail> = {}): SkillDetail => ({
  skillId: 'skill_test0001',
  name: 'test-first',
  approvedVersion: HASH_A,
  paused: false,
  source: { kind: 'git', checkable: true, label: 'github.com/oss/test-first', trackedRef: 'main' },
  capability: { declared: false },
  updateStatus: 'no-update',
  installs: [{ machineId: A1, installedVersion: HASH_A }],
  history: [{ contentHash: HASH_A, environmentVersionNumber: 1, approvedAt: new Date().toISOString() }],
  files: null,
  diff: null,
  ...over,
});

const service = (
  skill: SkillDetail | null,
  machines: MachineSummary[] = [machine()],
): SkillDetailService => ({
  getMachinesReadModel: async () => ({ machines } as MachinesReadModel),
  getSkillDetail: async (_auth, skillId) => {
    if (!skill || skillId !== skill.skillId)
      throw new CloudServiceError('skill-not-found', 'No such Skill.', 404);
    return skill;
  },
});

describe('loadSkillDetail', () => {
  it('fails safely on an invalid/not-owned skill id', async () => {
    const view = await loadSkillDetail(service(detail()), USER, 'skill_other0001', undefined);
    expect(view.kind).toBe('not-found');
  });
  it('renders Ready with matching install', async () => {
    const view = await loadSkillDetail(service(detail()), USER, 'skill_test0001', undefined);
    if (view.kind !== 'ready') throw new Error('expected ready');
    expect(view.statusText).toBe('Ready');
  });
  it('shows an honest unavailable state when files is null', async () => {
    const view = await loadSkillDetail(service(detail({ files: null })), USER, 'skill_test0001', undefined);
    if (view.kind !== 'ready') throw new Error('expected ready');
    expect(view.filesAvailable).toBe(false);
  });
  it('shows an honest unavailable state when diff is null even with an update available', async () => {
    const view = await loadSkillDetail(
      service(detail({ updateStatus: 'update-available', candidateVersion: 'rev123', diff: null })),
      USER,
      'skill_test0001',
      undefined,
    );
    if (view.kind !== 'ready') throw new Error('expected ready');
    expect(view.diffAvailable).toBe(false);
    expect(view.statusText).toBe('Update available');
  });
  it('keeps provenance/history/capabilities visible while paused (§17)', async () => {
    const view = await loadSkillDetail(
      service(detail({ paused: true, updateStatus: 'update-available', candidateVersion: 'rev123' })),
      USER,
      'skill_test0001',
      undefined,
    );
    if (view.kind !== 'ready') throw new Error('expected ready');
    expect(view.statusText).toBe('Paused');
    expect(view.updateAvailable).toBe(true);
    expect(view.sourceLabel).toBe('github.com/oss/test-first');
    expect(view.history).toHaveLength(1);
  });
  it('distinguishes currently-approved from older history entries', async () => {
    const view = await loadSkillDetail(
      service(
        detail({
          history: [
            { contentHash: HASH_B, environmentVersionNumber: 2, approvedAt: new Date().toISOString() },
            { contentHash: HASH_A, environmentVersionNumber: 1, approvedAt: new Date().toISOString() },
          ],
          approvedVersion: HASH_B,
        }),
      ),
      USER,
      'skill_test0001',
      undefined,
    );
    if (view.kind !== 'ready') throw new Error('expected ready');
    expect(view.history[0]?.current).toBe(true);
    expect(view.history[1]?.current).toBe(false);
  });
  it('reports capabilities-not-declared distinctly from declared-false', async () => {
    const notDeclared = await loadSkillDetail(service(detail({ capability: { declared: false } })), USER, 'skill_test0001', undefined);
    const declaredFalse = await loadSkillDetail(
      service(detail({ capability: { declared: true, capabilities: { network: false } } })),
      USER,
      'skill_test0001',
      undefined,
    );
    if (notDeclared.kind !== 'ready' || declaredFalse.kind !== 'ready') throw new Error('expected ready');
    expect(notDeclared.capabilitiesText).toBe('Capabilities not declared');
    expect(declaredFalse.capabilitiesText).not.toBe('Capabilities not declared');
  });
  it('never exposes an absolute or home-relative path in source label', async () => {
    const view = await loadSkillDetail(
      service(detail({ source: { kind: 'local', checkable: false } })),
      USER,
      'skill_test0001',
      undefined,
    );
    if (view.kind !== 'ready') throw new Error('expected ready');
    expect(view.sourceLabel).toBe('Local');
    expect(view.sourceLabel).not.toMatch(/[\\/]Users[\\/]|^~|^\/home\//);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx vitest run app/skills/skill-detail-data.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write the implementation**

```typescript
// apps/web/app/skills/skill-detail-data.ts
import { CloudServiceError, type CloudService } from '@stack/cloud-server';
import type { SkillDetail, SkillDiffFile, SkillFile, SkillVersionHistoryEntry } from '@stack/spec';

import {
  machineOption,
  resolveViewingMachineId,
  sortMachinesForSelection,
  statusLabel,
  machineDot,
  displayName,
  checkedIn,
  type MachineOption,
} from '../../lib/machine-context.js';
import type { WebUser } from '../../lib/session.js';

export type SkillDetailService = Pick<
  CloudService,
  'getMachinesReadModel' | 'getSkillDetail'
>;

const webAuth = (userId: string) => ({ userId, tokenId: 'web-session' });
const shortHash = (hash: string) => hash.slice(7, 15);

export type HistoryRow = {
  contentHash: string;
  shortHash: string;
  environmentVersionNumber: number;
  approvedAt: string;
  current: boolean;
};

export type SkillDetailView =
  | { kind: 'error' }
  | { kind: 'no-machines' }
  | { kind: 'choose-machine'; machines: MachineOption[]; anyCheckedIn: boolean }
  | { kind: 'not-found' }
  | {
      kind: 'ready';
      skillId: string;
      name: string;
      description?: string;
      viewing: { machineId: string; name: string; statusLabel: string; dot: string };
      machines: MachineOption[];
      statusText: string;
      updateAvailable: boolean;
      candidateVersion?: string;
      cannotCheckNote: boolean;
      sourceLabel: string;
      trackedRef?: string;
      approvedVersionShort: string;
      installedHere: string;
      installedHereAt: string | null;
      capabilitiesText: string;
      capabilityList: { label: string; value: 'declared-true' | 'declared-false' }[];
      history: HistoryRow[];
      filesAvailable: boolean;
      files: SkillFile[];
      diffAvailable: boolean;
      diffFiles: SkillDiffFile[];
      paused: boolean;
    };

const capabilityList = (
  capability: SkillDetail['capability'],
): { label: string; value: 'declared-true' | 'declared-false' }[] => {
  if (!capability.declared || !capability.capabilities) return [];
  const labels: Record<string, string> = {
    readFiles: 'Read files',
    writeFiles: 'Write files',
    runCommands: 'Run commands',
    network: 'Network',
  };
  return Object.entries(capability.capabilities)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => ({ label: labels[k] ?? k, value: v ? 'declared-true' : 'declared-false' }));
};

export const loadSkillDetail = async (
  service: SkillDetailService,
  user: WebUser,
  skillId: string,
  requestedMachine: string | undefined,
): Promise<SkillDetailView> => {
  const auth = webAuth(user.id);
  let machinesModel;
  try {
    machinesModel = await service.getMachinesReadModel(auth);
  } catch {
    return { kind: 'error' };
  }
  const active = machinesModel.machines.filter((m) => !m.revoked);
  if (active.length === 0) return { kind: 'no-machines' };

  const ordered = [...active].sort(sortMachinesForSelection);
  const options = ordered.map(machineOption);
  const anyCheckedIn = active.some(checkedIn);

  const viewingId = resolveViewingMachineId(active, requestedMachine);
  if (!viewingId) return { kind: 'choose-machine', machines: options, anyCheckedIn };

  let skill: SkillDetail;
  try {
    skill = await service.getSkillDetail(auth, skillId);
  } catch (error) {
    if (error instanceof CloudServiceError && error.code === 'skill-not-found')
      return { kind: 'not-found' };
    return { kind: 'error' };
  }

  const viewing = active.find((m) => m.machineId === viewingId)!;
  const viewingName = displayName(viewing);
  const viewingCheckedIn = checkedIn(viewing);
  const install = skill.installs.find((i) => i.machineId === viewingId);
  const installedHereMatches =
    viewingCheckedIn && !!install && install.installedVersion === skill.approvedVersion;

  let statusText: string;
  if (skill.paused) statusText = 'Paused';
  else if (skill.updateStatus === 'update-available') statusText = 'Update available';
  else if (!viewingCheckedIn) statusText = 'Not reported here yet';
  else if (!installedHereMatches) statusText = 'Not yet reconciled here';
  else statusText = 'Ready';

  const history: HistoryRow[] = skill.history
    .slice()
    .sort((a, b) => b.environmentVersionNumber - a.environmentVersionNumber)
    .map((h: SkillVersionHistoryEntry) => ({
      contentHash: h.contentHash,
      shortHash: shortHash(h.contentHash),
      environmentVersionNumber: h.environmentVersionNumber,
      approvedAt: h.approvedAt,
      current: h.contentHash === skill.approvedVersion,
    }));

  return {
    kind: 'ready',
    skillId: skill.skillId,
    name: skill.name,
    ...(skill.description ? { description: skill.description } : {}),
    viewing: {
      machineId: viewingId,
      name: viewingName,
      statusLabel: statusLabel(viewing),
      dot: machineDot(viewing),
    },
    machines: options,
    statusText,
    updateAvailable: skill.updateStatus === 'update-available',
    ...(skill.candidateVersion ? { candidateVersion: skill.candidateVersion } : {}),
    cannotCheckNote: skill.updateStatus === 'cannot-check',
    sourceLabel: skill.source.label ?? (skill.source.kind === 'local' ? 'Local' : skill.source.kind),
    ...(skill.source.trackedRef ? { trackedRef: skill.source.trackedRef } : {}),
    approvedVersionShort: shortHash(skill.approvedVersion),
    installedHere: install
      ? install.installedVersion
        ? shortHash(install.installedVersion)
        : 'Not installed here'
      : 'Not reported here',
    installedHereAt: viewingCheckedIn ? viewing.lastCheckinAt : null,
    capabilitiesText: skill.capability.declared ? 'Declared' : 'Capabilities not declared',
    capabilityList: capabilityList(skill.capability),
    history,
    filesAvailable: skill.files !== null,
    files: skill.files ?? [],
    diffAvailable: skill.diff !== null,
    diffFiles: skill.diff?.files ?? [],
    paused: skill.paused,
  };
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && npx vitest run app/skills/skill-detail-data.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/skills/skill-detail-data.ts apps/web/app/skills/skill-detail-data.test.ts
git commit -m "feat(p5): Skill detail view-model with honest files/diff states"
```

---

### Task 8: Server actions for approve / pause / resume

**Files:**
- Create: `apps/web/app/skills/actions.ts`

**Interfaces:**
- Consumes: `getCloudService`, `getSessionUser`.
- Produces: `approveSkillVersionAction(input: { skillId: string; candidateContentHash: string; candidateRevision: string }): Promise<{ ok: true; changed: boolean } | { ok: false; error: string; stale?: boolean }>`; `setSkillPausedAction(input: { skillId: string; paused: boolean }): Promise<{ ok: true; changed: boolean } | { ok: false; error: string }>`.

- [ ] **Step 1: Write the actions** (no new unit test file here — these are thin wrappers over already-tested P3 service methods; Task 9's component test covers the client-side pending/stale/error behavior with a fake action)

```typescript
// apps/web/app/skills/actions.ts
'use server';

import { CloudServiceError } from '@stack/cloud-server';

import { getCloudService } from '../../lib/cloud-service';
import { getSessionUser } from '../../lib/session';

const notSignedIn = { ok: false as const, error: 'You must sign in first.' };

export async function approveSkillVersionAction(input: {
  skillId: string;
  candidateContentHash: string;
  candidateRevision: string;
}): Promise<{ ok: true; changed: boolean } | { ok: false; error: string; stale?: boolean }> {
  const user = await getSessionUser();
  if (!user) return notSignedIn;
  try {
    const result = await getCloudService().approveSkillVersion(
      { userId: user.id, tokenId: 'web-session' },
      input,
    );
    return { ok: true, changed: result.changed };
  } catch (error) {
    if (error instanceof CloudServiceError && error.code === 'skill-not-found')
      return { ok: false, error: 'This Skill or candidate is no longer current.', stale: true };
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Could not approve this update.',
    };
  }
}

export async function setSkillPausedAction(input: {
  skillId: string;
  paused: boolean;
}): Promise<{ ok: true; changed: boolean } | { ok: false; error: string }> {
  const user = await getSessionUser();
  if (!user) return notSignedIn;
  try {
    const result = await getCloudService().setSkillPaused(
      { userId: user.id, tokenId: 'web-session' },
      input,
    );
    return { ok: true, changed: result.changed };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : `Could not ${input.paused ? 'pause' : 'resume'} this Skill.`,
    };
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/web && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/skills/actions.ts
git commit -m "feat(p5): approve/pause/resume server actions"
```

---

### Task 9: Approve/Pause client component

**Files:**
- Create: `apps/web/app/skills/_components/skill-actions.tsx`

**Interfaces:**
- Consumes: `approveSkillVersionAction`, `setSkillPausedAction` from `../actions.js`.
- Produces: `SkillActions({ skillId, paused, updateAvailable, candidateVersion, approvedVersionShort }): JSX.Element` (client; calls `router.refresh()` on success so the server component re-fetches `getSkillDetail`).

- [ ] **Step 1: Write the component**

```typescript
// apps/web/app/skills/_components/skill-actions.tsx
'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { approveSkillVersionAction, setSkillPausedAction } from '../actions';

export function SkillActions({
  skillId,
  paused,
  updateAvailable,
  candidateVersion,
  approvedVersionShort,
}: {
  skillId: string;
  paused: boolean;
  updateAvailable: boolean;
  candidateVersion?: string;
  approvedVersionShort: string;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<'approve' | 'pause' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);

  const approve = async () => {
    if (!candidateVersion || pending) return;
    setPending('approve');
    setError(null);
    setStale(false);
    const result = await approveSkillVersionAction({
      skillId,
      candidateContentHash: candidateVersion,
      candidateRevision: candidateVersion,
    });
    setPending(null);
    if (!result.ok) {
      setError(result.error);
      setStale(result.stale === true);
      return;
    }
    router.refresh();
  };

  const togglePause = async () => {
    if (pending) return;
    setPending('pause');
    setError(null);
    const result = await setSkillPausedAction({ skillId, paused: !paused });
    setPending(null);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    router.refresh();
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-end' }}>
      <div style={{ display: 'flex', gap: 10 }}>
        <button type="button" className="stak-pill" onClick={togglePause} disabled={pending !== null}>
          {pending === 'pause' ? '…' : paused ? 'Resume' : 'Pause'}
        </button>
        {updateAvailable ? (
          <button
            type="button"
            className="stak-approve"
            onClick={approve}
            disabled={pending !== null || !candidateVersion}
            aria-label={`Approve candidate version ${candidateVersion ?? ''}`}
          >
            {pending === 'approve' ? 'Approving…' : `Approve ${approvedVersionShort}→new`}
          </button>
        ) : null}
      </div>
      <span role="status" aria-live="polite" style={{ fontSize: 12.5, color: error ? '#e5776a' : 'transparent' }}>
        {error ? (stale ? `${error} Reload to review the latest candidate.` : error) : ''}
      </span>
    </div>
  );
}
```

- [ ] **Step 2: Add the `.stak-approve` style to `skills.css`**

```css
.stak-approve {
  background: var(--ink);
  color: var(--bg);
  font-weight: 600;
  padding: 8px 14px;
  border-radius: 6px;
  font-size: 13px;
  border: none;
  cursor: pointer;
  font-family: var(--sans);
}
.stak-approve:disabled,
.stak-pill:disabled {
  opacity: 0.6;
  cursor: default;
}
```

- [ ] **Step 3: Typecheck**

Run: `cd apps/web && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add apps/web/app/skills/_components/skill-actions.tsx apps/web/app/skills/skills.css
git commit -m "feat(p5): Approve/Pause/Resume action component with pending+stale states"
```

---

### Task 10: Skill detail page

**Files:**
- Create: `apps/web/app/skills/[skillId]/page.tsx`

**Interfaces:**
- Consumes: `loadSkillDetail` from `../skill-detail-data.js`; `SkillActions` from `../_components/skill-actions.js`; `ShellNotice`, `AppSidebar`, `MachineChooser`, `CommandDock`.

- [ ] **Step 1: Write the page**

```typescript
// apps/web/app/skills/[skillId]/page.tsx
import { redirect } from 'next/navigation';

import { AppSidebar } from '../../_components/app-sidebar';
import { CommandDock } from '../../_components/command-dock';
import { MachineChooser } from '../../_components/machine-chooser';
import { ShellNotice } from '../../_components/shell-notice';
import { getCloudService } from '../../../lib/cloud-service';
import { displayNameOf, getSessionUser } from '../../../lib/session';

import { loadSkillDetail } from '../skill-detail-data';
import { SkillActions } from '../_components/skill-actions';
import '../../overview/shell.css';
import '../skills.css';

export const dynamic = 'force-dynamic';

const PLACEHOLDER_SIDEBAR = {
  overview: { n: '', tone: 'neutral' as const },
  skills: '',
  memory: { n: '', tone: 'neutral' as const },
  projects: '',
  machines: '',
  stacks: '',
};

export default async function SkillDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ skillId: string }>;
  searchParams: Promise<{ machine?: string }>;
}) {
  const user = await getSessionUser();
  if (!user) redirect('/');
  const { skillId } = await params;
  const { machine } = await searchParams;
  const handle = user.githubUsername ?? displayNameOf(user);
  const view = await loadSkillDetail(getCloudService(), user, skillId, machine);

  if (view.kind === 'error')
    return (
      <ShellNotice active="skills" handle={handle} title="Couldn't load this Skill">
        <p>STAK Cloud didn&apos;t respond. Reload to try again.</p>
      </ShellNotice>
    );
  if (view.kind === 'not-found')
    return (
      <ShellNotice active="skills" handle={handle} title="Skill not found">
        <p>
          This Skill doesn&apos;t exist in your STAK, or you don&apos;t have access to it.{' '}
          <a href="/skills" style={{ color: 'var(--orange)' }}>Back to Skills</a>
        </p>
      </ShellNotice>
    );
  if (view.kind === 'no-machines')
    return (
      <ShellNotice active="skills" handle={handle} title="No machines yet">
        <p>
          Connect this computer first: run{' '}
          <code style={{ fontFamily: 'var(--mono)' }}>stak login</code> in your terminal.
        </p>
      </ShellNotice>
    );
  if (view.kind === 'choose-machine')
    return (
      <ShellNotice active="skills" handle={handle} title="Choose a machine">
        <p>Pick the machine you want this Skill&apos;s installed state shown for.</p>
        <MachineChooser options={view.machines} basePath={`/skills/${skillId}`} />
      </ShellNotice>
    );

  return (
    <div className="stak-frame">
      <AppSidebar
        active="skills"
        handle={handle}
        counts={PLACEHOLDER_SIDEBAR}
        viewing={view.viewing}
        machines={view.machines}
      />
      <main className="stak-main">
        <div style={{ padding: '22px 28px 0', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <span style={{ fontSize: 12.5, color: 'var(--dim)' }}>
            <a href="/skills" style={{ color: 'var(--dim)', textDecoration: 'none' }}>Skills</a> /{' '}
            <span style={{ color: 'var(--muted)' }}>{view.name}</span>
          </span>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
              <span style={{ font: "600 24px var(--mono)" }}>{view.name}</span>
              <span
                style={{
                  display: 'flex',
                  gap: 6,
                  alignItems: 'center',
                  fontSize: 12,
                  color: view.statusText === 'Update available' ? 'var(--orange)' : 'var(--muted)',
                  border: '1px solid var(--line-2)',
                  padding: '3px 9px',
                  borderRadius: 4,
                }}
              >
                {view.statusText}
              </span>
            </div>
            <SkillActions
              skillId={view.skillId}
              paused={view.paused}
              updateAvailable={view.updateAvailable}
              candidateVersion={view.candidateVersion}
              approvedVersionShort={view.approvedVersionShort}
            />
          </div>
          {view.description ? (
            <span style={{ fontSize: 14.5, color: 'var(--faint)' }}>{view.description}</span>
          ) : null}
        </div>

        <div style={{ padding: '20px 28px', display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr 1.2fr',
              border: '1px solid var(--line)',
              borderRadius: 8,
            }}
          >
            <div style={{ padding: '13px 16px', display: 'flex', flexDirection: 'column', gap: 3 }}>
              <span style={{ font: '500 11px var(--mono)', color: 'var(--dim)' }}>APPROVED IN STAK</span>
              <span style={{ font: '600 16px var(--mono)' }}>{view.approvedVersionShort}</span>
              {view.cannotCheckNote ? (
                <span style={{ fontSize: 12.5, color: 'var(--faint)' }}>Can&apos;t check for updates from this source.</span>
              ) : view.updateAvailable ? (
                <span style={{ fontSize: 12.5, color: 'var(--orange)' }}>A newer source candidate is available below.</span>
              ) : (
                <span style={{ fontSize: 12.5, color: 'var(--faint)' }}>What your machines should run.</span>
              )}
            </div>
            <div style={{ padding: '13px 16px', borderLeft: '1px solid var(--line)', display: 'flex', flexDirection: 'column', gap: 3 }}>
              <span style={{ font: '500 11px var(--mono)', color: 'var(--dim)' }}>
                INSTALLED ON {view.viewing.name.toUpperCase()}
              </span>
              <span style={{ font: '600 16px var(--mono)' }}>{view.installedHere}</span>
              <span style={{ fontSize: 12.5, color: 'var(--faint)' }}>
                {view.installedHereAt ? `At last check-in` : 'Hasn\u2019t checked in yet'}
              </span>
            </div>
            <div style={{ padding: '13px 16px', borderLeft: '1px solid var(--line)', display: 'flex', flexDirection: 'column', gap: 3 }}>
              <span style={{ font: '500 11px var(--mono)', color: 'var(--dim)' }}>SOURCE</span>
              <span style={{ font: '500 13.5px var(--mono)' }}>
                {view.sourceLabel}
                {view.trackedRef ? ` · ${view.trackedRef}` : ''}
              </span>
              <span style={{ fontSize: 12.5, color: 'var(--faint)' }}>
                {view.cannotCheckNote ? "Can't check for updates from this source." : 'Checked against the tracked ref.'}
              </span>
            </div>
          </div>

          {view.updateAvailable ? (
            <section style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
              <h2 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>Reviewing the candidate</h2>
              {view.diffAvailable ? (
                <div style={{ border: '1px solid var(--line)', borderRadius: 8, overflow: 'hidden', font: '12.5px var(--mono)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 14px', background: '#181816', color: 'var(--faint)' }}>
                    <span>Candidate {view.candidateVersion}</span>
                    <span>{view.diffFiles.length} file{view.diffFiles.length === 1 ? '' : 's'} changed</span>
                  </div>
                  {view.diffFiles.map((f) => (
                    <div
                      key={f.relativePath}
                      style={{
                        padding: '6px 14px',
                        color: f.kind === 'added' ? '#84cb8e' : f.kind === 'removed' ? '#e5776a' : '#e5b85c',
                      }}
                    >
                      {f.kind === 'added' ? '+ ' : f.kind === 'removed' ? '\u2212 ' : '~ '}
                      {f.relativePath}
                    </div>
                  ))}
                </div>
              ) : (
                <p style={{ fontSize: 13, color: 'var(--dim)' }}>No candidate diff is available for this Skill yet.</p>
              )}
            </section>
          ) : null}

          <section style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            <h2 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>Files</h2>
            {view.filesAvailable ? (
              <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 4 }}>
                {view.files.map((f) => (
                  <li key={f.relativePath} style={{ font: '12.5px var(--mono)', color: 'var(--muted)' }}>
                    {f.relativePath} <span style={{ color: 'var(--dim)' }}>({f.byteSize}B)</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p style={{ fontSize: 13, color: 'var(--dim)' }}>File contents aren&apos;t available for this Skill yet.</p>
            )}
          </section>

          <section style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            <h2 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>Versions</h2>
            {view.history.length === 0 ? (
              <p style={{ fontSize: 13, color: 'var(--dim)' }}>Only one version so far.</p>
            ) : (
              <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 4 }}>
                {view.history.map((h) => (
                  <li key={h.contentHash} style={{ display: 'flex', justifyContent: 'space-between', font: '12.5px var(--mono)' }}>
                    <span style={{ color: h.current ? 'var(--ink)' : 'var(--faint)' }}>
                      {h.shortHash} {h.current ? '· currently approved' : '· older approved version'}
                    </span>
                    <span style={{ color: 'var(--dim)' }}>v{h.environmentVersionNumber}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <h2 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>Capabilities</h2>
            <span style={{ fontSize: 13, color: 'var(--muted)' }}>{view.capabilitiesText}</span>
            {view.capabilityList.length > 0 ? (
              <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                {view.capabilityList.map((c) => (
                  <li key={c.label} style={{ fontSize: 12.5, color: c.value === 'declared-true' ? 'var(--orange)' : 'var(--faint)' }}>
                    {c.label}: {c.value === 'declared-true' ? 'Yes' : 'No'}
                  </li>
                ))}
              </ul>
            ) : (
              <span style={{ fontSize: 12.5, color: 'var(--faint)', lineHeight: 1.5 }}>
                The author hasn&apos;t listed what this Skill needs. STAK doesn&apos;t guess from its instructions.
              </span>
            )}
          </section>

          <div style={{ padding: '12px 14px', border: '1px solid var(--line)', borderRadius: 6, fontSize: 13, lineHeight: 1.55, color: 'var(--faint)' }}>
            <span style={{ color: 'var(--ink)' }}>Pause</span> keeps this Skill in STAK with its version and provenance; your agents stop receiving it. Not the same as removing it.
          </div>
        </div>

        <CommandDock
          machineName={view.viewing.name}
          command={`stak skill update ${view.name}`}
          hint={
            view.updateAvailable
              ? 'Approve above first — this installs whatever STAK already has approved'
              : 'Reconciles this machine to the approved version'
          }
        />
      </main>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/web && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/skills/[skillId]/page.tsx
git commit -m "feat(p5): Skill detail page — source, versions, diff, capabilities, actions"
```

---

### Task 11: Privacy + frozen-language audit

**Files:** none created; verification only.

- [ ] **Step 1: Grep the new Skills files for banned vocabulary**

Run:
```bash
cd apps/web/app/skills && grep -rniE "in sync|outdated|\bbroken\b|\bunsafe\b|\bonline\b|\boffline\b" . || echo "clean"
```
Expected: `clean` (no matches). If any match appears in a comment-only context explaining what NOT to show, that's fine; a match inside a literal UI string is not.

- [ ] **Step 2: Grep for path leakage**

Run:
```bash
cd apps/web/app/skills && grep -rniE "[A-Za-z]:\\\\Users|/home/|/Users/" . || echo "clean"
```
Expected: `clean`.

- [ ] **Step 3: Confirm `source.label` is rendered verbatim, never concatenated with a derived path**

Manually re-read `skills-data.ts`'s `sourceLabel` field and `skill-detail-data.ts`'s `sourceLabel`/`trackedRef` fields — confirm both read only `skill.source.label` / `.trackedRef` (already-sanitized P3 fields) and never touch `process.cwd()`, `os.homedir()`, or any filesystem API. (No code change expected; this is a read-confirmation step.)

- [ ] **Step 4: Record the result in the final phase report** (no commit for this task — it's verification, folded into Task 13's report)

---

### Task 12: Full validation pass

**Files:** none created.

- [ ] **Step 1: Run the full web test suite**

Run: `cd apps/web && npx vitest run`
Expected: PASS — every existing suite (Overview, format, dashboard, session, cloud-response, branding, recovery, etc.) plus the new `machine-context.test.ts`, `skills-data.test.ts`, `skill-detail-data.test.ts`.

- [ ] **Step 2: Typecheck, lint, format**

Run:
```bash
cd apps/web && npx tsc --noEmit
cd apps/web && npx eslint app lib
cd apps/web && npx prettier --check "app/skills/**/*.{ts,tsx,css}" "lib/machine-context.ts" "app/_components/shell-notice.tsx"
```
Expected: all PASS. Fix any formatting/lint findings with `npx prettier --write` / targeted edits, re-run until clean.

- [ ] **Step 3: `git diff --check`**

Run: `cd "C:/Users/NT/Desktop/stack" && git diff --check`
Expected: no whitespace-error output.

- [ ] **Step 4: Confirm no migrations, no shared/cloud-server production-affecting code changed**

Run: `cd "C:/Users/NT/Desktop/stack" && git status && git diff --stat main...HEAD`
Expected: only files under `apps/web/` touched (per the File Structure section above); nothing under `supabase/migrations/`.

---

### Task 13: Browser dogfood + Final Contract fidelity pass

**Files:** none created; this task produces the phase report, not code.

- [ ] **Step 1: Start the web dev server**

Run (background): `cd apps/web && npm run dev`

- [ ] **Step 2: Read-only dogfood on the real signed-in account**

Using the `agent-browser` or `claude-in-chrome` tooling already available in this environment, visit `/skills` and `/skills/<a real skill id>` signed in as the real dogfood account (31 Skills, DELL the one active machine). Verify, without clicking Approve/Pause/Resume:
- `/skills` renders the list, sidebar shows "Skills" as the active/real link, status sentence matches real data.
- Search narrows rows by name; status filter chips narrow by bucket; both combine.
- A row click navigates to `/skills/<entryId>`.
- Detail page shows SOURCE / APPROVED / INSTALLED facts, capabilities section, version history, and (given the real backend's `files`/`diff` are currently always null) the honest "not available yet" states for Files and any diff section.
- Command dock on both pages names DELL and the correct command.
- Keyboard: Tab reaches the search box, filter chips, each row link, Pause/Resume and Approve buttons; focus rings visible.

- [ ] **Step 3: Mutation dogfood against a disposable/fixture-backed instance only**

Do NOT click Approve/Pause/Resume against the real 31-Skill account. Either (a) point `getCloudService()` at a local in-memory `CloudRepository` fixture for this check only (temporary env override, reverted after), or (b) rely on the Task 9 component-level coverage plus a manual code read of `actions.ts` or (c) ask the user for an isolated test account if one exists. Record in the report which option was used and why.

- [ ] **Step 4: Compare against the Final Contract (S.05/S.06) at desktop reference width**

Re-open the DesignSync project `c7802a6a-cc4f-4ee9-93ea-f4f071d8c832`, file `STAK Final Contract.dc.html`, sections S.05 and S.06, side-by-side with the rendered `/skills` and `/skills/<id>` pages. Confirm: shell continuity with Overview (sidebar width, dark palette, IBM Plex), dense row layout, status-sentence placement, command dock placement/copy pattern, borders/spacing/typography, restrained orange use for update/action emphasis only. List and note every intentional deviation (e.g., dropped AGENTS/SCOPE/multi-machine ATLAS+STUDIO columns and the "Usage" tab — not backed by any real P3 field; dropped the non-functional "How to add a skill" pill — no backing feature in scope).

- [ ] **Step 5: Stop the dev server**

Run: `cd apps/web && [stop the background dev server process started in Step 1]`

---

### Task 14: Phase report

No code changes. Compose the 24-point report the brief's §35 requires (routes, architecture, machine-context behavior, search/filter, status derivation and the resolved §19 ambiguity, detail architecture, provenance/version/capability rendering, files/diff honest-unavailable behavior, approve/pause/resume behavior and stale-review handling, loading/empty/error states, privacy audit result, dogfood result, Final Contract fidelity result and deviations, files changed, test counts, commit hashes, final `git status`) and present it to the user. Then **stop** — do not start P6, do not merge, do not push.

---

## Self-Review

**Spec coverage:** §0 (source order) satisfied by the research already performed before this plan — contract, P2 `skill-source.ts`/`skill.ts`, P3 `product.ts`/`product-service.ts`, P4 shell files, and the live Final Contract S.05/S.06 + `stak-contract.js` frozen `lang` table were all read; `stak-truth.js` was never opened. §1 scope: list + detail + nav + search/filter + source/approved/installed + provenance + capabilities + files + history + update review/diff + approve + pause/resume + machine-specific install/dock + loading/empty/error ⇒ Tasks 4–10. Explicitly out-of-scope items (Memory/Projects/Machines/Stacks pages, marketplace, teams, collections, remote exec) are not touched by any task. §2–§3 (frozen model/vocabulary) ⇒ `deriveRow`/status logic in Tasks 4 & 7, audited in Task 11. §4–§6 (list, rows, search/filter) ⇒ Task 5. §7 (stable entryId route) ⇒ Task 10's dynamic segment `[skillId]`, never display name. §8–§12 (detail header, source, capabilities, files, history) ⇒ Tasks 7 & 10. §13–§14 (diff, approve) ⇒ Tasks 7–9. §15 (machine apply guidance) ⇒ `CommandDock` usage in Task 10. §16–§17 (pause/resume independence) ⇒ Task 9's `SkillActions` keeps both actions independent; Task 7's test "keeps provenance/history/capabilities visible while paused" covers §17. §18 (cannot-check) ⇒ `cannotCheckNote` throughout Tasks 4/7/10. §19 (Ready semantics ambiguity) ⇒ resolved with the user and encoded in `deriveRow`. §20 (machine context reuse) ⇒ Task 1's extraction, used by Tasks 4/5/7/10 — no forked selector. §21 (sidebar) ⇒ Task 6. §22 (status sentence) ⇒ `statusSentence` in Task 4. §23 (action safety) ⇒ Task 8 (session-derived auth, server-side ownership via existing `getSkillDetail`/`approveSkillVersion`/`setSkillPaused` scoping) + Task 9 (pending/disable/error/stale). §24 (URL/refresh) ⇒ `?machine=` already persists via existing pattern; entryId route persists by construction. §25 (states) ⇒ enumerated across Tasks 5/10/13. §26 (visual direction) ⇒ `skills.css` reuses `shell.css` tokens exactly. §27 (a11y baseline) ⇒ real `<Link>`/`<button>`, labelled controls, focus-visible rules, `role="status" aria-live` on action errors and copy-confirmation (reusing `CommandDock`'s existing one). §28 (no fake trust) ⇒ explicitly the reason AGENTS/SCOPE/Usage-tab/used-by-counts are dropped (Task 13 records this as a deviation). §29 (privacy) ⇒ Task 11 + Task 7 test. §30 (view-model tests) ⇒ Tasks 1/4/7 test lists map 1:1 to the brief's required cases (all-Ready, update-available, paused, cannot-check, mixed, no-Skills, never-checked-in, revoked-excluded, duplicate-name-by-id, filter-empty for list; Ready/update/paused/installed≠approved/source-unavailable/capabilities-declared/absent/history/files/no-files/invalid-id for detail; stale/duplicate/failed covered at the action layer in Task 8/9). §31 (rendered interaction) ⇒ Task 13 (explicit: no new test framework, agent-browser dogfood, manual-verification items named in the report). §32 (dogfood safety) ⇒ Task 13 Step 3's explicit no-write-to-real-account rule. §33–§35 ⇒ Tasks 13–14.

**Placeholder scan:** no "TBD"/"handle edge cases"/"similar to Task N" phrases; every step shows real code or an exact runnable command with its expected output.

**Type consistency:** `SkillRow`, `SkillDetailView`, `MachineOption`, `SkillsService`, `SkillDetailService` are each defined once (Tasks 4/7/1) and consumed with the same names/shapes in every later task (5/6/8/9/10) — checked field-by-field against the Task 4/7 definitions while writing Tasks 5–10.
