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

## 13. Phase 14B.2 closure — passkey ceremony, device-key hardening, deploy readiness

**Passkey web ceremony (built).** `apps/web/app/memory/protect` and
`.../recover` are minimal authenticated pages that run the WebAuthn PRF ceremony in
the browser and drive the one-time relay via cookie-authenticated server actions
(`app/memory/actions.ts` → `lib/recovery-actions.ts`). The browser crypto
(`lib/recovery-webcrypto.ts`, Web Crypto only) is the SAME construction as
`@stack/memory`; `lib/recovery-webcrypto.interop.test.ts` proves envelopes/wrappers
it produces are decrypted by the Node/CLI domain and vice-versa. The CLI side is
`stack memory protect --passkey` / `stack memory recover --passkey` (create session
→ open browser → poll relay → `openMmkFromEnvelope` → enroll device → migrate/
recover). Strict PRF detection: passkey support ≠ usable PRF; the ground truth is a
real `get()` returning `prf.results`. When PRF is unavailable the UI says exactly
that and points to the recovery file — never a silent Standard downgrade. The server
only ever relays the opaque session + envelope; it never sees the MMK. **Trust
limit unchanged:** a malicious Stack-served browser bundle could exfiltrate the MMK
in the browser — not defended in V0.

**Local device-key threat (measured).** Verified on Windows with `icacls`: Node's
`mode: 0o600` does NOT set NTFS ACLs — key files inherited the parent directory's
ACL (granting other principals read/modify). Fix: `LocalMemoryKeyStore` now locks
the keys directory to the current user's SID before writing (best-effort, via
built-in `whoami.exe`/`icacls.exe` at absolute System32 paths; `/inheritance:r` +
inheritable current-user-only grant). Verified result: `device-key.bin` and
`device-mmk.json` become `<user>:(I)(F)` only, and read-back still works.

Threat statement (explicit): **an attacker who can read BOTH the device key AND the
envelope file can decrypt the MMK.** The device-key indirection is for future
OS-keystore migration, not protection against local theft of both files. This is
distinct from **accidental access by unrelated local principals** (e.g. an inherited
group ACE), which Protected enrollment now actively prevents. Guarantees by platform:

- **POSIX (macOS/Linux):** owner-only via `mode 0o600` (`rw-------`).
- **Windows:** owner-only via `icacls` (Administrators/SYSTEM always retain access).
- **Fail-closed (14B.2.1):** after writing, `saveMmk` **verifies** the result is
  owner-only (POSIX: no group/other mode bits; Windows: a single non-inherited DACL
  principal). If it cannot verify, the partial key state is removed and enrollment
  **fails** — Protected is not enabled, the Cloud profile is not finalized Protected,
  no recovery-file is written, and there is no downgrade to Standard. Recovery that
  has already restored the store enrolls best-effort and never persists insecure key
  material. Platform calls sit behind an injectable abstraction so the fail-closed
  logic is unit-tested; the real ACL result is confirmed by the manual procedure.
- **All platforms:** V0 does NOT protect against full compromise of the local OS
  account (or a local Administrator). Future hardening (follow-up): OS-native secret
  storage — Windows Credential Manager / DPAPI, macOS Keychain, Linux Secret Service.

Windows ACL verification (read-only, manual): after enrolling a device
(`stack memory protect`), inspect the key files without revealing contents:

```
icacls "%STACK_HOME%\memory\keys\device-key.bin"
icacls "%STACK_HOME%\memory\keys\device-mmk.json"
```

Expect only the current user (e.g. `DOMAIN\User:(I)(F)`), no inherited group ACEs.

**Deployment readiness.** See
[`memory-cloud-deployment.md`](./memory-cloud-deployment.md) for the migration
review checklist, the exact manual `supabase db push` / psql procedure, verification
queries, and rollback SQL. The migration is not applied automatically.

### Manual production-page dogfood (prepare; do NOT auto-run; no real Memory)

> **Completed 2026-09-26 — PASS.** This was run end-to-end against a linked hosted
> Supabase project with synthetic data (Standard + Protected, fresh-machine passkey
> recovery, post-recovery continuity, and a second total-loss recovery). Full recorded
> evidence is in [`memory-cloud-deployment.md` §4](./memory-cloud-deployment.md).

Stronger than the isolated 14B1 dogfood because it exercises the real UI/API/bridge.

**A. Passkey enrollment (synthetic MMK):**

1. Apply migration 0003 to a staging project; run the web app; `stack login` (synthetic account).
2. `stack memory backup` (seeds a Standard backup).
3. `stack memory protect --passkey` → browser opens `/memory/protect` → create passkey (Google Password Manager / Windows Hello) → real PRF → wrapper stored → MMK sealed to CLI → device enrolled + migrated to Protected.
4. Confirm `stack memory status` shows Privacy: Protected, Recovery: Passkey.

**B. Passkey recovery (synthetic MMK, fresh device):**

1. On a fenced fresh `$STACK_HOME`: `stack login` → `stack memory recover --passkey`.
2. Browser opens `/memory/recover` → authenticate the synced passkey → real PRF → MMK unwrapped → sealed to CLI → downloaded/decrypted → local store reconstructed.
3. Verify byte-exact recovery (`stack memory restore --dry-run`), then confirm the CLI's recovered MMK hash matches (synthetic).

No real Claude Memory is used in A or B. Real-Memory dogfood (C) requires explicit
user approval and is not part of this phase.
