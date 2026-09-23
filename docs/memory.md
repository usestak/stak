# Memory

Stack preserves two different things:

- **Skills** — reusable capabilities. Potentially shareable, and publishable as
  reference-only public Stacks.
- **Memory** — the private, durable context an agent has learned or remembers.
  Always private; **never** shareable and never reachable from public publishing.

```
Stack
├── shareable
│   └── Skills
└── private
    └── Memory
```

Memory is treated as potentially secret-bearing. No public manifest, public
version, public snapshot preparation, or `stack publish` traversal ever touches
Memory storage, which lives in its own private namespace under
`$STACK_HOME/memory/` (content-addressed objects + an atomically committed
manifest), separate from the Skill store.

## What Stack Memory V0 preserves (Claude)

Only these allowlisted, durable surfaces are captured, each classified explicitly:

| Classification                 | Source (read-only)                          |
| ------------------------------ | ------------------------------------------- |
| `user-instructions`            | `~/.claude/CLAUDE.md`                       |
| `agent-memory` (global)        | `~/.claude/agent-memory/<agent>/**`         |
| `auto-memory` (project)        | `~/.claude/projects/<key>/memory/**`        |
| `agent-memory` (project)       | `<project>/.claude/agent-memory/<agent>/**` |
| `project-private-instructions` | `<project>/CLAUDE.local.md`                 |

Claude is the only Memory provider in V0. Codex and Cursor are not faked: Codex
has no native auto-memory directory, and Cursor account User Rules already sync
through Cursor while local `~/.cursor/rules` are a separate instruction surface —
adapters for them may register later and report `unsupported` until a stable
contract exists.

## What Stack Memory V0 does NOT preserve

Stack Memory is **not** "all agent history" or a "complete agent brain." It does
not capture, and never backs up:

- session `*.jsonl` transcripts, prompt history, tool-result archives
- file-history / checkpoint data, plans, tasks/todos
- debug logs, stats, paste/image caches, shell snapshots, session/env state
- OAuth data, authentication tokens, API keys, `.env` files, `~/.claude.json`
- settings containing credentials or environment secrets, plugin caches
- arbitrary files merely because they live under `~/.claude`

Discovery is allowlist-based (only the paths above are traversed), never follows
symlinks out of a memory root, and validates every path segment.

## Project identity

Project memory is keyed by a portable **project identity**, preferring the
canonical Git remote (`github.com/owner/repo`, normalized across https/ssh forms,
`.git` suffixes, host casing, and with any credentials stripped) rather than an
absolute filesystem path. So a project cloned to a different directory on another
machine is still recognized. When no portable Git identity exists, the identity
is `local` and unresolved, and restore must rebind it to a real local project;
if the project is not present, restore reports **"Project not found on this
machine."** rather than inventing a destination. Absolute source paths are
machine-local metadata and never appear in the portable manifest.

## Backup and restore

- `stack memory scan` — read-only discovery of portable memory. Changes nothing.
- `stack memory backup` — copies allowlisted memory into the private store and
  commits the manifest last. Read-only against native agent state: it never
  modifies, reformats, deletes, or invokes Claude. A failed backup leaves the
  previous backup valid and commits nothing.
- `stack memory status` — shows the last backup.
- `stack memory restore [--dry-run]` — resolves, previews, and applies. It only
  writes to **absent** targets; an existing target with different content is a
  **conflict** that is reported and left untouched (V0 never merges memory or
  lets an agent resolve conflicts). Identical targets are no-ops. Unmanaged
  memory absent from a backup is never deleted.

Default output stays beginner-friendly (no hashes, object paths, vendor keys, or
absolute paths). Use `--verbose` for diagnostics and `--json` for stable
structured output.

## Cloud

Memory is **not** uploaded to Stack Cloud in this phase. Remote Memory requires a
separate end-to-end encryption and recovery-key design and will not reuse the
plaintext private-Skill snapshot upload path. Local backup/restore is proven
first.
