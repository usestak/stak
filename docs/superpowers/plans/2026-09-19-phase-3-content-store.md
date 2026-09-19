# Phase 3 Content Store Implementation Plan

1. Move canonical tree enumeration/hash behavior into `@stack/shared`, retaining
   Phase 1 golden behavior and adding safe copy/symlink tests; update Scanner to
   consume it and verify unchanged hashes.
2. Add Spec contracts for content objects, restoration strategies, snapshots, and
   preservation status; write schema tests before implementation.
3. Build `@stack/store` ingestion, verification, typed errors, and materialization
   through failing filesystem tests covering deduplication, corruption, staging,
   path safety, full trees, and symlinks.
4. Extend Git provenance with local subtree cleanliness and test clean, modified,
   untracked, and non-portable-remote cases without network access.
5. Add Core policy selection and snapshot records, then integrate preservation into
   atomic init. Cover duplicates, ambiguity, portable locks, and failed preservation.
6. Extend Core status/diff and CLI rendering with independent preservation results;
   prove read-only behavior and JSON compatibility.
7. Add the controlled recovery integration test: init, delete source, observe
   missing, materialize from Store, and verify the canonical hash.
8. Update the technical specification, run all root validations and built-CLI
   smoke tests with isolated temporary state, audit Git, and commit Phase 3 only.
