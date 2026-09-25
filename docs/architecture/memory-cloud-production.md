# Remote Stack Memory — Production Architecture (Phase 14B)

**Status:** First production implementation. Version 0.1.0 (unpublished, undeployed).
Builds on the 14B0/14B1 spikes and ADRs
[0001](./adr/0001-envelope-encryption-for-remote-memory.md) /
[0003](./adr/0003-protection-modes-and-passkey-recovery.md).

Two privacy modes — **Standard** (server-readable, still strictly private) and
**Protected** (client-side encrypted, zero-knowledge to Stack). Everyday
`stack memory backup` serves both; complexity lives underneath.

## 1. The domain contract is the persistence boundary

`RemoteMemoryBackend` (in `@stack/memory`, per authenticated user) is implemented
three ways, and the same domain `modes` functions (`standardCloudBackup`,
`protectedCloudBackup`, `cloudRecover`, `migrateStandardToProtected`) run over all
three:

- **in-memory** (`inMemoryRemoteMemoryBackend`) — tests.
- **Supabase** (`apps/web/lib/memory-backend.ts`) — server persistence.
- **HTTP** (`stackCloudRemoteMemoryBackend`, CLI) — talks to the Cloud API.

The Cloud API is therefore just RPC over the contract: CLI adapter →
`@stack/cloud-client` → `@stack/cloud-server` handler/service → per-user backend.

```
stack memory backup (CLI)
  → domain modes  → StackCloud RemoteMemoryBackend (HTTP)
     → cloud-client → /api/v1/memory/* → cloud-server memory service
        → Supabase RemoteMemoryBackend → Postgres + private Storage
```

## 2. Key hierarchy (Protected)

```
recovery method (passkey PRF | recovery file | future trusted device)
   → wraps → Memory Master Key (MMK, persistent, 256-bit random)
   → wraps → per-backup DEK (fresh 256-bit random per generation)
   → encrypts → canonical MemoryBackupBundle (AES-256-GCM)
```

- **AEAD:** AES-256-GCM, random 96-bit nonce, routing metadata as AAD. Fresh DEK
  per backup ⇒ nonce reuse impossible.
- **KDF:** HKDF-SHA-256 with versioned domain separation (`stack-memory-recovery-v1`,
  `stack-memory-passkey-v1`, `stack-memory-bridge-v1`). Inputs (256-bit recovery key,
  32-byte PRF output) are already high-entropy, so no password-hardening KDF. A
  human passphrase would be a separate memory-hard path (not built).
- Versioned formats: `stack-mem-cipher-v1`, `stack-mem-bundle-v1`,
  `recovery-key-scrypt-…` is NOT used in production (the 14B0 scrypt path stayed in
  the spike). No custom cryptography — Node core + Web Crypto only.

Each recovery method wraps the same MMK independently: add/remove/rotate a method
without re-encrypting any backup. Removing the last method is refused (except via an
explicit Protected→Standard downgrade).

## 3. Canonical bundle

`stack-mem-bundle-v1` preserves the Phase 14A store byte-for-byte: the manifest file
plus every referenced content-addressed object. Recovery reconstructs the exact
local store (hash-verified); native Memory is never turned into semantic facts, and
Markdown/line-endings/bytes are never modified. Standard uploads the bundle as-is;
Protected uploads `nonce||ciphertext||tag`.

## 4. Backup generations & concurrency

Each committed backup is an immutable, numbered generation with a parent link.
`createGeneration(expectedParent, …)` is transactional (prepare → upload payload →
commit) and optimistic: if the current latest ≠ expectedParent it raises
`RemoteMemoryError('conflict')` (HTTP 409 `memory-conflict`) — no last-writer-wins.
The Postgres `commit_memory_generation` RPC enforces this atomically (raising
`STACK_REMOTE_CONFLICT`); an immutability trigger blocks mutation of a committed
generation except the retire transition. Incomplete generations never become latest.

## 5. Cloud schema (migration `supabase/migrations/0003_remote_memory.sql`)

- `memory_profiles` — per-user privacy mode + latest generation.
- `memory_backups` — immutable numbered generations (payload in Storage; only
  metadata here; Protected carries `crypto_version` + `wrapped_dek`, never project or
  file identities).
- `memory_recovery_methods` — opaque MMK wrapper envelopes per method.
- `memory_recovery_sessions` — one-time CLI↔browser relay (no RLS policy;
  service-role only, like `cli_auth_sessions`).
- Owner-select RLS on user-facing tables (defense-in-depth; the server derives
  identity from the token and writes via the service role). Private `stack-memory`
  Storage bucket. **Deploy with the project's normal Supabase migration workflow;
  it is not applied automatically here.**

## 6. CLI ↔ browser bridge (Protected recovery/enrollment)

WebAuthn PRF runs in the browser; Stack is a CLI. The bridge transfers the MMK so
the server only relays an opaque envelope: ephemeral ECDH P-256 → HKDF-SHA-256 →
AES-256-GCM, with AAD binding the one-time session, both public keys, the user, an
expiry, and a protocol version (defeating replay/misbinding). Neither private key
leaves its side; the server never sees the MMK. `direction` distinguishes
`recovery` (browser→CLI) from `enrollment` (CLI→browser). **Trust limit:** a
malicious Stack-served browser bundle could exfiltrate the MMK in the browser — not
defended in V0 (documented, accepted).

## 7. Local device key

An enrolled device stores the MMK in an AES-GCM envelope under a locally generated
device key, both owner-only (0600) under `$STACK_HOME/memory/keys/`
(`LocalMemoryKeyStore`). This keeps Stack Cloud blind and lets everyday Protected
backups run without a passkey prompt. It does **not** defend against full compromise
of the local OS account; OS-native secure storage (DPAPI/Keychain/Secret Service) is
future hardening. The raw MMK is never written in plaintext, put in config, or
logged.

## 8. Standard → Protected migration

`stack memory protect` establishes the MMK + a recovery method, enrolls the device,
then migrates: download each Standard generation, create an encrypted Protected
replacement, **verify it decrypts back to the original bytes**, and only then retire
the Standard payloads and finalize the account as Protected. Any failure leaves the
account Standard with Standard payloads intact — no partial/false "Protected".
Retirement is a soft-delete (bounded provider retention; not instant global erasure).

## 9. Security boundaries (proven by tests)

- Server stores ciphertext only for Protected; account access alone (wrong MMK)
  cannot decrypt.
- Cross-user isolation: another authenticated user cannot read or recover a user's
  Memory.
- Tamper/corruption/wrong-key/wrong-PRF fail closed.
- No Memory path from `stack publish` / public Stack resolution (separate namespace,
  private bucket, dedicated API surface).
- No secrets in logs or beginner output.

## 10. Rollback limitation (V0, honest)

A trusted local device keeps a high-water generation. A brand-new device after total
loss cannot, by itself, detect a provider serving a cryptographically valid but
stale generation without an external trusted anchor. No blockchain anchoring in this
phase; signed/chained generation heads are documented future hardening.

## 11. Synthetic live-dogfood commands (prepared — do NOT auto-run; no real Memory)

Run against synthetic, fenced accounts/data only. Real-Memory dogfood (C) requires
explicit user approval.

**Prereqs:** apply migration `0003`, deploy the web API (or run it locally), and
sign in the CLI (`stack login`) as a synthetic account.

**DOGFOOD A — Standard**

```
# machine 1 (synthetic memory in a fenced $STACK_HOME)
stack memory backup            # local + Standard Cloud
stack memory status            # Privacy: Standard
# destroy local store (fenced), then on a fresh machine:
stack login
stack memory recover           # Cloud -> private store
stack memory restore --dry-run # preview native restore
# verify: recovered store hashes == original (see modes byte-exact tests)
```

**DOGFOOD B — Protected (passkey PRF)**

```
stack memory protect           # choose Passkey; browser PRF ceremony
stack memory backup            # Protected (ciphertext only server-side)
# destroy local Memory + $STACK_HOME/memory/keys (device MMK), then fresh machine:
stack login
stack memory recover           # opens browser; passkey unlocks MMK via bridge
stack memory restore
# verify byte-exact; confirm server payload is ciphertext
# fallback: stack memory recover --recovery-file <path>
```

**DOGFOOD C — Real Claude Memory (ONLY after explicit user approval)**

```
stack memory protect
stack memory backup            # Protected Cloud backup of REAL memory
# fenced new machine:
stack login && stack memory recover && stack memory restore
# launch Claude; confirm recall of restored native memory (Phase 14A A/B method)
```

## 12. What is validated here vs. deployment

Validated offline (typecheck/lint/test/build green): the full domain, the cloud wire
(spec + server + client) via the in-memory backend, and the CLI end-to-end
round-trip (Standard + Protected byte-exact, cross-user isolation, fail-closed,
fresh-device recovery-key unlock). Not exercised here (no live infra): the deployed
Supabase migration and the browser passkey ceremony page — the Supabase backend and
bridge crypto are implemented and typechecked; the ceremony reuses the proven 14B1
PRF+bridge flow (`experiments/memory-remote/dogfood/`). See the final report for the
exact remaining deployment steps.
