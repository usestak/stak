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
- [ ] Stand up a **production Supabase** project and apply
      `supabase/migrations/0001` → `0002` → `0003` in order.
- [ ] **STAK-native Project Memory deploy order.** If the web app goes first,
      every Memory upload fails:
  1. Apply Supabase migration `0018`.
  2. Then run `notify pgrst, 'reload schema'`.
  3. Then deploy the web app.
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
