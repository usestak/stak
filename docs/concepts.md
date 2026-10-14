# Concepts

STAK has a small, deliberate vocabulary. Using these terms precisely is part of
the product.

## Skill

An existing Agent Skill directory — a `SKILL.md` file with `name` and
`description` front matter, plus any supporting files (`scripts/`,
`references/`). STAK never invents a new Skill format; it records metadata
around the directories that already exist.

## Content hash

Every Skill's contents hash to a canonical `sha256:...` value over its files and
symlinks. This is the unit of identity for restoration and verification. Changed
content produces a new hash.

## Store

The immutable, content-addressed cache at `$STAK_HOME/store/sha256/<hash>/`.
Store objects are written once and verified on read. Restoration always
materializes exact bytes from the Store.

## Reference vs snapshot

A Skill is preserved as either:

- a **reference** — a clean Git source (remote + exact revision +
  repository-relative path + expected hash) that can be reacquired anywhere; or
- a **snapshot** — a private copy of the content, used when the Skill is local,
  modified, unknown-source, or otherwise not reproducible from a reference.

## STAK

A reusable collection of Skill requirements authored as a directory with a
`stak.yaml`. STAKs can extend other local STAKs. An imported STAK becomes an
immutable resolved **version** identified by a deterministic version hash.

## Environment

Your desired local setup. V0.1 exposes exactly one Environment, `main`. It is
composed of direct Skills plus ordered STAK layers, resolved into a lockfile.
`main` is the source of truth for what you want; it is agent-neutral.

> Multiple named persistent Environments remain part of the long-term product
> model, but V0.1 exposes only `main`. `stak switch` is deferred until named
> Environment lifecycle exists.

## Machine

A computer running STAK, identified by a random UUID in
`$STAK_HOME/machine.json`. Machine-specific state — placements, agent bindings,
local snapshot IDs, sync metadata — is never portable and never uploaded.

## Binding

A physical projection of a desired Skill into an agent's Skill directory,
recorded in a machine-level registry. `stak run <agent>` reconciles bindings;
Codex and Cursor share `~/.agents/skills`, while Claude uses `~/.claude/skills`.

## Cloud Environment vs public STAK

Two separate cloud concepts with separate security domains:

- **Push/pull** back up and restore your **private** portable `main` Environment
  (may include private snapshots).
- **Publish** creates a **public**, reference-only STAK addressed as
  `@owner/name`. Public STAKs never carry snapshot bytes, credentials, or
  machine paths.

The flow is always: Cloud Environment → local desired `main` → agent
reconciliation → Machine bindings. Pull restores desired state; it never mutates
agent directories.
