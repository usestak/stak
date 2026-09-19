# Phase 2 Local Environment Implementation Plan

1. Add Zod contracts for Machine identity, portable Environment/lock, Machine
   baseline, status, and diff in `@stack/spec`; test schema path separation.
2. Add Core state paths, serialization/loading, atomic initialization, and Machine
   identity; drive implementation with temporary-directory tests.
3. Add Core comparison logic for logical drift, placement drift, collisions,
   invalid discovery, and failed-root uncertainty; cover the required scenarios.
4. Register `init`, `status`, and `diff` in CLI with human and JSON renderers;
   test parseable output and command boundaries.
5. Document the portable/Machine split and drift semantics in the technical spec.
6. Run install, typecheck, lint, test, build, built CLI help/JSON checks, and an
   isolated `STACK_HOME` smoke test; fix every failure before reporting.
