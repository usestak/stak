# Phase 5 Stack Composition Design

## Architecture

`@stack/spec` defines authoring manifests, imported immutable versions, Environment layers, origins, resolver results, skips, and conflicts. `@stack/core` owns local loading, deterministic version construction, pure resolution, and atomic desired-state mutation. `@stack/cli` previews and confirms `use`/`remove`. Adapters remain downstream and reconcile the resulting resolved Environment only when `stack run codex` executes.

## Import and persistence

`stack.yaml` accepts relative Skill and `extends` paths. Loading recursively canonicalizes directory or manifest inputs, detects cycles, validates Skills without modifying them, and orders parents depth-first in declared order with duplicate manifests visited once. Required invalid references fail; optional invalid references are recorded as deterministic skips.

The imported form contains portable resolved requirements and inherited Stack descriptors, never source paths. Its semantic JSON is key-sorted and SHA-256 hashed. Confirmed use assigns a random `stack_*` identity and stores immutable `stack.json` plus `stack.lock.json` under `$STACK_HOME/stacks/<stackId>/versions/<hex>/`. Store ingestion precedes desired-state commit; valid orphan objects/versions after late failure are acceptable.

## Resolution

The resolver processes direct Skills first, then layers in Environment order, and requirements within persisted deterministic order. The slot key is declared name. Equal name/hash requirements deduplicate and retain all origins. Different names never deduplicate. Required/required conflicts block. Required wins over optional. Optional/optional selects the first candidate and records later conflicts as skipped.

Direct IDs always win. Existing resolved IDs are reused by slot name when the selected logical requirement remains; new Stack-only slots receive `skill_<uuid>` during committed mutation. Preview uses deterministic provisional IDs that are never persisted.

## Desired state

`environment.yaml` retains direct entries and adds portable Stack layers. `stack.lock.json` represents all resolved Skills and records requirement origins. The Machine baseline receives empty locations for newly desired Stack Skills and drops entries no longer desired; it never claims Store content is Machine placement.

Use/remove stage and validate manifest, lock, and baseline together, swap the Environment directory and baseline with rollback copies, and leave Codex/vendor roots untouched.

## Codex reconciliation

Planning compares the registry with the resolved desired IDs. Healthy registered entries absent from desired become `remove-managed`. Modified stale managed entries become a blocking `managed-drift`. Apply handles additions, updates, and removals in one rollback journal. External content was never registered and is untouched.

## Scope

Only local manifests are supported. Registry names, URLs, updates, persistent conflict overrides, garbage collection, and `stack try` remain deferred.
