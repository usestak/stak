# Phase 0 Repository Foundation Design

## Scope

Phase 0 creates the repository foundation only. It establishes a pnpm and Turborepo TypeScript monorepo, eight library/CLI packages, a placeholder web workspace, fixture roots, shared tooling, a minimal help/version CLI, and CI. It does not implement scanning or any later-phase product behavior.

The Product Foundation definitions of Skill, Stack, Environment, and Machine remain unchanged.

## Architecture

The repository uses pnpm workspaces for dependency management and Turborepo for task orchestration. Every workspace is an ESM package with strict TypeScript settings inherited from `tsconfig.base.json`. Packages compile with `tsc` to their own `dist` directories and expose only their public entry points.

Dependency direction is inward:

- `@stack/cli` is presentation and orchestration and may consume lower-level packages.
- `@stack/core` contains agent-neutral domain logic and must not import CLI, web, React, or hosted-service concerns.
- `@stack/scanner`, `@stack/adapters`, `@stack/spec`, `@stack/store`, and `@stack/cloud-client` are separate infrastructure boundaries.
- `@stack/shared` contains only genuinely cross-cutting primitives when those are needed.
- `@stack/web` is a non-functional placeholder during Phase 0.

Phase 0 does not invent future APIs. Packages without behavior export a minimal marker so package resolution, compilation, and boundaries can be validated.

## Tooling

- Node.js 22 or newer and a pinned pnpm release through `packageManager`.
- Turborepo tasks for `build`, `test`, `lint`, and `typecheck`.
- TypeScript project configuration with strict ESM/NodeNext semantics.
- ESLint flat configuration with TypeScript rules and explicit restricted-import rules protecting core domain boundaries.
- Prettier for consistent formatting.
- Vitest for behavior tests.
- GitHub Actions on Node 22 running frozen install, typecheck, lint, test, and build.

## CLI

The `stack` executable uses Commander only to provide `--help` and `--version`. No `scan` command or other product command is registered. CLI construction is exported for an isolated behavior test, while the executable entry point performs process I/O.

## Fixtures and Documentation

The tracked fixture roots are `fixtures/skills`, `fixtures/environments`, `fixtures/stacks`, and `fixtures/machines`. Empty roots use `.gitkeep`. Existing product documents remain authoritative and unchanged.

## Verification

The completed repository must pass `pnpm install`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, and `pnpm build` from the root. The CLI tests assert help and version behavior through the real command parser.
