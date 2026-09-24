# ADR 0001 — Client-side envelope encryption for remote Memory backup

- **Status:** Proposed (Phase 14B0 spike). Not implemented; version 0.1.0 unchanged.
- **Date:** 2026-09-24
- **Context doc:** [`../memory-remote-spike.md`](../memory-remote-spike.md)

## Context

Phase 14A stores private agent Memory locally (byte-exact, content-addressed).
If the machine is destroyed, that memory is lost. We need a remote backup that a
new machine can recover, without the storage provider (Stack Cloud) being able to
read the memory — including project names, file names, and Git identities.

## Decision

Use **client-side envelope encryption**:

- Bundle the Phase 14A store into a canonical, byte-exact `MemoryBackupBundle`.
- Encrypt the bundle on-device with **AES-256-GCM** under a fresh random
  **per-backup DEK**; authenticate routing metadata as AAD.
- Derive a **KEK** from a 256-bit, client-generated **Stack Recovery Key** via
  **scrypt** (per-backup salt) and wrap the DEK with it.
- Upload only opaque ciphertext + the wrapped-key record + minimal non-sensitive
  routing metadata. The recovery key, KEK, and DEK never leave the device.

Recovery on a new machine: sign in, fetch the newest backup, verify its ciphertext
hash, supply the recovery key to unwrap the DEK, decrypt, and restore via Phase 14A.

## Consequences

- **Zero-knowledge to Stack:** account access alone cannot decrypt (proven in the
  prototype). Trade-off: a lost recovery key is unrecoverable by design.
- **No wallet, no tokens, no chain** — beginner-friendly recovery UX.
- Integrity, tamper, truncation, corruption, and (partial) rollback are detected
  and fail closed.
- Revocation, provider-availability attacks, and full rollback hardening are
  deferred to Phase 14B+ (see the spike doc §9, §12, §14).
- No custom cryptography: only Node core primitives are composed. The envelope is
  version-tagged (`stack-mem-cipher-v1`, `recovery-key-scrypt-aesgcm-v1`,
  `stack-mem-bundle-v1`) so algorithms can evolve without breaking old backups.

## Alternatives considered

Server-side/provider-held keys (rejected: not zero-knowledge); password-derived
keys without a high-entropy recovery key (rejected: brute-forceable); plaintext
manifest for server search (rejected: leaks identities).
