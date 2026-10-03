# Release checklist (V0.1)

Publishing and deployment are manual human actions. This checklist separates what
is automatically verified from what requires an owner decision.

## Automated / verified in CI

- [x] `pnpm install --frozen-lockfile`
- [x] `pnpm typecheck`
- [x] `pnpm lint` (eslint + prettier)
- [x] `pnpm test` (no live Supabase / network required)
- [x] `pnpm build` (workspace builds + CLI bundle + `next build`)
- [x] Cross-platform CI matrix: ubuntu / windows / macOS on Node 22
- [x] Packed CLI installs and runs from an isolated directory
- [x] Controlled demonstrations (Phase 7–10) run green
- [x] `pnpm audit --prod`: no known vulnerabilities
- [x] No secrets committed (tracked-file scan)
- [x] Version is `0.1.0`; `stak --version` reports `0.1.0`
- [x] `CHANGELOG.md`, README, and docs present

## Human action required (release blockers)

- [ ] **Public npm package name** — `stack` is taken. Verified-available
      candidates at audit time: `@getstack/cli`, `@skillstack/cli`,
      `@agentstack/cli`, `stackcli`, `agent-stack`. Choose one, then make
      `packages/cli` non-private, set `"name"`, and update install docs.
- [ ] **LICENSE** — no license file exists. Choose one (e.g. MIT or Apache-2.0)
      or intentionally keep it proprietary; add a root `LICENSE` and set the
      package `license` field.
- [ ] **Security contact** — fill in `SECURITY.md` with a real reporting channel.
- [ ] **GitHub remote** — no remote is configured; create the repository and push.
- [ ] **Production Supabase project** — create it and apply
      `supabase/migrations/0001_*` then `0002_*` in order.
- [ ] **GitHub OAuth app** — configure the provider + callback URLs in Supabase
      (see [cloud-setup.md](cloud-setup.md)).
- [ ] **Production `STACK_APP_URL` / domain** and web hosting deployment.
- [ ] Set server secrets (`SUPABASE_SERVICE_ROLE_KEY`, `STACK_TICKET_SECRET`) in
      the hosting environment — see [env-vars.md](env-vars.md).

## Release steps (manual, after blockers cleared)

1. Final `pnpm install --frozen-lockfile && pnpm typecheck && pnpm lint && pnpm test && pnpm build` from a clean checkout.
2. `cd packages/cli && npm pack`; inspect the tarball; install-smoke it.
3. Tag `v0.1.0`.
4. `npm publish` the CLI under the chosen name.
5. Apply Supabase migrations to production.
6. Deploy `apps/web` with production env vars.
7. Verify `stak login` → `push`/`pull` and a public publish/use against
   production.
