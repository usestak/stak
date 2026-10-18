# Troubleshooting

STAK uses typed errors. Messages state what failed, what did and did not change,
and the safe next step. Below are common situations.

## Skills and scanning

- **Invalid `SKILL.md`** — a Skill missing `name`/`description` front matter is
  reported and skipped; scanning continues. Fix the front matter and re-scan.
- **Unknown provenance** — a Skill with no clean Git source is preserved as a
  private snapshot. It works locally and can be published like any other
  Skill once its content has been pushed (`stak push`; see below).
- **Claude synced Skills not counted** — Skills under `~/.claude/skills/synced/`
  are Claude account Skills downloaded from claude.ai. STAK intentionally
  excludes them from `stak scan`/`status`/`init`, so they are neither counted
  nor reported as untracked, and are never backed up or published. This is
  expected — STAK does not own or disable Claude syncing. Claude's
  `~/.claude/skills/.trash/` (disabled synced Skills) is ignored for the same
  reason. If you want a synced Skill managed by STAK, keep your own copy as a
  personal Skill directly under the Skill root (not inside `synced/`).

## Composition and agents

- **`stak run` says an agent is missing** — the CLI verifies the agent binary
  (`codex` / `agent`|`cursor-agent` / `claude`) before any mutation. Install the
  agent or check your PATH.
- **Unmanaged binding conflict** — a target Skill directory exists that STAK did
  not create and whose content differs. STAK will not overwrite it. Remove or
  reconcile it manually, then re-run.
- **Cursor visibility conflict** — the same Skill name exists with differing
  content across Cursor-visible roots. STAK blocks rather than guess; resolve
  the divergence.
- **Store corruption / hash mismatch** — a Store object failed verification.
  STAK refuses to use it and never silently "repairs". The affected content must
  be reacquired; unrelated commands remain usable.
- **"Trial ended, but temporary cleanup was incomplete"** — a `stak try` runtime
  component (usually `workspace`) could not be deleted, often because another
  process on Windows briefly held a file. `main` and your normal Codex bindings
  are unchanged. The runtime is retained safely under
  `$STAK_HOME/runtime/<sessionId>/` with a valid ownership marker
  (`status: cleanup-failed`), and STAK retries cleanup conservatively on a later
  `stak try`. You can also remove that directory yourself. STAK never
  auto-deletes an unmarked runtime directory.

## Publishing

- **"…content hasn't been uploaded to STAK Cloud yet. Run `stak push`
  first…"** — every Skill publishes as an immutable, content-addressed
  snapshot, but the owner must have pushed that content before it can be
  published. Run `stak push` for the Skill, then retry the publish.
- **"source remote contains embedded credentials" / unsafe remote** — remove the
  credential from the remote URL; publish from a clean https/ssh remote.
- **Invalid slug** — pass `--slug <slug>` matching `[a-z0-9][a-z0-9-_]{0,62}`.
- **Public STAK conflict** — someone/another machine published a newer version;
  fetch and retry.

## Cloud

- **`STAK Cloud is not configured`** — set `STAK_API_URL`. Local commands do
  not need it.
- **`Not signed in` / session expired** — run `stak login` again.
- **Push conflict (remote newer / unsynced remote)** — pull the newer Environment
  before pushing; STAK never overwrites automatically.
- **Pull conflict (local changes / unsynced local)** — you have local changes
  that were never pushed; STAK will not replace them automatically.
- **Private Git restore failure** — the exact revision could not be reacquired
  (missing revision, permission denied, hash mismatch). `main` is left unchanged.
  Ensure your existing Git credentials (SSH agent / credential manager) grant
  access; STAK never collects or stores Git credentials.
- **Network errors** — the cloud client surfaces typed errors
  (`CloudUnavailable`, `401`, `409`, timeouts) and never retries non-idempotent
  operations blindly.

## Installation and platform

- **`npx stack` runs the wrong tool** — the npm name `stack` belongs to an
  unrelated project. Use the installation method in
  [getting-started.md](getting-started.md).
- **pnpm/corepack on Windows** — use the repository's pinned pnpm via
  `corepack enable`. If a dependency's native build is blocked, it is governed by
  `allowBuilds` in `pnpm-workspace.yaml`.
- **Windows symlink limitations** — recreating nested Skill symlinks may require
  Developer Mode or elevation; STAK reports a clear error rather than producing
  incorrect content.
