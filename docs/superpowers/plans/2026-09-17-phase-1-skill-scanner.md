# Phase 1 Skill Scanner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a deterministic, read-only scanner and the `stack scan` CLI with human and JSON output.

**Architecture:** `@stack/spec` defines stable scanner contracts, `@stack/scanner` produces structured results from injected physical roots, and `@stack/cli` renders those results. Content hashes group exact duplicates while names only identify collisions.

**Tech Stack:** Node.js 22+, strict ESM TypeScript, Zod, YAML, Commander, Vitest, local Git commands

**Spec:** `docs/superpowers/specs/2026-09-17-phase-1-skill-scanner-design.md`

## Global Constraints

- Scanning is read-only and performs no network access.
- Physical root identity and effective agent visibility remain separate.
- Only CLI → scanner → spec internal dependencies are introduced.
- Malformed Skills and failed roots do not prevent other discovery.
- No Phase 2 commands or models are implemented.

---

### Task 1: Scanner contracts and root resolution

**Files:**
- Create: `packages/spec/src/scanner.ts`
- Modify: `packages/spec/src/index.ts`, `packages/spec/package.json`
- Create: `packages/scanner/src/roots.ts`, `packages/scanner/src/roots.test.ts`
- Modify: `packages/scanner/package.json`, `packages/scanner/src/index.ts`

**Interfaces:**
- Produces: scanner schemas/types and `resolveScanRoots(options): SkillRoot[]`.

- [ ] Write failing tests for global roots, `CODEX_HOME`, fallback Codex home, and project roots.
- [ ] Run the focused tests and confirm missing exports fail.
- [ ] Implement schemas and deterministic root resolution.
- [ ] Run focused tests and typecheck.

### Task 2: Parsing, hashing, traversal, and provenance

**Files:**
- Create: `packages/scanner/src/frontmatter.ts`, `packages/scanner/src/hash.ts`, `packages/scanner/src/provenance.ts`, `packages/scanner/src/scanner.ts`
- Test: `packages/scanner/src/frontmatter.test.ts`, `packages/scanner/src/hash.test.ts`, `packages/scanner/src/scanner.test.ts`
- Create: Phase 1 content beneath `fixtures/skills/`

**Interfaces:**
- Produces: `hashSkillDirectory`, `parseSkillFile`, `detectProvenance`, and `scanSkills({ roots }): Promise<ScanResult>`.

- [ ] Add fixtures and failing tests for valid, nested, malformed, missing metadata, deterministic hashing, meaningful changes, ignored noise, scripts/assets, duplicates, collisions, multiple roots, and read-only behavior.
- [ ] Run focused tests and confirm failures are caused by missing scanner behavior.
- [ ] Implement the minimal parser, hasher, bounded traversal, provenance inspection, deduplication, diagnostics, and summaries.
- [ ] Run focused tests and refactor only while green.

### Task 3: Scope, Git, and symlink edge cases

**Files:**
- Test: `packages/scanner/src/scanner.test.ts`, `packages/scanner/src/provenance.test.ts`
- Modify: scanner implementation files as required by failing tests.

**Interfaces:**
- Extends scan results with correct global/project locations, Git provenance, visible/resolved symlink paths, and nested-link diagnostics.

- [ ] Add failing tests for project/global separation, Git metadata, direct Skill symlinks, nested symlinks, and failed/missing roots.
- [ ] Run focused tests and confirm the expected failures.
- [ ] Implement the smallest changes that satisfy the edge cases without following arbitrary link graphs.
- [ ] Run all scanner tests.

### Task 4: CLI orchestration and rendering

**Files:**
- Create: `packages/cli/src/commands/scan.ts`, `packages/cli/src/ui/scan.ts`
- Modify: `packages/cli/src/program.ts`, `packages/cli/src/program.test.ts`, `packages/cli/package.json`

**Interfaces:**
- Consumes: `resolveScanRoots` and `scanSkills` from `@stack/scanner`.
- Produces: `stack scan`, `--json`, and `--project`.

- [ ] Replace the Phase 0 no-scan assertion with failing tests for help, parseable JSON-only stdout, human output, project forwarding, and absence of Phase 2 commands.
- [ ] Run CLI tests and confirm they fail because `scan` is unregistered.
- [ ] Implement command orchestration and pure renderers.
- [ ] Run CLI tests and built CLI fixture smoke tests.

### Task 5: Documentation and final verification

**Files:**
- Modify: `docs/technical-build-spec.md`

**Interfaces:**
- Documents the approved physical-location versus adapter-visibility distinction.

- [ ] Add the narrow technical clarification without changing frozen product concepts.
- [ ] Run `pnpm install`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, and `pnpm build`.
- [ ] Run built CLI help, fixture JSON scan, and a safe real-root read-only smoke test.
- [ ] Inspect Git diff/status and commit Phase 1 without starting Phase 2.

