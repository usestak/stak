# STAK Admin v1 — Phase 3: Usage + Reliability + product_events Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Instrument push and pull with best-effort event recording (so Reliability can show real success/failure rates and Usage can show real pushes/pulls-per-day), then build the Usage and Reliability admin pages on top of that data. `product_events` (migration `0015`) already exists as of the Phase 2 fix commit — this phase is purely the instrumentation + the two new pages.

**Architecture:** `packages/cloud-server` is deliberately DB-agnostic — `createCloudService()` takes an injected `repository` object and injected callbacks (e.g. the existing `memoryBackendFor`), never a raw Supabase client. Event recording follows that exact pattern: a new optional `recordEvent?: (event: ProductEvent) => Promise<void>` field on `CloudServiceConfig`, called from `commitEnvironmentVersion`/`getEnvironment` in `service.ts` on both success and failure paths, wrapped so a recording failure can never affect the actual push/pull response. The real Supabase-backed implementation is wired up only in `apps/web/lib/cloud-service.ts`, where `createCloudService()` is actually constructed.

**Tech Stack:** TypeScript, Vitest (cloud-server uses an in-memory repository test fixture, not mocks), Next.js App Router, `@supabase/supabase-js`.

## Global Constraints

- Analytics/event-recording failures must NEVER cause a push/pull/recovery operation to fail. `recordEvent` is called from inside a `try/catch` that only logs (`console.error`), never rethrows.
- `recordEvent` must be optional (`config.recordEvent?.(...)`) — every existing test that constructs `createCloudService()` without it must keep passing unchanged.
- Event `metadata` is allowlisted per event — never raw file contents, paths, credentials, or exception stack traces.
- Do not add CLI version tracking (no header exists; out of scope per the design spec).
- Never use `git add .` / `git add -A` — stage exact file paths.
- No new migration needed — `product_events` already exists (`supabase/migrations/0015_product_events.sql`).

---

### Task 1: `ProductEvent` type + `recordEvent` on `CloudServiceConfig`

**Files:**

- Modify: `packages/cloud-server/src/service.ts`
- Modify: `packages/cloud-server/src/index.ts`
- Test: `packages/cloud-server/src/product-events.test.ts`

**Interfaces:**

- Produces: `export type ProductEvent = { userId: string | null; eventName: string; machineId?: string; success: boolean; errorCode?: string; metadata?: Record<string, unknown> }`, exported from both `service.ts` and the package's `index.ts`. `CloudServiceConfig` gains `recordEvent?: (event: ProductEvent) => Promise<void> | void`.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/cloud-server/src/product-events.test.ts
import { describe, expect, it, vi } from 'vitest';

import {
  createCloudService,
  createInMemoryBlobStore,
  createInMemoryRepository,
  type ProductEvent,
} from './index.js';

describe('recordEvent config option', () => {
  it('createCloudService accepts an optional recordEvent callback without it being called for unrelated operations', async () => {
    const recordEvent = vi.fn();
    const service = createCloudService({
      repository: createInMemoryRepository(),
      blobStore: createInMemoryBlobStore(),
      appUrl: 'http://localhost:3000',
      ticketSecret: 'test-secret',
      recordEvent,
    });
    expect(service).toBeTruthy();
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it('createCloudService still works when recordEvent is omitted entirely', () => {
    expect(() =>
      createCloudService({
        repository: createInMemoryRepository(),
        blobStore: createInMemoryBlobStore(),
        appUrl: 'http://localhost:3000',
        ticketSecret: 'test-secret',
      }),
    ).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @stack/cloud-server test product-events.test.ts`
Expected: FAIL — `ProductEvent` is not exported yet (TypeScript error on the import), and `recordEvent` is not a known config field.

- [ ] **Step 3: Add the type and config field**

In `packages/cloud-server/src/service.ts`, near the other exported types (find `export type CloudServiceConfig = {`):

```typescript
export type ProductEvent = {
  userId: string | null;
  eventName: string;
  machineId?: string;
  success: boolean;
  errorCode?: string;
  metadata?: Record<string, unknown>;
};
```

Add one field to the existing `CloudServiceConfig` type (do not remove or reorder existing fields):

```typescript
  /** Best-effort product analytics. A thrown/rejected call here must never
   * affect the operation it's recording — see commitEnvironmentVersion and
   * getEnvironment, which wrap every call in try/catch. Absent = no-op. */
  recordEvent?: (event: ProductEvent) => Promise<void> | void;
```

Add one line inside `createCloudService`'s body (near the other `config.X ?? default` destructuring, e.g. near `const now = ...`):

```typescript
const recordEventSafely = async (event: ProductEvent): Promise<void> => {
  try {
    await config.recordEvent?.(event);
  } catch (err) {
    console.error('[product-events] recordEvent failed', err);
  }
};
```

- [ ] **Step 4: Export `ProductEvent` from the package root**

In `packages/cloud-server/src/index.ts`, add `ProductEvent` to the existing named export block from `./service.js`:

```typescript
export {
  createCloudService,
  type AuthenticatedUser,
  type CloudService,
  type CloudServiceConfig,
  type PendingCliAuthSessionView,
  type ProductEvent,
} from './service.js';
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @stack/cloud-server test product-events.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 6: Run the full cloud-server suite to confirm no regressions**

Run: `pnpm --filter @stack/cloud-server test`
Expected: all existing tests still pass (recordEvent is optional and unused by them).

- [ ] **Step 7: Commit**

```bash
git add packages/cloud-server/src/service.ts packages/cloud-server/src/index.ts packages/cloud-server/src/product-events.test.ts
git commit -m "feat(cloud-server): add optional recordEvent product-analytics hook to CloudServiceConfig"
```

---

### Task 2: Instrument `commitEnvironmentVersion` (push) and `getEnvironment` (pull)

**Files:**

- Modify: `packages/cloud-server/src/service.ts`
- Test: `packages/cloud-server/src/product-events.test.ts` (extend from Task 1)

**Interfaces:**

- Consumes: `recordEventSafely` (Task 1, defined inside `createCloudService`'s closure — both methods being modified are also defined inside that same closure, so it's already in scope, no import needed).

- [ ] **Step 1: Write the failing tests (append to product-events.test.ts)**

```typescript
// Append to packages/cloud-server/src/product-events.test.ts
import {
  describe as describe2,
  expect as expect2,
  it as it2,
  vi as vi2,
} from 'vitest';

function makeEnvironmentBundle(name: string) {
  return {
    schemaVersion: 1 as const,
    environment: { name, agents: [], skills: [], memorySettings: null },
    resolved: { skills: [] },
    importedStackVersions: [],
    contentUploadRequirements: [],
    digest: 'digest-placeholder',
  };
}

describe2('push/pull event recording', () => {
  it2(
    'records cloud.push.succeeded on a successful commitEnvironmentVersion, and does not affect the response',
    async () => {
      const recordEvent = vi2.fn();
      const service = createCloudService({
        repository: createInMemoryRepository(),
        blobStore: createInMemoryBlobStore(),
        appUrl: 'http://localhost:3000',
        ticketSecret: 'test-secret',
        recordEvent,
      });
      const user = { userId: 'user-1', tokenId: 'token-1' };
      const result = await service.commitEnvironmentVersion(user, 'main', {
        bundle: makeEnvironmentBundle('main'),
        expectedLatestVersionId: null,
      });
      expect(result.createdNew).toBe(true);
      expect(recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          eventName: 'cloud.push.succeeded',
          success: true,
        }),
      );
    },
  );

  it2(
    'commitEnvironmentVersion still succeeds even if recordEvent throws',
    async () => {
      const recordEvent = vi2
        .fn()
        .mockRejectedValue(new Error('analytics db down'));
      const service = createCloudService({
        repository: createInMemoryRepository(),
        blobStore: createInMemoryBlobStore(),
        appUrl: 'http://localhost:3000',
        ticketSecret: 'test-secret',
        recordEvent,
      });
      const user = { userId: 'user-1', tokenId: 'token-1' };
      const result = await service.commitEnvironmentVersion(user, 'main', {
        bundle: makeEnvironmentBundle('main'),
        expectedLatestVersionId: null,
      });
      expect(result.createdNew).toBe(true); // the push itself must not fail
    },
  );

  it2(
    'records cloud.pull.succeeded on a successful getEnvironment',
    async () => {
      const recordEvent = vi2.fn();
      const service = createCloudService({
        repository: createInMemoryRepository(),
        blobStore: createInMemoryBlobStore(),
        appUrl: 'http://localhost:3000',
        ticketSecret: 'test-secret',
        recordEvent,
      });
      const user = { userId: 'user-1', tokenId: 'token-1' };
      await service.commitEnvironmentVersion(user, 'main', {
        bundle: makeEnvironmentBundle('main'),
        expectedLatestVersionId: null,
      });
      recordEvent.mockClear();
      await service.getEnvironment(user, 'main');
      expect(recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          eventName: 'cloud.pull.succeeded',
          success: true,
        }),
      );
    },
  );

  it2(
    'records cloud.pull.failed when getEnvironment throws not-found, and still throws',
    async () => {
      const recordEvent = vi2.fn();
      const service = createCloudService({
        repository: createInMemoryRepository(),
        blobStore: createInMemoryBlobStore(),
        appUrl: 'http://localhost:3000',
        ticketSecret: 'test-secret',
        recordEvent,
      });
      const user = { userId: 'user-1', tokenId: 'token-1' };
      await expect(
        service.getEnvironment(user, 'does-not-exist'),
      ).rejects.toThrow();
      expect(recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          eventName: 'cloud.pull.failed',
          success: false,
        }),
      );
    },
  );
});
```

Note: if `makeEnvironmentBundle`'s shape doesn't match the real `CloudEnvironmentBundle` type closely enough to typecheck, read the existing bundle-building helper already in `packages/cloud-server/src/product.test.ts` (search for `computeEnvironmentBundleDigest` and the function that builds a bundle around it, roughly lines 60-103) and adapt that exact shape instead — the point of this test is exercising event recording, not re-deriving bundle construction, so copy the established pattern rather than inventing a new one.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @stack/cloud-server test product-events.test.ts`
Expected: FAIL — `commitEnvironmentVersion`/`getEnvironment` don't call `recordEvent` yet.

- [ ] **Step 3: Instrument `getEnvironment`**

In `packages/cloud-server/src/service.ts`, wrap the existing `getEnvironment` body (found via `getEnvironment: async (`) in try/catch, calling `recordEventSafely` on both paths. The body logic itself is unchanged — only wrap it:

```typescript
    getEnvironment: async (
      user: AuthenticatedUser,
      name: string,
    ): Promise<GetEnvironmentResponse> => {
      try {
        const environment = await config.repository.getEnvironmentByName(
          user.userId,
          name,
        );
        if (!environment)
          throw notFound(
            'remote-environment-not-found',
            `No cloud Environment named ${name}.`,
          );
        if (!environment.latestVersionId) {
          await recordEventSafely({ userId: user.userId, eventName: 'cloud.pull.succeeded', success: true });
          return { environmentId: environment.environmentId, name, latest: null };
        }
        const version = await config.repository.getEnvironmentVersion(
          environment.latestVersionId,
        );
        if (!version || version.userId !== user.userId)
          throw notFound(
            'remote-environment-not-found',
            'Environment version is unavailable.',
          );
        const response = {
          environmentId: environment.environmentId,
          name,
          latest: {
            version: {
              versionId: version.versionId,
              versionNumber: version.versionNumber,
              digest: version.digest,
              // ... (keep every existing field here exactly as it was —
              // this plan does not reproduce the full original object to
              // avoid drift; the implementer must preserve it verbatim)
            },
          },
        };
        await recordEventSafely({ userId: user.userId, eventName: 'cloud.pull.succeeded', success: true });
        return response;
      } catch (error) {
        const errorCode =
          error instanceof CloudServiceError ? error.code : 'unknown-error';
        await recordEventSafely({
          userId: user.userId,
          eventName: 'cloud.pull.failed',
          success: false,
          errorCode,
        });
        throw error;
      }
    },
```

IMPORTANT: the plan's snippet above elides the real `latest.version` object's full field list (it has more fields than shown — `createdAt`, `bundle`, etc., visible in the real file around where `getEnvironment` currently returns). The implementer must read the CURRENT real implementation first (`grep -n "getEnvironment:" -A40 packages/cloud-server/src/service.ts`) and wrap it exactly as it is today, only adding the try/catch and the two `recordEventSafely` calls — do not drop, rename, or restructure any existing field.

- [ ] **Step 4: Instrument `commitEnvironmentVersion`**

Same pattern: wrap the existing `commitEnvironmentVersion` body in try/catch. On every return path that represents success (including the early `idempotencyKey` existing-version return), call `recordEventSafely({ userId: user.userId, eventName: 'cloud.push.succeeded', success: true, ...(input.machineId ? { machineId: input.machineId } : {}) })` before returning. On catch, call `recordEventSafely({ userId: user.userId, eventName: 'cloud.push.failed', success: false, errorCode: error instanceof CloudServiceError ? error.code : 'unknown-error', ...(input.machineId ? { machineId: input.machineId } : {}) })` and rethrow.

Read the current full real implementation first (`grep -n "commitEnvironmentVersion:" -A80 packages/cloud-server/src/service.ts`) before editing — it has multiple internal steps (idempotency check, bundle validation, the actual repository write) and this task must preserve every one of them unchanged, only adding the try/catch wrapper and the two event-recording call sites (one per return path, one in the catch).

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @stack/cloud-server test product-events.test.ts`
Expected: PASS (6 tests total: the 2 from Task 1 + 4 new ones)

- [ ] **Step 6: Run the full cloud-server suite**

Run: `pnpm --filter @stack/cloud-server test`
Expected: all tests pass — especially re-run `product.test.ts` in full, since it exercises `commitEnvironmentVersion`/`getEnvironment` extensively and must show zero behavior change for callers that don't pass `recordEvent`.

- [ ] **Step 7: Commit**

```bash
git add packages/cloud-server/src/service.ts packages/cloud-server/src/product-events.test.ts
git commit -m "feat(cloud-server): record push/pull success/failure via recordEvent, best-effort"
```

---

### Task 3: Wire the real Supabase-backed `recordEvent` in `apps/web/lib/cloud-service.ts`

**Files:**

- Modify: `apps/web/lib/cloud-service.ts`
- Test: `apps/web/lib/cloud-service.test.ts` (create if it doesn't already exist, or extend if it does — check first)

**Interfaces:**

- Consumes: `ProductEvent` (Task 1, exported from `@stack/cloud-server`), `serviceClient()` (`apps/web/lib/supabase.ts`).

- [ ] **Step 1: Read the current file to see exactly how `createCloudService` is called today**

Run: `cat apps/web/lib/cloud-service.ts`
(Already partially seen: it calls `createCloudService({ repository: supabaseRepository(), ..., memoryBackendFor: (userId) => supabaseRemoteMemoryBackend(userId) })`.) Confirm the exact current field list and ordering before editing, so the diff only adds one field.

- [ ] **Step 2: Add the `recordEvent` field**

Add a `recordEvent` field to the `createCloudService(...)` call, implemented inline using `serviceClient()`:

```typescript
      recordEvent: async (event) => {
        const { error } = await serviceClient().from('product_events').insert({
          user_id: event.userId,
          event_name: event.eventName,
          machine_id: event.machineId ?? null,
          success: event.success,
          error_code: event.errorCode ?? null,
          metadata: event.metadata ?? null,
        });
        if (error) console.error('[product_events] insert failed', error);
      },
```

Import `serviceClient` from `./supabase` if not already imported in this file (check first — `apps/web/lib/cloud-service.ts` may already import other things from `./supabase`).

- [ ] **Step 3: Write a test confirming the mapping (field names, null-coalescing)**

```typescript
// apps/web/lib/cloud-service.test.ts (extend existing file, or create new if none exists — check first)
import { describe, expect, it, vi } from 'vitest';

const insertMock = vi.fn().mockResolvedValue({ error: null });
const fromMock = vi.fn(() => ({ insert: insertMock }));
vi.mock('./supabase', () => ({ serviceClient: () => ({ from: fromMock }) }));

// Import getCloudService (or however this module exposes the configured
// service) AFTER the mock is set up. If this module caches a singleton
// (check for a module-level `let cached` or similar), either reset it
// between tests or extract the recordEvent closure into a small testable
// unit rather than going through the full singleton — read the real file's
// structure first and adapt.
```

Note: this file's exact structure (singleton caching, existing test setup) must be read before writing this test — the brief above is a sketch of intent, not literal code to transcribe blindly, because the real file wasn't fully visible when this plan was written. If `apps/web/lib/cloud-service.ts` has no existing test file and its structure makes the `recordEvent` closure hard to unit test in isolation (e.g. it's inline in a large singleton factory), it is acceptable to extract the mapping logic into a small named function (e.g. `mapProductEventToRow(event)`) exported from the same file, test THAT directly, and keep the `recordEvent` field as a one-line call to it. Report this choice either way.

- [ ] **Step 4: Run the test, typecheck, and lint**

Run: `pnpm --filter @stack/web test cloud-service.test.ts && pnpm --filter @stack/web typecheck && pnpm --filter @stack/web lint`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/cloud-service.ts apps/web/lib/cloud-service.test.ts
git commit -m "feat(web): wire the real Supabase-backed recordEvent into the Cloud service"
```

---

### Task 4: Usage page

**Files:**

- Create: `apps/web/app/admin/usage/usage-data.ts`
- Create: `apps/web/app/admin/usage/page.tsx`
- Test: `apps/web/app/admin/usage/usage-data.test.ts`

**Interfaces:**

- Produces: `export type UsageMetrics = { pushesPerDay: { date: string; count: number }[]; pullsPerDay: { date: string; count: number }[]; activeMachines: number; memoryBackupsCount: number; memoryRecoveriesCount: number; publicStakPublications: number }` and `export async function loadUsageMetrics(db: SupabaseClient, range: AdminDateRange): Promise<UsageMetrics>`.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/web/app/admin/usage/usage-data.test.ts
import { describe, expect, it } from 'vitest';

import { loadUsageMetrics } from './usage-data';

function fakeDb(
  responses: Record<
    string,
    { data: unknown[]; count?: number; error?: unknown }
  >,
) {
  return {
    from: (table: string) => {
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      builder.select = chain;
      builder.gte = chain;
      builder.eq = chain;
      builder.is = chain;
      builder.then = (resolve: (v: unknown) => void) =>
        resolve(responses[table] ?? { data: [], count: 0, error: null });
      return builder;
    },
  } as never;
}

describe('loadUsageMetrics', () => {
  it('buckets push/pull events per day and counts machines/memory/publications', async () => {
    const db = fakeDb({
      product_events: {
        data: [
          {
            event_name: 'cloud.push.succeeded',
            created_at: '2026-10-19T10:00:00Z',
          },
          {
            event_name: 'cloud.push.succeeded',
            created_at: '2026-10-19T11:00:00Z',
          },
          {
            event_name: 'cloud.pull.succeeded',
            created_at: '2026-10-19T12:00:00Z',
          },
          {
            event_name: 'memory.recovered',
            created_at: '2026-10-19T13:00:00Z',
          },
        ],
        error: null,
      },
      machines: { data: [{ user_id: 'u1', machine_id: 'm1' }], error: null },
      memory_backups: { data: [{ id: 'b1' }], error: null },
      public_stack_versions: { data: [{ id: 'v1' }], error: null },
    });

    const result = await loadUsageMetrics(db, 'all');

    expect(result.pushesPerDay).toEqual([{ date: '2026-10-19', count: 2 }]);
    expect(result.pullsPerDay).toEqual([{ date: '2026-10-19', count: 1 }]);
    expect(result.memoryRecoveriesCount).toBe(1);
    expect(result.activeMachines).toBe(1);
    expect(result.memoryBackupsCount).toBe(1);
    expect(result.publicStakPublications).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @stack/web test usage-data.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write the implementation**

```typescript
// apps/web/app/admin/usage/usage-data.ts
import type { SupabaseClient } from '@supabase/supabase-js';

import { rangeStart, type AdminDateRange } from '@/lib/admin-date-range';

export type UsageMetrics = {
  pushesPerDay: { date: string; count: number }[];
  pullsPerDay: { date: string; count: number }[];
  activeMachines: number;
  memoryBackupsCount: number;
  memoryRecoveriesCount: number;
  publicStakPublications: number;
};

const bucketByDay = (
  rows: { created_at: string }[],
): { date: string; count: number }[] => {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const date = row.created_at.slice(0, 10);
    counts.set(date, (counts.get(date) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => a.date.localeCompare(b.date));
};

export const loadUsageMetrics = async (
  db: SupabaseClient,
  range: AdminDateRange,
): Promise<UsageMetrics> => {
  const since = rangeStart(range);

  let eventsQuery = db.from('product_events').select('event_name, created_at');
  if (since) eventsQuery = eventsQuery.gte('created_at', since.toISOString());
  const { data: events, error: eventsError } = await eventsQuery;
  if (eventsError) throw eventsError;

  const rows = (events ?? []) as { event_name: string; created_at: string }[];
  const pushRows = rows.filter((r) => r.event_name === 'cloud.push.succeeded');
  const pullRows = rows.filter((r) => r.event_name === 'cloud.pull.succeeded');
  const memoryRecoveriesCount = rows.filter(
    (r) => r.event_name === 'memory.recovered',
  ).length;

  const { data: machineRows, error: machineError } = await db
    .from('machines')
    .select('user_id, machine_id')
    .is('revoked_at', null);
  if (machineError) throw machineError;
  const activeMachines = new Set(
    ((machineRows ?? []) as { machine_id: string }[]).map((m) => m.machine_id),
  ).size;

  const { count: memoryBackupsCount, error: backupsError } = await db
    .from('memory_backups')
    .select('id', { count: 'exact', head: true });
  if (backupsError) throw backupsError;

  const { count: publicStakPublications, error: publicationsError } = await db
    .from('public_stack_versions')
    .select('id', { count: 'exact', head: true });
  if (publicationsError) throw publicationsError;

  return {
    pushesPerDay: bucketByDay(pushRows),
    pullsPerDay: bucketByDay(pullRows),
    activeMachines,
    memoryBackupsCount: memoryBackupsCount ?? 0,
    memoryRecoveriesCount,
    publicStakPublications: publicStakPublications ?? 0,
  };
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @stack/web test usage-data.test.ts`
Expected: PASS (1 test)

- [ ] **Step 5: Write the page (same independent-gate pattern as every prior admin page)**

```typescript
// apps/web/app/admin/usage/page.tsx
import { notFound } from 'next/navigation';

import { getAdminUser } from '@/lib/admin';
import { serviceClient } from '@/lib/supabase';
import type { AdminDateRange } from '@/lib/admin-date-range';

import { AdminSidebar } from '../_components/admin-sidebar';
import { loadUsageMetrics } from './usage-data';

const RANGES: AdminDateRange[] = ['24h', '7d', '30d', 'all'];
const isAdminDateRange = (value: string | undefined): value is AdminDateRange =>
  RANGES.includes(value as AdminDateRange);

export default async function AdminUsagePage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  const admin = await getAdminUser();
  if (!admin) notFound();

  const params = await searchParams;
  const range: AdminDateRange = isAdminDateRange(params.range) ? params.range : '30d';
  const metrics = await loadUsageMetrics(serviceClient(), range);

  return (
    <>
      <AdminSidebar active="usage" />
      <main className="stak-admin-main">
        <h1>Usage</h1>
        <nav aria-label="Date range" className="stak-admin-range-pills">
          {RANGES.map((r) => (
            <a
              key={r}
              href={`/admin/usage?range=${r}`}
              className={`stak-admin-nav-link${r === range ? ' is-active' : ''}`}
            >
              {r}
            </a>
          ))}
        </nav>
        <dl className="stak-admin-metric-grid">
          <div>
            <dt>Active machines</dt>
            <dd>{metrics.activeMachines}</dd>
          </div>
          <div>
            <dt>Memory backups</dt>
            <dd>{metrics.memoryBackupsCount}</dd>
          </div>
          <div>
            <dt>Memory recoveries</dt>
            <dd>{metrics.memoryRecoveriesCount}</dd>
          </div>
          <div>
            <dt>Public STAK publications</dt>
            <dd>{metrics.publicStakPublications}</dd>
          </div>
        </dl>
        <h2>Pushes per day</h2>
        {metrics.pushesPerDay.length === 0 ? (
          <p>No pushes in this period.</p>
        ) : (
          <ul>
            {metrics.pushesPerDay.map((d) => (
              <li key={d.date}>
                {d.date}: {d.count}
              </li>
            ))}
          </ul>
        )}
        <h2>Pulls per day</h2>
        {metrics.pullsPerDay.length === 0 ? (
          <p>No pulls in this period.</p>
        ) : (
          <ul>
            {metrics.pullsPerDay.map((d) => (
              <li key={d.date}>
                {d.date}: {d.count}
              </li>
            ))}
          </ul>
        )}
      </main>
    </>
  );
}
```

- [ ] **Step 6: Add a page-level gate test, matching the established pattern from Overview/Users/Activation**

```typescript
// apps/web/app/admin/usage/page.test.tsx
import { describe, expect, it, vi } from 'vitest';

const { getAdminUserMock, notFoundMock, loadUsageMetricsMock } = vi.hoisted(
  () => ({
    getAdminUserMock: vi.fn(),
    notFoundMock: vi.fn(() => {
      throw new Error('NEXT_NOT_FOUND');
    }),
    loadUsageMetricsMock: vi.fn().mockResolvedValue({
      pushesPerDay: [],
      pullsPerDay: [],
      activeMachines: 0,
      memoryBackupsCount: 0,
      memoryRecoveriesCount: 0,
      publicStakPublications: 0,
    }),
  }),
);

vi.mock('@/lib/admin', () => ({ getAdminUser: getAdminUserMock }));
vi.mock('next/navigation', () => ({ notFound: notFoundMock }));
vi.mock('@/lib/supabase', () => ({ serviceClient: () => ({}) }));
vi.mock('./usage-data', () => ({ loadUsageMetrics: loadUsageMetricsMock }));

import AdminUsagePage from './page';

describe('AdminUsagePage', () => {
  it('calls notFound (its own gate) when there is no admin user', async () => {
    getAdminUserMock.mockResolvedValue(null);
    await expect(
      AdminUsagePage({ searchParams: Promise.resolve({}) }),
    ).rejects.toThrow('NEXT_NOT_FOUND');
    expect(loadUsageMetricsMock).not.toHaveBeenCalled();
  });

  it('renders for an admin user, defaulting to "30d"', async () => {
    getAdminUserMock.mockResolvedValue({ id: 'admin-1', role: 'owner' });
    await AdminUsagePage({ searchParams: Promise.resolve({}) });
    expect(loadUsageMetricsMock).toHaveBeenCalledWith({}, '30d');
  });
});
```

- [ ] **Step 7: Run tests, typecheck, lint**

Run: `pnpm --filter @stack/web test && pnpm --filter @stack/web typecheck && pnpm --filter @stack/web lint`
Expected: all pass. Watch for the unused-import lint error pattern seen in Phase 2 — double check test file imports.

- [ ] **Step 8: Commit**

```bash
git add apps/web/app/admin/usage/usage-data.ts apps/web/app/admin/usage/usage-data.test.ts apps/web/app/admin/usage/page.tsx apps/web/app/admin/usage/page.test.tsx
git commit -m "feat(web): add admin Usage page sourced from product_events"
```

---

### Task 5: Reliability page

**Files:**

- Create: `apps/web/app/admin/reliability/reliability-data.ts`
- Create: `apps/web/app/admin/reliability/page.tsx`
- Test: `apps/web/app/admin/reliability/reliability-data.test.ts`

**Interfaces:**

- Produces: `export type ReliabilityMetrics = { pushSuccessRate: number | null; pullSuccessRate: number | null; recentFailures: { operation: string; errorCode: string; count: number; affectedUsers: number; firstSeen: string; lastSeen: string }[] }` and `export async function loadReliabilityMetrics(db: SupabaseClient, range: AdminDateRange): Promise<ReliabilityMetrics>`.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/web/app/admin/reliability/reliability-data.test.ts
import { describe, expect, it } from 'vitest';

import { loadReliabilityMetrics } from './reliability-data';

function fakeDb(
  rows: {
    event_name: string;
    success: boolean;
    error_code: string | null;
    user_id: string;
    created_at: string;
  }[],
) {
  return {
    from: () => ({
      select: () => ({
        gte: () => ({
          then: (resolve: (v: unknown) => void) =>
            resolve({ data: rows, error: null }),
        }),
      }),
    }),
  } as never;
}

describe('loadReliabilityMetrics', () => {
  it('computes push/pull success rates and groups recent failures', async () => {
    const db = fakeDb([
      {
        event_name: 'cloud.push.succeeded',
        success: true,
        error_code: null,
        user_id: 'u1',
        created_at: '2026-10-19T10:00:00Z',
      },
      {
        event_name: 'cloud.push.failed',
        success: false,
        error_code: 'invalid-request',
        user_id: 'u1',
        created_at: '2026-10-19T11:00:00Z',
      },
      {
        event_name: 'cloud.push.failed',
        success: false,
        error_code: 'invalid-request',
        user_id: 'u2',
        created_at: '2026-10-19T12:00:00Z',
      },
      {
        event_name: 'cloud.pull.succeeded',
        success: true,
        error_code: null,
        user_id: 'u1',
        created_at: '2026-10-19T13:00:00Z',
      },
    ]);

    const result = await loadReliabilityMetrics(db, 'all');

    expect(result.pushSuccessRate).toBeCloseTo(1 / 3);
    expect(result.pullSuccessRate).toBe(1);
    expect(result.recentFailures).toEqual([
      {
        operation: 'cloud.push.failed',
        errorCode: 'invalid-request',
        count: 2,
        affectedUsers: 2,
        firstSeen: '2026-10-19T11:00:00Z',
        lastSeen: '2026-10-19T12:00:00Z',
      },
    ]);
  });

  it('returns null success rates (not NaN) when there are zero attempts of that type', async () => {
    const db = fakeDb([]);
    const result = await loadReliabilityMetrics(db, 'all');
    expect(result.pushSuccessRate).toBeNull();
    expect(result.pullSuccessRate).toBeNull();
    expect(result.recentFailures).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @stack/web test reliability-data.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write the implementation**

```typescript
// apps/web/app/admin/reliability/reliability-data.ts
import type { SupabaseClient } from '@supabase/supabase-js';

import { rangeStart, type AdminDateRange } from '@/lib/admin-date-range';

export type ReliabilityMetrics = {
  pushSuccessRate: number | null;
  pullSuccessRate: number | null;
  recentFailures: {
    operation: string;
    errorCode: string;
    count: number;
    affectedUsers: number;
    firstSeen: string;
    lastSeen: string;
  }[];
};

type EventRow = {
  event_name: string;
  success: boolean;
  error_code: string | null;
  user_id: string | null;
  created_at: string;
};

const successRateFor = (
  rows: EventRow[],
  succeededName: string,
  failedName: string,
): number | null => {
  const relevant = rows.filter(
    (r) => r.event_name === succeededName || r.event_name === failedName,
  );
  if (relevant.length === 0) return null;
  const succeeded = relevant.filter(
    (r) => r.event_name === succeededName,
  ).length;
  return succeeded / relevant.length;
};

export const loadReliabilityMetrics = async (
  db: SupabaseClient,
  range: AdminDateRange,
): Promise<ReliabilityMetrics> => {
  const since = rangeStart(range) ?? new Date(0);
  const { data, error } = await db
    .from('product_events')
    .select('event_name, success, error_code, user_id, created_at')
    .gte('created_at', since.toISOString());
  if (error) throw error;

  const rows = (data ?? []) as EventRow[];

  const failures = rows.filter((r) => !r.success);
  const grouped = new Map<string, EventRow[]>();
  for (const row of failures) {
    const key = `${row.event_name}::${row.error_code ?? 'unknown'}`;
    const list = grouped.get(key) ?? [];
    list.push(row);
    grouped.set(key, list);
  }

  const recentFailures = [...grouped.entries()]
    .map(([, list]) => {
      const sorted = [...list].sort((a, b) =>
        a.created_at.localeCompare(b.created_at),
      );
      return {
        operation: sorted[0]!.event_name,
        errorCode: sorted[0]!.error_code ?? 'unknown',
        count: sorted.length,
        affectedUsers: new Set(sorted.map((r) => r.user_id).filter(Boolean))
          .size,
        firstSeen: sorted[0]!.created_at,
        lastSeen: sorted[sorted.length - 1]!.created_at,
      };
    })
    .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));

  return {
    pushSuccessRate: successRateFor(
      rows,
      'cloud.push.succeeded',
      'cloud.push.failed',
    ),
    pullSuccessRate: successRateFor(
      rows,
      'cloud.pull.succeeded',
      'cloud.pull.failed',
    ),
    recentFailures,
  };
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @stack/web test reliability-data.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Write the page**

```typescript
// apps/web/app/admin/reliability/page.tsx
import { notFound } from 'next/navigation';

import { getAdminUser } from '@/lib/admin';
import { serviceClient } from '@/lib/supabase';
import type { AdminDateRange } from '@/lib/admin-date-range';

import { AdminSidebar } from '../_components/admin-sidebar';
import { loadReliabilityMetrics } from './reliability-data';

const RANGES: AdminDateRange[] = ['24h', '7d', '30d', 'all'];
const isAdminDateRange = (value: string | undefined): value is AdminDateRange =>
  RANGES.includes(value as AdminDateRange);

const pct = (rate: number | null): string => (rate === null ? 'No data yet' : `${(rate * 100).toFixed(1)}%`);

export default async function AdminReliabilityPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  const admin = await getAdminUser();
  if (!admin) notFound();

  const params = await searchParams;
  const range: AdminDateRange = isAdminDateRange(params.range) ? params.range : '30d';
  const metrics = await loadReliabilityMetrics(serviceClient(), range);

  return (
    <>
      <AdminSidebar active="reliability" />
      <main className="stak-admin-main">
        <h1>Reliability</h1>
        <nav aria-label="Date range" className="stak-admin-range-pills">
          {RANGES.map((r) => (
            <a
              key={r}
              href={`/admin/reliability?range=${r}`}
              className={`stak-admin-nav-link${r === range ? ' is-active' : ''}`}
            >
              {r}
            </a>
          ))}
        </nav>
        <dl className="stak-admin-metric-grid">
          <div>
            <dt>Push success rate</dt>
            <dd>{pct(metrics.pushSuccessRate)}</dd>
          </div>
          <div>
            <dt>Pull success rate</dt>
            <dd>{pct(metrics.pullSuccessRate)}</dd>
          </div>
          <div>
            <dt>CLI version breakdown</dt>
            <dd>Unavailable — no CLI version header exists yet</dd>
          </div>
        </dl>
        <h2>Recent failures</h2>
        {metrics.recentFailures.length === 0 ? (
          <p>No failures in this period.</p>
        ) : (
          <div className="stak-admin-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Operation</th>
                  <th>Error code</th>
                  <th>Count</th>
                  <th>Affected users</th>
                  <th>First seen</th>
                  <th>Last seen</th>
                </tr>
              </thead>
              <tbody>
                {metrics.recentFailures.map((f) => (
                  <tr key={`${f.operation}-${f.errorCode}`}>
                    <td>{f.operation}</td>
                    <td>{f.errorCode}</td>
                    <td>{f.count}</td>
                    <td>{f.affectedUsers}</td>
                    <td>{new Date(f.firstSeen).toLocaleString()}</td>
                    <td>{new Date(f.lastSeen).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </>
  );
}
```

- [ ] **Step 6: Add a page-level gate test (same pattern as Task 4 Step 6)**

```typescript
// apps/web/app/admin/reliability/page.test.tsx
import { describe, expect, it, vi } from 'vitest';

const { getAdminUserMock, notFoundMock, loadReliabilityMetricsMock } =
  vi.hoisted(() => ({
    getAdminUserMock: vi.fn(),
    notFoundMock: vi.fn(() => {
      throw new Error('NEXT_NOT_FOUND');
    }),
    loadReliabilityMetricsMock: vi.fn().mockResolvedValue({
      pushSuccessRate: null,
      pullSuccessRate: null,
      recentFailures: [],
    }),
  }));

vi.mock('@/lib/admin', () => ({ getAdminUser: getAdminUserMock }));
vi.mock('next/navigation', () => ({ notFound: notFoundMock }));
vi.mock('@/lib/supabase', () => ({ serviceClient: () => ({}) }));
vi.mock('./reliability-data', () => ({
  loadReliabilityMetrics: loadReliabilityMetricsMock,
}));

import AdminReliabilityPage from './page';

describe('AdminReliabilityPage', () => {
  it('calls notFound (its own gate) when there is no admin user', async () => {
    getAdminUserMock.mockResolvedValue(null);
    await expect(
      AdminReliabilityPage({ searchParams: Promise.resolve({}) }),
    ).rejects.toThrow('NEXT_NOT_FOUND');
    expect(loadReliabilityMetricsMock).not.toHaveBeenCalled();
  });

  it('renders for an admin user, defaulting to "30d"', async () => {
    getAdminUserMock.mockResolvedValue({ id: 'admin-1', role: 'owner' });
    await AdminReliabilityPage({ searchParams: Promise.resolve({}) });
    expect(loadReliabilityMetricsMock).toHaveBeenCalledWith({}, '30d');
  });
});
```

- [ ] **Step 7: Run full suite, typecheck, lint, and build (last task of this phase)**

Run: `pnpm --filter @stack/web test && pnpm --filter @stack/web typecheck && pnpm --filter @stack/web lint && pnpm --filter @stack/web build && pnpm --filter @stack/cloud-server test`
Expected: all pass; build lists `/admin/usage` and `/admin/reliability` as dynamic (ƒ).

- [ ] **Step 8: Commit**

```bash
git add apps/web/app/admin/reliability/reliability-data.ts apps/web/app/admin/reliability/reliability-data.test.ts apps/web/app/admin/reliability/page.tsx apps/web/app/admin/reliability/page.test.tsx
git commit -m "feat(web): add admin Reliability page sourced from product_events"
```

---

## Phase 3 Completion Checklist

- [ ] All 5 tasks committed individually.
- [ ] `recordEvent` is optional and every pre-existing `createCloudService()` call site/test (that doesn't pass it) still behaves identically.
- [ ] A test explicitly proves push/pull still succeeds even when `recordEvent` throws (Task 2's second test) — this is the single most important test in this phase, since it's the global constraint the whole phase exists to prove.
- [ ] No CLI version is faked — Reliability explicitly shows "Unavailable — no CLI version header exists yet".
- [ ] Full web suite + cloud-server suite + typecheck + lint + build all pass.
- [ ] Phase 4 plan (Feedback inbox, using the `feedback` workflow columns already added in the Phase 2 fix commit) to be written next.
