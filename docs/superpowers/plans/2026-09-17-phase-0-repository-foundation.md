# Phase 0 Repository Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create the validated Phase 0 pnpm/Turborepo TypeScript monorepo foundation for Stack without implementing later-phase functionality.

**Architecture:** pnpm owns the workspaces and Turborepo coordinates uniform package scripts. Each ESM workspace compiles independently with strict shared TypeScript settings and exposes a single public entry point; ESLint restrictions protect the agent-neutral core from CLI, web, React, and hosted-service dependencies.

**Tech Stack:** Node.js 22+, pnpm, Turborepo, TypeScript, Commander, Vitest, ESLint, typescript-eslint, Prettier, GitHub Actions

**Spec:** `docs/superpowers/specs/2026-09-17-phase-0-repository-foundation-design.md`

## Global Constraints

- Implement Phase 0 only; do not implement `stack scan` or later functionality.
- Preserve the frozen Skill, Stack, Environment, and Machine concepts.
- Use ESM and strict TypeScript throughout.
- Keep core agent-neutral and independent of CLI, web, React, Supabase, and hosted-service concerns.
- All root acceptance commands must exit successfully.

---

### Task 1: Root workspace and tooling

**Files:**
- Create: `.gitignore`, `.prettierignore`, `.prettierrc.json`, `eslint.config.js`, `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `turbo.json`

**Interfaces:**
- Produces: root scripts `build`, `test`, `lint`, `typecheck`, and `format`; shared compiler and lint rules consumed by all workspaces.

- [ ] Create the root package manifest with Node 22, pinned pnpm, Turbo scripts, and development dependencies.
- [ ] Configure workspace discovery for `apps/*` and `packages/*`.
- [ ] Configure strict NodeNext TypeScript, Turbo task outputs, ESLint flat rules, Prettier, and ignored generated files.
- [ ] Run `pnpm install` and retain the generated lockfile.

### Task 2: Workspace package skeletons and fixture roots

**Files:**
- Create: `packages/{core,scanner,adapters,spec,store,cloud-client,shared}/package.json`
- Create: `packages/{core,scanner,adapters,spec,store,cloud-client,shared}/tsconfig.json`
- Create: `packages/{core,scanner,adapters,spec,store,cloud-client,shared}/src/index.ts`
- Create: `apps/web/package.json`, `apps/web/tsconfig.json`, `apps/web/src/index.ts`
- Create: `fixtures/{skills,environments,stacks,machines}/.gitkeep`

**Interfaces:**
- Produces: importable public package roots for `@stack/core`, `@stack/scanner`, `@stack/adapters`, `@stack/spec`, `@stack/store`, `@stack/cloud-client`, `@stack/shared`, and the private `@stack/web` placeholder.

- [ ] Add uniform ESM package manifests with `exports`, `types`, and root task scripts.
- [ ] Add per-package compiler configurations extending `tsconfig.base.json`.
- [ ] Add minimal typed public markers without domain behavior.
- [ ] Add all four tracked fixture roots.
- [ ] Run root typecheck and build to prove package resolution and output generation.

### Task 3: Minimal CLI through TDD

**Files:**
- Create: `packages/cli/package.json`, `packages/cli/tsconfig.json`
- Test: `packages/cli/src/program.test.ts`
- Create: `packages/cli/src/program.ts`, `packages/cli/src/index.ts`, `packages/cli/src/bin.ts`

**Interfaces:**
- Consumes: Commander.
- Produces: `createProgram(): Command`, the `@stack/cli` public export, and the `stack` executable.

- [ ] Add the CLI workspace manifest and compiler configuration.
- [ ] Write tests asserting that help identifies Stack and version output equals the package version.
- [ ] Run the CLI test and confirm it fails because `createProgram` does not exist.
- [ ] Implement the minimal Commander program and executable entry point, registering no product commands.
- [ ] Run the CLI tests and confirm they pass.

### Task 4: Continuous integration and repository verification

**Files:**
- Create: `.github/workflows/ci.yml`
- Modify: any Phase 0 file required to fix validation failures.

**Interfaces:**
- Consumes: root scripts and `pnpm-lock.yaml`.
- Produces: CI validation on Node 22 with frozen dependency installation.

- [ ] Add GitHub Actions checkout, pnpm setup, Node 22 setup/cache, install, typecheck, lint, test, and build steps.
- [ ] Run `pnpm install` from the root.
- [ ] Run `pnpm typecheck`, `pnpm lint`, `pnpm test`, and `pnpm build` from the root.
- [ ] Fix every failure and rerun the complete validation sequence.
- [ ] Inspect the repository tree and Git status for the final handoff.
