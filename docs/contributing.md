# Contributing

## Prerequisites

- Node.js 22+
- pnpm via corepack (the version is pinned in `package.json` `packageManager`)

```bash
corepack enable
pnpm install --frozen-lockfile
```

## Everyday commands

```bash
pnpm typecheck     # tsc --noEmit across all packages
pnpm lint          # eslint + prettier --check
pnpm test          # vitest across all packages
pnpm build         # tsc builds + tsup bundle for the CLI
pnpm format        # prettier --write
```

All five must pass before a change is complete.

## Monorepo layout

- `@stack/spec` — canonical zod schemas and pure helpers (parsers, digests).
- `@stack/shared` — filesystem tree hashing, path fencing, canonical JSON.
- `@stack/store` — content-addressed Store and snapshot archive transport.
- `@stack/scanner` — read-only Skill discovery and provenance.
- `@stack/core` — Environment/Stack/resolver/composition, cloud bundle, push/pull,
  publish, remote source, Git reference restoration.
- `@stack/adapters` — Codex/Cursor/Claude binding engine and `stak try` runtime.
- `@stack/cloud-client` — typed HTTP client and cloud error types.
- `@stack/cloud-server` — framework-agnostic auth/environment/snapshot/public
  services, in-memory repository, and the `/api/v1` router.
- `@usestak/cli` — the `stak` command (bundled into a self-contained binary).
- `apps/web` — the Next.js STAK Cloud app (API routes + sign-in + public pages).

Domain/infrastructure packages must not import CLI, web, React, Next.js, or
Supabase concerns (enforced by ESLint).

## Testing safety rule (mandatory)

**Tests and demos must never write to real user Skill roots, the real HOME, or
any real agent directory.** Use the Phase 6.1 fenced owned-temporary-root harness
(`createOwnedTestRoot`) or per-test `mkdtemp` directories, and always clean up.
Real-home canaries and path fences exist to catch violations — do not weaken
them. Live Supabase, GitHub OAuth, agent auth, and network model calls are never
required by the test suite; use the in-memory cloud service and injected
executors.

## Fixtures

Prefer constructing fixtures in temporary directories at test time. When a test
needs a Git-reference-backed Skill, create a real throwaway Git repo inside the
temp root (see the Phase 9 demo); reacquisition in tests uses an injected Git
executor so no network is required.

## Commits

Focused commits with clear messages. Do not rewrite published history.
