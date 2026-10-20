# Public Beta Onboarding/Docs Pass — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `@memstk/cli@0.2.0-beta.1` Public Beta self-serve — a new developer can install, use the daily `status → add → push` workflow, recover on another machine, and leave feedback without maintainer help — by fixing the website, docs, README, and CLI reference, and by adding a lightweight feedback feature.

**Architecture:** No CLI semantic changes, no npm publish, no version bump. Pure content/docs correction across the Next.js web app (`apps/web`) and root `docs/`, plus one small, additive feature (website feedback form → Supabase, following the existing `cloud-server`/`lib/supabase-server.ts` service-role write pattern — no new abstraction layer).

**Tech Stack:** Next.js 15 (App Router) + React 19 in `apps/web`, Zod schemas in `packages/spec`, Supabase (Postgres + RLS) migrations in `supabase/migrations`, Vitest for tests, pnpm/turbo workspace.

## Global Constraints

- Public Beta install command is always `npm install -g @memstk/cli@beta` in onboarding/install content — npm `latest` stays `0.1.2`, do not change dist-tags.
- Do not change CLI semantics, do not publish npm, do not bump the CLI version.
- Primary onboarding (new STAK): `npm install -g @memstk/cli@beta` → `stak login` → `stak init` → `stak status`.
- Recovery onboarding (new machine): `npm install -g @memstk/cli@beta` → `stak login` → `stak pull` → `stak status`. Never follow a fresh-machine `pull` with `stak memory recover` as the taught next step — teach `stak project` / `stak memory restore --dry-run` / `stak memory restore` instead. `stak memory recover` is advanced/explicit-recovery only.
- Daily/primary workflow is `stak status` → `stak add .` → `stak push`. `stak scan` is diagnostic, not the everyday starting point. `stak memory backup` is advanced/manual, never taught as part of the normal push flow.
- Memory portability claim: "Skills move across Claude Code, Cursor, and Codex. During the public beta, Project Memory portability supports Claude Code." Never claim Cursor/Codex Memory portability or agent-neutral Memory.
- `stak try` = temporary/isolated/no main mutation/cleanup after. `stak use` = adopts into main, does not launch, does not auto-push Cloud. Public STAKs never contain private Memory/Projects/machine bindings/credentials/local paths.
- No large warning banners anywhere; Public Beta is presented as understated/intentional, never alarming.
- Feedback form never auto-collects local paths, Memory content, Skill content, terminal contents, credentials, or secrets.
- Plain developer language in onboarding copy — no "bundle composition," "generation semantics," "canonical manifest," "registry reconciliation," etc.
- Keep existing advanced commands (`scan`, `memory backup`, `memory recover`, deep `project` commands) documented, just correctly scoped as advanced/reference, never deleted.

---

## File Map

| File | Responsibility |
|---|---|
| `packages/spec/src/feedback.ts` (new) | Zod request schema + types for a feedback submission — shared validation contract. |
| `packages/spec/src/index.ts` | Export the new feedback module. |
| `supabase/migrations/0012_feedback.sql` (new) | `public.feedback` table, RLS enabled with **no** policies (service-role-only writes, matching `cli_auth_sessions`/`cli_tokens` posture) — never publicly readable. |
| `apps/web/app/api/feedback/route.ts` (new) | POST handler: validates body with the shared schema, attaches safe metadata, inserts via `serviceClient()`. |
| `apps/web/app/api/feedback/route.test.ts` (new) | Route handler tests (validation, metadata attach, no-PII guarantee). |
| `apps/web/app/feedback/page.tsx` (new) | `/feedback` page: short form + privacy note. |
| `apps/web/app/feedback/feedback-form.tsx` (new) | Client component: the actual form, calls the API route, shows confirmation. |
| `apps/web/app/feedback/feedback-form.test.tsx` (new) | Form behavior tests. |
| `apps/web/app/beta/page.tsx` (new) | `/beta` page: what Public Beta is, install command, what's ready, what's not, feedback CTA. |
| `apps/web/app/beta/page.test.tsx` (new) | Smoke test for `/beta` content. |
| `apps/web/lib/beta.ts` (new) | Single source of truth: `PUBLIC_BETA_VERSION`, `PUBLIC_BETA_INSTALL_COMMAND`, `PUBLIC_BETA_LABEL`. |
| `apps/web/lib/beta.test.ts` (new) | Asserts the constants' exact values (regression guard). |
| `apps/web/app/_components/public-landing-shell.tsx` | Modify: beta pill in nav, hero copy, replace `YourStakSection`/`MoveSection` workflow story with status/add/push + pull/project/memory-restore, footer Feedback link. |
| `apps/web/app/_components/public-landing-shell.test.tsx` | Modify: assertions for the above. |
| `apps/web/app/docs/page.tsx` | Modify: add "Daily workflow" and "Move to another machine" sections using `@beta` install. |
| `apps/web/app/docs/workflows/page.tsx` | Modify: add `status`/`add`/`push` as the primary story; fix the Memory recovery sequence; reframe `scan`/`memory backup`/`memory recover` as advanced. |
| `apps/web/app/docs/memory/page.tsx` | Modify: fix "Moving to another computer" sequence (no `memory recover` immediately after `pull`). |
| `apps/web/app/docs/docs-nav.ts` | Modify: no structural change needed — confirmed by `docs.test.ts`; only touched if a nav entry is added. |
| `apps/web/app/docs/cli/cli-reference.data.ts` | Modify: verify/update `add`, `push`, `pull`, `status` entries are accurate and first-class; correct any stale beta/version text. |
| `apps/web/app/_components/beta-pill.tsx` (new) | Small reusable `<BetaPill />` client-free component for the nav pill, linking to `/beta`. |
| `docs/getting-started.md` | Modify: replace V0.1-from-source instructions with `@beta` npm install + status/add/push + new-machine flow (keep source-build as an "advanced/contributing" aside, see CONTRIBUTING.md). |
| `docs/commands.md`, `docs/memory.md`, `docs/cloud-setup.md`, `docs/troubleshooting.md` | Modify only the specific outdated sequences found in audit (see Task 8); leave advanced-command descriptions intact. |
| `README.md` | Modify: Public Beta banner line, `@beta` install, new workflow story, accurate Memory limitation. |
| `packages/cli/README.md` | Modify: same install-command fix; workflow story already closer to current — audit and patch only what's stale. |
| `.github/ISSUE_TEMPLATE/*`, `CONTRIBUTING.md`, `SECURITY.md` | Audit only; patch only if they contain a stale install command or workflow claim. |

---

## Task 1: Shared Public Beta constants + feedback Zod schema

**Files:**
- Create: `apps/web/lib/beta.ts`
- Test: `apps/web/lib/beta.test.ts`
- Create: `packages/spec/src/feedback.ts`
- Test: `packages/spec/src/feedback.test.ts`
- Modify: `packages/spec/src/index.ts`

**Interfaces:**
- Produces: `PUBLIC_BETA_VERSION = 'v0.2.0-beta.1'`, `PUBLIC_BETA_INSTALL_COMMAND = 'npm install -g @memstk/cli@beta'`, `PUBLIC_BETA_LABEL = 'Public Beta'` from `apps/web/lib/beta.ts`.
- Produces: `feedbackRequestSchema` (Zod) and `type FeedbackRequest = z.infer<typeof feedbackRequestSchema>` from `packages/spec/src/feedback.ts`, consumed by Task 3's route handler.

- [ ] **Step 1: Write the failing tests**

`apps/web/lib/beta.test.ts`:
```ts
import { describe, expect, it } from 'vitest';

import {
  PUBLIC_BETA_INSTALL_COMMAND,
  PUBLIC_BETA_LABEL,
  PUBLIC_BETA_VERSION,
} from './beta';

describe('beta constants', () => {
  it('pins the public beta install command to the @beta dist-tag', () => {
    expect(PUBLIC_BETA_INSTALL_COMMAND).toBe('npm install -g @memstk/cli@beta');
  });

  it('pins the surfaced version string', () => {
    expect(PUBLIC_BETA_VERSION).toBe('v0.2.0-beta.1');
  });

  it('pins the label used across the nav pill and /beta page', () => {
    expect(PUBLIC_BETA_LABEL).toBe('Public Beta');
  });
});
```

`packages/spec/src/feedback.test.ts`:
```ts
import { describe, expect, it } from 'vitest';

import { feedbackRequestSchema } from './feedback.js';

describe('feedbackRequestSchema', () => {
  it('accepts a minimal valid submission', () => {
    const result = feedbackRequestSchema.safeParse({
      type: 'idea',
      message: 'It would help if `stak status` showed staged Memory too.',
    });
    expect(result.success).toBe(true);
  });

  it('accepts the full optional shape', () => {
    const result = feedbackRequestSchema.safeParse({
      type: 'bug',
      message: 'stak pull did not restore my Claude Code memory.',
      goal: 'Restoring my setup on a new laptop.',
      email: 'dev@example.com',
      pageUrl: 'https://www.memstk.com/beta',
    });
    expect(result.success).toBe(true);
  });

  it('rejects an unknown type', () => {
    const result = feedbackRequestSchema.safeParse({
      type: 'complaint',
      message: 'Something.',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty message', () => {
    const result = feedbackRequestSchema.safeParse({ type: 'other', message: '' });
    expect(result.success).toBe(false);
  });

  it('rejects a message over 4000 characters', () => {
    const result = feedbackRequestSchema.safeParse({
      type: 'other',
      message: 'a'.repeat(4001),
    });
    expect(result.success).toBe(false);
  });

  it('rejects an invalid email when provided', () => {
    const result = feedbackRequestSchema.safeParse({
      type: 'other',
      message: 'Something broke.',
      email: 'not-an-email',
    });
    expect(result.success).toBe(false);
  });

  it('strips unknown fields rather than accepting arbitrary payload keys', () => {
    const result = feedbackRequestSchema.safeParse({
      type: 'idea',
      message: 'Ok.',
      localProjectPath: '/Users/me/secret-repo',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty('localProjectPath');
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @stack/web test -- beta.test.ts` and `pnpm --filter @stack/spec test -- feedback.test.ts`
Expected: FAIL — modules don't exist yet.

- [ ] **Step 3: Write minimal implementation**

`apps/web/lib/beta.ts`:
```ts
export const PUBLIC_BETA_LABEL = 'Public Beta';
export const PUBLIC_BETA_VERSION = 'v0.2.0-beta.1';
export const PUBLIC_BETA_INSTALL_COMMAND = 'npm install -g @memstk/cli@beta';
```

`packages/spec/src/feedback.ts`:
```ts
import { z } from 'zod';

/**
 * Website feedback submission contract. Intentionally has no field for local
 * paths, Memory content, Skill content, terminal output, or credentials —
 * the form never collects them, so the schema never accepts them. Unknown
 * keys are stripped (default Zod object behavior), not merely ignored.
 */
export const feedbackRequestSchema = z.object({
  type: z.enum(['bug', 'confusing', 'idea', 'other']),
  message: z.string().min(1).max(4000),
  goal: z.string().max(2000).optional(),
  email: z.string().email().optional(),
  pageUrl: z.string().max(2048).optional(),
});

export type FeedbackRequest = z.infer<typeof feedbackRequestSchema>;
```

Add to `packages/spec/src/index.ts`:
```ts
export * from './feedback.js';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @stack/web test -- beta.test.ts` and `pnpm --filter @stack/spec test -- feedback.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/beta.ts apps/web/lib/beta.test.ts packages/spec/src/feedback.ts packages/spec/src/feedback.test.ts packages/spec/src/index.ts
git commit -m "feat: add public beta constants and feedback request schema"
```

---

## Task 2: Feedback storage migration

**Files:**
- Create: `supabase/migrations/0012_feedback.sql`

**Interfaces:**
- Produces: table `public.feedback(id uuid pk, type text, message text, goal text, email text, page_url text, user_id uuid nullable, user_agent text, app_version text, created_at timestamptz)`, consumed by Task 3's route handler via `serviceClient()`.

- [ ] **Step 1: Write the migration**

`supabase/migrations/0012_feedback.sql`:
```sql
-- Public Beta website feedback. Mirrors the cli_auth_sessions/cli_tokens posture
-- (0001_stack_cloud.sql): RLS is enabled with NO policies at all, so anon/
-- authenticated PostgREST callers can neither insert nor select. The only write
-- path is the Next.js route handler using the service-role client after it has
-- validated the body against packages/spec's feedbackRequestSchema — RLS here is
-- defense-in-depth, not the enforcement point. Feedback is never exposed to any
-- public API or page; there is deliberately no select policy for any role.
create table if not exists public.feedback (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('bug', 'confusing', 'idea', 'other')),
  message text not null check (char_length(message) between 1 and 4000),
  goal text check (goal is null or char_length(goal) <= 2000),
  email text check (email is null or char_length(email) <= 320),
  page_url text check (page_url is null or char_length(page_url) <= 2048),
  -- Set only when the submitter had an authenticated web session; null for
  -- anonymous submissions, which are allowed.
  user_id uuid references auth.users (id) on delete set null,
  user_agent text,
  app_version text,
  created_at timestamptz not null default now()
);

alter table public.feedback enable row level security;
-- No policies: insert/select only via the service-role client in server code.

create index if not exists feedback_created_at_idx on public.feedback (created_at desc);
```

- [ ] **Step 2: Apply and verify locally**

Run: `pnpm supabase db reset` (or the project's existing local-Supabase verification command — check `docs/cloud-setup.md` / `package.json` for the exact script already used by prior migrations before inventing a new one)
Expected: migration applies cleanly with no errors, table `public.feedback` exists.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0012_feedback.sql
git commit -m "feat(db): add feedback table with service-role-only RLS posture"
```

---

## Task 3: Feedback API route

**Files:**
- Create: `apps/web/app/api/feedback/route.ts`
- Test: `apps/web/app/api/feedback/route.test.ts`

**Interfaces:**
- Consumes: `feedbackRequestSchema` (Task 1, `@stack/spec`), `serviceClient()` (`apps/web/lib/supabase.ts`), `getSessionUser()` (`apps/web/lib/session.ts`).
- Produces: `POST /api/feedback` — `202 { ok: true }` on success, `400 { ok: false, error }` on invalid body.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/session', () => ({ getSessionUser: vi.fn(async () => null) }));

const insertMock = vi.fn(async () => ({ error: null }));
vi.mock('../../../lib/supabase', () => ({
  serviceClient: () => ({ from: () => ({ insert: insertMock }) }),
}));

import { POST } from './route';

const req = (body: unknown) =>
  new Request('https://www.memstk.com/api/feedback', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'vitest' },
    body: JSON.stringify(body),
  });

describe('POST /api/feedback', () => {
  it('accepts a valid anonymous submission and inserts a safe row', async () => {
    const res = await POST(
      req({ type: 'idea', message: 'Great tool.', pageUrl: '/beta' }),
    );
    expect(res.status).toBe(202);
    expect(insertMock).toHaveBeenCalledTimes(1);
    const row = insertMock.mock.calls[0][0];
    expect(row).toMatchObject({
      type: 'idea',
      message: 'Great tool.',
      page_url: '/beta',
      user_id: null,
    });
    expect(row).not.toHaveProperty('localProjectPath');
  });

  it('rejects an invalid body without touching the database', async () => {
    insertMock.mockClear();
    const res = await POST(req({ type: 'nope', message: '' }));
    expect(res.status).toBe(400);
    expect(insertMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @stack/web test -- app/api/feedback/route.test.ts`
Expected: FAIL — `./route` has no export `POST`.

- [ ] **Step 3: Write minimal implementation**

```ts
import { feedbackRequestSchema } from '@stack/spec';

import { getSessionUser } from '../../../lib/session';
import { serviceClient } from '../../../lib/supabase';

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: 'invalid-json' }, { status: 400 });
  }

  const parsed = feedbackRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ ok: false, error: 'invalid-body' }, { status: 400 });
  }

  const user = await getSessionUser();
  const { type, message, goal, email, pageUrl } = parsed.data;

  const { error } = await serviceClient()
    .from('feedback')
    .insert({
      type,
      message,
      goal: goal ?? null,
      email: email ?? null,
      page_url: pageUrl ?? null,
      user_id: user?.id ?? null,
      user_agent: request.headers.get('user-agent'),
      app_version: 'web',
    });

  if (error) {
    return Response.json({ ok: false, error: 'storage-failed' }, { status: 500 });
  }

  return Response.json({ ok: true }, { status: 202 });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @stack/web test -- app/api/feedback/route.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/api/feedback/route.ts apps/web/app/api/feedback/route.test.ts
git commit -m "feat(web): add POST /api/feedback route"
```

---

## Task 4: Feedback page and form

**Files:**
- Create: `apps/web/app/feedback/feedback-form.tsx`
- Test: `apps/web/app/feedback/feedback-form.test.tsx`
- Create: `apps/web/app/feedback/page.tsx`
- Test: `apps/web/app/feedback/page.test.tsx`

**Interfaces:**
- Consumes: `POST /api/feedback` (Task 3).
- Produces: `<FeedbackForm />` client component used by `/feedback`; `/feedback` route.

- [ ] **Step 1: Write the failing tests**

`feedback-form.test.tsx`:
```tsx
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { FeedbackForm } from './feedback-form';

describe('FeedbackForm', () => {
  it('submits the selected type and message, then shows a calm confirmation', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 202, json: async () => ({ ok: true }) });
    vi.stubGlobal('fetch', fetchMock);

    render(<FeedbackForm />);
    await userEvent.selectOptions(screen.getByLabelText(/type/i), 'idea');
    await userEvent.type(
      screen.getByLabelText(/what happened, or what would you change/i),
      'Add a dark mode toggle.',
    );
    await userEvent.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() =>
      expect(screen.getByText(/thanks\. this directly helps shape the public beta/i)).toBeInTheDocument(),
    );

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/feedback',
      expect.objectContaining({ method: 'POST' }),
    );
    const sentBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sentBody).toMatchObject({ type: 'idea', message: 'Add a dark mode toggle.' });
  });

  it('shows the privacy note about credentials and secrets', () => {
    render(<FeedbackForm />);
    expect(
      screen.getByText(/don't include credentials, secrets, or private memory content/i),
    ).toBeInTheDocument();
  });
});
```

`page.test.tsx`:
```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import FeedbackPage from './page';

describe('/feedback page', () => {
  it('renders the feedback form', () => {
    render(<FeedbackPage />);
    expect(screen.getByRole('heading', { name: /feedback/i })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @stack/web test -- app/feedback`
Expected: FAIL — files don't exist.

- [ ] **Step 3: Write minimal implementation**

`feedback-form.tsx`:
```tsx
'use client';

import { useState } from 'react';

type FeedbackType = 'bug' | 'confusing' | 'idea' | 'other';

export function FeedbackForm() {
  const [type, setType] = useState<FeedbackType>('idea');
  const [message, setMessage] = useState('');
  const [goal, setGoal] = useState('');
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatus('sending');
    try {
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type,
          message,
          goal: goal || undefined,
          email: email || undefined,
          pageUrl: typeof window !== 'undefined' ? window.location.pathname : undefined,
        }),
      });
      setStatus(res.ok ? 'sent' : 'error');
    } catch {
      setStatus('error');
    }
  };

  if (status === 'sent') {
    return <p role="status">Thanks. This directly helps shape the public beta.</p>;
  }

  return (
    <form onSubmit={submit}>
      <label htmlFor="feedback-type">Type</label>
      <select
        id="feedback-type"
        value={type}
        onChange={(e) => setType(e.target.value as FeedbackType)}
      >
        <option value="bug">Bug</option>
        <option value="confusing">Something confusing</option>
        <option value="idea">Idea</option>
        <option value="other">Other</option>
      </select>

      <label htmlFor="feedback-message">What happened, or what would you change?</label>
      <textarea
        id="feedback-message"
        required
        value={message}
        onChange={(e) => setMessage(e.target.value)}
      />

      <label htmlFor="feedback-goal">What were you trying to do? (optional)</label>
      <input
        id="feedback-goal"
        value={goal}
        onChange={(e) => setGoal(e.target.value)}
      />

      <label htmlFor="feedback-email">Email (optional)</label>
      <input
        id="feedback-email"
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />

      <p>Please don&apos;t include credentials, secrets, or private Memory content.</p>

      <button type="submit" disabled={status === 'sending'}>
        Send feedback
      </button>
      {status === 'error' ? <p role="alert">Something went wrong. Try again.</p> : null}
    </form>
  );
}
```

`page.tsx`:
```tsx
import type { Metadata } from 'next';

import { FeedbackForm } from './feedback-form';

export const metadata: Metadata = {
  title: 'Feedback',
  description: 'Tell us what worked, what was confusing, or what you expected during the STAK Public Beta.',
};

export default function FeedbackPage() {
  return (
    <main>
      <h1>Feedback</h1>
      <p>Short and specific is perfect. This goes straight to the people building STAK.</p>
      <FeedbackForm />
    </main>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @stack/web test -- app/feedback`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/feedback
git commit -m "feat(web): add /feedback page and form"
```

---

## Task 5: Public Beta page (`/beta`)

**Files:**
- Create: `apps/web/app/beta/page.tsx`
- Test: `apps/web/app/beta/page.test.tsx`

**Interfaces:**
- Consumes: `PUBLIC_BETA_VERSION`, `PUBLIC_BETA_INSTALL_COMMAND` (Task 1, `apps/web/lib/beta.ts`).

- [ ] **Step 1: Write the failing test**

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import BetaPage from './page';

describe('/beta page', () => {
  it('surfaces the @beta install command and current version', () => {
    render(<BetaPage />);
    expect(screen.getByText('npm install -g @memstk/cli@beta')).toBeInTheDocument();
    expect(screen.getByText(/v0\.2\.0-beta\.1/)).toBeInTheDocument();
  });

  it('links to the feedback page', () => {
    render(<BetaPage />);
    expect(screen.getByRole('link', { name: /feedback/i })).toHaveAttribute('href', '/feedback');
  });

  it('does not overclaim memory portability across every agent', () => {
    render(<BetaPage />);
    expect(screen.queryByText(/memory.{0,20}every agent/i)).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @stack/web test -- app/beta`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Write minimal implementation**

```tsx
import type { Metadata } from 'next';
import Link from 'next/link';

import { PUBLIC_BETA_INSTALL_COMMAND, PUBLIC_BETA_VERSION } from '../../lib/beta';

export const metadata: Metadata = {
  title: 'Public Beta',
  description: 'What to expect from the STAK Public Beta — what works, what we want tested, and known limitations.',
};

export default function BetaPage() {
  return (
    <main>
      <h1>Public Beta — {PUBLIC_BETA_VERSION}</h1>
      <p>
        STAK is in a developer Public Beta. The core workflow — carrying
        Skills and Memory across machines with a Git-like flow — is stable
        enough to use daily; some edges are still being sharpened.
      </p>

      <h2>Install</h2>
      <pre>
        <code>{PUBLIC_BETA_INSTALL_COMMAND}</code>
      </pre>

      <h2>What&apos;s ready</h2>
      <ul>
        <li>Daily workflow: <code>stak status</code>, <code>stak add .</code>, <code>stak push</code>.</li>
        <li>Moving to another machine: <code>stak login</code>, <code>stak pull</code>.</li>
        <li>Skills move across Claude Code, Cursor, and Codex.</li>
        <li>During the public beta, Project Memory portability supports Claude Code.</li>
      </ul>

      <h2>What we particularly want tested</h2>
      <ul>
        <li>Restoring Memory on a fresh machine with <code>stak project</code> and <code>stak memory restore</code>.</li>
        <li>Mapping local-only Projects with <code>stak project map</code>.</li>
        <li>Using <code>stak try</code> and <code>stak use</code> with public STAKs.</li>
      </ul>

      <h2>Known limitations</h2>
      <ul>
        <li>Project Memory portability currently targets Claude Code, not Cursor or Codex.</li>
        <li>Some Projects can require explicit <code>stak project map</code> when identity can&apos;t be proven automatically.</li>
        <li>STAK deliberately fails closed on a conflicting Memory restore rather than overwriting it.</li>
        <li>CLI and Cloud semantics may continue evolving during the beta.</li>
      </ul>

      <h2>Feedback</h2>
      <p>
        Tell us what was confusing, what broke, or what you expected STAK to
        do that it didn&apos;t — it directly shapes the beta.{' '}
        <Link href="/feedback">Send feedback</Link>.
      </p>
    </main>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @stack/web test -- app/beta`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/beta
git commit -m "feat(web): add /beta public beta information page"
```

---

## Task 6: Landing page — beta pill, hero, workflow story, footer feedback link

**Files:**
- Create: `apps/web/app/_components/beta-pill.tsx`
- Modify: `apps/web/app/_components/public-landing-shell.tsx`
- Modify: `apps/web/app/_components/public-landing-shell.test.tsx`

**Interfaces:**
- Consumes: `PUBLIC_BETA_LABEL` (Task 1).
- Produces: `<BetaPill />`, used in `LandingNav`.

- [ ] **Step 1: Extend the failing tests**

Read `apps/web/app/_components/public-landing-shell.test.tsx` first to match its existing assertion style, then add:
```tsx
it('shows an understated Public Beta pill linking to /beta', () => {
  render(<PublicLandingShell />);
  const pill = screen.getByRole('link', { name: /public beta/i });
  expect(pill).toHaveAttribute('href', '/beta');
});

it('leads the daily workflow story with status, add, push', () => {
  render(<PublicLandingShell />);
  expect(screen.getByText('stak status')).toBeInTheDocument();
  expect(screen.getByText('stak add .')).toBeInTheDocument();
  expect(screen.getByText('stak push')).toBeInTheDocument();
});

it('shows memory restore (not memory recover) as the step right after pull', () => {
  render(<PublicLandingShell />);
  const pullStep = screen.getByText('stak pull').closest('li');
  expect(pullStep?.textContent).not.toMatch(/stak memory recover/);
});

it('links Feedback in the footer', () => {
  render(<PublicLandingShell />);
  expect(screen.getByRole('link', { name: 'Feedback' })).toHaveAttribute('href', '/feedback');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @stack/web test -- public-landing-shell`
Expected: FAIL on the four new assertions.

- [ ] **Step 3: Implement `BetaPill`**

`beta-pill.tsx`:
```tsx
import Link from 'next/link';

import { PUBLIC_BETA_LABEL } from '../../lib/beta';

export function BetaPill() {
  return (
    <Link href="/beta" className="stak-landing-beta-pill">
      {PUBLIC_BETA_LABEL}
    </Link>
  );
}
```

- [ ] **Step 4: Wire the pill into `LandingNav`**

In `public-landing-shell.tsx`, import `BetaPill` and render it next to the wordmark:
```tsx
import { BetaPill } from './beta-pill';
```
```tsx
<Link href="/" className="stak-landing-wordmark">
  <img src="/brand/stak-symbol-dark.svg" alt="" width={18} height={18} />
  Memory STAK
</Link>
<BetaPill />
```
(Add a minimal `.stak-landing-beta-pill` rule to `public-landing-shell.css` — small text, subtle border/background using existing design tokens in that file, no new color system.)

- [ ] **Step 5: Replace the hero lead copy**

Replace the `<p className="stak-landing-lead">` block in `Hero()` with:
```tsx
<p className="stak-landing-lead">
  Your AI coding environment should move with you. STAK carries portable
  Skills and Project Memory across machines with a familiar Git-like
  workflow.
</p>
```

- [ ] **Step 6: Replace `YourStakSection`'s closing strip and `MoveSection`'s steps**

In `YourStakSection`, replace the `stak scan` strip with:
```tsx
<div className="stak-landing-strip">
  <span className="stak-landing-strip-cmd">
    <span className="stak-landing-tone-dim">$ </span>stak status
  </span>
  <span className="stak-landing-strip-note">
    See what&apos;s changed before anything moves.
  </span>
</div>
```

Replace the `MOVES` array in `MoveSection` with the Machine → Main → Cloud story:
```tsx
const MOVES = [
  {
    n: '1',
    t: 'SEE WHAT CHANGED',
    cmd: 'stak status',
    d: 'Read-only — compares this machine against main.',
  },
  {
    n: '2',
    t: 'CHOOSE WHAT BELONGS IN MAIN',
    cmd: 'stak add .',
    d: 'Stage the Skills and Memory you want to keep.',
  },
  {
    n: '3',
    t: 'SYNC IT',
    cmd: 'stak push',
    d: 'Synchronize staged main Skills and Memory to STAK Cloud.',
  },
  {
    n: '4',
    t: 'ON ANOTHER MACHINE',
    cmd: 'stak login && stak pull',
    d: 'Bring main and Skills down to a new machine.',
  },
  {
    n: '5',
    t: 'RESTORE CLAUDE MEMORY WHEN NEEDED',
    cmd: 'stak project',
    d: 'Review recovered Projects, then stak memory restore to write Memory back into Claude Code.',
  },
];
```
Update the heading above the list from "Bring your STAK to a new machine." to "Machine → Main → Cloud." and the eyebrow from `MOVE TO ANOTHER MACHINE` to `HOW IT WORKS`. Keep the existing `<ol>`/`stak-landing-move-*` markup — only the data array and heading text change, so the list test selectors (`.closest('li')`) keep working.

- [ ] **Step 7: Add the footer Feedback link**

In `FOOTER_GROUPS`, add a `RESOURCES` entry (or extend the existing one — check current groups first) with `{ t: 'Feedback', u: '/feedback' }`.

- [ ] **Step 8: Run tests to verify they pass**

Run: `pnpm --filter @stack/web test -- public-landing-shell`
Expected: PASS — including all pre-existing assertions (re-run the full file, not just the new tests, since section headings/eyebrows changed).

- [ ] **Step 9: Commit**

```bash
git add apps/web/app/_components/beta-pill.tsx apps/web/app/_components/public-landing-shell.tsx apps/web/app/_components/public-landing-shell.test.tsx apps/web/app/_components/public-landing-shell.css
git commit -m "feat(web): landing page public beta pill and git-like workflow story"
```

---

## Task 6b: Hero scroll-story data — fix stale workflow narrated in `landing-scroll-story.tsx`

**Discovered during Task 6's implementation (not in the original audit):** `apps/web/app/_components/landing-scroll-story.tsx`'s `STEPS` array drives the hero's pinned Windows → STAK → macOS scroll animation and independently narrates the OLD workflow — `stak scan` as the lead command, `stak push\nstak memory backup` paired as one step, and `stak login\nstak pull\nstak memory recover` as one step. This violates the same locked constraints Task 6 fixed in the static sections below the hero. `public-landing-shell.tsx` (Task 6) does not render this data — it's a separate component — so Task 6's own diff could not have fixed it.

**Files:**
- Modify: `apps/web/app/_components/landing-scroll-story.tsx` (only the `STEPS` array's `cmd`/`cap`/`sub` string literals — do not touch the scroll-scrubbing/rendering logic around it)

**Interfaces:**
- No exported signature changes — `STEPS: Step[]` keeps its existing `[machine, cmd, output, cap, sub]` tuple shape and length (7 entries).

- [ ] **Step 1: Replace the `STEPS` array's command/caption text for steps 1, 3, and 5 (indices 0, 2, 4)**

Current (lines ~181-213):
```tsx
const STEPS: Step[] = [
  [
    'Windows',
    'stak scan',
    '',
    'Your agent setup starts on Windows.',
    'Skills, Memory and local setup accumulate as you work.',
  ],
  ['Windows', 'stak status', '', 'STAK makes the portable parts visible.', ''],
  [
    'Windows',
    'stak push\nstak memory backup',
    '',
    'You choose what goes to STAK Cloud, and when.',
    'Your STAK and Memory move only when you tell STAK to move them.',
  ],
  [
    'Windows',
    'stak skill check review-pr',
    '',
    'Check a Skill locally. Review the update on the web.',
    '',
  ],
  [
    'macOS',
    'stak login\nstak pull\nstak memory recover',
    '',
    'On macOS, pull your STAK and recover your Memory.',
    '',
  ],
  [
    'macOS',
    'stak memory restore',
    '',
    'Restore Memory into the agents that use it.',
    'Recover brings the backup to this machine. Restore puts it back into native agent Memory.',
  ],
  // ... step 7 comment + entry unchanged ...
];
```

Replace with:
```tsx
const STEPS: Step[] = [
  [
    'Windows',
    'stak status',
    '',
    'Your agent setup starts on Windows.',
    'Skills, Memory and local setup accumulate as you work.',
  ],
  [
    'Windows',
    'stak add .',
    '',
    'Choose what belongs in main.',
    '',
  ],
  [
    'Windows',
    'stak push',
    '',
    'Sync it to STAK Cloud.',
    'Your STAK and Memory move only when you tell STAK to move them.',
  ],
  [
    'Windows',
    'stak skill check review-pr',
    '',
    'Check a Skill locally. Review the update on the web.',
    '',
  ],
  [
    'macOS',
    'stak login\nstak pull',
    '',
    'On macOS, pull your STAK — Skills, main, and your latest staged Memory come with it.',
    '',
  ],
  [
    'macOS',
    'stak project\nstak memory restore',
    '',
    'Restore Memory into the agents that use it.',
    'Pull already brought Memory down — restore writes it into native agent Memory on this machine.',
  ],
  // ... step 7 comment + entry unchanged (stak run claude) ...
];
```
Leave the 7th entry (`stak run claude`) and its preceding comment exactly as-is — only entries 1, 2, 3, and 5, 6 (1-indexed) change. Entry 4 (`stak skill check review-pr`) is unchanged.

- [ ] **Step 2: Run the full landing shell test file** (there is no dedicated test file for this component; `public-landing-shell.test.tsx` renders `<ScrollStory />` as part of the page)

Run: `pnpm --filter @stack/web test -- public-landing-shell`
Expected: PASS — confirm no existing assertion was asserting the old step text (if one was, update it to the new text, don't weaken it).

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/_components/landing-scroll-story.tsx
git commit -m "fix(web): update hero scroll-story steps to the git-like beta workflow"
```

---

## Task 7: Docs — getting started, workflows, memory pages

**Files:**
- Modify: `apps/web/app/docs/page.tsx`
- Modify: `apps/web/app/docs/workflows/page.tsx`
- Modify: `apps/web/app/docs/memory/page.tsx`
- Modify (tests, if present): `apps/web/app/docs/docs.test.ts` (read first — only touch if a route is added/removed; this task adds no new docs route)

- [ ] **Step 1: Read current content**

Read `apps/web/app/docs/page.tsx`, `apps/web/app/docs/workflows/page.tsx`, and `apps/web/app/docs/memory/page.tsx` in full before editing (confirmed stale sections: `docs/page.tsx` has no daily-workflow section at all; `workflows/page.tsx` has no `add`/`push`/`status` section and teaches `memory recover` immediately after nothing; `memory/page.tsx:65-77` teaches `stak pull` → `stak memory recover` → `stak memory restore` as the normal new-machine sequence).

- [ ] **Step 2: Add "Daily workflow" and "Move to another machine" to `app/docs/page.tsx`**

Insert after the existing "Install STAK" section and before "Your first STAK":
```tsx
<h2>Daily workflow</h2>
<p>
  Once you have Skills and Memory worth keeping, the everyday loop is three
  commands:
</p>
<pre>
  <code>{`stak status\nstak add .\nstak push`}</code>
</pre>
<p>
  <code>stak status</code> is read-only and shows what changed.{' '}
  <code>stak add .</code> stages the Skills and Memory you want in{' '}
  <code>main</code>. <code>stak push</code> synchronizes staged{' '}
  <code>main</code> Skills and Memory to STAK Cloud — nothing unstaged is
  pushed silently.
</p>

<h2>Move to another machine</h2>
<p>On a new machine:</p>
<pre>
  <code>{`npm install -g @memstk/cli@beta\nstak login\nstak pull\nstak status`}</code>
</pre>
<p>
  <code>stak pull</code> restores <code>main</code>, Skills, and your latest
  staged private Memory generation. If you use Claude Code, Memory may still
  need materializing into it:
</p>
<pre>
  <code>{`stak project\nstak memory restore --dry-run\nstak memory restore`}</code>
</pre>
<p>
  A local-only Project (no Git identity to reconcile automatically) may need
  an explicit <code>stak project map &lt;project&gt; &lt;directory&gt;</code>.
  See <Link href="/docs/memory">Memory &amp; Projects</Link> for the full
  explanation, and <Link href="/beta">Public Beta</Link> for current
  limitations.
</p>
```
Also update the existing `<pre><code>{'npm install -g @memstk/cli\nstak login'}</code></pre>` under "Install STAK" to use `npm install -g @memstk/cli@beta`.

- [ ] **Step 3: Rewrite `app/docs/workflows/page.tsx`'s primary story**

Replace the section order so `status`/`add`/`push` leads (insert right after the intro paragraph, before "Discover existing Skills"):
```tsx
<h2>See what changed</h2>
<p>Read-only — compares this machine against <code>main</code>. Nothing moves yet.</p>
<pre>
  <code>stak status</code>
</pre>

<h2>Choose what belongs in main</h2>
<p>Stage the Skills and Memory you want to keep in <code>main</code>.</p>
<pre>
  <code>stak add .</code>
</pre>

<h2>Sync it</h2>
<p>Synchronize staged <code>main</code> Skills and Memory to STAK Cloud.</p>
<pre>
  <code>stak push</code>
</pre>
```
Reframe the existing "Discover existing Skills" section's lead-in to make clear `scan` is diagnostic, not the starting point: change "Before capturing a desired state, see what Skills already exist" to "A diagnostic, read-only discovery across agent Skill roots — not where the daily workflow starts (that's `stak status`)."

Replace the "Recover Memory" section and the "Move/use STAK on another machine" section's command block. Current (stale):
```tsx
<pre>
  <code>{`stak memory recover\nstak memory restore`}</code>
</pre>
...
<pre>
  <code>{`stak login\nstak pull\nstak run claude`}</code>
</pre>
```
Replace the whole "Move/use STAK on another machine" section with:
```tsx
<h2>Move to another machine</h2>
<p>
  On a new machine, sign in and pull — this restores <code>main</code>,
  Skills, and your latest staged private Memory generation:
</p>
<pre>
  <code>{`stak login\nstak pull\nstak status`}</code>
</pre>
<p>
  If you use Claude Code, materialize recovered Memory into it:
</p>
<pre>
  <code>{`stak project\nstak memory restore --dry-run\nstak memory restore`}</code>
</pre>
<p>
  <code>stak memory recover</code> remains available for explicit or
  history-based recovery (see <Link href="/docs/cli">CLI Reference</Link>)
  but is not part of this normal flow.
</p>
```
Keep the existing "Back up Memory" section but add one sentence clarifying it's the manual/advanced path: "This is the explicit, manual backup command — the normal `stak push` flow already syncs staged Memory; use this when you want an out-of-band backup."

- [ ] **Step 4: Fix `app/docs/memory/page.tsx`'s "Moving to another computer" section**

Replace:
```tsx
<pre>
  <code>{`stak login\nstak pull\nstak memory recover\nstak memory restore\nstak project map my-app ~/code/my-app`}</code>
</pre>
```
and its preceding paragraph with:
```tsx
<p>
  On a new machine, sign in and pull — this restores your desired
  Environment and your latest staged private Memory generation in one step.
  If you use Claude Code, materialize that Memory into it, then map any
  Project that can&apos;t reconcile automatically:
</p>
<pre>
  <code>{`stak login\nstak pull\nstak project\nstak memory restore --dry-run\nstak memory restore\nstak project map my-app ~/code/my-app`}</code>
</pre>
<p>
  <code>stak memory recover</code> is the explicit/history recovery path —
  reach for it when you need an older generation or Memory outside the
  normal pull flow, not as a routine step after <code>pull</code>.
</p>
```

- [ ] **Step 5: Run affected tests**

Run: `pnpm --filter @stack/web test -- docs`
Expected: PASS (docs.test.ts only checks nav/href wiring, which is unchanged — no route added or removed in this task).

- [ ] **Step 6: Commit**

```bash
git add apps/web/app/docs/page.tsx apps/web/app/docs/workflows/page.tsx apps/web/app/docs/memory/page.tsx
git commit -m "docs: lead with status/add/push and fix post-pull memory recovery sequence"
```

---

## Task 8: Audit and fix remaining stale references (root `docs/*.md`, security/troubleshooting docs pages)

**Files:**
- Modify (as needed, triage first): `docs/getting-started.md`, `docs/commands.md`, `docs/memory.md`, `docs/cloud-setup.md`, `docs/troubleshooting.md`, `apps/web/app/docs/security/page.tsx`, `apps/web/app/docs/troubleshooting/page.tsx`

- [ ] **Step 1: Re-run the audit greps from the plan header against these files only**

```bash
grep -n "npm install -g @memstk/cli\"\|stak memory backup\|stak memory recover\|new machine\|0\.1\.2" \
  docs/getting-started.md docs/commands.md docs/memory.md docs/cloud-setup.md docs/troubleshooting.md \
  apps/web/app/docs/security/page.tsx apps/web/app/docs/troubleshooting/page.tsx
```
For each hit, classify A (outdated onboarding — fix) / B (correct advanced/reference use of the command — leave) / C (test fixture needing a synchronized change) per the plan header's rule. Do not blanket-replace.

- [ ] **Step 2: Fix `docs/getting-started.md`**

This file still documents a from-source V0.1 install with no `@beta` npm path and no `add`/`push`/`status`. Replace the `## Install (V0.1 from source)` section and its npm-name caveat with:
```md
## Install (Public Beta)

```bash
npm install -g @memstk/cli@beta
stak login
stak init
stak status
```

`npm install -g @memstk/cli@beta` installs the Public Beta — npm's `latest`
tag intentionally still points at `0.1.2`. Building from source remains
possible for contributors; see `CONTRIBUTING.md`.
```
Replace the `## Your first Environment` block's lead (`stak scan` / `stak init` / `stak status` / `stak diff`) with a split: keep `stak init`/`stak status`/`stak diff` as-is, but reframe `stak scan` with one sentence: "Optional diagnostic: `stak scan` is read-only discovery across agent Skill roots — not required before `init`." Add a new `## Everyday workflow` section right after with:
```md
## Everyday workflow

```bash
stak status
stak add .
stak push
```
```

- [ ] **Step 3: Fix `apps/web/app/docs/security/page.tsx` line ~32-37**

Current text implies `pull` + `memory recover` is the normal two-step Cloud recovery flow. Change "run `stak pull` for `main` and Skills, and separately run `stak memory recover` to bring your Memory back down" to "run `stak pull`, which also restores your latest staged private Memory generation; `stak memory recover` remains available for explicit/history recovery — see Workflows for the current sequence."

- [ ] **Step 4: Fix `apps/web/app/docs/troubleshooting/page.tsx` line ~29-35 if it implies `memory recover` is a routine post-pull step**

Read the surrounding paragraph (it currently frames `memory recover`/`memory protect` as the commands that require sign-in, which is accurate) — only edit if, in context, it also implies recover is the routine next step after pull; otherwise leave unchanged as correct advanced-command reference and record it as "intentionally retained."

- [ ] **Step 5: Triage `docs/commands.md`, `docs/memory.md`, `docs/cloud-setup.md`**

These are root reference docs (not the live `/docs` site). For each stale install-command or post-pull-recover-sequence hit found in Step 1, apply the same two fixes as Tasks 7/8 above (`@beta` install command; pull restores latest staged Memory, recover is explicit/advanced). Leave command syntax/flag reference tables untouched — only fix the workflow narrative text.

- [ ] **Step 6: Run full web test suite to catch any test fixture coupled to the edited copy**

Run: `pnpm --filter @stack/web test`
Expected: PASS. If a test asserts old copy verbatim, update that test's expected string to match the new copy (classify C) in the same commit.

- [ ] **Step 7: Commit**

```bash
git add docs/getting-started.md docs/commands.md docs/memory.md docs/cloud-setup.md apps/web/app/docs/security/page.tsx apps/web/app/docs/troubleshooting/page.tsx
git commit -m "docs: fix remaining stale pre-0.2 install/recovery references"
```

---

## Task 9: CLI reference audit

**Files:**
- Modify (as needed): `apps/web/app/docs/cli/cli-reference.data.ts`
- Test: `apps/web/app/docs/cli/cli-reference.test.ts` (existing — read first)

- [ ] **Step 1: Read the full data file and its test**

Confirm each of `status`, `add`, `push`, `pull`, `run`, `try`, `use`, `project`, `memory` has an entry, `add` is present and described as first-class (not buried as a memory-only or project-only subcommand), and no entry's `usage`/`purpose`/`examples` string contains a stale `0.1.x`-only claim or a removed flag.

- [ ] **Step 2: Fix any gaps found**

If `add` is missing or under-described, add/extend its entry following the existing object shape (seen in the `memory` entry: `{ usage, purpose, examples }`) — pull the exact current flags from `packages/cli/src/ui/add.ts` and `packages/cli/src/program.ts`, never invent a flag.

- [ ] **Step 3: Run the reference test**

Run: `pnpm --filter @stack/web test -- cli-reference`
Expected: PASS.

- [ ] **Step 4: Commit** (only if changes were made)

```bash
git add apps/web/app/docs/cli/cli-reference.data.ts
git commit -m "docs: ensure CLI reference matches 0.2.0-beta.1 behavior"
```

---

## Task 10: README.md and packages/cli/README.md

**Files:**
- Modify: `README.md`
- Modify: `packages/cli/README.md`

**Interfaces:**
- Consumes: exact copy from the plan header's Global Constraints.

- [ ] **Step 1: Update root `README.md`**

Replace:
```md
STAK is currently in beta. The CLI and Cloud model are actively evolving.

## Install

```bash
npm install -g @memstk/cli
stak login
```
```
with:
```md
**Public Beta · v0.2.0-beta.1.** The CLI and Cloud model are actively
evolving during the beta.

## Install

```bash
npm install -g @memstk/cli@beta
stak login
stak init
stak status
```

`npm` `latest` intentionally still points at `0.1.2` — the beta lives on the
`@beta` dist-tag.
```
After the existing "Try vs. Use" / "Supported agents" tables, add (or replace an equivalent stale section if one already covers this ground — read the rest of the file first):
```md
## Everyday workflow

```bash
stak status
stak add .
stak push
```

## Move to another machine

```bash
npm install -g @memstk/cli@beta
stak login
stak pull
stak status
```

Skills move across Claude Code, Cursor, and Codex. During the Public Beta,
Project Memory portability supports Claude Code — see
[`docs/memory.md`](docs/memory.md).

## Feedback

Found a bug or something confusing? [Open an issue](https://github.com/usestak/stak/issues)
or use the in-app feedback form at `/feedback` on [memstk.com](https://www.memstk.com).

## Docs

See [`docs/getting-started.md`](docs/getting-started.md) and
[memstk.com/docs](https://www.memstk.com/docs).
```

- [ ] **Step 2: Update `packages/cli/README.md`**

Read it in full first (it already uses the newer workflow per the earlier audit grep hit list — only the literal install command is stale). Replace every `npm install -g @memstk/cli` with `npm install -g @memstk/cli@beta`, and add one line near the top: `Public Beta · v0.2.0-beta.1.` if no beta marker exists yet.

- [ ] **Step 3: Commit**

```bash
git add README.md packages/cli/README.md
git commit -m "docs: update README install commands and workflow for public beta"
```

---

## Task 10b: Fix stale "not yet published to npm" contradiction in `packages/cli/README.md`

**Discovered during Task 10's review:** `packages/cli/README.md:12-15` still reads:
```markdown
> **Status: 0.1.0 release candidate.** This package is not yet published to npm.
> Until the public 0.1.0 release, install from source — see the repository.

## Install (after 0.1.0 is published)
```
directly above a real, working `npm install -g @memstk/cli@beta` command (added by Task 10). This directly contradicts the Public Beta's self-serve goal — a new reader is told in one breath the package isn't published and to install from source, then given a real npm command two lines later.

**Files:**
- Modify: `packages/cli/README.md` (only these 4 lines: the blockquote and the heading immediately below it)

- [ ] **Step 1: Replace the stale blockquote and heading**

Replace:
```markdown
> **Status: 0.1.0 release candidate.** This package is not yet published to npm.
> Until the public 0.1.0 release, install from source — see the repository.

## Install (after 0.1.0 is published)
```
with:
```markdown
## Install
```
(The `Public Beta · v0.2.0-beta.1.` line Task 10 already added near the top of this file now carries the beta-status signal — the blockquote was saying the same thing with stale, contradictory information, so it is removed rather than reworded.)

- [ ] **Step 2: Re-read the full file to confirm no other stale "not yet published"/"0.1.0 release candidate" claim remains**

Run: `grep -n "not yet published\|release candidate\|after 0.1.0" packages/cli/README.md`
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add packages/cli/README.md
git commit -m "docs(cli): remove stale not-yet-published blockquote now that @beta is live"
```

---

## Task 11a: Fix bare install command on the landing page (missed by Task 6)

**Discovered during Task 11's repo-wide audit:** `apps/web/app/_components/public-landing-shell.tsx` has TWO `<CopyRow command="npm install -g @memstk/cli" />` occurrences (hero, line ~167, and `CloseSection`, line ~565) that Task 6 did not touch — Task 6's brief only covered the nav pill, hero lead paragraph, `YourStakSection`/`MoveSection`, and footer, not these two `CopyRow` install CTAs. This violates the locked constraint that every install example uses `@beta`.

**Files:**
- Modify: `apps/web/app/_components/public-landing-shell.tsx` (exactly these two `command="..."` string literals)
- Modify: `apps/web/app/_components/public-landing-shell.test.tsx` (only if an existing assertion checks this literal string and needs updating)

- [ ] **Step 1: Fix both occurrences**

Change both:
```tsx
<CopyRow command="npm install -g @memstk/cli" />
```
and
```tsx
<CopyRow command="npm install -g @memstk/cli" prefix="1 " />
```
to use `npm install -g @memstk/cli@beta` instead.

- [ ] **Step 2: Run the full test file**

Run: `pnpm --filter @stack/web test -- public-landing-shell`
Expected: PASS. If an existing assertion checks for the old bare string, update it to the `@beta` string.

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/_components/public-landing-shell.tsx
git commit -m "fix(web): add missing @beta tag to landing page install CTAs"
```
(add the test file too, by exact name, only if it was touched)

---

## Task 11b: Fix missing `stak pull` step in the signed-in onboarding page's "existing account, new machine" flow

**Discovered during Task 11's repo-wide audit:** `apps/web/app/onboarding/page.tsx` (the authenticated post-login onboarding screen, not a public marketing/docs page) has a branch for `view.mode !== 'new-account'` (i.e., an existing account signing in on a new machine) that currently reads:
```tsx
<p>Your STAK already has Cloud Memory. On the new machine, run:</p>
<pre className="stak-cmd">
  <code>{`stak login\nstak memory recover\nstak memory restore`}</code>
</pre>
```
This never tells the user to run `stak pull` — meaning the copy as written would never bring down `main`/Skills, only Memory. This is a real functional-onboarding gap, not just stale wording — fix the copy only, do not touch `onboarding-data.ts` or any conditional logic.

**Files:**
- Modify: `apps/web/app/onboarding/page.tsx` (only the JSX inside the `view.mode !== 'new-account'` branch shown above)
- Modify: `apps/web/app/onboarding/onboarding-data.test.ts` or any page-level test, only if an existing assertion checks this exact string

- [ ] **Step 1: Add the missing `stak pull` step**

Replace:
```tsx
<p>Your STAK already has Cloud Memory. On the new machine, run:</p>
<pre className="stak-cmd">
  <code>{`stak login\nstak memory recover\nstak memory restore`}</code>
</pre>
<p>
  <code style={{ fontFamily: 'var(--mono)' }}>recover</code> brings
  your Memory down from Cloud to this machine.{' '}
  <code style={{ fontFamily: 'var(--mono)' }}>restore</code> writes it
  into your agents&apos; files — it never overwrites anything already
  there. If your Memory is Protected, recover needs a passkey or your
  recovery file from this account.
</p>
```
with:
```tsx
<p>Your STAK already has Cloud Memory. On the new machine, run:</p>
<pre className="stak-cmd">
  <code>{`stak login\nstak pull\nstak memory restore`}</code>
</pre>
<p>
  <code style={{ fontFamily: 'var(--mono)' }}>pull</code> brings down{' '}
  <code style={{ fontFamily: 'var(--mono)' }}>main</code>, Skills, and
  your latest staged Memory generation.{' '}
  <code style={{ fontFamily: 'var(--mono)' }}>restore</code> writes that
  Memory into your agents&apos; files — it never overwrites anything
  already there. If you need an older generation or your Memory is
  Protected, use{' '}
  <code style={{ fontFamily: 'var(--mono)' }}>stak memory recover</code>{' '}
  instead — it needs a passkey or your recovery file from this account
  when Protected.
</p>
```
(This replaces the routine `recover` step with `pull`, matching the locked workflow, while still mentioning `memory recover` as the explicit/Protected-mode alternative rather than deleting it.)

- [ ] **Step 2: Run any existing test covering this page**

Run: `pnpm --filter @stack/web test -- onboarding`
Expected: PASS. Update any assertion checking the old string, if found.

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/onboarding/page.tsx
git commit -m "fix(web): teach stak pull (not memory recover) in existing-account onboarding flow"
```
(add a test file too, by exact name, only if it was touched)

---

## Task 11: Final audit, full validation, and summary

- [ ] **Step 1: Re-run every audit grep from the plan header against the whole repo**

```bash
grep -rn "npm install -g @memstk/cli\"" --include=*.md --include=*.tsx --include=*.ts . | grep -v node_modules | grep -v "@memstk/cli@beta"
grep -rln "stak memory recover" --include=*.tsx --include=*.md . | grep -v node_modules
```
For every remaining hit, confirm it is either (a) inside a code block documenting the advanced/explicit command correctly, or (b) a CLI source/test file (untouched by design). Note any genuine remaining gap.

- [ ] **Step 2: Run full validation**

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
git diff --check
```
Expected: all PASS. Fix any failure before proceeding — do not skip hooks or checks.

- [ ] **Step 3: Review `git status` and `git log` for this work**

```bash
git status
git log --oneline -15
```
Confirm every intended file is committed and nothing unrelated was swept in.

- [ ] **Step 4: Push (only after explicit confirmation)**

This pushes to `origin/main` on a shared repo — confirm with the user before running:
```bash
git fetch origin main
git push origin main
```
Do not force-push. If `origin/main` has moved incompatibly, stop and report rather than force-pushing or rebasing destructively.

- [ ] **Step 5: Report**

Produce the final report matching the spec's 20-point RETURN checklist: audit findings, landing changes, beta presentation, onboarding flows, docs IA changes, README changes, CLI reference changes, feedback UX + storage + privacy behavior, files changed, tests added, validation results, remaining intentional old-command references (with reasons), commit hashes, push result, final `git status`, and the exact public URLs (`/`, `/docs`, `/docs` getting-started section, `/beta`, `/feedback`, `/docs/cli`).
