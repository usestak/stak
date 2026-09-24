# ADR 0002 — Defer Seal + Walrus and Walrus Memory for V0 remote Memory

- **Status:** Proposed (Phase 14B0 spike). Not implemented; version 0.1.0 unchanged.
- **Date:** 2026-09-24
- **Context doc:** [`../memory-remote-spike.md`](../memory-remote-spike.md)

## Context

We evaluated two decentralized options alongside Stack Cloud envelope encryption
(ADR 0001) for backing up private agent Memory:

- **Option B — Seal + Walrus:** Walrus is public blob storage ("All blobs uploaded
  to Walrus are publicly available" — no confidentiality); Seal adds client-side
  encryption and on-chain access policies.
- **Option C — Walrus Memory:** a semantic `remember`/`recall` memory layer for AI
  agents, built on Seal + Walrus.

(Findings grounded in official docs, fetched 2026-09-24 — see the spike doc §2.)

## Decision

**Do not adopt Option B or C for the V0 remote-recovery feature.** Keep a
`RemoteMemoryBackend` plugin interface so Option B can be added later as an optional
self-custodied, decentralized tier, and evaluate Option C **separately** as a future
semantic layer (not disaster recovery).

## Rationale

- **Option B collides with the no-wallet UX requirement.** Seal ties identity and
  recovery to a **Sui wallet** and requires wallet-signed session keys; Walrus
  needs a **Sui wallet + WAL + SUI** and signed transactions. Stack must not put an
  owner key in the server or silently custody it, so the wallet burden cannot be
  hidden. Storage is **epoch-bounded** and must be **renewed via the Sui object
  id** or it expires. MPC committee mode is **testnet-only**; the SDK is **beta**;
  rotation/revocation are undocumented.
- **Option C is semantic, not byte-exact.** Walrus Memory stores meaning
  (embeddings), not exact file bytes/restore descriptors/identity/hashes/version,
  so it cannot reconstruct the Phase 14A store. Its default managed relayer also
  **sees plaintext** (only the manual client flow keeps keys client-side).

## Consequences

- V0 ships with Option A (ADR 0001): beginner-friendly, zero-knowledge, no chain.
- The `RemoteMemoryBackend` interface and env-gated, compile-valid Seal/Walrus and
  Walrus Memory sketches (`experiments/memory-remote/`) preserve a low-cost path to
  revisit Option B for a crypto-native tier and Option C for semantic cross-agent
  recall — as independent product decisions.
- All external facts must be re-verified against live docs before any future
  implementation.
