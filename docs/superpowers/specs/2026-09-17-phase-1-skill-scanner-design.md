# Phase 1 Skill Scanner Design

## Scope

Phase 1 implements only read-only Skill discovery through `stack scan`, `stack scan --json`, and `stack scan --project`. It does not create Environments, persist Stack state, bind Skills, install content, contact cloud services, or execute Skill code.

The frozen definitions of Skill, Stack, Environment, and Machine are unchanged.

## Physical Location and Visibility

Scanner identity is based on physical evidence: root kind, scope, visible path, resolved path, content, and provenance. `agents` means the shared standard root `~/.agents/skills`; it is not an agent identifier. A Skill under a Codex root remains physically located in the Codex root even if another tool can consume it. Effective agent visibility belongs to adapters and is not modeled by the Phase 1 scanner.

## Package Boundaries

- `@stack/spec` exports Zod schemas and inferred TypeScript types for roots, locations, metadata, provenance, diagnostics, discovered content, collisions, summaries, and complete scan results.
- `@stack/scanner` depends on `@stack/spec` and implements root resolution, traversal, parsing, hashing, local provenance inspection, deduplication, and summary calculation.
- `@stack/cli` depends on `@stack/scanner`, invokes it, and renders either human text or clean JSON.
- `@stack/core`, `@stack/store`, `@stack/adapters`, and `@stack/cloud-client` remain uninvolved.

## Root Resolution

Default global roots are `.agents/skills`, `.cursor/skills`, `.claude/skills`, and either `$CODEX_HOME/skills` or `.codex/skills` under the supplied home directory. `--project` adds only the four corresponding roots directly beneath the selected working directory. It does not search parent directories or nested workspaces.

Every configured root yields a `ScannedRoot` with `missing`, `scanned`, or `failed` status. Missing roots are successful, expected outcomes. Root enumeration failures become error diagnostics while other roots continue.

## Discovery and Parsing

Traversal is bounded to 32 directory levels, remains within known roots, and does not follow arbitrary directory symlinks. A symlink directly resolving to a directory containing `SKILL.md` is a Skill occurrence; an organizational symlink without a directly exposed `SKILL.md` is skipped with a diagnostic. Once a Skill directory is found, it is treated as a boundary and its descendants are content rather than additional Skills.

`SKILL.md` must contain YAML frontmatter with non-empty string `name` and `description`. Additional keys are preserved. Invalid frontmatter produces diagnostics and an invalid content record without stopping the scan. A declared name differing from the containing directory produces a warning without repair.

## Hashing and Symlinks

SHA-256 covers deterministic entry records containing normalized relative paths and bytes. Entries are sorted lexicographically. `.git` directories, `.DS_Store`, and `Thumbs.db` are ignored. Scripts, assets, references, and all other files participate.

The visible Skill directory may itself be a symlink; hashing reads its resolved directory while retaining both visible and real paths in the location. Nested symlinks are never followed. Their relative path and link target text are hashed as link metadata and produce a warning, preserving deterministic behavior without traversing external graphs.

## Provenance and Deduplication

Phase 1 uses local evidence only. It checks whether the resolved Skill path belongs to a Git worktree and, when it does, records the local remote if present, HEAD revision, and repository-relative path. Otherwise it reports `local`. `unknown` is reserved for cases where provenance cannot be determined confidently. Installer-specific metadata is deferred because no trustworthy Stack installer format exists yet.

Content hash is the deduplication key. Identical content becomes one `DiscoveredSkill` with all physical locations preserved. The same declared name on multiple different hashes is never merged and produces a name-collision record and diagnostic.

## CLI and Failures

Human output reports physical roots, counts, duplicates, collisions, provenance, diagnostics, and the read-only assurance. JSON mode writes exactly one serialized `ScanResult` to stdout. Expected filesystem and metadata problems remain structured results with a successful command; unexpected internal failures set a non-zero exit status through Commander.

## Testing

Tests use temporary roots and committed fixture content, never the developer's real home. Coverage includes roots, nested discovery, parsing failures, name mismatch, hashing invariants, duplicates, collisions, scope, Codex root selection, read-only behavior, Git provenance, CLI JSON/human behavior, and symlink behavior with graceful platform skips.
