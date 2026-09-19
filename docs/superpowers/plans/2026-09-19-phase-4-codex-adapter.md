# Phase 4 Codex Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Safely expose the preserved `main` Environment at Codex's current user Skill root and launch Codex without taking ownership of unrelated content.

**Architecture:** Cross-package contracts live in Spec; the Codex implementation and Machine binding registry live in Adapters; CLI only orchestrates load, detect, plan, approval, apply, verify, and launch. Store is the exclusive binding content source.

**Tech Stack:** Node.js 22+, strict ESM TypeScript, Zod, Vitest, pnpm, Turborepo.

**Spec:** `docs/superpowers/specs/2026-09-19-phase-4-codex-adapter-design.md`

## Global Constraints

- Preserve frozen Skill, Stack, Environment, and Machine concepts.
- New Codex bindings use `$HOME/.agents/skills`; legacy Codex roots are discovery-only.
- Never overwrite or delete unmanaged paths.
- Never bind from a current source directory; use the immutable Store.
- No Phase 5 commands or generalized transaction engine.

---

### Task 1: Exclude bundled legacy Codex Skills

**Files:** Modify `packages/scanner/src/scanner.ts`; test `packages/scanner/src/scanner.test.ts`.

**Interfaces:** Preserve `scanSkills(options): Promise<ScanResult>` while pruning only `.system` beneath Codex legacy roots.

- [ ] Add failing tests proving `.system` is skipped and sibling legacy Skills remain discoverable.
- [ ] Run scanner tests and confirm the new assertions fail.
- [ ] Add the narrow traversal exclusion.
- [ ] Rerun scanner tests to green.

### Task 2: Add Phase 4 contracts

**Files:** Create `packages/spec/src/adapter.ts`, `packages/spec/src/adapter.test.ts`; modify `packages/spec/src/index.ts`.

**Interfaces:** Produce Zod schemas/types for `AgentId`, detection, resolved binding Skills, records, registry, plan operations, apply/removal results, verification, and launch results.

- [ ] Add failing schema tests for valid registries/plans and unsafe or inconsistent records.
- [ ] Run Spec tests and observe missing exports.
- [ ] Implement the minimum schemas and exports.
- [ ] Run Spec tests to green.

### Task 3: Implement Codex resolution, detection, and planning

**Files:** Create `packages/adapters/src/types.ts`, `packages/adapters/src/errors.ts`, `packages/adapters/src/codex/paths.ts`, `detect.ts`, `registry.ts`, `plan.ts`, associated tests; modify package configuration and index.

**Interfaces:** Produce `AgentAdapter`; `resolveCodexBindingRoot`; `detectCodex`; `readBindingRegistry`; `planCodexBindings`.

- [ ] Write failing tests for current root resolution, `STACK_HOME` independence, detection success/failure, all planning states, collisions, unsafe names, and missing/corrupt Store.
- [ ] Run adapter tests and confirm failures are feature-related.
- [ ] Implement direct executable lookup, atomic registry parsing helpers, name validation, and pure planning.
- [ ] Run adapter tests to green and refactor only while green.

### Task 4: Implement transactional application and removal

**Files:** Create `packages/adapters/src/codex/apply.ts`, `remove.ts`, tests; extend registry helpers.

**Interfaces:** Produce `applyCodexBindings` and `removeCodexBindings`, both returning structured results and throwing typed adapter errors.

- [ ] Write failing tests for exact additions, managed updates, external drift, multiple additions, materialization/registry failures, rollback, healthy removal, and refusal cases.
- [ ] Run adapter tests and confirm red.
- [ ] Implement staged operations, rollback journals, post-write registry commit, and atomic registry persistence.
- [ ] Run adapter tests to green.

### Task 5: Implement verification and launch

**Files:** Create `packages/adapters/src/codex/verify.ts`, `launch.ts`, tests.

**Interfaces:** Produce `verifyCodexBindings` and `launchCodex`; complete `CodexAdapter` implementing `AgentAdapter`.

- [ ] Write failing tests for healthy/missing/changed bindings and direct spawn environment/cwd/stdio/shell/exit behavior.
- [ ] Run adapter tests and confirm red.
- [ ] Implement read-only verification and injected direct spawning.
- [ ] Run adapter tests to green.

### Task 6: Add `stack run codex`

**Files:** Create `packages/cli/src/commands/run.ts`, `packages/cli/src/ui/run.ts`; modify `program.ts`, `program.test.ts`, `bin.ts`, and package dependencies.

**Interfaces:** Register `run codex [--dry-run] [--json] [--yes]`; dependencies expose load/detect/plan/apply/verify/launch/confirm functions.

- [ ] Write failing CLI tests for missing `main`, missing Codex before mutation, dry-run output and immutability, conflicts, approval, no-change launch, JSON, and absent future commands.
- [ ] Run CLI tests and confirm red.
- [ ] Implement orchestration and rendering without domain logic.
- [ ] Run CLI tests to green.

### Task 7: Document, validate, and smoke-test

**Files:** Modify `docs/technical-build-spec.md`.

**Interfaces:** Document current/legacy roots, `.system`, ownership, registry, status separation, run flow, and Phase 6 isolation deferral.

- [ ] Update documentation without changing Product Foundation.
- [ ] Run `pnpm install`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, and `pnpm build`.
- [ ] Run built `stack run --help`, `stack run codex --help`, and controlled dry-run with temporary HOME/STACK_HOME/fake Codex.
- [ ] Review `git diff --check`, commit Phase 4, and confirm clean status.
