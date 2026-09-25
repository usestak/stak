# ADR 0003 — Standard/Protected modes, MMK hierarchy, and passkey PRF recovery

- **Status:** Proposed (Phase 14B1 spike). Not implemented; version 0.1.0 unchanged.
- **Date:** 2026-09-25
- **Context doc:** [`../memory-protection-modes-spike.md`](../memory-protection-modes-spike.md)
- **Supersedes (recovery model):** the 14B0 direct recovery-key→DEK wrapping
  ([ADR 0001](./0001-envelope-encryption-for-remote-memory.md)).

## Context

Stack Memory needs a remote backup that serves both a simple user (no recovery
credential) and a privacy-maximizing user (client-side encryption), plus a recovery
story for the encrypted case that works for a normal developer with no wallet.

## Decision

1. **Two modes.** Standard (server-readable at rest, still strictly private) and
   Protected (client-side encrypted, zero-knowledge to Stack). Both first-class;
   Standard is never described as insecure/plaintext.
2. **MMK hierarchy.** A persistent Memory Master Key sits between recovery methods
   and per-backup DEKs: `recovery method → wraps MMK → wraps DEK → encrypts bundle`.
   Adding/removing/rotating a recovery method touches only MMK wrappers, never
   backup ciphertext.
3. **HKDF, not scrypt, for random material.** Recovery keys and PRF outputs are
   already high-entropy; derive KEKs with HKDF-SHA-256 and versioned domain
   separation. A memory-hard password KDF is reserved for a future human-passphrase
   path and never mixed with this one.
4. **Passkey PRF as primary recovery**, recovery file as fallback. Each passkey and
   the recovery file is an independent MMK wrapper. Never assume "passkey = PRF" or
   that synced passkeys yield the same PRF across devices — enroll per authenticator.
5. **CLI↔browser zero-knowledge bridge.** Ephemeral ECDH P-256 + HKDF + AES-GCM,
   bound to a one-time session/CLI key/user/expiry/version; the server relays only
   an opaque envelope and never learns the MMK.

## Consequences

- Protected: Stack account compromise without a recovery method cannot decrypt
  (proven). Standard: infra can read (disclosed).
- Multiple recovery methods, method removal, and rotation work without
  re-encrypting backups (proven for add/remove/multi-unwrap; rotation designed).
- **Trust limitation:** the bridge does not defend against Stack serving malicious
  browser JavaScript; disclosed and accepted for V0, with future mitigations noted.
- **Cross-device synced-PRF determinism is not guaranteed;** the design tolerates
  this via per-authenticator wrappers + a recovery file. It was NOT tested and must
  not be assumed.
- "Deletion" in migration is soft-delete + bounded retention, not instant global
  erasure; disclosed.

## Evidence

- **Single-device passkey PRF recovery: PROVEN (manual dogfood, 2026-09-25).**
  Windows + Chrome + Google Password Manager (localhost, RP ID `localhost`). Real
  passkey create + WebAuthn PRF `get()`; a synthetic random MMK was wrapped, the
  plaintext discarded, and after a fresh authentication the MMK was recovered with a
  matching hash. No real Memory; no key material displayed or logged. Scope is the
  tested environment only — this does not imply all passkeys/providers support PRF,
  nor that PRF reproduces across a genuinely different device. See the spike doc
  §17.1 and decisions A/B/C.

## Alternatives considered

Single mandatory encrypted mode (rejected: worse first-run UX, no simple tier);
recovery key wrapping each backup directly, 14B0-style (rejected: can't add methods
without re-encrypting); password-hardening KDF on already-random keys (rejected:
unnecessary); passkey as login replacement (rejected: keep GitHub OAuth for
identity; recovery ≠ login).
