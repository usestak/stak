# Release checklist (0.1.0)

Publishing and deployment are manual human actions. This checklist separates what
is automatically verified from what requires an owner decision.

## Automated / verified in CI

- [x] `pnpm install --frozen-lockfile`
- [x] `pnpm typecheck`
- [x] `pnpm lint` (eslint + prettier)
- [x] `pnpm test` (no live Supabase / network required)
- [x] `pnpm build` (workspace builds + CLI bundle + `next build`)
- [x] Cross-platform CI matrix: ubuntu / windows / macOS on Node 22
- [x] Packed CLI installs and runs the `stak` command from an isolated directory
- [x] Controlled demonstrations (Phase 7–10) run green
- [x] `pnpm audit --prod`: no known vulnerabilities
- [x] No secrets committed (tracked-file scan)
- [x] Version is `0.1.0`; `stak --version` reports `0.1.0`
- [x] `CHANGELOG.md`, README, and docs present

## Resolved (identity & metadata)

- [x] **Product identity** — STAK; CLI command `stak`.
- [x] **Public npm package name** — `@memstk/cli` (decided as part of the
      Memory STAK rebrand; `packages/cli` is non-private with
      `publishConfig.access: public`. The `@memstk` npm scope's ownership was
      **not verified as part of this change** — confirm it's secured before
      publish).
- [x] **LICENSE** — MIT added at the repository root; package `license` set.
- [x] **GitHub repository** — `usestak/stak`; the `origin` remote is configured
      locally (not yet pushed).
- [x] **Security reporting channel** — `SECURITY.md` points to GitHub Private
      Vulnerability Reporting (enabling it in repo settings is still open, below).
- [x] **Migrations present** — `supabase/migrations/0001`, `0002`, `0003`.
- [x] **Env vars** — `STAK_*` preferred with `STACK_*` legacy aliases.
- [x] **Local state** — new installs default to `~/.stak`; a legacy `~/.stack` is
      adopted in place.
- [x] **Release artifacts ignored** — `.release/` is in `.gitignore`.

> External/manual facts (cannot be verified from this repository): the `@usestak`
> npm organization has 2FA/publish protection enabled, and the `usestak/stak`
> GitHub namespace is secured.

## Human action required before release (still open)

- [ ] Enable **GitHub Private Vulnerability Reporting** in `usestak/stak` settings.
- [ ] Configure DNS/Vercel for the **`www.memstk.com`** domain (canonical
      production origin), plus `memstk.com`, `memorystak.com`, and
      `www.memorystak.com` redirecting permanently to it.
- [ ] Stand up a **production Supabase** project and apply **every** migration
      in `supabase/migrations/` in numeric order (`0001` → … → `0018`; there is
      no `0016`). None may be skipped.
- [ ] **STAK-native Project Memory deploy order.** If the web app goes first,
      every Memory upload fails:
  1. [x] Apply Supabase migration `0018` (after all earlier ones). Done
         2026-10-27 — applied to production.
  2. [x] Then run `notify pgrst, 'reload schema'`. Done 2026-10-27, right
         after migration `0018`.
  3. [ ] Then deploy the web app. **Still open** — confirm the production
         deployment is on latest `main`.
  4. [ ] Only **after** the web deploy is live, publish the CLI on npm
         `@beta`. **Still open.** Against the old server, the new CLI gets
         no sticky v1-after-v2 gate and no guarded retire, so old CLIs could
         overwrite upgraded accounts and protect runs unguarded.

### How to publish a beta (from `0.2.0-beta.5` on)

GitHub Actions builds and stages the CLI now, not a laptop. The workflow is
`.github/workflows/release-cli.yml` ("Release CLI (beta)"). It uses npm
trusted publishing, so there is no npm token or `npm login`. It only
_stages_ the version: nothing reaches users until an owner approves it on npm
with 2FA.

One-time setup (done once, by an npm owner of `@memstk/cli`):

- [ ] On npmjs.com → `@memstk/cli` → **Settings** → **Trusted Publisher** →
      **GitHub Actions**. Organization or user `usestak`, repository `stak`,
      workflow filename `release-cli.yml`, environment name `npm`. Leave
      **Allow `npm publish`** and **Allow `npm dist-tag`** unticked, so the
      workflow can only stage.
- [ ] Same page, **Publishing access**: "Require two-factor authentication
      and disallow bypass 2fa tokens (recommended)".

Each release:

1. [ ] Merge the version-bump PR (`packages/cli/package.json` version,
       `CHANGELOG.md`, `PUBLIC_BETA_VERSION` in `apps/web/lib/beta.ts`).
2. [ ] If it adds migrations, apply them to production first, then
       `notify pgrst, 'reload schema'`, then let the web deploy finish.
3. [ ] GitHub → **Actions** → **Release CLI (beta)** → **Run workflow** on
       `main`. It refuses non-beta versions, versions already on npm, and runs
       from anywhere but `main`. It builds, typechecks and tests the CLI,
       installs the packed package, then stages it with `--tag beta` and
       pushes the Git tag `v<version>`.
4. [ ] Approve the staged version on npmjs.com, or with npm 12:
       `npm stage list @memstk/cli`, then `npm stage approve <stage-id>`.
       If something looks wrong, `npm stage reject <stage-id>` instead.
5. [ ] A few minutes later, `npm view @memstk/cli dist-tags` → `beta` is the
       new version and `latest` is still `0.1.2`.

### Publishing `@memstk/cli@0.2.0-beta.3` to the `beta` dist-tag

Run from a clean checkout, after the web deploy above is confirmed live.
`latest` must stay on `0.1.2` — do not let this move it.

- [ ] `pnpm install --frozen-lockfile`
- [ ] `pnpm build` (from the repo root, or `pnpm --filter @memstk/cli build`)
- [ ] `cd packages/cli`
- [ ] `node dist/bin.js --version` → confirm it prints `0.2.0-beta.3`
- [ ] `npm publish --tag beta` (never plain `npm publish` — that would move
      `latest`; `publishConfig.access` is already `public` in
      `packages/cli/package.json`)
- [ ] `npm dist-tag ls @memstk/cli` → confirm `beta` points at `0.2.0-beta.3`
      and `latest` is still `0.1.2`

### Publishing `@memstk/cli@0.2.0-beta.4` to the `beta` dist-tag

No server migration is needed for beta.4: #19, #20, #21, and #23 (the PRs
this release is built from) added no new files under `supabase/migrations/`
— the newest migration is still `0018_memory_replica_of.sql`, applied for
beta.3. There is no deploy-order constraint to observe before publishing
this one.

Run from a clean checkout. `latest` must stay on `0.1.2` — do not let this
move it.

- [ ] `pnpm install --frozen-lockfile`
- [ ] `pnpm build` (from the repo root, or `pnpm --filter @memstk/cli build`)
- [ ] `cd packages/cli`
- [ ] `node dist/bin.js --version` → confirm it prints `0.2.0-beta.4`
- [ ] `npm publish --tag beta` (never plain `npm publish` — that would move
      `latest`; `publishConfig.access` is already `public` in
      `packages/cli/package.json`)
- [ ] `npm dist-tag ls @memstk/cli` → confirm `beta` points at `0.2.0-beta.4`
      and `latest` is still `0.1.2`

- [ ] **Production web deployment** of `apps/web` with production env vars.
- [ ] Set server secrets (`SUPABASE_SERVICE_ROLE_KEY`, `STAK_TICKET_SECRET`) in the
      hosting environment — see [env-vars.md](env-vars.md).
- [ ] Configure the **production GitHub OAuth app** + callback URLs in Supabase
      (see [cloud-setup.md](cloud-setup.md)).
- [ ] Validate **production WebAuthn** RP ID / allowed origins on the real domain
      (localhost success does not prove production).
- [ ] Decide the **production API endpoint** (baked default vs documented
      `STAK_API_URL`); no production URL is hardcoded yet.
- [ ] Provision a **production security email** (`security@usestak.app`) — do not
      advertise it until the mailbox exists.
- [ ] Final **fresh-machine acceptance** against production (login → push/pull →
      memory backup/recover, Standard and Protected).

## Release steps (manual, after the open items are cleared)

1. Final `pnpm install --frozen-lockfile && pnpm typecheck && pnpm lint && pnpm test && pnpm build` from a clean checkout.
2. `cd packages/cli && npm pack`; inspect the tarball; install-smoke the `stak` binary.
3. Push `main` to `origin` and tag `v0.1.0`.
4. `npm publish` `@memstk/cli` (public access).
5. Apply Supabase migrations to production.
6. Deploy `apps/web` with production env vars.
7. Verify `stak login` → `push`/`pull` and a public publish/use against production.
8. Create the GitHub release for `v0.1.0`.
