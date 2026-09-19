# Phase 2 Local Environment Design

## Scope

Phase 2 adds local Machine identity, `main`, and read-only drift reporting through
`stack init`, `stack status`, and `stack diff`. It does not store Skill content or
repair the Machine.

## Boundaries

- `@stack/scanner` remains a read-only producer of `ScanResult`.
- `@stack/cli` orchestrates a fresh global scan and passes structured data to Core.
- `@stack/core` creates, validates, persists, loads, and compares local Environment
  state. It consumes scanner contracts from `@stack/spec`, not scanner runtime code.
- `@stack/spec` owns all persisted and command-result schemas.
- Store, adapters, cloud client, and web remain uninvolved.

This produces `cli -> {scanner, core, spec}`, `core -> spec`, and
`scanner -> spec`.

## Three state layers

1. `ScanResult` is current Machine discovery.
2. `environment.yaml` and `stack.lock.json` are portable desired state. They never
   contain observed absolute vendor paths.
3. `state/machines/<machineId>/environments/main.json` is Machine-specific
   placement baseline and may contain absolute paths.

## Identity and resolution

Each imported logical Skill receives a random UUID-based `skill_...` entry ID at
initialization. The ID is persisted rather than recalculated from name, hash, or
path, so later content updates need not change logical identity. Exact duplicate
content creates one entry; same-name/different-content Skills create distinct
entries.

The lock records the desired hash and all distinct observed source evidence. A
single unambiguous Git source may be selected as preferred; ambiguity is retained
instead of guessed. Local and unknown Skills remain desired entries.

## Persistence

Machine identity uses a same-directory temporary file and atomic rename. Init
validates all objects in memory, writes and re-parses a staged Environment
directory plus staged baseline, commits the baseline first, and renames the
complete Environment directory last. The presence of `environments/main` is the
commit marker. Failures clean staging state and never expose a partial `main`.

## Drift classification

- `satisfied`: desired hash exists anywhere in the successful global observation.
- `modified`: desired hash is absent, but a baseline path still contains different
  content.
- `missing`: desired hash is absent and no baseline location remains.
- `uncertain`: desired hash is absent and a failed root prevents a conclusive
  observation.
- `untracked`: valid current content is neither desired nor assigned as an
  in-place modification.

Placement drift compares baseline occurrences with current occurrences separately
from logical state. It reports added, removed, and resolved-target changes. A
removed duplicate does not make a still-present logical Skill missing. Status and
diff only read state and Skill roots.
