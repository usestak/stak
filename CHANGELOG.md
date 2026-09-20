# Changelog

All notable changes to Stack are documented here. This project adheres to
semantic versioning.

## 0.1.0 — unreleased (release candidate)

First V0 release candidate: the core "my agent setup is portable" thesis,
end to end.

### Added

- **Discovery** — `stack scan` reads Skills across Codex, Cursor, and Claude Code
  roots without mutating anything.
- **Desired state** — `stack init` captures the `main` Environment; `stack status`
  and `stack diff` show drift.
- **Content Store** — immutable, content-addressed preservation and hash-verified
  restoration.
- **Agents** — `stack run codex|cursor|claude` projects `main` into agent
  directories with shared physical binding ownership (`~/.agents/skills` for
  Codex and Cursor; `~/.claude/skills` for Claude) and unmanaged-content
  protection.
- **Composition** — `stack use`/`stack remove` compose local Stacks safely;
  removal preserves Skills still required elsewhere.
- **Isolated trials** — `stack try <stack> -- codex` runs a Stack in a fenced
  scratch workspace with a temporary HOME/`CODEX_HOME`; `main` is untouched.
- **Cloud portability** — `stack login`/`logout`/`whoami`, and `stack push`/`pull`
  back up and reconstruct the private portable `main` across machines with
  matching Skill hashes, private snapshot transport, and exact Git reference
  reacquisition.
- **Public Stacks** — `stack publish` creates reference-only public Stacks
  addressed as `@owner/name`; `stack use @owner/name` and
  `stack try @owner/name -- codex` consume them. Public reads never expose private
  Environments or snapshots.
- **Distribution** — the CLI is bundled into a single self-contained binary.

### Deferred from V0.1

`stack switch` (only `main` exists), isolated `try` for Cursor/Claude, public
snapshot publishing, automatic Stack updates, force conflict overrides, teams/
organizations, and marketplace features.
