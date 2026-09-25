# Memory Protection Modes + Passkey Recovery — Architecture Spike (Phase 14B1)

**Status:** Spike / exploration. Not an implementation commitment.
**Date:** 2026-09-25. **Version line:** 0.1.0 (unchanged; nothing here ships).
**Prototype:** [`experiments/memory-remote/`](../../experiments/memory-remote)
(isolated; imported by nothing that ships; synthetic fixtures only).
**Builds on:** [`memory-remote-spike.md`](./memory-remote-spike.md) (14B0).

Product decision validated here: **Stack Memory supports two privacy modes —
Standard and Protected.** Both are first-class, legitimate choices. Standard is
not "insecure"; Protected is opt-in stronger privacy with passkey-based recovery.

---

## 1. Standard vs Protected product model

|                              | **Standard**                                              | **Protected**                                                 |
| ---------------------------- | --------------------------------------------------------- | ------------------------------------------------------------- |
| Everyday command             | `stack memory backup`                                     | `stack memory backup` (after one-time `stack memory protect`) |
| Where encryption happens     | server/storage at rest                                    | on the device, before upload                                  |
| Can Stack infra read Memory? | Technically yes                                           | No                                                            |
| Recovery credential          | none (just `stack login`)                                 | passkey or recovery file                                      |
| Isolation / privacy          | per-user, private, never public, never shared             | same, plus client-side encryption                             |
| Honest label                 | "Standard" — NOT end-to-end encrypted, NOT zero-knowledge | "Protected" — client-side encrypted, zero-knowledge to Stack  |

Both modes keep the everyday command identical (`stack memory backup`); complexity
lives underneath. Only disaster recovery introduces recovery UX. Standard security
model, documented honestly: authenticated Stack account, TLS in transit, per-user
authorization + strict RLS, encryption at rest, not shareable, not public — **and**
Stack infrastructure is technically capable of reading Standard Memory.

Prototype: `standardBackup`/`standardRecover` and `protectedBackup`/`protectedRecover`
in `src/modes.ts`, both proven to reconstruct the Phase 14A store byte-for-byte.

---

## 2. Threat model differences

The 14B0 threat model (20 threats) still applies to Protected. The mode-specific
difference is **who can read Memory**:

- **Standard**: a Stack account compromise, or a sufficiently privileged
  infrastructure/provider actor, **may permit Memory retrieval**. Accepted, and
  disclosed, as the cost of zero-recovery-credential simplicity.
- **Protected**: a Stack account compromise **without a valid recovery method must
  NOT permit decryption** (proven by the "wrong MMK (Stack account access alone)
  cannot decrypt" test). This asymmetry is the core reason both modes exist.

New Protected-specific threats introduced by passkey recovery and the bridge:
tampered wrapped-MMK / wrapped-DEK (fail closed), wrong PRF output, replayed or
expired recovery session, wrong CLI ephemeral key, and a malicious Stack app bundle
in the browser (§9). All are covered by tests except the last, which is a
documented trust assumption.

---

## 3. MMK key hierarchy (change from 14B0)

14B0 wrapped each backup's DEK directly with the recovery key. 14B1 introduces a
persistent **Memory Master Key (MMK)**:

```
Recovery Method (passkey PRF | recovery file | future trusted device)
      → wraps →  Memory Master Key (MMK, stable until rotated)
      → wraps →  per-backup DEK (fresh random per backup)
      → encrypts →  MemoryBackupBundle
```

Evidence the assumed benefits hold (all demonstrated in `src/mmk.test.ts` /
`src/modes.test.ts`):

- **Add a recovery method without re-encrypting backups** — a method adds one MMK
  wrapper; bundle ciphertext is untouched. ✔
- **Multiple methods protect the same MMK** — two passkeys + a recovery file each
  unwrap the same MMK. ✔
- **Remove/revoke one method without breaking others** — removing a wrapper leaves
  the rest working; removing the last is refused. ✔
- **Rotation by re-wrapping the MMK** — conceptually sound (re-wrap + drop old
  wrappers); rotation of the MMK itself would re-wrap DEK records, still not bundle
  ciphertext. ✔ (design)
- **Backend independence** — the MMK/keyring is transport-agnostic; a future
  Seal-based recovery provider could add a wrapper. ✔ (design)

---

## 4. Per-backup DEKs

Each backup still gets a fresh random 256-bit DEK (`wrapDekWithMmk`/
`unwrapDekWithMmk`), AAD-bound to its `backupId`. One key encrypts exactly one
bundle → nonce reuse is impossible; a DEK wrapped for one backup will not unwrap
for another (tested).

---

## 5. Passkey PRF recovery

Flow (grounded in official research — see Sources): a WebAuthn credential is
created with the `prf` extension **enabled**, and the actual 32-byte PRF output is
obtained via **authentication (`get()`)**, treated as HKDF input keying material
(not a final key), and run through `HKDF-SHA-256` with domain label
`stack-memory-passkey-v1` to derive the Passkey KEK, which wraps the MMK.

Key research facts driving the design:

- `prf` is the WebAuthn surface of CTAP2 `hmac-secret`; output is 32 bytes; same
  credential + same salt is deterministic **on the same authenticator**.
- **Do not rely on create-time PRF results** — use `create()` to enable, `get()`
  to derive. The dogfood page follows this exactly.
- **Cross-device determinism for synced passkeys is NOT guaranteed** and shows
  real-world inconsistency (esp. hybrid/QR flows). This is why each authenticator
  gets its OWN MMK wrapper (envelope encryption) rather than assuming a shared PRF.

Prototype: `derivePasskeyKek` (`src/kdf.ts`) + `addPasskeyWrapper`/
`unwrapWithPasskey` (`src/recovery-methods.ts`); the browser side is `dogfood/`.
The Node tests prove the wrapping crypto **given** a PRF output; the real browser
PRF flow was then verified manually and **recorded PASSED** in §17.1 (Windows +
Chrome + Google Password Manager, single device).

---

## 6. Feature-detection behavior

Three distinct states must drive UX (never assume "passkey exists = PRF works"):

1. **Passkeys supported** — `window.PublicKeyCredential` exists.
2. **PRF advertised** — `PublicKeyCredential.getClientCapabilities()` (Chrome
   133+) returns `"extension:prf": true` (client-level hint only).
3. **PRF usable** — ground truth: a real `get()` returns
   `getClientExtensionResults().prf.results.first`. Absent/empty ⇒ PRF
   unavailable even though authentication succeeded.

The dogfood page reports all three separately. When passkey auth works but PRF
does not, the UX must say exactly that and offer the recovery-file fallback — not
"passkeys unsupported" (§ "Passkey unsupported UX" in the brief).

---

## 7. Fallback recovery method (recovery file / key)

A high-entropy (256-bit) client-generated **Recovery Key**, exportable as a
printable Crockford-base32 code or a `.stackkey` file, never stored plaintext in
Stack Cloud, able to unwrap the same MMK (`addRecoveryFileWrapper`). It uses HKDF
(domain `stack-memory-recovery-v1`) — **not** a password KDF, because the material
is already random (a human-chosen passphrase would be a separate path with a
memory-hard KDF; the two are never mixed). Honest caveat baked into the file's own
`note`: putting the secret in a file shifts the problem to protecting the file; it
is a usability artifact (store in a password manager / external drive), not "secure
by itself". Not required to be memorized.

---

## 8. CLI ↔ browser zero-knowledge bridge

WebAuthn runs in the browser; Stack is a CLI. The bridge (`src/bridge.ts`) moves
the unlocked MMK from browser to CLI so the **server only relays an opaque
envelope**:

```
CLI: create one-time session + ephemeral ECDH keypair (private key stays on CLI)
  → Browser: passkey PRF unlocks MMK locally; ephemeral ECDH; ECDH+HKDF→transfer key;
             AES-GCM encrypt MMK with AAD binding {session, CLI pubkey, user, expiry, version}
  → Server: relays the opaque envelope only
  → CLI: ECDH+HKDF→same transfer key; AES-GCM decrypt → MMK
```

Primitives (standard, identical in Node 22 and browsers via Web Crypto; no
library): ephemeral **ECDH P-256**, **HKDF-SHA-256** (domain
`stack-memory-bridge-v1`), **AES-256-GCM**. Bound to a one-time session, the
intended CLI ephemeral public key, the Stack user, an expiry, and a protocol
version → replay and misbinding fail closed. The CLI/browser private keys never
leave their side; the server never sees the MMK. Proven end-to-end in Node
(`src/bridge.test.ts`), including wrong-CLI-key, replay, expiry, session-mismatch,
and tamper failures.

---

## 9. Browser trust limitation (explicit, not hand-waved)

The browser JavaScript that unlocks and re-encrypts the MMK is **served by Stack**.
If Stack served malicious JavaScript, that code could exfiltrate the decrypted MMK
in the browser before the bridge re-encrypts it. **This design does NOT defend
against a malicious Stack application bundle.** The bridge protects against the
server-as-relay and network observers, not against Stack shipping hostile client
code. For V0 this is judged acceptable (the same trust is implicit in any web app
that touches secrets), and must be disclosed. Stronger future mitigations:
subresource integrity, reproducible/signed client bundles, or a native/CLI-local
WebAuthn path that avoids browser-served code entirely.

---

## 10. Multi-passkey model

Multiple PRF-capable passkeys can protect the same MMK, each with its own wrapper —
never assuming different providers yield the same PRF output. Adding passkey B does
not touch passkey A's wrapper or any backup; removing one leaves the others intact
(tested). This directly mitigates the cross-device PRF uncertainty (§5): enroll a
passkey per device rather than betting on synced-PRF determinism.

---

## 11. Trusted-device future (design only)

An already-authorized Machine A could enroll Machine B without a recovery key or
passkey: B generates a device keypair, A approves it, A wraps the MMK for B's device
key (a `trusted-device` wrapper type is reserved in `MmkWrapper`). This is likely
the easiest multi-device path. Not implemented in this spike; no production device
management is built.

---

## 12. Standard → Protected migration

`migrateStandardToProtected` (`src/modes.ts`): discover existing Standard backups →
download → encrypt locally → upload Protected replacements → **verify each
replacement decrypts back to the original bytes** → only then soft-delete the
Standard plaintext payloads → finalize the account as Protected. The account is
marked Protected **only after** every replacement verifies; a failure leaves the
account Standard and does not delete the Standard payloads (both proven by tests).
This prevents the incoherent state of claiming "Protected" while forgotten
plaintext historical backups remain.

**What "deletion" means:** the prototype hard-removes the simulated payload. In
production, "delete" is a soft-delete + retention-policy operation; provider/storage
retention (backups, replicas, WORM) means bytes may persist for a bounded window.
This must be disclosed and bounded, not asserted as instant global erasure.

---

## 13. Protected → Standard semantics

No silent downgrade. Disabling Protected must be an explicit, confirmed action
warning that future backups will be readable by Stack infrastructure and that
existing Protected backups remain encrypted unless explicitly migrated. Not built
in this spike; the account-mode field (`getAccountMode`/`setAccountMode`) models
where the state lives.

---

## 14. Account-compromise behavior

- **Standard**: Stack account compromise may permit Memory retrieval (disclosed).
- **Protected**: Stack account compromise **without** a valid recovery method
  (passkey PRF output or recovery key) cannot decrypt — the server holds only
  ciphertext + wrapped DEK + wrapped MMK, none usable without recovery material
  (proven). Residual: an attacker who also controls a logged-in browser session and
  can drive a passkey ceremony (with user verification) is a different, stronger
  threat; UV and the browser-trust limitation (§9) bound it.

---

## 15. Remote metadata model

One versioned record shape (`stack-mem-remote-v1`) carries both modes without
mixing semantics (`modeRecordSchema`):

```
backupId, userId, generation, createdAt, privacyMode,
payloadLocator, payloadSha256, formatVersion, parentGeneration
// Protected additionally: cryptoVersion, wrappedDek, mmkId
```

Protected payloads and records expose **no** project/file names or memory text
(those are inside the encrypted bundle). Standard payloads are server-readable
bundles by definition, but duplication of metadata is minimized. Per-user
isolation, size bounds, and integrity hashes are enforced by the backend
(`InMemoryModeBackend`), and there is no publish/share surface (no crossover into
Skills / public Stack APIs).

---

## 16. Beginner UX

First backup is calm and non-scary:

```
$ stack memory backup
Memory backed up to Stack Cloud.
Privacy: Standard

For client-side encryption:
  stack memory protect
```

Opting in:

```
$ stack memory protect
Protect your Stack Memory
Choose a recovery method:
> Passkey
  Recovery file
  Set up later
```

No fear language, no giant warnings, no security wizard before first use. Do not
promise a specific biometric ("Use Face ID / Touch ID / Windows Hello, or a
compatible passkey provider" — the authenticator decides). Recovery on a new
machine opens the browser for a passkey ceremony, or `--recovery-file <path>` as
fallback. These are conceptual; not finalized as production flags in this spike.

---

## 17. Real Windows passkey dogfood procedure (MANUAL — do not auto-run)

Prototype page: `experiments/memory-remote/dogfood/`. It uses a SYNTHETIC random
MMK, reports only capability/state, and never displays or logs key material.

1. Start the server: `node experiments/memory-remote/dogfood/server.mjs`
2. Open `http://localhost:4599` in **Chrome on Windows** (localhost is a secure
   context; RP ID = `localhost`).
3. Click **1. Detect capabilities** — note Passkeys / Platform authenticator /
   PRF advertised.
4. Click **2. Create passkey + wrap synthetic MMK** — approve with Windows Hello
   (or your passkey provider / a security key). Note "PRF usable".
5. Click **3. Recover MMK (re-authenticate)** — approve again; expect
   **MMK recovery: passed**.
6. (If available) Repeat on a **second device/browser** with the SAME synced
   credential to test cross-device PRF determinism — the critical unknown.

Environment caveats from research (verify at run time): Windows Hello PRF needs a
2026 cumulative update (KB5077181) and a recent Chrome (147+ for create-time; auth
`get()` sooner). A YubiKey (`hmac-secret`) or 1Password (recent version) are more
predictable PRF sources on Windows. If PRF is unavailable, use the recovery-file
fallback.

### 17.1 Recorded dogfood result — PASSED (2026-09-25)

The manual dogfood was completed successfully.

- **Environment:** Windows · Chrome · `http://localhost` secure context · RP ID
  `localhost` · passkey provider **Google Password Manager**.
- **Reported state:**

  | Check                     | Result     |
  | ------------------------- | ---------- |
  | Passkeys supported        | supported  |
  | Platform authenticator    | available  |
  | PRF advertised            | advertised |
  | Credential created        | created    |
  | PRF usable (real `get()`) | usable     |
  | MMK recovery              | passed     |

- **Flow exercised:** capability detection → real passkey creation → real WebAuthn
  PRF use → synthetic random MMK wrapped → plaintext MMK discarded → fresh passkey
  authentication → PRF obtained again → MMK recovered → recovered MMK hash matched
  the original. No real Claude Memory was used; no key material was displayed or
  logged.

**Scope of this evidence (do not over-generalize):** this proves PRF works and
re-derives the same MMK **only for the exact environment tested** (Windows + Chrome

- Google Password Manager). It does **not** prove that "all passkeys support PRF",
  nor that Google Password Manager PRF is guaranteed to reproduce across a genuinely
  different device (see decision C).

---

## 18. Proposed Phase 14B production scope (for later approval — not started here)

1. Standard mode against real Stack Cloud (object storage + metadata DB), per-user
   RLS, versioning, size bounds, soft-delete, no public/share surface.
2. Protected mode: productionize codec/cipher/MMK/DEK + `StackCloudModeBackend`.
3. `stack memory protect` (choose recovery method; passkey via browser bridge, or
   recovery file), everyday `stack memory backup` unchanged for both modes.
4. Passkey recovery: browser flow with strict feature detection; the ZK bridge
   (ECDH/HKDF/AES-GCM) with server-side one-time session relay + expiry.
5. Multi-passkey + recovery-file wrappers over one MMK; MMK rotation; method
   removal/revocation.
6. Standard→Protected migration with verify-before-delete; explicit Protected→
   Standard downgrade confirmation.
7. `stack memory status` showing Privacy + Recovery; recovery runbook; disclosures
   for Standard readability, deletion/retention, and the browser-trust limit.
8. Trusted-device enrollment (later).

Out of scope for 14B: Seal/Walrus backends, semantic memory, passkey **login**
(recovery ≠ login; keep GitHub OAuth for identity).

---

## Decision output

**A. Does real WebAuthn PRF work in our current Windows/browser environment?**
**YES — proven manually (2026-09-25)** with Chrome + Google Password Manager on
Windows (localhost secure context). The dogfood page (§17.1) reported PRF advertised
and usable via a real `get()`. This confirms only the environment actually tested;
it does not imply all passkeys/providers support PRF.

**B. Can it reliably recover the same synthetic MMK after local MMK deletion?**
**YES — proven manually (2026-09-25).** After wrapping a synthetic random MMK and
discarding the plaintext, a fresh passkey authentication produced the PRF output
again and the MMK was recovered with a matching hash. (The wrapping crypto is also
proven in Node: HKDF→KEK→AES-GCM wrap/unwrap round-trips the exact MMK.)

**C. What remains unproven about cross-device synced-passkey recovery?**
Whether the SAME synced credential yields the SAME PRF output on a **genuinely
different device**. This was NOT tested and **must not be guaranteed** — specs and
vendor docs are silent, and hybrid/QR flows are reported to differ or omit PRF. The
multi-wrapper MMK design means we never depend on it: enroll a wrapper per
device/authenticator, plus a recovery file.

**D. What fallback should Stack offer when PRF is unavailable?**
The recovery file / high-entropy recovery key (§7), which wraps the same MMK via
HKDF and requires no passkey/PRF. Offer it whenever PRF is not usable, and always
as a second method alongside a passkey.

**E. Is Standard + Protected still recommended after implementation evidence?**
Yes. The prototype shows both modes deliver byte-exact recovery; Protected is
zero-knowledge to Stack with a workable no-wallet recovery UX; the MMK hierarchy
cleanly supports multiple/rotatable recovery methods. The two-mode model is sound.

**F. What exact architecture should production Phase 14B implement?**
Standard + Protected on Stack Cloud with the MMK hierarchy (§3), per-backup DEKs
(§4), passkey PRF + recovery-file methods (§5, §7) each wrapping one MMK (§10), the
ECDH/HKDF/AES-GCM CLI↔browser bridge with a one-time server relay (§8), strict
feature detection (§6), verify-before-delete migration (§12), and the disclosures
in §9/§12/§14 — scoped exactly as §18.

---

## Sources (WebAuthn PRF; fetched 2026-09-25)

- W3C WebAuthn L3 (prf): https://www.w3.org/TR/webauthn-3/ ; editor's draft:
  https://w3c.github.io/webauthn/#prf-extension ; explainer:
  https://github.com/w3c/webauthn/wiki/Explainer:-PRF-extension
- MDN WebAuthn extensions (prf):
  https://developer.mozilla.org/en-US/docs/Web/API/Web_Authentication_API/WebAuthn_extensions ;
  getClientCapabilities:
  https://developer.mozilla.org/en-US/docs/Web/API/PublicKeyCredential/getClientCapabilities_static
- Yubico PRF deep dive:
  https://developers.yubico.com/WebAuthn/Concepts/PRF_Extension/CTAP2_HMAC_Secret_Deep_Dive.html ;
  guide:
  https://developers.yubico.com/WebAuthn/Concepts/PRF_Extension/Developers_Guide_to_PRF.html
- Apple: https://developer.apple.com/documentation/authenticationservices/asauthorizationpublickeycredentialprfassertioninput-swift.struct ;
  cross-device inconsistency report: https://developer.apple.com/forums/thread/774111
- Chromium intent-to-ship:
  https://groups.google.com/a/chromium.org/g/blink-dev/c/iTNOgLwD2bI ;
  Chrome client capabilities: https://developer.chrome.com/blog/passkeys-client-capabilities
- 1Password PRF: https://1password.com/blog/encrypt-data-saved-passkeys

_See also:_ [`adr/0003-protection-modes-and-passkey-recovery.md`](./adr/0003-protection-modes-and-passkey-recovery.md).
