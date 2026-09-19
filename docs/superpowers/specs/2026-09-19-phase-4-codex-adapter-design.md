# Phase 4 Codex Adapter Design

## Scope

Phase 4 exposes the preserved `main` Environment to Codex through the current user Skill root and launches Codex. It adds no Stack composition, isolated testing, cloud behavior, or adapters for other agents.

## Boundaries

- `@stack/spec` owns agent, binding, registry, verification, and launch contracts.
- `@stack/adapters` owns Codex detection, target resolution, planning, transactional application, verification, removal, and launch.
- `@stack/store` remains the only source of bytes for bindings.
- `@stack/cli` loads `main`, orchestrates the adapter, handles confirmation, renders structured plans, and launches.
- Environment drift and Codex binding state remain independent.

Runtime internal dependencies are `cli -> adapters/core/scanner/spec`, `adapters -> spec/store/shared`, `core -> spec/store`, `scanner -> spec/shared`, and `store -> spec/shared`.

## Codex Paths

New Stack-managed Codex user bindings target `$HOME/.agents/skills/<declared-name>`. `STACK_HOME` never affects this path. `$CODEX_HOME/skills` and `~/.codex/skills` remain read-only legacy discovery roots. Scanner excludes the top-level `.system` subtree only for legacy Codex roots. `/etc/codex/skills` and bundled Skills are outside V0 personal management.

## Contracts and Ownership

The adapter consumes a resolved local Environment containing persistent entry IDs, declared names, hashes, and preservation state. A Machine registry lives at `$STACK_HOME/state/machines/<machineId>/bindings/codex.json` and records absolute target paths created by Stack.

A path is managed only when its normalized path and Environment entry match a registry record. Identical unmanaged bytes are `externally-satisfied` and never become owned. Differing unmanaged bytes are `conflict-unmanaged`. Two desired entries with one declared target name are `conflict-name`. Unsafe names are `invalid-target-name`.

Planning states are `already-managed`, `externally-satisfied`, `add`, `update-managed`, `managed-drift`, `conflict-unmanaged`, `conflict-name`, `invalid-target-name`, `store-unavailable`, and `store-corrupt`. Conflicts and unavailable content block all application.

## Transactions

Adds materialize from Store and are registered only after successful verification. Managed updates move the old target to a private sibling rollback path, materialize the desired object, verify it, then update the registry. A multi-operation failure restores prior managed targets and removes additions from that operation. Registry persistence is an atomic temporary-file rename; if it fails, filesystem changes are rolled back.

Removal is internal. It removes only a registered target whose current hash equals the registered installed hash. Missing, unmanaged, or externally modified targets produce structured conflicts rather than deletion.

## Detection and Launch

Detection searches injected or process `PATH` directly, including Windows executable suffixes, without a shell. It may spawn the resolved executable with `--version`, `shell: false`, a timeout, and captured stdio. Missing Codex is a normal `installed: false` result.

Launch directly spawns the resolved executable with inherited stdio, `shell: false`, the requested/current working directory, and the existing environment unchanged. It reports the process exit status. Project Skill discovery remains Codex's responsibility.

## CLI Flow

`stack run codex` loads `main`, detects Codex before mutation, plans bindings, stops on conflicts, prompts only when writes are required, applies and verifies, then launches. `--yes` approves safe mutations but never conflicts. `--dry-run` detects and plans without mutation or launch. `--dry-run --json` writes only structured JSON to stdout.

## Safety and Testing

All filesystem roots, executable lookup, process spawning, confirmation, and persistence are injectable. Tests use temporary homes, Stack homes, stores, and fake executables. They cover scanner exclusion, every plan class, transactional rollback, registry atomicity, removal safety, verification, process invocation, CLI orchestration, and separation from Machine baseline state.
