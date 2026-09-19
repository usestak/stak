# Phase 5 Stack Composition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compose immutable local Stack versions with direct Skills into `main`, safely remove layers, and reconcile stale Codex bindings.

**Architecture:** Spec owns portable contracts, Core owns loading/resolution/persistence, CLI owns preview/confirmation, and Adapters remain downstream. Desired-state mutation never writes agent roots.

**Tech Stack:** Node.js 22+, strict ESM TypeScript, Zod, YAML, Vitest, SHA-256, pnpm, Turborepo.

**Spec:** `docs/superpowers/specs/2026-09-19-phase-5-stack-composition-design.md`

## Global Constraints

- Product Foundation concepts remain frozen.
- Only local filesystem Stack references are supported.
- Absolute authoring paths never persist into portable state.
- Store ingestion precedes desired-state commit.
- `stack use/remove` never touch vendor Skill roots.
- Phase 6 commands remain absent.

### Task 1: Stack and composition contracts

**Files:** Create `packages/spec/src/stack.ts` and tests; modify Environment schemas.

- [ ] Write failing schema tests for manifests, layers, imported versions, origins, conflicts, and skips.
- [ ] Run Spec tests red.
- [ ] Implement schemas and exports; rerun green.

### Task 2: Local loader and deterministic version

**Files:** Create `packages/core/src/stack-loader.ts` and tests.

- [ ] Write failing tests for directory/direct paths, invalid/missing Skills, optional skips, extends, cycles, source-path removal, and deterministic version hashing.
- [ ] Run Core tests red.
- [ ] Implement read-only recursive loading and semantic hashing; rerun green.

### Task 3: Pure resolver

**Files:** Create `packages/core/src/resolver.ts` and tests.

- [ ] Write failing tests for exact dedupe, different names, required/optional rules, hard conflicts, origins, and ID reuse.
- [ ] Run red; implement pure ordered resolution; run green.

### Task 4: Atomic use/remove services

**Files:** Create `packages/core/src/composition.ts`; extend state and status; add integration tests.

- [ ] Write failing tests for preservation, portable persistence, bundle deletion, duplicate/version rejection, use/remove, shared requirements, stable IDs, and failure rollback.
- [ ] Run red; implement staging, imported-version persistence, and atomic main replacement; run green.

### Task 5: CLI use/remove

**Files:** Add CLI commands/rendering and tests; register dependencies.

- [ ] Write failing tests for help, previews, dry-run JSON, confirmation, `--yes`, conflicts, cancellation, and absent future commands.
- [ ] Run red; implement orchestration; run green.

### Task 6: Codex stale reconciliation

**Files:** Extend adapter contracts, planner, apply transaction, and tests.

- [ ] Write failing tests for healthy stale removal, modified stale blocking, external non-ownership, add/remove transaction, and rollback.
- [ ] Run red; implement removal planning/application; run green.

### Task 7: Fixtures, docs, validation

**Files:** Populate `fixtures/stacks`; update `docs/technical-build-spec.md`.

- [ ] Add representative local bundles and document Phase 5 semantics.
- [ ] Run install, typecheck, lint, test, build, built CLI help, and isolated end-to-end workflow.
- [ ] Review diff, commit, and confirm clean Git status.
