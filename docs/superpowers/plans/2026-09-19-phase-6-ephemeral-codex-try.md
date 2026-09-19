# Phase 6 Ephemeral Codex Try Implementation Plan

1. Add Phase 6 Zod contracts for trial resolution, isolation, session state, preparation, and exit results in `@stack/spec`; test parsing and secret-free serialization.
2. Add Core trial resolution in `packages/core/src/trial.ts`, reusing the local Stack loader and Phase 5 resolver with an empty ephemeral manifest/lock and ephemeral IDs. Test local/direct manifests, extends, optional behavior, conflicts, no-main operation, Store ingestion, and dry-run purity.
3. Add Codex trial runtime support in `packages/adapters/src/codex-trial.ts`: safe paths, allowlisted state bridge, staged runtime materialization, verification, isolated launch environment, cleanup, and typed errors. Test state allowlist, path isolation, exact content, success/non-zero/failure cleanup, and invariants for normal user Skills and binding registry.
4. Add `stack try <stack> -- codex`, dry-run, JSON output, and concise human rendering. Test canonical Commander syntax, no mutation/launch on dry-run, structured JSON, missing agent, and absence of Phase 7 commands.
5. Add fixture coverage and Technical Build Specification clarification.
6. Run install, typecheck, lint, tests, build, compiled CLI help/dry-runs, and a controlled fake-Codex isolation demonstration. Request code review, fix findings, commit, and verify clean Git status.
