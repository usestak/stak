# Phase 6 Ephemeral Codex Try Design

## Boundary

Core loads a local Stack and resolves a trial-only Environment with the Phase 5 resolver. It never loads or writes `main`. The Codex adapter prepares and owns an isolated runtime beneath `$STACK_HOME/runtime`, bridges only allowlisted Codex state, materializes project-scoped Skills, launches Codex, and removes the runtime. CLI parses `stack try <stack> -- codex` and renders structured results.

## Trial data flow

1. Detect Codex before persistent runtime mutation.
2. Load the local Stack and resolve its requirements against an empty ephemeral Environment.
3. Stop on internal required conflicts.
4. For a real run, ingest exact Skill content into the immutable Store.
5. Stage a unique runtime containing `home`, `codex-home`, and `workspace/.agents/skills`.
6. Copy only `config.toml`, `auth.json`, and root `*.config.toml` files from the user's Codex home.
7. Materialize and verify each resolved Skill as a real directory.
8. Atomically rename the staged runtime to its final session path and launch Codex with isolated home variables and workspace cwd.
9. Clean the session after every exit or launch failure.

Dry-run stops after detection and resolution. It creates no Store object or runtime path.

## Isolation

The runtime changes only inherited child-process environment variables. It never invokes normal Codex binding planning, reads normal binding ownership for mutation, or writes user Skill roots. Built-in, administrator, OS-keyring, and intrinsic Codex capabilities remain outside this Skill-isolation guarantee.

## Safety

Runtime paths are constructed exclusively from a generated session ID. Skill names must be safe single path segments. Session metadata is schema validated and contains paths and hashes but no bridged file contents. Staged preparation is removed on failure. Unknown runtime directories are not automatically deleted.

## Deferred

Remote Stacks, existing-project mode, keeping workspaces, adoption into `main`, credential synchronization, and automatic orphan deletion remain deferred.
