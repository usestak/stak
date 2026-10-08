# P6 — Memory + Projects + Project Mapping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the signed-in `/memory` and `/projects` (+ `/projects/[projectId]`) web surfaces on top of the already-shipped P3 `CloudService` read models, visually and architecturally matching the accepted P4 (Overview) / P5 (Skills) `.stak` shell pattern, and flip the Memory/Projects sidebar placeholders into real links.

**Architecture:** Server-rendered Next.js pages (`export const dynamic = 'force-dynamic'`) call `getCloudService()` in-process (no HTTP, no cloud-client — this is the existing, confirmed web-app pattern) through a pure, unit-testable `load*` view-model function per page, exactly like `overview-data.ts` / `skills-data.ts`. Lifecycle writes (archive/unarchive) go through a `'use server'` action calling `CloudService.setProjectLifecycle`, mirroring `skills/actions.ts`.

**Tech Stack:** Next.js App Router (server components), TypeScript, Zod (`@stack/spec`), Vitest, the existing `.stak` design-token CSS system (`apps/web/app/overview/shell.css`).

## Global Constraints

- Memory privacy mode is **account-wide only** — never render or imply a per-project mode (contract §1).
- Protected Memory's `perProject` is **always `null`** — never reconstruct or fake per-project file counts from ciphertext (contract §1, frozen P3 read-model rule in `packages/cloud-server/src/product-service.ts:1048-1051`).
- Frozen Memory status words: **Backed up** / **Not backed up yet**. Frozen Project words: **Active** / **Archived** / **On this machine** / **Not on this machine**. Banned words: In sync, Online, Offline, Outdated, Lost, Broken, Unsafe (contract §10).
- The web **never** runs `stak memory backup/recover/restore` or `stak project map/archive/unarchive` itself — it only names the exact CLI command via `<CommandDock>` (reuse `apps/web/app/_components/command-dock.tsx` verbatim, no new component).
- Only real CLI syntax may appear in any CommandDock string: `stak memory backup`, `stak memory history`, `stak memory protect`, `stak memory recover`, `stak memory status`, `stak memory restore`, `stak project map <project> <directory>`, `stak project archive <project>`, `stak project unarchive <project>`. Never invent `stak project locate`, `stak stack apply`, or `stak restore`.
- `cloud_projects` (migration `0005_product_read_models.sql`) stores **no path, no Git remote, no Memory content** — the server has no "canonical Git identity" or "explicit mapping exists" fact to expose; those are CLI-local-only facts (confirmed: `packages/cli/src/memory/project-ops.ts` holds that logic, never synced to Cloud). Pages must not fabricate or imply knowledge of them.
- `ProjectsReadModel.projects[].lastBackupAt` is **hardcoded `null`** today in `getProjectsReadModel` (`packages/cloud-server/src/product-service.ts:957-990`) — no real per-project backup timestamp exists. Do not invent one; do not add a server-side change to produce one (out of P6 scope).
- Archive/unarchive is explicit lifecycle intent only — never triggered by discovery sync, never deletes Memory/files/mapping/history (contract §16).
- No real-account mutation during dogfood: never call `setProjectLifecycle`, `syncProjects`, or any Memory write RPC against the real signed-in account while verifying pages in the browser. Use the injected-fake-service Vitest tests for all mutation-path testing.
- Migration `0006_skill_review_checks.sql` is P5a's schema (Skill source-check), unrelated to Memory/Projects — P6 depends only on migrations `0001`–`0005`, already applied to the dev Supabase project (confirmed in prior session).
- Settings/P8-owned surfaces (Delete Cloud Memory, privacy-mode change button, full Machines page, onboarding) stay **out of scope** — Memory page only *shows* status/mode/recovery read-only plus CLI guidance.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `apps/web/lib/project-presentation.ts` | New. Shared Project presentation helpers (CLI selector, presence/lifecycle label) — the Projects-page equivalent of `lib/skill-presentation.ts`, so list/detail pages can't drift. |
| `apps/web/lib/project-presentation.test.ts` | New. Unit tests for the above. |
| `apps/web/app/memory/(dashboard)/layout.tsx` | New. `.stak` shell wrapper, scoped via a route group so it does **not** also wrap the existing `app/memory/protect/` and `app/memory/recover/` pages (which keep their own `SiteHeader`/`globals.css` shell). |
| `apps/web/app/memory/(dashboard)/memory.css` | New. Memory-page-only CSS extending `shell.css` tokens (backup-history rows, Standard per-project table, Protected block). |
| `apps/web/app/memory/memory-data.ts` | New. Pure `loadMemoryView(service, user, requestedMachine)` view-model builder. (Lives at `app/memory/`, not inside the route group, so it's a plain importable module, matching `overview-data.ts`'s placement one level up from its `page.tsx`'s own segment is irrelevant here — kept beside the route group for easy relative imports.) |
| `apps/web/app/memory/memory-data.test.ts` | New. Vitest unit tests (fake injected service). |
| `apps/web/app/memory/(dashboard)/page.tsx` | New. The `/memory` page — status sentence, fact strip, backup history, Standard/Protected treatment, recovery state, CommandDock. |
| `apps/web/app/projects/layout.tsx` | New. `.stak` shell wrapper (no conflicting nested routes exist under `/projects` today — plain layout, no route group needed). |
| `apps/web/app/projects/projects.css` | New. Projects-list CSS mirroring `apps/web/app/skills/skills.css`'s toolbar/table structure. |
| `apps/web/app/projects/projects-data.ts` | New. Pure `loadProjectsList(service, user, requestedMachine)` view-model builder. |
| `apps/web/app/projects/projects-data.test.ts` | New. Vitest unit tests. |
| `apps/web/app/projects/page.tsx` | New. The `/projects` list page. |
| `apps/web/app/projects/actions.ts` | New. `'use server'` `setProjectLifecycleAction`, mirrors `apps/web/app/skills/actions.ts`. |
| `apps/web/app/projects/_components/projects-table.tsx` | New. Client component: filter chips + search + table, mirrors `apps/web/app/skills/_components/skills-table.tsx`. |
| `apps/web/app/projects/_components/project-lifecycle-button.tsx` | New. Client component: Archive/Unarchive button, mirrors `apps/web/app/skills/_components/skill-actions.tsx`. |
| `apps/web/app/projects/[projectId]/project-detail-data.ts` | New. Pure `loadProjectDetail(service, user, projectId, requestedMachine)` view-model builder. |
| `apps/web/app/projects/[projectId]/project-detail-data.test.ts` | New. Vitest unit tests. |
| `apps/web/app/projects/[projectId]/page.tsx` | New. The Project detail/mapping page. |
| `apps/web/app/_components/app-sidebar.tsx` | Modify. Flip `memory`/`projects` nav items from `aria-disabled` placeholders to real `<Link>`s (lines ~82-98). |

---

### Task 1: Shared Project presentation helpers

**Files:**
- Create: `apps/web/lib/project-presentation.ts`
- Test: `apps/web/lib/project-presentation.test.ts`

**Interfaces:**
- Produces: `cliProjectSelector(projectId: string, name: string | undefined, allProjects: readonly { projectId: string; name?: string }[]): string`, `presenceLabel(presentOn: readonly string[], viewingMachineId: string): 'On this machine' | 'Not on this machine'`, `lifecycleLabel(lifecycle: 'active' | 'archived'): 'Active' | 'Archived'`.
- Consumes: nothing (pure, no project imports beyond types it defines inline — avoids a dependency on `@stack/spec` just for two string literals).

- [ ] **Step 1: Write the failing tests**

```ts
// apps/web/lib/project-presentation.test.ts
import { describe, expect, it } from 'vitest';

import {
  cliProjectSelector,
  lifecycleLabel,
  presenceLabel,
} from './project-presentation.js';

describe('cliProjectSelector', () => {
  it('uses the display name when it is unique', () => {
    const all = [
      { projectId: 'prj_abc123', name: 'stak' },
      { projectId: 'prj_def456', name: 'other-repo' },
    ];
    expect(cliProjectSelector('prj_abc123', 'stak', all)).toBe('stak');
  });

  it('falls back to the stable projectId when the name collides', () => {
    const all = [
      { projectId: 'prj_abc123', name: 'api' },
      { projectId: 'prj_def456', name: 'api' },
    ];
    expect(cliProjectSelector('prj_abc123', 'api', all)).toBe('prj_abc123');
  });

  it('falls back to the stable projectId when there is no name', () => {
    const all = [{ projectId: 'prj_abc123', name: undefined }];
    expect(cliProjectSelector('prj_abc123', undefined as any, all)).toBe(
      'prj_abc123',
    );
  });
});

describe('presenceLabel', () => {
  it('reports On this machine when present', () => {
    expect(presenceLabel(['m1', 'm2'], 'm1')).toBe('On this machine');
  });
  it('reports Not on this machine when absent', () => {
    expect(presenceLabel(['m2'], 'm1')).toBe('Not on this machine');
  });
  it('reports Not on this machine for an empty presence list', () => {
    expect(presenceLabel([], 'm1')).toBe('Not on this machine');
  });
});

describe('lifecycleLabel', () => {
  it('capitalizes active', () => {
    expect(lifecycleLabel('active')).toBe('Active');
  });
  it('capitalizes archived', () => {
    expect(lifecycleLabel('archived')).toBe('Archived');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/web && npx vitest run lib/project-presentation.test.ts`
Expected: FAIL with "Cannot find module './project-presentation.js'" (or similar resolution error).

- [ ] **Step 3: Write the implementation**

```ts
// apps/web/lib/project-presentation.ts

/**
 * Shared Project presentation logic — the Projects-list, Projects-detail, and Memory per-project
 * table all derive the CLI selector and presence/lifecycle labels from here, so they can never
 * drift apart (the same reason `lib/skill-presentation.ts` exists for Skills).
 */

/** The CLI selector a human should be shown for `stak project map`/`archive`/`unarchive`: the
 *  display name when it is unique across every Project the viewer can see, the stable `prj_...`
 *  id otherwise. Mirrors `cliSkillSelector` in `lib/skill-presentation.ts`. */
export const cliProjectSelector = (
  projectId: string,
  name: string | undefined,
  allProjects: readonly { projectId: string; name?: string }[],
): string => {
  if (!name) return projectId;
  const matches = allProjects.filter((p) => p.name === name);
  return matches.length === 1 ? name : projectId;
};

/** Frozen Project presence vocabulary (contract §10/§15) — never "Online"/"Offline"/"Lost". */
export const presenceLabel = (
  presentOn: readonly string[],
  viewingMachineId: string,
): 'On this machine' | 'Not on this machine' =>
  presentOn.includes(viewingMachineId)
    ? 'On this machine'
    : 'Not on this machine';

/** Frozen Project lifecycle vocabulary (contract §10). */
export const lifecycleLabel = (
  lifecycle: 'active' | 'archived',
): 'Active' | 'Archived' => (lifecycle === 'active' ? 'Active' : 'Archived');
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/web && npx vitest run lib/project-presentation.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/project-presentation.ts apps/web/lib/project-presentation.test.ts
git commit -m "feat(p6): shared Project presentation helpers"
```

---

### Task 2: Memory view-model (`memory-data.ts`)

**Files:**
- Create: `apps/web/app/memory/memory-data.ts`
- Test: `apps/web/app/memory/memory-data.test.ts`

**Interfaces:**
- Consumes: `CloudService['getMachinesReadModel' | 'getMemoryReadModel' | 'getProjectsReadModel']`, `MachineOption`/`resolveViewingMachineId`/`sortMachinesForSelection`/`machineOption`/`checkedIn`/`displayName`/`statusLabel`/`machineDot`/`relative` from `../../lib/machine-context.js`, `SidebarCounts` type from `../overview/overview-data.js`, `WebUser` from `../../lib/session.js`.
- Produces: `MemoryService` type, `loadMemoryView(service, user, requestedMachine): Promise<MemoryView>` where `MemoryView` is the discriminated union `{ kind: 'error' } | { kind: 'no-machines' } | { kind: 'choose-machine'; machines; anyCheckedIn } | { kind: 'ready'; ...}` — later tasks (`page.tsx`) render on these exact field names.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/web/app/memory/memory-data.test.ts
import { describe, expect, it } from 'vitest';

import type {
  MachineSummary,
  MachinesReadModel,
  MemoryReadModel,
  ProjectsReadModel,
} from '@stack/spec';

import { loadMemoryView, type MemoryService } from './memory-data.js';

const USER = { id: 'user-1' };
const A1 = '00000000-0000-4000-8000-0000000000a1';
const nowIso = (minsAgo: number) =>
  new Date(Date.now() - minsAgo * 60_000).toISOString();

const machine = (over: Partial<MachineSummary> = {}): MachineSummary => ({
  machineId: A1,
  name: 'Dell',
  platform: 'win32',
  arch: 'x64',
  agentsDetected: ['Claude Code'],
  firstSeenAt: nowIso(60 * 24 * 10),
  lastCheckinAt: nowIso(12),
  memoryBackedUp: true,
  revoked: false,
  status: 'up-to-date',
  updatesWaiting: [],
  projectsPresent: 2,
  ...over,
});

const memoryModel = (
  over: Partial<MemoryReadModel> = {},
): MemoryReadModel => ({
  mode: 'standard',
  latestBackupAt: nowIso(60 * 24),
  backups: [
    { generation: 6, mode: 'standard', createdAt: nowIso(60 * 24) },
    { generation: 5, mode: 'standard', createdAt: nowIso(60 * 24 * 8) },
  ],
  recoveryMethods: [],
  hasRecoveryMethod: false,
  perProject: [{ projectId: 'prj_abc', fileCount: 12 }],
  ...over,
});

const service = (opts: {
  machines?: MachineSummary[];
  memory?: MemoryReadModel;
  projects?: ProjectsReadModel['projects'];
  throwMachines?: boolean;
  throwMemory?: boolean;
}): MemoryService => ({
  getMachinesReadModel: async (): Promise<MachinesReadModel> => {
    if (opts.throwMachines) throw new Error('offline');
    return { machines: opts.machines ?? [machine()] };
  },
  getMemoryReadModel: async () => {
    if (opts.throwMemory) throw new Error('offline');
    return opts.memory ?? memoryModel();
  },
  getProjectsReadModel: async () => ({ projects: opts.projects ?? [] }),
});

const ready = (view: Awaited<ReturnType<typeof loadMemoryView>>) => {
  if (view.kind !== 'ready')
    throw new Error(`expected ready, got ${view.kind}`);
  return view;
};

describe('loadMemoryView', () => {
  it('returns error when getMachinesReadModel throws', async () => {
    const view = await loadMemoryView(
      service({ throwMachines: true }),
      USER,
      undefined,
    );
    expect(view.kind).toBe('error');
  });

  it('returns no-machines when every machine is revoked', async () => {
    const view = await loadMemoryView(
      service({ machines: [machine({ revoked: true })] }),
      USER,
      undefined,
    );
    expect(view.kind).toBe('no-machines');
  });

  it('auto-selects a single active machine', async () => {
    const view = await loadMemoryView(service({}), USER, undefined);
    expect(ready(view).viewing.machineId).toBe(A1);
  });

  it('asks the caller to choose with 2+ active machines and no valid ?machine=', async () => {
    const view = await loadMemoryView(
      service({
        machines: [
          machine({ machineId: A1 }),
          machine({ machineId: '00000000-0000-4000-8000-0000000000b2' }),
        ],
      }),
      USER,
      undefined,
    );
    expect(view.kind).toBe('choose-machine');
  });

  it('reports Not backed up yet when latestBackupAt is null', async () => {
    const view = ready(
      await loadMemoryView(
        service({ memory: memoryModel({ latestBackupAt: null, backups: [] }) }),
        USER,
        A1,
      ),
    );
    expect(view.statusSentence).toMatch(/not backed up yet/i);
    expect(view.backedUp).toBe(false);
  });

  it('flags a machine-level gap when the selected machine is checked in but memoryBackedUp is false', async () => {
    const view = ready(
      await loadMemoryView(
        service({ machines: [machine({ memoryBackedUp: false })] }),
        USER,
        A1,
      ),
    );
    expect(view.machineGap).toBe(true);
    expect(view.statusSentence).toMatch(/dell/i);
  });

  it('never flags a machine gap when the machine has not checked in', async () => {
    const view = ready(
      await loadMemoryView(
        service({
          machines: [
            machine({ memoryBackedUp: false, lastCheckinAt: null, status: 'never-checked-in' }),
          ],
        }),
        USER,
        A1,
      ),
    );
    expect(view.machineGap).toBe(false);
  });

  it('exposes Standard perProject rows joined with known project names', async () => {
    const view = ready(
      await loadMemoryView(
        service({
          memory: memoryModel({
            perProject: [{ projectId: 'prj_abc', fileCount: 12 }],
          }),
          projects: [
            {
              projectId: 'prj_abc',
              name: 'stak',
              lifecycle: 'active',
              presentOn: [A1],
              fileCount: 12,
              lastBackupAt: null,
            },
          ],
        }),
        USER,
        A1,
      ),
    );
    expect(view.mode).toBe('standard');
    expect(view.perProject).toEqual([
      { projectId: 'prj_abc', name: 'stak', fileCount: 12 },
    ]);
  });

  it('forces perProject null for Protected even if the server somehow returned rows', async () => {
    // Defensive: the server contract already guarantees null for Protected, but the view model
    // must never render a Protected per-project table under any circumstance.
    const view = ready(
      await loadMemoryView(
        service({
          memory: memoryModel({ mode: 'protected', perProject: null }),
          projects: [
            {
              projectId: 'prj_abc',
              name: 'stak',
              lifecycle: 'active',
              presentOn: [A1],
              fileCount: null,
              lastBackupAt: null,
            },
          ],
        }),
        USER,
        A1,
      ),
    );
    expect(view.mode).toBe('protected');
    expect(view.perProject).toBeNull();
    expect(view.protectedProjectsKnownCount).toBe(1);
  });

  it('surfaces needsRecoveryMethod when Protected has no recovery method', async () => {
    const view = ready(
      await loadMemoryView(
        service({
          memory: memoryModel({
            mode: 'protected',
            perProject: null,
            hasRecoveryMethod: false,
          }),
        }),
        USER,
        A1,
      ),
    );
    expect(view.needsRecoveryMethod).toBe(true);
  });

  it('never surfaces needsRecoveryMethod for Standard', async () => {
    const view = ready(
      await loadMemoryView(
        service({ memory: memoryModel({ mode: 'standard', hasRecoveryMethod: false }) }),
        USER,
        A1,
      ),
    );
    expect(view.needsRecoveryMethod).toBe(false);
  });

  it('returns backup history newest-first with Standard/Protected tags', async () => {
    const view = ready(await loadMemoryView(service({}), USER, A1));
    expect(view.history[0]).toMatchObject({ generation: 6, mode: 'standard' });
    expect(view.history[1]).toMatchObject({ generation: 5, mode: 'standard' });
  });

  it('returns an empty history list honestly when there are no backups', async () => {
    const view = ready(
      await loadMemoryView(
        service({ memory: memoryModel({ backups: [], latestBackupAt: null }) }),
        USER,
        A1,
      ),
    );
    expect(view.history).toEqual([]);
  });

  it('returns error when getMemoryReadModel throws', async () => {
    const view = await loadMemoryView(
      service({ throwMemory: true }),
      USER,
      A1,
    );
    expect(view.kind).toBe('error');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/web && npx vitest run app/memory/memory-data.test.ts`
Expected: FAIL with "Cannot find module './memory-data.js'".

- [ ] **Step 3: Write the implementation**

```ts
// apps/web/app/memory/memory-data.ts
import { CloudServiceError, type CloudService } from '@stack/cloud-server';
import type { MemoryReadModel } from '@stack/spec';

import type { WebUser } from '../../lib/session.js';
import {
  relative,
  displayName,
  checkedIn,
  statusLabel,
  machineDot,
  machineOption,
  sortMachinesForSelection,
  resolveViewingMachineId,
  type MachineOption,
} from '../../lib/machine-context.js';
import type { SidebarCounts } from '../overview/overview-data.js';

export type MemoryService = Pick<
  CloudService,
  'getMachinesReadModel' | 'getMemoryReadModel' | 'getProjectsReadModel'
>;

const webAuth = (userId: string) => ({ userId, tokenId: 'web-session' });

export type MemoryHistoryRow = {
  generation: number;
  mode: MemoryReadModel['mode'];
  createdAt: string;
  when: string;
};

export type MemoryPerProjectRow = {
  projectId: string;
  name: string;
  fileCount: number;
};

export type MemoryView =
  | { kind: 'error' }
  | { kind: 'no-machines' }
  | { kind: 'choose-machine'; machines: MachineOption[]; anyCheckedIn: boolean }
  | {
      kind: 'ready';
      viewing: {
        machineId: string;
        name: string;
        statusLabel: string;
        dot: 'ready' | 'attention' | 'neutral';
      };
      machines: MachineOption[];
      sidebar: SidebarCounts;
      mode: MemoryReadModel['mode'];
      backedUp: boolean;
      /** True only when the SELECTED, checked-in machine's own local backup manifest is behind
       *  (contract: account Cloud-backup truth is kept separate from machine-level local-backup
       *  truth — never collapsed into one boolean). */
      machineGap: boolean;
      statusSentence: string;
      modeSentence: string;
      hasRecoveryMethod: boolean;
      needsRecoveryMethod: boolean;
      history: MemoryHistoryRow[];
      /** Standard-only; always null for Protected (contract §1/§7/§8 — never fabricated). */
      perProject: MemoryPerProjectRow[] | null;
      /** Protected-only honest substitute: how many Projects the Cloud registry independently
       *  knows about, NOT derived from decrypted Memory content. */
      protectedProjectsKnownCount: number;
      dockCommand: string;
      dockHint: string;
    };

export const loadMemoryView = async (
  service: MemoryService,
  user: WebUser,
  requestedMachine: string | undefined,
): Promise<MemoryView> => {
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
  if (!viewingId)
    return { kind: 'choose-machine', machines: options, anyCheckedIn };

  const viewing = active.find((m) => m.machineId === viewingId)!;
  const viewingName = displayName(viewing);
  const viewingCheckedIn = checkedIn(viewing);

  let memory: MemoryReadModel;
  let projects;
  try {
    const [m, p] = await Promise.all([
      service.getMemoryReadModel(auth),
      service.getProjectsReadModel(auth),
    ]);
    memory = m;
    projects = p.projects;
  } catch (error) {
    if (
      error instanceof CloudServiceError &&
      error.code === 'machine-not-found'
    )
      return { kind: 'choose-machine', machines: options, anyCheckedIn };
    return { kind: 'error' };
  }

  const backedUp = memory.latestBackupAt !== null;
  const machineGap = viewingCheckedIn && !viewing.memoryBackedUp;

  const statusSentence = !backedUp
    ? 'Not backed up yet.'
    : machineGap
      ? `Latest Cloud backup ${relative(memory.latestBackupAt)}. ${viewingName} has Memory changes that aren't backed up yet.`
      : `Backed up — latest ${relative(memory.latestBackupAt)}.`;

  const modeSentence =
    memory.mode === 'protected'
      ? "Protected: encrypted on your machine. STAK stores ciphertext and can't read it."
      : memory.mode === 'standard'
        ? "Standard: private to your account. STAK's service can read it to deliver it."
        : 'No Memory mode set yet.';

  const needsRecoveryMethod =
    memory.mode === 'protected' && !memory.hasRecoveryMethod;

  const history: MemoryHistoryRow[] = memory.backups.map((b) => ({
    generation: b.generation,
    mode: b.mode,
    createdAt: b.createdAt,
    when: relative(b.createdAt),
  }));

  const nameById = new Map(projects.map((p) => [p.projectId, p.name]));
  const perProject: MemoryPerProjectRow[] | null =
    memory.mode === 'standard' && memory.perProject
      ? memory.perProject.map((row) => ({
          projectId: row.projectId,
          name: nameById.get(row.projectId) ?? row.projectId,
          fileCount: row.fileCount,
        }))
      : null;

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
      skills: '',
      memory: backedUp ? { n: 'Backed up', tone: 'ready' } : { n: '', tone: 'neutral' },
      projects: '',
      machines: String(active.length),
      stacks: '',
    },
    mode: memory.mode,
    backedUp,
    machineGap,
    statusSentence,
    modeSentence,
    hasRecoveryMethod: memory.hasRecoveryMethod,
    needsRecoveryMethod,
    history,
    perProject,
    protectedProjectsKnownCount: projects.length,
    dockCommand: 'stak memory backup',
    dockHint: machineGap
      ? `Backs up ${viewingName}'s current Memory to STAK Cloud.`
      : 'Creates a new backup generation.',
  };
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/web && npx vitest run app/memory/memory-data.test.ts`
Expected: PASS (15 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/memory/memory-data.ts apps/web/app/memory/memory-data.test.ts
git commit -m "feat(p6): Memory view-model (loadMemoryView)"
```

---

### Task 3: Memory page shell + route

**Files:**
- Create: `apps/web/app/memory/(dashboard)/layout.tsx`
- Create: `apps/web/app/memory/(dashboard)/memory.css`
- Create: `apps/web/app/memory/(dashboard)/page.tsx`

**Interfaces:**
- Consumes: `loadMemoryView` from `../memory-data.js` (Task 2), `AppSidebar`/`CommandDock`/`MachineChooser`/`ShellNotice` from `../../_components/*`, `getCloudService` from `../../../lib/cloud-service`, `getSessionUser`/`displayNameOf` from `../../../lib/session`.
- Produces: the `/memory` route.

- [ ] **Step 1: Write the layout**

```tsx
// apps/web/app/memory/(dashboard)/layout.tsx
import type { ReactNode } from 'react';

import '../../overview/shell.css';

/**
 * Next.js scopes layouts per route segment, so `/memory` — a plain page sibling to the
 * CLI-driven `/memory/protect` and `/memory/recover` WebAuthn flows, which keep their own
 * `SiteHeader`/`globals.css` shell — needs the `.stak` wrapper WITHOUT also wrapping those
 * siblings. Putting this page inside a `(dashboard)` route group (invisible in the URL: this
 * still serves `/memory`) gives it its own layout slot that `protect/` and `recover/`, which
 * live outside the group, never inherit. Mirrors `apps/web/app/skills/layout.tsx`'s reason for
 * existing, adapted for the extra nested-route conflict `/memory` has and `/skills` doesn't.
 */
export default function MemoryDashboardLayout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <>
      <link
        rel="preconnect"
        href="https://fonts.googleapis.com"
      />
      <link
        href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap"
        rel="stylesheet"
      />
      <div className="stak">{children}</div>
    </>
  );
}
```

Check `apps/web/app/skills/layout.tsx` and `apps/web/app/overview/layout.tsx` for the exact font-link markup before finalizing this file — copy it verbatim rather than retyping, so all three shells stay byte-identical.

- [ ] **Step 2: Write the page**

```tsx
// apps/web/app/memory/(dashboard)/page.tsx
import { redirect } from 'next/navigation';

import { AppSidebar } from '../../_components/app-sidebar';
import { CommandDock } from '../../_components/command-dock';
import { MachineChooser } from '../../_components/machine-chooser';
import { ShellNotice } from '../../_components/shell-notice';
import { getCloudService } from '../../../lib/cloud-service';
import { displayNameOf, getSessionUser } from '../../../lib/session';
import { relative } from '../../../lib/machine-context';

import { loadMemoryView } from '../memory-data';
import './memory.css';

export const dynamic = 'force-dynamic';

const DOT: Record<'ready' | 'attention' | 'neutral', string> = {
  ready: '#84cb8e',
  attention: '#ee7a3b',
  neutral: '#a19d94',
};

const dateOnly = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });

export default async function MemoryPage({
  searchParams,
}: {
  searchParams: Promise<{ machine?: string }>;
}) {
  const user = await getSessionUser();
  if (!user) redirect('/');
  const { machine } = await searchParams;
  const handle = user.githubUsername ?? displayNameOf(user);
  const view = await loadMemoryView(getCloudService(), user, machine);

  if (view.kind === 'error')
    return (
      <ShellNotice active="memory" handle={handle} title="Couldn't load Memory">
        <p>
          STAK Cloud didn&apos;t respond. This is a temporary problem, not a
          change to your data. Reload to try again.
        </p>
      </ShellNotice>
    );
  if (view.kind === 'no-machines')
    return (
      <ShellNotice active="memory" handle={handle} title="No machines yet">
        <p>
          Connect this computer to your account first. In your terminal, run{' '}
          <code style={{ fontFamily: 'var(--mono)' }}>stak login</code>, then{' '}
          <code style={{ fontFamily: 'var(--mono)' }}>stak scan</code>.
        </p>
      </ShellNotice>
    );
  if (view.kind === 'choose-machine')
    return (
      <ShellNotice active="memory" handle={handle} title="Choose a machine">
        <p>
          Memory shows this machine&apos;s own backup state alongside your
          account&apos;s Cloud backup. Pick the machine you want to view.
        </p>
        {!view.anyCheckedIn ? (
          <p>
            None of your machines has checked in yet. Run{' '}
            <code style={{ fontFamily: 'var(--mono)' }}>stak status</code> on
            the machine you want, then pick it here.
          </p>
        ) : null}
        <MachineChooser options={view.machines} basePath="/memory" />
      </ShellNotice>
    );

  const statusDot: 'ready' | 'attention' | 'neutral' = !view.backedUp
    ? 'neutral'
    : view.machineGap || view.needsRecoveryMethod
      ? 'attention'
      : 'ready';

  return (
    <div className="stak-frame">
      <AppSidebar
        active="memory"
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
              style={{ width: 10, height: 10, background: DOT[statusDot] }}
              aria-hidden
            />
            <span>{view.statusSentence}</span>
          </div>
          <span className="stak-sub">{view.modeSentence}</span>
        </div>

        <div className="stak-summaries">
          <div className="stak-sum">
            <span className="k">MODE</span>
            <span className="v" style={{ fontSize: 15 }}>
              {view.mode === 'protected'
                ? 'Protected'
                : view.mode === 'standard'
                  ? 'Standard'
                  : 'Not set'}
            </span>
            <span className="d">Account-wide — never per project.</span>
          </div>
          <div className="stak-sum">
            <span className="k">RECOVERY</span>
            <span className="v" style={{ fontSize: 15 }}>
              {view.hasRecoveryMethod ? 'Configured' : 'Not configured'}
            </span>
            <span className="d">
              {view.needsRecoveryMethod
                ? 'Needs attention — add a passkey or recovery file.'
                : view.mode === 'protected'
                  ? 'A passkey or recovery file unlocks your backups.'
                  : ' '}
            </span>
          </div>
          <div className="stak-sum">
            <span className="k">ON {view.viewing.name.toUpperCase()}</span>
            <span className="v" style={{ fontSize: 15 }}>
              {view.machineGap ? 'Changes not backed up' : 'Up to date'}
            </span>
            <span className="d">{view.viewing.statusLabel}</span>
          </div>
          <div className="stak-sum">
            <span className="k">LATEST BACKUP</span>
            <span className="v" style={{ fontSize: 15 }}>
              {view.backedUp ? view.history[0]!.when : 'None yet'}
            </span>
            <span className="d">
              {view.backedUp
                ? `Generation ${view.history[0]!.generation}`
                : ' '}
            </span>
          </div>
        </div>

        <div className="stak-body">
          <div className="stak-col">
            <section className="stak-mem-section">
              <h2>Backup history</h2>
              {view.history.length === 0 ? (
                <p className="stak-mem-empty">No backups yet.</p>
              ) : (
                <ul className="stak-mem-history">
                  {view.history.map((h) => (
                    <li key={h.generation}>
                      <span className="when">{h.when}</span>
                      <span className="mode">
                        {h.mode === 'protected' ? 'Protected' : 'Standard'}
                      </span>
                      <span className="gen">
                        Generation {h.generation} · {dateOnly(h.createdAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {view.mode === 'standard' ? (
              <section className="stak-mem-section">
                <h2>Projects in this backup</h2>
                {view.perProject === null || view.perProject.length === 0 ? (
                  <p className="stak-mem-empty">
                    No per-project detail is available for this backup.
                  </p>
                ) : (
                  <>
                    <p className="stak-mem-caption">
                      As of your latest Standard backup
                      {view.backedUp ? ` (${view.history[0]!.when})` : ''}.
                    </p>
                    <ul className="stak-mem-projects">
                      {view.perProject.map((p) => (
                        <li key={p.projectId}>
                          <span className="name">{p.name}</span>
                          <span className="count">
                            {p.fileCount} file{p.fileCount === 1 ? '' : 's'}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </section>
            ) : view.mode === 'protected' ? (
              <section className="stak-mem-section">
                <h2>Protected</h2>
                <p className="stak-mem-protected">
                  Encrypted on your machine. STAK stores ciphertext and
                  can&apos;t read your encrypted Memory content.
                </p>
                <p className="stak-mem-protected">
                  {view.protectedProjectsKnownCount} project
                  {view.protectedProjectsKnownCount === 1 ? '' : 's'} known to
                  STAK.
                </p>
              </section>
            ) : null}
          </div>
        </div>

        <CommandDock
          machineName={view.viewing.name}
          command={view.dockCommand}
          hint={view.dockHint}
        />
      </main>
    </div>
  );
}
```

- [ ] **Step 3: Write the CSS**

```css
/* apps/web/app/memory/(dashboard)/memory.css — extends shell.css tokens, Memory-specific only. */
.stak-mem-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.stak-mem-empty,
.stak-mem-caption {
  font-size: 13px;
  color: var(--dim);
  margin: 0;
}
.stak-mem-history,
.stak-mem-projects {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
}
.stak-mem-history li {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  gap: 10px;
  padding: 7px 0;
  border-bottom: 1px solid #1c1b19;
  font-size: 13px;
  align-items: baseline;
}
.stak-mem-history .mode {
  color: var(--faint);
  font: 500 11.5px var(--mono);
}
.stak-mem-history .gen {
  color: var(--dim);
  font: 11.5px var(--mono);
  text-align: right;
}
.stak-mem-projects li {
  display: flex;
  justify-content: space-between;
  padding: 6px 0;
  border-bottom: 1px solid #1c1b19;
  font-size: 13px;
}
.stak-mem-projects .count {
  color: var(--faint);
  font: 12px var(--mono);
}
.stak-mem-protected {
  font-size: 13px;
  color: var(--muted);
  max-width: 560px;
  line-height: 1.6;
  margin: 0;
}
```

- [ ] **Step 4: Verify the route compiles**

Run: `cd apps/web && npx tsc --noEmit -p .`
Expected: no new type errors from `app/memory/(dashboard)/*` or `app/memory/memory-data.ts`.

- [ ] **Step 5: Commit**

```bash
git add "apps/web/app/memory/(dashboard)" apps/web/app/memory/memory-data.ts apps/web/app/memory/memory-data.test.ts
git commit -m "feat(p6): /memory page — status, mode, recovery, backup history"
```

---

### Task 4: Projects view-model (`projects-data.ts`)

**Files:**
- Create: `apps/web/app/projects/projects-data.ts`
- Test: `apps/web/app/projects/projects-data.test.ts`

**Interfaces:**
- Consumes: `CloudService['getMachinesReadModel' | 'getProjectsReadModel']`, `cliProjectSelector`/`presenceLabel`/`lifecycleLabel` from `../../lib/project-presentation.js` (Task 1), machine-context helpers, `SidebarCounts`, `WebUser`.
- Produces: `ProjectsService` type, `ProjectRow` type, `STATUS_FILTERS`/`filterProjectRows`, `loadProjectsList(service, user, requestedMachine): Promise<ProjectsListView>`.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/web/app/projects/projects-data.test.ts
import { describe, expect, it } from 'vitest';

import type { MachineSummary, MachinesReadModel, ProjectSummary } from '@stack/spec';

import {
  filterProjectRows,
  loadProjectsList,
  type ProjectsService,
} from './projects-data.js';

const USER = { id: 'user-1' };
const A1 = '00000000-0000-4000-8000-0000000000a1';
const nowIso = (minsAgo: number) =>
  new Date(Date.now() - minsAgo * 60_000).toISOString();

const machine = (over: Partial<MachineSummary> = {}): MachineSummary => ({
  machineId: A1,
  name: 'Dell',
  platform: 'win32',
  arch: 'x64',
  agentsDetected: ['Claude Code'],
  firstSeenAt: nowIso(60 * 24 * 10),
  lastCheckinAt: nowIso(12),
  memoryBackedUp: true,
  revoked: false,
  status: 'up-to-date',
  updatesWaiting: [],
  projectsPresent: 1,
  ...over,
});

const project = (over: Partial<ProjectSummary> = {}): ProjectSummary => ({
  projectId: 'prj_abc',
  name: 'stak',
  lifecycle: 'active',
  presentOn: [A1],
  fileCount: 4,
  lastBackupAt: null,
  ...over,
});

const service = (opts: {
  machines?: MachineSummary[];
  projects?: ProjectSummary[];
  throwMachines?: boolean;
  throwProjects?: boolean;
}): ProjectsService => ({
  getMachinesReadModel: async (): Promise<MachinesReadModel> => {
    if (opts.throwMachines) throw new Error('offline');
    return { machines: opts.machines ?? [machine()] };
  },
  getProjectsReadModel: async () => {
    if (opts.throwProjects) throw new Error('offline');
    return { projects: opts.projects ?? [project()] };
  },
});

const ready = (view: Awaited<ReturnType<typeof loadProjectsList>>) => {
  if (view.kind !== 'ready')
    throw new Error(`expected ready, got ${view.kind}`);
  return view;
};

describe('loadProjectsList', () => {
  it('returns error when machines fail to load', async () => {
    const view = await loadProjectsList(
      service({ throwMachines: true }),
      USER,
      undefined,
    );
    expect(view.kind).toBe('error');
  });

  it('returns no-machines with zero active machines', async () => {
    const view = await loadProjectsList(
      service({ machines: [machine({ revoked: true })] }),
      USER,
      undefined,
    );
    expect(view.kind).toBe('no-machines');
  });

  it('returns a truthful empty state with zero Projects', async () => {
    const view = ready(
      await loadProjectsList(service({ projects: [] }), USER, A1),
    );
    expect(view.rows).toEqual([]);
    expect(view.statusSentence).not.toMatch(/writes memory/i);
  });

  it('marks a Project present on the viewing machine', async () => {
    const view = ready(
      await loadProjectsList(
        service({ projects: [project({ presentOn: [A1] })] }),
        USER,
        A1,
      ),
    );
    expect(view.rows[0]!.presence).toBe('On this machine');
  });

  it('marks a Project absent from the viewing machine', async () => {
    const view = ready(
      await loadProjectsList(
        service({ projects: [project({ presentOn: [] })] }),
        USER,
        A1,
      ),
    );
    expect(view.rows[0]!.presence).toBe('Not on this machine');
  });

  it('labels lifecycle Active/Archived using the frozen words', async () => {
    const view = ready(
      await loadProjectsList(
        service({
          projects: [
            project({ projectId: 'prj_1', lifecycle: 'active' }),
            project({ projectId: 'prj_2', lifecycle: 'archived' }),
          ],
        }),
        USER,
        A1,
      ),
    );
    const byId = new Map(view.rows.map((r) => [r.projectId, r.lifecycleLabel]));
    expect(byId.get('prj_1')).toBe('Active');
    expect(byId.get('prj_2')).toBe('Archived');
  });

  it('never labels fileCount null as zero (Protected-mode-derived unavailability)', async () => {
    const view = ready(
      await loadProjectsList(
        service({ projects: [project({ fileCount: null })] }),
        USER,
        A1,
      ),
    );
    expect(view.rows[0]!.fileCountLabel).toBe('Unavailable');
  });

  it('filters by lifecycle', async () => {
    const rows = ready(
      await loadProjectsList(
        service({
          projects: [
            project({ projectId: 'prj_1', lifecycle: 'active' }),
            project({ projectId: 'prj_2', lifecycle: 'archived' }),
          ],
        }),
        USER,
        A1,
      ),
    ).rows;
    expect(filterProjectRows(rows, 'archived', '')).toHaveLength(1);
    expect(filterProjectRows(rows, 'active', '')).toHaveLength(1);
    expect(filterProjectRows(rows, 'all', '')).toHaveLength(2);
  });

  it('filters by search query against the display name', async () => {
    const rows = ready(
      await loadProjectsList(
        service({
          projects: [
            project({ projectId: 'prj_1', name: 'stak' }),
            project({ projectId: 'prj_2', name: 'other' }),
          ],
        }),
        USER,
        A1,
      ),
    ).rows;
    expect(filterProjectRows(rows, 'all', 'sta')).toHaveLength(1);
  });

  it('computes a unique-else-id CLI selector per row', async () => {
    const view = ready(
      await loadProjectsList(
        service({
          projects: [
            project({ projectId: 'prj_1', name: 'api' }),
            project({ projectId: 'prj_2', name: 'api' }),
          ],
        }),
        USER,
        A1,
      ),
    );
    expect(view.rows.every((r) => r.cliSelector === r.projectId)).toBe(true);
  });

  it('returns error when projects read model throws', async () => {
    const view = await loadProjectsList(
      service({ throwProjects: true }),
      USER,
      A1,
    );
    expect(view.kind).toBe('error');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/web && npx vitest run app/projects/projects-data.test.ts`
Expected: FAIL with "Cannot find module './projects-data.js'".

- [ ] **Step 3: Write the implementation**

```ts
// apps/web/app/projects/projects-data.ts
import type { CloudService } from '@stack/cloud-server';
import type { ProjectSummary } from '@stack/spec';

import type { WebUser } from '../../lib/session.js';
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
import {
  cliProjectSelector,
  lifecycleLabel,
  presenceLabel,
} from '../../lib/project-presentation.js';
import type { SidebarCounts } from '../overview/overview-data.js';

export type ProjectsService = Pick<
  CloudService,
  'getMachinesReadModel' | 'getProjectsReadModel'
>;

const webAuth = (userId: string) => ({ userId, tokenId: 'web-session' });

export type ProjectRow = {
  projectId: string;
  name: string;
  lifecycle: ProjectSummary['lifecycle'];
  lifecycleLabel: 'Active' | 'Archived';
  presence: 'On this machine' | 'Not on this machine';
  fileCountLabel: string;
  cliSelector: string;
};

export const STATUS_FILTERS = ['all', 'active', 'archived'] as const;
export type ProjectStatusFilter = (typeof STATUS_FILTERS)[number];

export const filterProjectRows = (
  rows: ProjectRow[],
  status: ProjectStatusFilter,
  query: string,
): ProjectRow[] => {
  const q = query.trim().toLowerCase();
  return rows.filter((r) => {
    if (q && !r.name.toLowerCase().includes(q)) return false;
    if (status === 'all') return true;
    return r.lifecycle === status;
  });
};

export type ProjectsListView =
  | { kind: 'error' }
  | { kind: 'no-machines' }
  | { kind: 'choose-machine'; machines: MachineOption[]; anyCheckedIn: boolean }
  | {
      kind: 'ready';
      viewing: {
        machineId: string;
        name: string;
        statusLabel: string;
        dot: 'ready' | 'attention' | 'neutral';
      };
      machines: MachineOption[];
      sidebar: SidebarCounts;
      statusSentence: string;
      rows: ProjectRow[];
    };

export const loadProjectsList = async (
  service: ProjectsService,
  user: WebUser,
  requestedMachine: string | undefined,
): Promise<ProjectsListView> => {
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
  if (!viewingId)
    return { kind: 'choose-machine', machines: options, anyCheckedIn };

  const viewing = active.find((m) => m.machineId === viewingId)!;

  let projects: ProjectSummary[];
  try {
    const result = await service.getProjectsReadModel(auth);
    projects = result.projects;
  } catch {
    return { kind: 'error' };
  }

  const allForSelector = projects.map((p) => ({
    projectId: p.projectId,
    ...(p.name ? { name: p.name } : {}),
  }));

  const rows: ProjectRow[] = projects
    .map((p) => ({
      projectId: p.projectId,
      name: p.name ?? p.projectId,
      lifecycle: p.lifecycle,
      lifecycleLabel: lifecycleLabel(p.lifecycle),
      presence: presenceLabel(p.presentOn, viewingId),
      fileCountLabel:
        p.fileCount === null ? 'Unavailable' : `${p.fileCount} file${p.fileCount === 1 ? '' : 's'}`,
      cliSelector: cliProjectSelector(p.projectId, p.name, allForSelector),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const activeCount = rows.filter((r) => r.lifecycle === 'active').length;
  const notHereCount = rows.filter(
    (r) => r.presence === 'Not on this machine' && r.lifecycle === 'active',
  ).length;

  const statusSentence =
    rows.length === 0
      ? "No Projects yet. STAK learns about Projects when a machine checks in and reports them — run `stak status` on a machine with Projects STAK can see."
      : notHereCount === 0
        ? `${activeCount} active Project${activeCount === 1 ? '' : 's'}, all on ${displayName(viewing)}.`
        : `${activeCount} active Project${activeCount === 1 ? '' : 's'}; ${notHereCount} not on ${displayName(viewing)}.`;

  return {
    kind: 'ready',
    viewing: {
      machineId: viewingId,
      name: displayName(viewing),
      statusLabel: statusLabel(viewing),
      dot: machineDot(viewing),
    },
    machines: options,
    sidebar: {
      overview: { n: '', tone: 'neutral' },
      skills: '',
      memory: { n: '', tone: 'neutral' },
      projects: String(rows.length),
      machines: String(active.length),
      stacks: '',
    },
    statusSentence,
    rows,
  };
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/web && npx vitest run app/projects/projects-data.test.ts`
Expected: PASS (11 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/projects/projects-data.ts apps/web/app/projects/projects-data.test.ts
git commit -m "feat(p6): Projects list view-model (loadProjectsList)"
```

---

### Task 5: Projects lifecycle server action

**Files:**
- Create: `apps/web/app/projects/actions.ts`

**Interfaces:**
- Consumes: `getCloudService` from `../../lib/cloud-service`, `getSessionUser` from `../../lib/session`, `CloudServiceError` from `@stack/cloud-server`.
- Produces: `setProjectLifecycleAction(input: { projectId: string; lifecycle: 'active' | 'archived' }): Promise<{ ok: true } | { ok: false; error: string }>` — consumed by Task 6's client component and Task 7's detail page.

- [ ] **Step 1: Write the implementation**

(No test file: this mirrors `apps/web/app/skills/actions.ts`'s existing, untested `'use server'` action pattern exactly — those Server Actions are integration-tested indirectly through the browser dogfood step, Task 9, not unit-tested, matching the established P5 convention.)

```ts
// apps/web/app/projects/actions.ts
'use server';

import { CloudServiceError } from '@stack/cloud-server';

import { getCloudService } from '../../lib/cloud-service';
import { getSessionUser } from '../../lib/session';

const notSignedIn = { ok: false as const, error: 'You must sign in first.' };

export async function setProjectLifecycleAction(input: {
  projectId: string;
  lifecycle: 'active' | 'archived';
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const user = await getSessionUser();
  if (!user) return notSignedIn;
  try {
    await getCloudService().setProjectLifecycle(
      { userId: user.id, tokenId: 'web-session' },
      input.projectId,
      input.lifecycle,
    );
    return { ok: true };
  } catch (error) {
    if (error instanceof CloudServiceError && error.code === 'project-not-found')
      return { ok: false, error: 'This Project no longer exists in your account.' };
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : `Could not ${input.lifecycle === 'archived' ? 'archive' : 'unarchive'} this Project.`,
    };
  }
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd apps/web && npx tsc --noEmit -p .`
Expected: no new errors referencing `app/projects/actions.ts`. (`CloudService.setProjectLifecycle`'s exact signature — `(user, projectId, lifecycle)`, not an object — is confirmed in `packages/cloud-server/src/product-service.ts:1006-1021`; a mismatched call shape here would fail this check.)

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/projects/actions.ts
git commit -m "feat(p6): Project archive/unarchive server action"
```

---

### Task 6: Projects list page + table + lifecycle button

**Files:**
- Create: `apps/web/app/projects/layout.tsx`
- Create: `apps/web/app/projects/projects.css`
- Create: `apps/web/app/projects/_components/project-lifecycle-button.tsx`
- Create: `apps/web/app/projects/_components/projects-table.tsx`
- Create: `apps/web/app/projects/page.tsx`

**Interfaces:**
- Consumes: `loadProjectsList`/`filterProjectRows`/`STATUS_FILTERS` (Task 4), `setProjectLifecycleAction` (Task 5), `AppSidebar`/`CommandDock`/`MachineChooser`/`ShellNotice`.
- Produces: the `/projects` route.

- [ ] **Step 1: Write the layout**

```tsx
// apps/web/app/projects/layout.tsx
import type { ReactNode } from 'react';

import '../overview/shell.css';

/** No nested routes exist under `/projects` (unlike `/memory`), so this is a plain layout —
 *  same shape as `apps/web/app/skills/layout.tsx`. Copy its exact font-link markup. */
export default function ProjectsLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link
        href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap"
        rel="stylesheet"
      />
      <div className="stak">{children}</div>
    </>
  );
}
```

- [ ] **Step 2: Write the lifecycle button**

```tsx
// apps/web/app/projects/_components/project-lifecycle-button.tsx
'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { setProjectLifecycleAction } from '../actions';

export function ProjectLifecycleButton({
  projectId,
  lifecycle,
}: {
  projectId: string;
  lifecycle: 'active' | 'archived';
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    const next = lifecycle === 'active' ? 'archived' : 'active';
    const result = await setProjectLifecycleAction({ projectId, lifecycle: next });
    setPending(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    router.refresh();
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-start' }}>
      <button
        type="button"
        className="stak-pill"
        onClick={toggle}
        disabled={pending}
        aria-label={lifecycle === 'active' ? 'Archive this Project' : 'Unarchive this Project'}
      >
        {pending ? '…' : lifecycle === 'active' ? 'Archive' : 'Unarchive'}
      </button>
      <span role="status" aria-live="polite" style={{ fontSize: 12.5, color: error ? '#e5776a' : 'transparent' }}>
        {error ?? ''}
      </span>
    </div>
  );
}
```

- [ ] **Step 3: Write the table**

```tsx
// apps/web/app/projects/_components/projects-table.tsx
'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';

import {
  STATUS_FILTERS,
  filterProjectRows,
  type ProjectRow,
  type ProjectStatusFilter,
} from '../projects-data';
import { ProjectLifecycleButton } from './project-lifecycle-button';

const FILTER_LABEL: Record<ProjectStatusFilter, string> = {
  all: 'All',
  active: 'Active',
  archived: 'Archived',
};

export function ProjectsTable({
  rows,
  machineName,
}: {
  rows: ProjectRow[];
  machineName: string;
}) {
  const [status, setStatus] = useState<ProjectStatusFilter>('all');
  const [query, setQuery] = useState('');
  const filtered = useMemo(
    () => filterProjectRows(rows, status, query),
    [rows, status, query],
  );

  const counts = useMemo(() => {
    const c: Record<ProjectStatusFilter, number> = { all: rows.length, active: 0, archived: 0 };
    for (const r of rows) c[r.lifecycle] += 1;
    return c;
  }, [rows]);

  return (
    <div className="stak-projects">
      <div className="stak-projects-toolbar" role="group" aria-label="Filter Projects">
        <div className="stak-projects-filters" role="radiogroup" aria-label="Lifecycle">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              role="radio"
              aria-checked={status === f}
              className={`stak-projects-chip${status === f ? ' active' : ''}`}
              onClick={() => setStatus(f)}
            >
              {FILTER_LABEL[f]} {counts[f]}
            </button>
          ))}
        </div>
        <input
          type="search"
          className="stak-projects-search"
          placeholder="Search Projects"
          aria-label="Search Projects by name"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <div className="stak-projects-head" role="row">
        <span>PROJECT</span>
        <span>LIFECYCLE</span>
        <span>ON {machineName.toUpperCase()}</span>
        <span>MEMORY</span>
        <span />
      </div>

      {rows.length === 0 ? (
        <p className="stak-projects-empty">
          No Projects yet. STAK learns about Projects when a machine checks
          in and reports them — run <code>stak status</code> on a machine
          with Projects STAK can see.
        </p>
      ) : filtered.length === 0 ? (
        <p className="stak-projects-empty">No Projects match this filter.</p>
      ) : (
        filtered.map((r) => (
          <div key={r.projectId} className="stak-projects-row">
            <Link href={`/projects/${r.projectId}`} className="stak-projects-name">
              <span className="n">{r.name}</span>
            </Link>
            <span className="stak-projects-lifecycle">{r.lifecycleLabel}</span>
            <span className="stak-projects-presence">{r.presence}</span>
            <span className="stak-projects-memory">{r.fileCountLabel}</span>
            <ProjectLifecycleButton projectId={r.projectId} lifecycle={r.lifecycle} />
          </div>
        ))
      )}
    </div>
  );
}
```

- [ ] **Step 4: Write the CSS**

```css
/* apps/web/app/projects/projects.css — extends shell.css tokens, mirrors skills.css structure. */
.stak-projects {
  display: flex;
  flex-direction: column;
}
.stak-projects-toolbar {
  display: flex;
  gap: 10px;
  align-items: center;
  padding: 0 28px 12px;
}
.stak-projects-filters {
  display: flex;
  border: 1px solid var(--line-2);
  border-radius: 6px;
  overflow: hidden;
}
.stak-projects-chip {
  padding: 6px 12px;
  font-size: 13px;
  color: var(--faint);
  background: none;
  border: none;
  border-left: 1px solid var(--line-2);
  cursor: pointer;
  font-family: var(--sans);
}
.stak-projects-chip:first-child {
  border-left: none;
}
.stak-projects-chip:hover:not(.active) {
  background: #171615;
  color: var(--ink);
}
.stak-projects-chip.active {
  background: #1e1d1b;
  color: var(--ink);
  font-weight: 500;
}
.stak-projects-search {
  margin-left: auto;
  width: 260px;
  padding: 7px 12px;
  border: 1px solid var(--chip);
  border-radius: 6px;
  background: #151413;
  color: var(--ink);
  font: 13px var(--sans);
}
.stak-projects-search::placeholder {
  color: var(--dim);
}
.stak-projects-search:hover {
  border-color: var(--faint);
}
.stak-projects-head,
.stak-projects-row {
  display: grid;
  grid-template-columns: 2.2fr 1fr 1.4fr 1fr auto;
  gap: 14px;
  padding: 9px 28px;
  align-items: center;
}
.stak-projects-head {
  border-top: 1px solid var(--line);
  border-bottom: 1px solid var(--line);
  font: 500 10.5px var(--mono);
  letter-spacing: 0.06em;
  color: var(--dim);
}
.stak-projects-row {
  border-bottom: 1px solid #1c1b19;
}
.stak-projects-row:hover {
  background: #171615;
}
.stak-projects-name {
  font: 500 13px var(--mono);
  color: inherit;
  text-decoration: none;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.stak-projects-name:hover {
  text-decoration: none;
}
.stak-projects-lifecycle,
.stak-projects-presence,
.stak-projects-memory {
  font-size: 12.5px;
  color: var(--muted);
}
.stak-projects-empty {
  padding: 24px 28px;
  color: var(--dim);
  font-size: 13.5px;
}
.stak-projects-chip:focus-visible,
.stak-projects-search:focus-visible,
.stak-projects-name:focus-visible {
  outline: 2px solid var(--orange);
  outline-offset: 2px;
}
```

- [ ] **Step 5: Write the page**

```tsx
// apps/web/app/projects/page.tsx
import { redirect } from 'next/navigation';

import { AppSidebar } from '../_components/app-sidebar';
import { CommandDock } from '../_components/command-dock';
import { MachineChooser } from '../_components/machine-chooser';
import { ShellNotice } from '../_components/shell-notice';
import { getCloudService } from '../../lib/cloud-service';
import { displayNameOf, getSessionUser } from '../../lib/session';

import { loadProjectsList } from './projects-data';
import { ProjectsTable } from './_components/projects-table';
import './projects.css';

export const dynamic = 'force-dynamic';

export default async function ProjectsPage({
  searchParams,
}: {
  searchParams: Promise<{ machine?: string }>;
}) {
  const user = await getSessionUser();
  if (!user) redirect('/');
  const { machine } = await searchParams;
  const handle = user.githubUsername ?? displayNameOf(user);
  const view = await loadProjectsList(getCloudService(), user, machine);

  if (view.kind === 'error')
    return (
      <ShellNotice active="projects" handle={handle} title="Couldn't load your Projects">
        <p>
          STAK Cloud didn&apos;t respond. This is a temporary problem, not a
          change to your data. Reload to try again.
        </p>
      </ShellNotice>
    );
  if (view.kind === 'no-machines')
    return (
      <ShellNotice active="projects" handle={handle} title="No machines yet">
        <p>
          Connect this computer to your account first. In your terminal, run{' '}
          <code style={{ fontFamily: 'var(--mono)' }}>stak login</code>, then{' '}
          <code style={{ fontFamily: 'var(--mono)' }}>stak scan</code>.
        </p>
      </ShellNotice>
    );
  if (view.kind === 'choose-machine')
    return (
      <ShellNotice active="projects" handle={handle} title="Choose a machine">
        <p>
          Projects shows presence from that machine&apos;s last check-in.
          Pick the machine you want to view.
        </p>
        {!view.anyCheckedIn ? (
          <p>
            None of your machines has checked in yet. Run{' '}
            <code style={{ fontFamily: 'var(--mono)' }}>stak status</code> on
            the machine you want, then pick it here.
          </p>
        ) : null}
        <MachineChooser options={view.machines} basePath="/projects" />
      </ShellNotice>
    );

  return (
    <div className="stak-frame">
      <AppSidebar
        active="projects"
        handle={handle}
        counts={view.sidebar}
        viewing={view.viewing}
        machines={view.machines}
      />
      <main className="stak-main">
        <div className="stak-head">
          <div className="stak-sentence">
            <span>{view.statusSentence}</span>
          </div>
        </div>
        <ProjectsTable rows={view.rows} machineName={view.viewing.name} />
        <CommandDock
          machineName={view.viewing.name}
          command="stak project map <project> <directory>"
          hint="Binds a Project to a local folder on this machine. Local only — never sent to STAK Cloud."
        />
      </main>
    </div>
  );
}
```

- [ ] **Step 6: Verify it compiles**

Run: `cd apps/web && npx tsc --noEmit -p .`
Expected: no new errors.

- [ ] **Step 7: Commit**

```bash
git add apps/web/app/projects/layout.tsx apps/web/app/projects/projects.css apps/web/app/projects/page.tsx apps/web/app/projects/_components
git commit -m "feat(p6): /projects list page — lifecycle, presence, archive/unarchive"
```

---

### Task 7: Project detail/mapping page

**Files:**
- Create: `apps/web/app/projects/[projectId]/project-detail-data.ts`
- Test: `apps/web/app/projects/[projectId]/project-detail-data.test.ts`
- Create: `apps/web/app/projects/[projectId]/page.tsx`

**Interfaces:**
- Consumes: `CloudService['getMachinesReadModel' | 'getProjectsReadModel' | 'getMemoryReadModel']`, `cliProjectSelector`/`presenceLabel`/`lifecycleLabel`, machine-context helpers, `setProjectLifecycleAction` (Task 5), `ProjectLifecycleButton` (Task 6).
- Produces: `ProjectDetailService` type, `loadProjectDetail(service, user, projectId, requestedMachine): Promise<ProjectDetailView>` — discriminated union adding a `not-found` kind beyond the list page's kinds.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/web/app/projects/[projectId]/project-detail-data.test.ts
import { describe, expect, it } from 'vitest';

import type {
  MachineSummary,
  MachinesReadModel,
  MemoryReadModel,
  ProjectSummary,
} from '@stack/spec';

import {
  loadProjectDetail,
  type ProjectDetailService,
} from './project-detail-data.js';

const USER = { id: 'user-1' };
const A1 = '00000000-0000-4000-8000-0000000000a1';
const nowIso = (minsAgo: number) =>
  new Date(Date.now() - minsAgo * 60_000).toISOString();

const machine = (over: Partial<MachineSummary> = {}): MachineSummary => ({
  machineId: A1,
  name: 'Dell',
  platform: 'win32',
  arch: 'x64',
  agentsDetected: ['Claude Code'],
  firstSeenAt: nowIso(60 * 24 * 10),
  lastCheckinAt: nowIso(12),
  memoryBackedUp: true,
  revoked: false,
  status: 'up-to-date',
  updatesWaiting: [],
  projectsPresent: 1,
  ...over,
});

const project = (over: Partial<ProjectSummary> = {}): ProjectSummary => ({
  projectId: 'prj_abc',
  name: 'stak',
  lifecycle: 'active',
  presentOn: [A1],
  fileCount: 4,
  lastBackupAt: null,
  ...over,
});

const memoryModel = (over: Partial<MemoryReadModel> = {}): MemoryReadModel => ({
  mode: 'standard',
  latestBackupAt: nowIso(60 * 24),
  backups: [],
  recoveryMethods: [],
  hasRecoveryMethod: false,
  perProject: [{ projectId: 'prj_abc', fileCount: 4 }],
  ...over,
});

const service = (opts: {
  machines?: MachineSummary[];
  projects?: ProjectSummary[];
  memory?: MemoryReadModel;
  throwMachines?: boolean;
}): ProjectDetailService => ({
  getMachinesReadModel: async (): Promise<MachinesReadModel> => {
    if (opts.throwMachines) throw new Error('offline');
    return { machines: opts.machines ?? [machine()] };
  },
  getProjectsReadModel: async () => ({ projects: opts.projects ?? [project()] }),
  getMemoryReadModel: async () => opts.memory ?? memoryModel(),
});

const ready = (view: Awaited<ReturnType<typeof loadProjectDetail>>) => {
  if (view.kind !== 'ready')
    throw new Error(`expected ready, got ${view.kind}`);
  return view;
};

describe('loadProjectDetail', () => {
  it('returns not-found for an unknown projectId', async () => {
    const view = await loadProjectDetail(service({}), USER, 'prj_missing', A1);
    expect(view.kind).toBe('not-found');
  });

  it('returns not-found for a Project not owned by this account (never 500s)', async () => {
    const view = await loadProjectDetail(
      service({ projects: [project({ projectId: 'prj_other' })] }),
      USER,
      'prj_abc',
      A1,
    );
    expect(view.kind).toBe('not-found');
  });

  it('returns error when machines fail to load', async () => {
    const view = await loadProjectDetail(
      service({ throwMachines: true }),
      USER,
      'prj_abc',
      undefined,
    );
    expect(view.kind).toBe('error');
  });

  it('renders identity, lifecycle, and presence for a known Project', async () => {
    const view = ready(
      await loadProjectDetail(service({}), USER, 'prj_abc', A1),
    );
    expect(view.name).toBe('stak');
    expect(view.lifecycleLabel).toBe('Active');
    expect(view.presence).toBe('On this machine');
    expect(view.technical.projectId).toBe('prj_abc');
  });

  it('shows Standard Memory file count for this one Project', async () => {
    const view = ready(
      await loadProjectDetail(
        service({ memory: memoryModel({ mode: 'standard', perProject: [{ projectId: 'prj_abc', fileCount: 9 }] }) }),
        USER,
        'prj_abc',
        A1,
      ),
    );
    expect(view.memoryFact).toBe('9 files');
  });

  it('never fabricates a Protected per-project file count', async () => {
    const view = ready(
      await loadProjectDetail(
        service({ memory: memoryModel({ mode: 'protected', perProject: null }) }),
        USER,
        'prj_abc',
        A1,
      ),
    );
    expect(view.memoryFact).toBe('Unavailable — Protected Memory');
  });

  it('computes the same unique-else-id CLI selector as the list page', async () => {
    const view = ready(
      await loadProjectDetail(
        service({
          projects: [
            project({ projectId: 'prj_abc', name: 'api' }),
            project({ projectId: 'prj_other', name: 'api' }),
          ],
        }),
        USER,
        'prj_abc',
        A1,
      ),
    );
    expect(view.cliSelector).toBe('prj_abc');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/web && npx vitest run "app/projects/[projectId]/project-detail-data.test.ts"`
Expected: FAIL with "Cannot find module './project-detail-data.js'".

- [ ] **Step 3: Write the implementation**

```ts
// apps/web/app/projects/[projectId]/project-detail-data.ts
import type { CloudService } from '@stack/cloud-server';
import type { MemoryReadModel, ProjectSummary } from '@stack/spec';

import type { WebUser } from '../../../lib/session.js';
import {
  machineOption,
  resolveViewingMachineId,
  sortMachinesForSelection,
  statusLabel,
  machineDot,
  displayName,
  checkedIn,
  type MachineOption,
} from '../../../lib/machine-context.js';
import {
  cliProjectSelector,
  lifecycleLabel,
  presenceLabel,
} from '../../../lib/project-presentation.js';

export type ProjectDetailService = Pick<
  CloudService,
  'getMachinesReadModel' | 'getProjectsReadModel' | 'getMemoryReadModel'
>;

const webAuth = (userId: string) => ({ userId, tokenId: 'web-session' });

export type ProjectDetailView =
  | { kind: 'error' }
  | { kind: 'not-found' }
  | { kind: 'no-machines' }
  | { kind: 'choose-machine'; machines: MachineOption[]; anyCheckedIn: boolean }
  | {
      kind: 'ready';
      viewing: {
        machineId: string;
        name: string;
        statusLabel: string;
        dot: 'ready' | 'attention' | 'neutral';
      };
      machines: MachineOption[];
      name: string;
      lifecycle: ProjectSummary['lifecycle'];
      lifecycleLabel: 'Active' | 'Archived';
      presence: 'On this machine' | 'Not on this machine';
      memoryFact: string;
      cliSelector: string;
      technical: { projectId: string };
    };

const memoryFactFor = (
  memory: MemoryReadModel,
  projectId: string,
): string => {
  if (memory.mode === 'protected') return 'Unavailable — Protected Memory';
  if (memory.mode !== 'standard' || !memory.perProject) return 'Not available';
  const row = memory.perProject.find((p) => p.projectId === projectId);
  if (!row) return 'Not available';
  return `${row.fileCount} file${row.fileCount === 1 ? '' : 's'}`;
};

export const loadProjectDetail = async (
  service: ProjectDetailService,
  user: WebUser,
  projectId: string,
  requestedMachine: string | undefined,
): Promise<ProjectDetailView> => {
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
  if (!viewingId)
    return { kind: 'choose-machine', machines: options, anyCheckedIn };

  const viewing = active.find((m) => m.machineId === viewingId)!;

  let projects: ProjectSummary[];
  let memory: MemoryReadModel;
  try {
    const [p, m] = await Promise.all([
      service.getProjectsReadModel(auth),
      service.getMemoryReadModel(auth),
    ]);
    projects = p.projects;
    memory = m;
  } catch {
    return { kind: 'error' };
  }

  const project = projects.find((p) => p.projectId === projectId);
  if (!project) return { kind: 'not-found' };

  const allForSelector = projects.map((p) => ({
    projectId: p.projectId,
    ...(p.name ? { name: p.name } : {}),
  }));

  return {
    kind: 'ready',
    viewing: {
      machineId: viewingId,
      name: displayName(viewing),
      statusLabel: statusLabel(viewing),
      dot: machineDot(viewing),
    },
    machines: options,
    name: project.name ?? project.projectId,
    lifecycle: project.lifecycle,
    lifecycleLabel: lifecycleLabel(project.lifecycle),
    presence: presenceLabel(project.presentOn, viewingId),
    memoryFact: memoryFactFor(memory, projectId),
    cliSelector: cliProjectSelector(project.projectId, project.name, allForSelector),
    technical: { projectId: project.projectId },
  };
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/web && npx vitest run "app/projects/[projectId]/project-detail-data.test.ts"`
Expected: PASS (7 tests)

- [ ] **Step 5: Write the page**

```tsx
// apps/web/app/projects/[projectId]/page.tsx
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { AppSidebar } from '../../_components/app-sidebar';
import { CommandDock } from '../../_components/command-dock';
import { MachineChooser } from '../../_components/machine-chooser';
import { ShellNotice } from '../../_components/shell-notice';
import { getCloudService } from '../../../lib/cloud-service';
import { displayNameOf, getSessionUser } from '../../../lib/session';

import { loadProjectDetail } from './project-detail-data';
import { ProjectLifecycleButton } from '../_components/project-lifecycle-button';
import '../projects.css';

export const dynamic = 'force-dynamic';

const PLACEHOLDER_SIDEBAR = {
  overview: { n: '', tone: 'neutral' as const },
  skills: '',
  memory: { n: '', tone: 'neutral' as const },
  projects: '',
  machines: '',
  stacks: '',
};

export default async function ProjectDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ machine?: string }>;
}) {
  const user = await getSessionUser();
  if (!user) redirect('/');
  const { projectId } = await params;
  const { machine } = await searchParams;
  const handle = user.githubUsername ?? displayNameOf(user);
  const view = await loadProjectDetail(getCloudService(), user, projectId, machine);

  if (view.kind === 'error')
    return (
      <ShellNotice active="projects" handle={handle} title="Couldn't load this Project">
        <p>
          STAK Cloud didn&apos;t respond. This is a temporary problem, not a
          change to your data. Reload to try again.
        </p>
      </ShellNotice>
    );
  if (view.kind === 'not-found')
    return (
      <ShellNotice active="projects" handle={handle} title="Project not found">
        <p>This Project doesn&apos;t exist, or isn&apos;t in your account.</p>
        <p>
          <Link href="/projects">Back to Projects</Link>
        </p>
      </ShellNotice>
    );
  if (view.kind === 'no-machines')
    return (
      <ShellNotice active="projects" handle={handle} title="No machines yet">
        <p>
          Connect this computer to your account first. In your terminal, run{' '}
          <code style={{ fontFamily: 'var(--mono)' }}>stak login</code>, then{' '}
          <code style={{ fontFamily: 'var(--mono)' }}>stak scan</code>.
        </p>
      </ShellNotice>
    );
  if (view.kind === 'choose-machine')
    return (
      <ShellNotice active="projects" handle={handle} title="Choose a machine">
        <p>This Project&apos;s presence is shown relative to one machine. Pick the machine you want to view.</p>
        {!view.anyCheckedIn ? (
          <p>
            None of your machines has checked in yet. Run{' '}
            <code style={{ fontFamily: 'var(--mono)' }}>stak status</code> on
            the machine you want, then pick it here.
          </p>
        ) : null}
        <MachineChooser options={view.machines} basePath={`/projects/${projectId}`} />
      </ShellNotice>
    );

  return (
    <div className="stak-frame">
      <AppSidebar
        active="projects"
        handle={handle}
        counts={PLACEHOLDER_SIDEBAR}
        viewing={view.viewing}
        machines={view.machines}
      />
      <main className="stak-main">
        <div className="stak-head">
          <span style={{ fontSize: 12.5, color: 'var(--dim)' }}>
            <Link href="/projects" style={{ color: 'inherit' }}>
              Projects
            </Link>{' '}
            / {view.name}
          </span>
          <div className="stak-sentence">
            <span>{view.name}</span>
          </div>
          <span className="stak-sub">{view.lifecycleLabel}</span>
        </div>

        <div className="stak-summaries">
          <div className="stak-sum">
            <span className="k">LIFECYCLE</span>
            <span className="v" style={{ fontSize: 15 }}>{view.lifecycleLabel}</span>
            <span className="d">Archive is organizational only — Memory is preserved.</span>
          </div>
          <div className="stak-sum">
            <span className="k">ON {view.viewing.name.toUpperCase()}</span>
            <span className="v" style={{ fontSize: 15 }}>{view.presence}</span>
            <span className="d">{view.viewing.statusLabel}</span>
          </div>
          <div className="stak-sum">
            <span className="k">MEMORY</span>
            <span className="v" style={{ fontSize: 15 }}>{view.memoryFact}</span>
            <span className="d"> </span>
          </div>
        </div>

        <div className="stak-body">
          <div className="stak-col">
            <section className="stak-mem-section">
              <h2>Mapping</h2>
              <p style={{ fontSize: 13, color: 'var(--muted)', maxWidth: 560, lineHeight: 1.6 }}>
                Mapping a Project to a local folder happens only on the machine itself — STAK
                Cloud never stores or chooses a folder path. If {view.viewing.name} already
                resolves this Project automatically through its Git remote, no mapping command is
                needed there.
              </p>
            </section>

            <section className="stak-mem-section">
              <h2>Actions</h2>
              <ProjectLifecycleButton projectId={view.technical.projectId} lifecycle={view.lifecycle} />
            </section>

            <details style={{ fontSize: 12.5 }}>
              <summary style={{ cursor: 'pointer', color: 'var(--faint)', fontSize: 12.5, fontWeight: 600 }}>
                Technical details
              </summary>
              <div style={{ marginTop: 10, font: '11.5px var(--mono)', color: 'var(--faint)' }}>
                <span>projectId: {view.technical.projectId}</span>
              </div>
            </details>
          </div>
        </div>

        <CommandDock
          machineName={view.viewing.name}
          command={`stak project map ${view.cliSelector} <directory>`}
          hint="Binds this Project to a local folder on this machine. Local only — never sent to STAK Cloud."
        />
      </main>
    </div>
  );
}
```

- [ ] **Step 6: Verify it compiles**

Run: `cd apps/web && npx tsc --noEmit -p .`
Expected: no new errors.

- [ ] **Step 7: Commit**

```bash
git add "apps/web/app/projects/[projectId]"
git commit -m "feat(p6): Project detail/mapping page"
```

---

### Task 8: Sidebar — flip Memory/Projects to real links

**Files:**
- Modify: `apps/web/app/_components/app-sidebar.tsx:82-98`

**Interfaces:**
- Consumes: nothing new.
- Produces: Memory and Projects nav items become real `<Link>`s with correct `href`s; Machines and Stacks remain `aria-disabled` placeholders.

- [ ] **Step 1: Edit the render condition and href mapping**

In `apps/web/app/_components/app-sidebar.tsx`, change the item-render condition (currently `item.key === 'overview' || item.key === 'skills'`) and the `href` ternary to include `memory` and `projects`:

```tsx
        {items.map((item) =>
          item.key === 'overview' ||
          item.key === 'skills' ||
          item.key === 'memory' ||
          item.key === 'projects' ? (
            <Link
              key={item.key}
              href={
                item.key === 'overview'
                  ? '/overview'
                  : item.key === 'skills'
                    ? '/skills'
                    : item.key === 'memory'
                      ? '/memory'
                      : '/projects'
              }
              className="stak-nav-item"
              aria-current={active === item.key ? 'page' : undefined}
            >
              <span>{item.label}</span>
              {item.n ? (
                <span
                  className="n"
                  style={{ color: DOT[item.tone] ?? '#85817a' }}
                >
                  {item.n}
                </span>
              ) : null}
            </Link>
          ) : (
            <div
              key={item.key}
              className="stak-nav-item"
              aria-disabled="true"
              title="Arrives in a later phase"
            >
              <span>{item.label}</span>
              {item.n ? (
                <span
                  className="n"
                  style={{ color: DOT[item.tone] ?? '#85817a' }}
                >
                  {item.n}
                </span>
              ) : null}
            </div>
          ),
        )}
```

Also update the component doc comment (currently "P4 builds only Overview; the other five are shell destinations rendered as placeholders") to say Machines and Stacks remain placeholders, since Memory/Projects/Skills/Overview are now real.

- [ ] **Step 2: Run the existing Overview/Skills tests to check for regressions**

Run: `cd apps/web && npx vitest run app/overview/overview-data.test.ts app/skills/skills-data.test.ts app/skills/skill-detail-data.test.ts`
Expected: PASS — `app-sidebar.tsx` isn't imported by these view-model tests, but this confirms nothing else broke incidentally.

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/_components/app-sidebar.tsx
git commit -m "feat(p6): sidebar — Memory and Projects become real links"
```

---

### Task 9: Full validation pass + read-only real-account dogfood

**Files:** none (verification only).

- [ ] **Step 1: Run the full web test suite**

Run: `cd apps/web && npx vitest run`
Expected: all tests pass, including the new `memory-data.test.ts`, `projects-data.test.ts`, `project-detail-data.test.ts`, `project-presentation.test.ts`.

- [ ] **Step 2: Run the monorepo test/typecheck/lint**

Run (from repo root): `npx turbo run test typecheck lint --filter=@stack/web`
Expected: all green. If `@stack/cloud-server`/`@stack/spec` package names differ from `@stack/web`, use the filter shown in `turbo.json`/`apps/web/package.json`'s workspace name instead.

- [ ] **Step 3: Format P6-owned files with Prettier**

Run: `npx prettier --write apps/web/app/memory apps/web/app/projects apps/web/lib/project-presentation.ts apps/web/lib/project-presentation.test.ts apps/web/app/_components/app-sidebar.tsx`
Expected: no unexpected reformatting of files outside P6's scope (do not run Prettier repo-wide — contract/plan constraint: never clean unrelated formatting debt).

- [ ] **Step 4: `git diff --check`**

Run: `git diff --check`
Expected: no trailing-whitespace/conflict-marker warnings.

- [ ] **Step 5: Production build**

Run: `cd apps/web && npm run build` (or the monorepo's `turbo run build --filter=@stack/web`)
Expected: build succeeds with no new type/lint errors from the P6 routes.

- [ ] **Step 6: Read-only real-account browser dogfood**

Using the signed-in real account (read-only — **never** click Archive/Unarchive or run any CLI mutation against it during this step):
- Visit `/memory`: expect Protected mode, latest Cloud backup generation 6, DELL showing a Memory-changes-not-backed-up gap if that's still the live state, recovery-method state rendered honestly, no fabricated per-project counts.
- Visit `/projects`: expect the current real project count (0 or whatever is live) rendered with the real empty/populated copy — no fake rows.
- If any real Project exists, visit its detail page and confirm no local path, Git remote, or Memory plaintext ever renders.
- Confirm the sidebar's Memory/Projects entries are real, keyboard-navigable links with correct `aria-current` on their own routes.

Note the actual observed state in the phase report (Task "Validation" in the user's §30, reported per their §31 template) rather than assuming the dev-session's slightly-stale memory of "Protected · gen 6 · DELL gap · 0 projects" — it may have changed since that was last confirmed.

- [ ] **Step 7: Commit (only if Step 3 changed anything beyond what Tasks 1-8 already committed)**

```bash
git status
# If `prettier --write` changed anything not already committed:
git add -u
git commit -m "style(p6): prettier formatting for Memory/Projects files"
```

---

## Self-Review Notes (for the plan author, already applied above)

- **Spec coverage:** §1 (account-wide mode, never per-project) → Task 2/3 `modeSentence`/summary cells. §4/§5/§6 (status hierarchy, no manifest dump) → Task 3 fact strip. §6/§7/§8 (backup history, Standard per-project, Protected null) → Task 2/3. §9 (recovery state distinct from backup existence) → Task 2/3 `needsRecoveryMethod`. §10/§11 (backup/recover/restore semantics via CommandDock only) → Task 3/6/7 CommandDock usage, Global Constraints. §12/§13/§14/§15/§16 (Project model, list, identity, presence, lifecycle) → Tasks 4/6. §17/§18 (mapping is local, canonical Git auto-resolution) → Task 7's honest "Mapping" section. §19 (truthful empty state) → Task 4's `statusSentence`. §20 (no over-coupling Memory/Projects) → Task 2's `perProject` stays Memory-page-local; Task 4 never reads Memory. §21 (detail/mapping screen) → Task 7. §22 (Delete Cloud Memory deferred) → Global Constraints, not built. §23 (sidebar) → Task 8. §24 (visual consistency) → reuse of `shell.css`/`CommandDock`/`AppSidebar`/`.stak-sum` throughout. §25 (accessibility) → real `<Link>`s, labelled buttons, `aria-live` status, focus rings in CSS. §26 (privacy audit) → Global Constraints + Task 9 Step 6. §27/§28 (test matrices) → Task 2/4/7 test lists cover every listed case (no-backup, Standard, Protected, machine-gap, recovery-with/without-method, perProject null, malformed/unavailable, history, empty history; no-Projects, active, archived, present/absent, canonical-Git honesty via Task 7's copy, archive/unarchive, duplicate-name-stays-distinct-by-id, invalid-Project-fails-safely, no-path-leakage via never rendering any path anywhere). §29 (dogfood) → Task 9 Step 6. §30 (validation) → Task 9 Steps 1-5.
- **Placeholder scan:** no "TBD"/"add error handling"/"similar to Task N" placeholders remain; every step has literal file content.
- **Type consistency:** `ProjectRow`/`ProjectsListView`/`ProjectDetailView`/`MemoryView` field names are used identically across their producing `*-data.ts` file, consuming `page.tsx`, and their `*.test.ts` assertions (e.g. `lifecycleLabel`, `presence`, `fileCountLabel`, `cliSelector`, `memoryFact`, `machineGap`, `needsRecoveryMethod`, `perProject`, `protectedProjectsKnownCount` all match between Tasks 2/4/6/7).
