# Memory Remote Backup, Encryption & Recovery — Architecture Spike (Phase 14B0)

**Status:** Spike / exploration. **Not** an implementation commitment.
**Date:** 2026-09-24. **Version line:** 0.1.0 (unchanged; nothing here ships).
**Prototype:** [`experiments/memory-remote/`](../../experiments/memory-remote) —
isolated, imported by nothing that ships, synthetic fixtures only.

This document answers one question: **how does a user's private agent Memory
survive the total loss of the machine it was created on**, such that a brand-new
machine can recover it, while the storage provider cannot casually read it?

It compares three serious options without pre-judging, states a threat model
first, and recommends a path plus the exact scope for a future Phase 14B.

---

## 1. Purpose, scope, and non-goals

**In scope.** Encryption, decryption, and key recovery for backing up the
Phase 14A private Memory store to a remote location, so a new machine can restore
it after the original is destroyed. A working offline prototype of one option, and
compile-valid, grounded sketches of the other two.

**Explicitly a spike.** No production code path is touched. No CLI command is
added. `stack memory protect` / `stack memory recover` appear only as conceptual
UX and as an isolated harness (`protect()` / `recover()` in the prototype).

**Non-goals for V0 (called out so they are not silently assumed):**

- Full multi-device live sync (designed here, not implemented).
- Real-time collaboration or shared team memory.
- Server-side search over memory (would require plaintext or a searchable-encryption
  scheme; out of scope).
- Portable **semantic** memory (remember/recall). Evaluated for the future but
  kept strictly separate from disaster recovery — see §4 and §11.
- Any live network write to Walrus/Seal/Stack Cloud. No live test is claimed.

---

## 2. Version assumptions and sources

All external findings below were gathered from official docs on **2026-09-24** and
are version-sensitive. Treat them as assumptions to re-verify before implementation.

**Walrus** (decentralized blob storage):

- https://docs.wal.app/ — "Open-source decentralized storage infrastructure."
- https://docs.wal.app/docs/system-overview/core-concepts — blob IDs, epochs.
- https://docs.wal.app/docs/system-overview/storage-costs — cost model.
- https://docs.wal.app/docs/walrus-client/storing-blobs — storing/extending.
- https://sdk.mystenlabs.com/walrus + npm `@mysten/walrus` (~1.2.x, actively
  published; no formal stability label found — treat as evolving).

**Walrus Memory** ("Portable memory layer for AI agents"):

- https://docs.wal.app/walrus-memory + `/getting-started/quick-start` +
  `/sdk/api-reference` + `/relayer/self-hosting`.
- Reference impl: https://github.com/MystenLabs/MemWal ; SDK
  `@mysten-incubation/memwal` (incubation).

**Seal** (encryption + on-chain access policies):

- https://docs.sui.io/sui-stack/seal (redirect target of `seal-docs.wal.app`) +
  `/seal/design` + `/seal/using-seal`.
- https://seal.mystenlabs.com/ — states Seal is "currently live on Mainnet."
- npm `@mysten/seal` — **beta**, actively released (1.4.x observed).

**Key version-sensitive facts assumed:**

- Walrus: "All blobs uploaded to Walrus are publicly available" — **no
  confidentiality**; encryption must precede upload.
- Walrus: storage is epoch-bounded (~2 weeks/epoch on mainnet); blobs expire;
  extension is done via the **Sui object id**, not the blob id; storing needs a
  **Sui wallet + WAL + SUI**.
- Seal: MPC **committee mode is testnet-only**; identity/recovery is tied to a
  **Sui wallet**; session keys need a **wallet signature** and are short-lived; an
  optional exported 32-byte **backup key** is the break-glass path. Rotation and
  revocation are **not documented** (open risk).
- Walrus Memory: default managed relayer **sees plaintext**; only the manual
  client flow keeps keys/plaintext client-side; it is a **semantic** store.

---

## 3. Threat model (enumerated) and what V0 protects

Adversaries considered: a curious or breached storage provider; a network MITM; a
thief of one device; an attacker with the user's Stack account credentials; an
attacker who tampers with stored data; and the user's own operational mistakes.

| #   | Threat                                                           | V0 (Option A) stance                                                |
| --- | ---------------------------------------------------------------- | ------------------------------------------------------------------- |
| T1  | Storage provider reads memory contents at rest                   | **Protected** — only AEAD ciphertext is stored                      |
| T2  | Provider employee/DB dump reads project/repo/file names          | **Protected** — manifest is inside the encrypted bundle             |
| T3  | Network MITM reads memory in transit                             | **Protected** — ciphertext + TLS; plaintext never sent              |
| T4  | Attacker with Stack account creds alone decrypts a backup        | **Protected** — needs the recovery key, which Stack never holds     |
| T5  | Provider silently substitutes different ciphertext               | **Protected** — `ciphertextSha256` + AEAD tag fail closed           |
| T6  | Provider tampers with routing metadata (id/generation/timestamp) | **Protected** — metadata is the AEAD AAD; decryption fails          |
| T7  | Provider truncates a stored object                               | **Protected** — hash mismatch → refuse before decrypt               |
| T8  | Replay of a stale/old backup as if current (rollback)            | **Partially** — `backupGeneration` high-water mark (see §14 limits) |
| T9  | Corrupted remote object returned                                 | **Protected** — hash check before decryption                        |
| T10 | Duplicate/confused backup ids                                    | **Protected** — backend rejects duplicate `backupId`                |
| T11 | Single device lost/destroyed                                     | **Protected** — recover from remote with recovery key               |
| T12 | Recovery key lost by the user                                    | **NOT protected** — by design; zero-knowledge = unrecoverable       |
| T13 | Recovery key stolen (phished/leaked)                             | **NOT protected** — holder can decrypt; needs rotation (§9)         |
| T14 | Compromised device keeps decrypting future backups               | **NOT (V0)** — revocation deferred; see §12                         |
| T15 | Weak client RNG produces a guessable key                         | **Mitigated** — CSPRNG + scrypt KDF defense-in-depth                |
| T16 | Nonce reuse under a key                                          | **Protected** — fresh random DEK per backup; one msg/key            |
| T17 | Plaintext leaks into logs                                        | **Protected** — structured, plaintext-free events (tested)          |
| T18 | Provider correlates users via metadata                           | **Partially** — `userId` + timestamps remain (see §13)              |
| T19 | Provider deletes/withholds backups (availability attack)         | **NOT (V0)** — single provider; mitigate with 2nd backend later     |
| T20 | Malicious memory content injected upstream (prompt injection)    | **Out of scope** — backup preserves bytes faithfully; not a filter  |

**V0 protects:** confidentiality and integrity of memory content and its
identifiers against the storage provider and network; single-device loss recovery;
tamper/rollback/corruption **detection**. **V0 does not protect:** a lost recovery
key (unrecoverable by design), a stolen recovery key (needs rotation), device
revocation, provider availability attacks, or prompt-injection in the content.

---

## 4. Native memory recovery vs portable semantic memory (do not conflate)

Two fundamentally different capabilities are in play:

- **Native memory recovery (this spike's job).** Take the Phase 14A store —
  byte-exact files, restore descriptors, project identity, content hashes,
  classification, version — to another machine and reconstruct it **identically**.
  This is disaster recovery of the real files agents read.
- **Portable semantic memory.** A `remember`/`recall` layer (e.g. Walrus Memory)
  that stores _meaning_ and returns semantically-similar snippets. Useful for
  cross-agent recall, but it is **not** a byte-exact backup and cannot reconstruct
  the Phase 14A store.

These are complementary, not substitutes. This spike solves the first. The second
is evaluated separately in §11 as future work and must not be used as the recovery
mechanism.

---

## 5. Canonical `MemoryBackupBundle` (byte-exact, format-versioned)

The bundle is the unit that gets encrypted. It reconstructs the Phase 14A store
without changing its local format. Format id: **`stack-mem-bundle-v1`**.

```
MemoryBackupBundle = {
  bundleFormat:   "stack-mem-bundle-v1",
  provider:       "claude",
  manifestSha256: "sha256:<hex>",     // hash of the manifest file bytes
  manifestB64:    <base64 of manifests/current.json, byte-for-byte>,
  objects: [ { contentHash: "sha256:<hex>", bytesB64: <base64 raw bytes> }, ... ]
             // deduplicated, sorted by contentHash → deterministic bytes
}
```

- Preserves the manifest file **and** every referenced content-addressed object
  byte-for-byte (`experiments/memory-remote/src/bundle-codec.ts`).
- Deterministic serialization (fixed key order, sorted objects) so the same store
  always bundles to identical bytes (tested).
- Restore writes objects through the **real** `@stack/memory` content-addressed
  store (which re-verifies each hash) and restores the manifest verbatim, then
  verifies the manifest hash. Phase 14A `planMemoryRestore`/`runMemoryRestore`
  then rebinds items to local projects — unchanged.

The codec is transport- and crypto-agnostic: **bundle → encrypt → upload**, and
**download → decrypt → un-bundle → 14A restore**. It never sees keys.

---

## 6. Encryption boundary (what leaves the device)

Plaintext (the bundle, which contains the manifest with project/file names and the
memory contents) is encrypted **on the device**, before any upload. What leaves:

- **Opaque ciphertext**: `{ nonce, ciphertext, tag }` (AES-256-GCM).
- **Wrapped-key record**: the DEK encrypted under a KEK derived from the recovery
  key (never the recovery key, KEK, or DEK themselves).
- **Minimal routing metadata**: `userId`, `backupId`, `createdAt`,
  `ciphertextLocator`, `ciphertextSha256`, `cryptoVersion`, `backupGeneration`,
  `parentBackupId`. **No** project names, repo/file names, Git identities, memory
  text, or logical IDs.

This boundary is enforced by the `RemoteObject` / `RemoteBackupRecord` types
(`src/backend.ts`) and asserted by `src/no-plaintext.test.ts`, which fails if the
synthetic secret marker, `github.com/example`, a project name, or the recovery key
ever appears in the simulated remote store or in any log event.

---

## 7. Key hierarchy and algorithm choices (envelope encryption)

```
Stack Recovery Key (256-bit, client-generated, shown once)
        │  scrypt(N=2^15, r=8, p=1) + per-backup random salt
        ▼
     KEK (256-bit)  ──AES-256-GCM wrap──▶  Wrapped DEK record (stored remotely)
        ▲                                        │ unwrap on recovery
        │                                        ▼
   per-backup random DEK (256-bit)  ──AES-256-GCM──▶  ciphertext of bundle
```

- **AEAD = AES-256-GCM.** In Node core, AES-NI accelerated, FIPS-approved; 96-bit
  random nonce; 16-byte tag authenticates ciphertext **and** the routing header
  (AAD). Rejected for V0 but noted: XChaCha20-Poly1305 (bigger nonce, random-safe
  at scale) — not in Node core; the versioned envelope (`stack-mem-cipher-v1`)
  lets a future backend add it without breaking old backups.
- **KDF = scrypt** (memory-hard, in Node core). The recovery key already carries
  256 bits of entropy, so the KDF is defense-in-depth (T15), not password
  stretching. Argon2id is a defensible future alternative (needs a native addon);
  the wrapped-key scheme is versioned (`recovery-key-scrypt-aesgcm-v1`).
- **Per-backup DEK** guarantees one message per key → nonce reuse is impossible
  (T16). **Per-backup salt** makes each wrapped record independent.

No custom cryptography is introduced; only standard primitives are composed.

---

## 8. Recovery mechanism (zero-knowledge-compatible)

**Stack Recovery Key.** A 256-bit value generated by the client CSPRNG, shown to
the user exactly once, formatted as grouped Crockford base32 for legibility
(`generateRecoveryKey()`). It is **never** sent to Stack Cloud in plaintext.

Because the DEK is wrapped only under a KEK derived from this key, **Stack Cloud
holds nothing that can decrypt a backup**: account access alone fails (T4,
demonstrated by the "Stack account access alone … cannot decrypt" test). This is
the zero-knowledge property — with the direct trade-off that a **lost recovery key
is unrecoverable** (T12). That trade-off is stated to the user, not hidden.

Recovery on a new machine: `stack login` (identity/routing only) → list backups →
fetch newest → verify ciphertext hash → user supplies the recovery key → unwrap
DEK → decrypt → 14A restore. Proven end-to-end offline in `src/protect.test.ts`
("recovers byte-exactly on a new machine: original hash == recovered hash").

---

## 9. Option A — Stack Cloud + client-side envelope encryption (answers)

Direct answers to the hard questions (no hand-waving):

- **Master key vs per-backup DEK?** Per-backup random DEK, each wrapped by the
  recovery-derived KEK. Optionally a persistent **Memory Master Key** (itself
  wrapped by the recovery key) could wrap all DEKs so one unwrap enables many
  backups; V0 keeps per-backup independence for simplicity and blast-radius
  control.
- **Rotation?** Generate a new recovery key, re-wrap existing DEKs' records (or
  re-encrypt) under the new KEK, publish new wrapped records, retire the old.
  Rotation touches only wrapped-key records, not ciphertext, if a Master Key is
  used; without it, each backup's wrapped record is re-wrapped.
- **Decryptability of old backups after rotation?** Yes, as long as their wrapped
  records are re-wrapped to the new key. Old wrapped records should be deleted so
  the old recovery key alone stops working (forward security on rotation).
- **Second device?** Any device that has the recovery key can back up and restore.
  See §12 for the fuller multi-device model (per-device wrapped records).
- **Revocation?** V0: none (T14). Design: per-device key material so a compromised
  device's wrapped records can be dropped and a rotation forces new ciphertext the
  revoked device cannot read. Deferred to Phase 14B+.
- **Integrity?** AEAD tag + `ciphertextSha256` + per-object content hashes +
  manifest hash. Any tamper/truncation/corruption fails closed (T5–T7, T9).
- **Rollback detection?** `backupGeneration` monotonic counter + `parentBackupId`
  lineage + a client-remembered high-water mark; recovery refuses an older
  generation (T8). Limits and the stronger future design are in §14.
- **Lost recovery key?** Unrecoverable by design (T12). Mitigation is UX: strongly
  encourage the user to store it in a password manager; optionally offer an
  additional recovery path (e.g. a second recovery key, or an escrowed share) as a
  future opt-in — never silent Stack custody.
- **Stack auth compromised but key safe?** Attacker can list/delete/observe
  metadata but **cannot decrypt** (T4). Deletion/availability is the residual risk
  (T19), addressed by soft-delete + versioning server-side.
- **Can Cloud decrypt anything?** No. It never receives the recovery key, KEK, or
  DEK, and the plaintext bundle never leaves the device.
- **Metadata encryption?** The sensitive metadata (manifest: names, identities) is
  inside the encrypted bundle. Only non-sensitive routing metadata is plaintext
  remotely (§13). Fully hiding `userId`/timestamps would need blind storage; out
  of V0 scope (T18).
- **Deletion?** Backend `deleteBackup` removes record + object. Production should
  use soft-delete + retention so a compromised-account attacker cannot hard-purge
  history (T19).

**Verdict:** Option A meets the confidentiality, integrity, and new-machine
recovery goals today, with a normal-developer UX and no blockchain dependency. It
is the recommended V0 (§18). Weaknesses (revocation, availability) are deferrable.

---

## 10. Option B — Seal + Walrus (findings)

**Shape.** Walrus is public blob storage with **no confidentiality** ("All blobs
uploaded to Walrus are publicly available"); Seal supplies client-side encryption
and on-chain access control. So the composition is: bundle → **Seal-encrypt** →
store blob on **Walrus**; recover: fetch blob → Seal-decrypt.

**Strengths.** Decentralized durability; encryption + access policy are first-class
(identity-based encryption, t-of-n threshold key servers, Move `seal_approve`
policies); an exported 32-byte **backup key** exists for break-glass recovery.

**Blockers / open risks for Stack:**

- **Wallet requirement collides with the no-wallet UX rule.** Seal ties identity
  and recovery to a **Sui wallet keypair**; session keys need a **wallet
  signature**. Walrus storage needs a **Sui wallet + WAL + SUI** and transaction
  signing. A normal developer would have to connect a wallet, acquire tokens, and
  sign — exactly what the spec forbids. Stack must **not** put an owner private key
  in the web server and must **not** silently custody the user's owner key, so the
  obvious "hide the wallet" shortcuts are off-limits.
- **Storage is not permanent by default.** Blobs are epoch-bounded (~2 weeks/epoch
  on mainnet) and must be **renewed via the Sui object id**; a forgotten renewal
  loses the backup. Renewal is another signed transaction.
- **Rotation/revocation undocumented; recovery on a lost-everything machine hinges
  on restoring the Sui wallet seed** (or the exported backup key). MPC committee
  mode is **testnet-only**; the SDK is **beta**.

**Verdict:** Powerful and genuinely decentralized, but the wallet/token/tx UX and
the epoch-renewal operational burden make it a poor fit for a "normal developer,
no wallet" V0. Revisit if Stack later wants a decentralized, self-custodied tier
and can either (a) target crypto-native users, or (b) build a carefully-scoped,
non-custodial signing UX. Not recommended for V0.

---

## 11. Option C — Walrus Memory (two separate verdicts)

**As a Phase 14A backup target — poor fit.** Walrus Memory is a **semantic**
`remember`/`recall` store: the relayer "generates vector embeddings so your data is
searchable by meaning." It is not a byte-exact blob API and is not designed to
preserve exact file bytes, restore descriptors, project identity, content hashes,
classification, or version. Round-tripping the Phase 14A store through
remember/recall would not reconstruct it identically. Additionally, the **default
managed relayer sees plaintext** (only the manual client flow keeps keys/plaintext
client-side), and it inherits Walrus's wallet/Seal dependencies. **Do not use it
for disaster recovery.**

**As a future cross-agent semantic layer — promising, but orthogonal.** Its
namespaces, owner-scoped isolation, `remember`/`recall`, and potential auto
capture/recall are attractive for _semantic_ cross-agent memory. Concerns to track
separately: managed-relayer plaintext trust, prompt-injection into recalled
content, multi-agent isolation guarantees, and the incubation-stage SDK. This is a
**different product decision** from native recovery and must not be conflated with
it (§4).

---

## 12. Multi-device model (A/B/C)

Design (not implemented in V0):

- **Enrollment.** Each authorized device holds, or can derive, key material able to
  unwrap DEKs. Preferred: a per-user Memory Master Key wrapped once per device
  (device-specific wrapped record), plus the recovery key as the ultimate root.
- **Any device backs up.** Backups are content-addressed and generation-numbered;
  any enrolled device can create the next generation.
- **Losing one device loses nothing.** Other devices + the recovery key still
  decrypt every backup.
- **Revoke a compromised device.** Drop that device's wrapped record and **rotate**
  the Master Key so new backups use a key the revoked device never had; old
  ciphertext it may have copied is unchanged, so rotation must be paired with
  re-encryption if past confidentiality from that device matters.
- **No silent overwrite of newer backups.** Generations are monotonic; a device
  publishing an older generation over a newer one is refused; conflicts are
  explicit (parent lineage mismatch) and surfaced, not auto-merged.

Option B/C multi-device reduces to "same Sui wallet on each device" (seed-phrase
sync) plus Seal access policies — simpler conceptually but re-imposes the wallet UX.

---

## 13. Metadata model (minimal remote record)

```
RemoteBackupRecord = {
  userId, backupId, createdAt,
  ciphertextLocator, ciphertextSha256,
  cryptoVersion, wrappedKeyRecord,
  backupGeneration, parentBackupId
}
```

No project names, repo/file names, memory text, Git identities, vendor keys, or
logical IDs. Those live only inside the encrypted bundle. Residual plaintext:
`userId` and timestamps enable provider-side correlation (T18) — acceptable for V0,
improvable later with pseudonymous ids and coarse timestamps. `parentBackupId` and
`backupGeneration` are plaintext to support rollback reasoning without decryption.

---

## 14. Versioning and rollback protection

- **V0.** `cryptoVersion` + `bundleFormat` allow format evolution. Rollback
  protection is a monotonic `backupGeneration` with a client-remembered high-water
  mark: recovery refuses a generation older than expected (`minGeneration`), and
  `parentBackupId` records lineage. Demonstrated in the "rejects a rollback to an
  older generation" test.
- **Limits.** A brand-new machine with **no** remembered high-water mark cannot,
  by itself, know it is being served a stale-but-authentic backup; the generation
  counter is plaintext and provider-assertable. V0 relies on the provider not
  colluding to hide newer generations, plus AEAD ensuring any served backup is at
  least authentic-and-untampered.
- **Stronger future.** Sign each generation with a per-user signing key (rooted in
  the recovery key), and/or maintain a hash-chained head so a new machine can
  verify it holds the true latest. This closes the rollback gap without a trusted
  provider.

---

## 15. Privacy comparison across options

| Aspect                                 | A (Cloud + envelope) | B (Seal + Walrus)  | C (Walrus Memory)                       |
| -------------------------------------- | -------------------- | ------------------ | --------------------------------------- |
| Plaintext leaves device?               | No                   | No (Seal client)   | **Yes (managed relayer)** / No (manual) |
| Provider can read content?             | No                   | No                 | Relayer can (managed)                   |
| Names/identities hidden from provider? | Yes (in bundle)      | Yes                | Partial (semantic index)                |
| Who holds decryption authority?        | User (recovery key)  | User (Sui wallet)  | User + relayer (managed)                |
| Zero-knowledge to the company?         | Yes                  | Yes (Mysten infra) | No (managed)                            |
| Blast radius of provider breach        | Ciphertext only      | Public ciphertext  | Plaintext (managed)                     |

---

## 16. Beginner recovery UX comparison (laptop destroyed → new laptop)

- **Option A.** Install Stack → `stack login` → `stack memory recover` → paste the
  Stack Recovery Key → memory restored. One secret to keep; no wallet, no tokens,
  no chain. Failure mode: lost recovery key = lost memory (clearly communicated).
- **Option B.** Install Stack → restore **Sui wallet from seed phrase** (or the
  exported backup key) → connect wallet → re-sign session key → fetch/decrypt →
  restore. Extra: ensure blobs were **renewed** and not expired. Heavier; assumes
  crypto literacy.
- **Option C.** Same wallet/Seal burden as B, and even then you get **semantic
  recall**, not a byte-exact store — not true recovery.

Option A is by far the most beginner-friendly for genuine recovery.

---

## 17. Cost and operations comparison (no fabricated pricing)

- **Option A.** Ops cost is standard object storage + a small metadata DB under
  Stack Cloud's existing infra; no per-user token economics. Backups are small
  (memory is text). No fabricated dollar figures here; sizing is ordinary blob
  storage.
- **Option B/C.** Walrus docs state a fixed **USD-denominated** storage rate and
  bill on **encoded** size (erasure-coding expansion, ~4.5× per docs) plus per-blob
  overhead; small files are disproportionately expensive (docs recommend batching
  via "Quilt"). Users need **WAL + SUI**, and storage must be **renewed per epoch**
  or it expires. Operationally this shifts cost and lifecycle management onto the
  user/wallet. Exact figures must be re-verified against the live page before any
  planning; none are asserted here.

---

## 18. Decision matrix, recommendation, alternatives, open questions, proposed scope

### 18.1 Decision matrix (~21 criteria)

| #   | Criterion                               | A             | B                 | C             |
| --- | --------------------------------------- | ------------- | ----------------- | ------------- |
| 1   | Byte-exact 14A recovery                 | ✅            | ✅                | ❌            |
| 2   | No-wallet UX                            | ✅            | ❌                | ❌            |
| 3   | No token purchase                       | ✅            | ❌                | ❌            |
| 4   | Zero-knowledge to company               | ✅            | ✅                | ❌(managed)   |
| 5   | Content confidentiality vs provider     | ✅            | ✅                | ⚠️            |
| 6   | Names/identity confidentiality          | ✅            | ✅                | ⚠️            |
| 7   | Integrity/tamper detection              | ✅            | ✅                | ✅            |
| 8   | Rollback detection                      | ⚠️V0          | ⚠️                | ⚠️            |
| 9   | New-machine recovery simplicity         | ✅            | ⚠️                | ⚠️            |
| 10  | Lost-key recovery option                | ❌(by design) | ⚠️(seed/backup)   | ⚠️            |
| 11  | Device revocation                       | ⚠️(future)    | ⚠️                | ⚠️            |
| 12  | Multi-device                            | ✅(design)    | ✅(seed)          | ✅(seed)      |
| 13  | Durability model                        | Cloud SLA     | Decentralized     | Decentralized |
| 14  | Storage permanence (no expiry)          | ✅            | ❌(epochs)        | ❌            |
| 15  | Operational burden on user              | Low           | High              | High          |
| 16  | SDK maturity                            | N/A(own)      | beta              | incubation    |
| 17  | Cost predictability for Stack           | ✅            | ⚠️                | ⚠️            |
| 18  | Avoids server custody of owner keys     | ✅            | ✅(if done right) | ⚠️            |
| 19  | Portability away from Stack-the-company | ⚠️(export)    | ✅                | ⚠️            |
| 20  | Semantic cross-agent recall (future)    | ❌            | ⚠️                | ✅            |
| 21  | Time-to-ship for V0                     | ✅            | ❌                | ❌            |

Legend: ✅ good · ⚠️ partial/conditional · ❌ poor/by-design-absent.

### 18.2 Recommendation

Adopt **Option A (Stack Cloud + client-side envelope encryption)** for Phase 14B
V0 remote memory recovery. It is the only option that delivers byte-exact recovery
with a no-wallet, no-token, beginner-friendly UX while remaining zero-knowledge to
Stack. Keep the `RemoteMemoryBackend` interface so a **Seal+Walrus backend** can be
added later as a self-custodied, decentralized tier, and evaluate **Walrus Memory**
independently as a future _semantic_ layer (not recovery). A hybrid is natural:
Option A for recovery now; Option B as an optional advanced backend; Option C as a
separate semantic feature.

### 18.3 Rejected alternatives

- **Server-side encryption / provider-held keys** — violates zero-knowledge (T4).
- **Password-derived key without a high-entropy recovery key** — weak against
  offline brute force; rejected in favor of a 256-bit recovery key.
- **Storing the manifest in plaintext for server-side search** — leaks names and
  identities (T2); rejected.
- **Walrus Memory as the recovery mechanism** — semantic, not byte-exact (§4, §11).
- **Silent wallet custody to hide Seal's wallet UX** — explicitly forbidden.

### 18.4 Open questions

- Exact rollback-hardening design (signed generations vs hash-chained head).
- Whether to offer an optional escrow/second-recovery-key path without breaking
  zero-knowledge.
- Device-revocation semantics and whether past-confidentiality-on-revocation is a
  requirement.
- Re-verify all Walrus/Seal facts (epoch length, pricing, SDK stability, Seal
  rotation/revocation) against live docs at implementation time.

### 18.5 Proposed Phase 14B scope (for later approval — not started here)

1. Productionize Option A: `MemoryBackupCodec`, `MemoryCipher`,
   `RecoveryKeyProvider`, and a `StackCloudRemoteBackend` implementing
   `RemoteMemoryBackend` against Stack Cloud object storage + metadata DB.
2. Real CLI: `stack memory protect` (first run generates + shows the recovery key
   once) and `stack memory recover`.
3. Server: opaque ciphertext + minimal metadata only; soft-delete + versioning;
   generation monotonicity enforcement.
4. Multi-device enrollment (per-device wrapped records) and key rotation.
5. Stronger rollback protection (signed/chained generations).
6. Docs + a recovery runbook; export path for portability away from Stack.

Out of scope for 14B: Option B/C implementation, semantic memory, live sync.

---

_See also:_ [`adr/0001-envelope-encryption-for-remote-memory.md`](./adr/0001-envelope-encryption-for-remote-memory.md),
[`adr/0002-defer-seal-walrus-and-walrus-memory.md`](./adr/0002-defer-seal-walrus-and-walrus-memory.md).
