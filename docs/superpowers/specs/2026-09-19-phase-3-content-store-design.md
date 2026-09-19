# Phase 3 Content Store Design

## Scope

Phase 3 preserves every desired Skill locally, chooses portable restoration
metadata, verifies preservation during status/diff, and provides an internal
materializer. It adds no public restore command and never writes vendor roots.

## Boundaries

- `@stack/shared` owns one canonical filesystem tree enumeration and SHA-256
  implementation. Scanner and Store both consume it.
- `@stack/store` owns immutable content objects, verification, and controlled
  target materialization. It depends only on Shared and Spec.
- `@stack/core` selects reference versus snapshot, creates snapshot records,
  coordinates initialization, and combines Machine drift with preservation
  status. It depends on Store and Spec, not Scanner.
- `@stack/scanner` continues read-only discovery and enriches local Git evidence
  with subtree cleanliness.
- CLI only renders the structured results.

## Canonical tree semantics

Shared enumerates files and nested symlinks without following symlinks. It ignores
exactly `.git/`, `.DS_Store`, and `Thumbs.db`, normalizes relative paths to `/`,
sorts lexicographically, and retains the Phase 1 byte stream used for hashing.
The same entries drive store copying so hashing and preservation cannot diverge.
Every relative path is validated before writing beneath a target root.

## Store layout and lifecycle

```text
$STACK_HOME/store/sha256/<first-two-hex>/<full-hex>/
  content/
  object.json
```

Ingest verifies an existing object before reuse. A missing object is copied to a
sibling staging directory, rehashed, given validated metadata, and atomically
renamed. Corrupt existing objects are never replaced. Concurrent creation reuses
the winner only after verification. Failed staging is removed.

Materialization verifies the object, refuses an existing target, recreates the
canonical entries in a sibling staging directory, rehashes the result, and
atomically renames it. Unsupported symlink creation is a typed failure and never
falls back to dereferencing or flattening.

## Restoration policy

A reference is eligible only when exactly one distinct observation supplies a
portable HTTPS, SSH, Git, or SCP-style remote, exact revision, repository-relative
path, and `clean: true` subtree evidence. Multiple distinct eligible references
are ambiguous and use a snapshot. Local paths and `file:` remotes are not
portable. No network request is made.

Every other desired Skill uses a snapshot record under
`$STACK_HOME/snapshots/<snapshotId>.json`. The record references the immutable
content hash and logical Environment entry; it does not duplicate bytes. Reasons
distinguish local, unknown, ambiguous, modified, and non-portable sources.

## Initialization transaction

Core builds desired state, ingests every unique hash, chooses restoration policy,
stages snapshot records, and only then stages Environment/lock/baseline state.
Snapshot records and the baseline commit before the complete Environment directory,
which remains the final commit marker. Failure removes snapshot and Environment
staging. Already committed valid content objects may remain as harmless unreferenced
cache objects; a completed `main` can never claim unavailable preservation.

## Status and diff

Logical Machine alignment remains unchanged. Each desired Skill also receives an
independent preservation state: `available`, `missing`, or `corrupt`. Status and
diff call read-only verification and expose aggregate preservation and restoration
strategy counts. They never ingest, repair, rewrite, or refresh baselines.
