# Stack Project Identity (Phase 15A architecture)

- **Status:** Proposed — architecture/specification only. No production behavior
  changes in this phase. Version 0.1.0 unchanged.
- **Date:** 2026-09-27
- **Companion docs:** [`project-lifecycle.md`](./project-lifecycle.md),
  [`project-recovery-mapping.md`](./project-recovery-mapping.md),
  [ADR 0004](./adr/0004-durable-logical-project-identity.md).
- **Grounds:** `packages/memory/src/project-identity.ts`,
  `packages/memory/src/domain.ts`,
  [`memory-cloud-deployment.md` §5](./memory-cloud-deployment.md) (real dogfood).

## 1. Problem statement

Stack Memory V0 can back up and recover a machine's Claude Memory, but it can only
**automatically** reattach recovered Memory to a project when that project carries a
**portable Git identity**. The real-Memory dogfood (deployment doc §5) recovered 27
files across 9 projects: the 1 project with a canonical Git remote
(`github.com/reymiahthesun-bit/atlas-access-flow`) auto-restored its 7 files, and the
20 files from the 8 local-only projects were correctly retained but left unresolved.

The current portable identity for a non-Git project is
`local:<vendorKey>`, where `vendorKey` is the **absolute filesystem path** with
`:` `\` `/` replaced by `-` (`encodeClaudeProjectKey`, e.g.
`local:C--Users-NT-Desktop-nexus`). That is not portable across machines, drives, or
usernames, and — because it is derived purely from a path — it collides if an unrelated
project is later created at the same path. We need a durable, portable, opaque logical
identity that survives path/drive/username/laptop changes and clone/transfer, without
ever trusting a filesystem path as proof of identity.

### Real dogfood motivation (corrected interpretation)

The initial reading was that all 8 unresolved projects demonstrated an identity
**portability** gap. Later review corrected this: at least one of them (**Nexus**) had
been **intentionally deleted** from the machine before the dogfood. So the unresolved
set was a _mixture_ — some projects that merely lacked a portable identity, and some
that no longer existed locally (unknown machine-availability / lifecycle state). This
is the founding insight for Phase 15: **identity, lifecycle, machine availability, and
recovery resolution are four separate dimensions and must not be collapsed into one
status.** `project-not-found` today conflates "no portable identity," "not checked out
here," "deleted locally," and "user retired it." Stack correctly did nothing with the
20 files; the fix is not to guess harder but to model these dimensions distinctly.

## 2. Goals

- A durable, opaque, provider-neutral **logical project** identity that outlives any
  path, drive, username, machine, or folder name.
- Preserve the proven behavior: an unambiguous canonical Git remote auto-matches a
  project across moved directories.
- Represent legacy `local:` identities forever, as **historical aliases** that never by
  themselves authorize an automatic write.
- Let historical immutable backups (including Protected **generation 3**) resolve under
  the new model **without decrypt→rewrite→re-upload**.
- Never contaminate one project's Memory with another's via path reuse, copy, clone, or
  fork.
- Keep project identity/lifecycle metadata **private**, and — for Protected users —
  **zero-knowledge to the Stack server**.

## 3. Non-goals (this phase and V0)

- No production code, schema, migration, or crypto change (architecture only).
- Not a project-management product (no boards, tags, teams, or rich metadata).
- No automatic whole-disk scanning to "find" projects.
- No silent destination guessing, ever.
- No rewriting of immutable historical generations.
- Not a login/auth mechanism — identity here is about _which project_, not _which user_.

## 4. Terminology

Each term names exactly one concept. The word **"missing"** is deliberately avoided as
a status because it has meant several unrelated things.

| Term                            | Meaning                                                                                                                                                                             |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Logical Project**             | The durable, machine-independent entity that "a project" _is_. Owns identity claims, lifecycle, historical Memory, and per-machine bindings.                                        |
| **Project ID**                  | An opaque, stable, random identifier for a logical project (`prj_<random>`). Not derived from path, username, machine, or folder name.                                              |
| **Identity Claim**              | A typed piece of evidence that a logical project _is_ something recognizable elsewhere (a Git remote, a legacy alias, a user-confirmed alias, a marker id).                         |
| **Strong Identity**             | An identity claim that, when unambiguous, may authorize **automatic** matching (today: a canonical Git remote; also the Project ID via marker/registry).                            |
| **Historical Identity / Alias** | A claim that _was_ strong or was user-confirmed but is not the current strong identity (e.g. a former Git remote after a transfer). Corroborates; does not alone authorize a write. |
| **Legacy Local Identity**       | A pre-Phase-15 `local:<vendorKey>` identity embedded in an existing backup. A historical alias derived from an old machine path; **never** strong.                                  |
| **Machine Binding**             | A record, on one machine, that a logical project's working copy lives at a specific local directory. Machine-local, never portable.                                                 |
| **Project Lifecycle**           | The user's stance on the logical project overall: `active` or `archived`. See [`project-lifecycle.md`](./project-lifecycle.md).                                                     |
| **Machine Availability**        | Whether/where the project is present _on this machine_: `present`, `missing`, `unbound`, or `candidate`. Orthogonal to lifecycle.                                                   |
| **Recovery Resolution**         | The per-restore determination of whether Stack is currently authorized to write recovered Memory into a local destination.                                                          |
| **Identity Confidence**         | How strongly identity is established for a resolution: `verified`, `confirmed`, `candidate`, or `unresolved`. Never mixed with lifecycle.                                           |
| **Confirmed Mapping**           | A user's explicit, durable decision that a recovered logical project corresponds to a specific local directory and/or identity claim.                                               |
| **Candidate Mapping**           | A heuristic-suggested possible match, not yet authorized. Requires confirmation before any write.                                                                                   |
| **Archived / Retired Project**  | A logical project the user has explicitly set inactive. Historical Memory is retained; recovery prompts stop.                                                                       |
| **Hard Delete**                 | An explicit, separate destructive operation to remove project metadata and/or destroy recoverable Memory. Never implied by archive or by a missing directory.                       |

## 5. Identity model

A logical project is an opaque entity that holds a set of **identity claims**. Claims
are typed evidence; resolution ranks them by strength.

```
Logical Project (prj_ID)
├── identity claims
│   ├── stack-project-id : prj_...            (self, strongest)
│   ├── git (current)    : host/owner/repo    (strong when unambiguous)
│   ├── git (historical) : host/owner/repo    (alias; after transfer/rename)
│   ├── legacy-local     : local:<vendorKey>  (historical alias; never strong)
│   └── alias (confirmed): user-confirmed relationship
├── lifecycle            : active | archived        (see project-lifecycle.md)
├── historical Memory    : which generations carry this project's files
└── machine bindings     : per-machine, machine-local (see below)
    ├── Machine A → C:\work\project              (present)
    ├── Machine B → (none)                        (unbound)
    └── Machine C → D:\src\project                (present)
```

### 5.1 Project ID generation (Q3)

`project_id = "prj_" + base32(128 bits of CSPRNG randomness)` (crockford base32,
lowercased, ~26 symbols). Properties and rationale:

- **Random, not derived.** It must not depend on path, username, machine, folder name,
  or even content — so it cannot leak those and cannot collide via path reuse.
- **Minted lazily, once per logical project**, the first time a project is observed
  during backup and cannot be resolved to an existing logical project via a strong
  claim. Persisted in the registry (§7).
- **Independent minting is expected.** Two machines that first see the "same" project
  before any shared registry exists will mint _different_ IDs. This is intentional:
  reconciliation happens through identity claims + explicit user confirmation
  (§9, `project-recovery-mapping.md`), never by hoping two random IDs collide. IDs are
  merged only by an explicit confirmed relationship.
- **Opaque.** Nothing infers meaning from the bytes; it is a pointer, not a fingerprint.

### 5.2 How claims attach

Claims attach to the logical project in the registry (§7). A claim carries `{ type,
value, confidence-grade, provenance, addedAt }`. Provenance records _why_ the claim
exists (observed Git origin, legacy backup manifest, user confirmation, marker file),
which drives confidence and is required for anything above `candidate`.

## 6. Identity confidence model (Q11, Q12)

Confidence is about _identity_, strictly separate from lifecycle. An `archived` project
may be `verified`; an `active` project may be `unresolved` on this machine.

| Confidence     | Meaning                                                                                                                                                                                               | May authorize automatic write?                   |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| **VERIFIED**   | Strong portable evidence establishes identity unambiguously — a single canonical Git remote match, or a Project ID delivered by an authoritative registry/marker.                                     | Yes (subject to lifecycle + availability gates). |
| **CONFIRMED**  | The user explicitly confirmed a durable identity/mapping relationship earlier.                                                                                                                        | Yes.                                             |
| **CANDIDATE**  | Weak/heuristic evidence suggests a match: folder name, `package.json`/project metadata, `stak.yaml`, file fingerprints, repository structure, an exact historical path, or an unauthenticated marker. | **No** — requires user confirmation first.       |
| **UNRESOLVED** | No authorized local destination exists (no strong claim, no confirmed mapping, no accepted candidate).                                                                                                | No — preserve Memory, do not write.              |

**Heuristics may only produce CANDIDATE.** They rank suggestions; they never authorize a
write. This is invariant #11.

## 7. Registry placement (Q4, Q5, Q6, Q7)

We evaluated: (A) machine-local only, (B) private Cloud registry, (C) project-side
marker, (D) hybrid. **Recommendation: (D) hybrid**, with a strict portable/machine-local
split.

**Portable private state** — travels with the user, is the same on every machine:

- Project ID
- Identity claims (Git current/historical, legacy aliases, confirmed aliases)
- Lifecycle state
- Confirmed identity relationships (which claims/IDs are the same logical project)

**Machine-local state** — never leaves the machine, never uploaded:

- Filesystem paths / machine bindings
- Last-seen availability
- Local checkout bindings and the per-machine "leave unavailable" (deferral) choice

**Where the portable registry lives:** _inside the Memory backup bundle itself_, as a
new top-level registry section alongside the manifest — **not** as a separate
server-readable table. This is the key privacy decision: because the registry rides in
the bundle, it inherits the bundle's protection automatically (Standard: server-readable
like the rest of the bundle; Protected: client-side encrypted, zero-knowledge). It also
keeps the registry consistent with the generation it describes.

**Machine-local registry** lives under Stack home (e.g.
`<stackHome>/projects/registry.json` + a bindings file), never uploaded, never in the
manifest. Absolute filesystem paths therefore **never leave the machine** (Q7: no).

An **optional project-side marker** (§10) is corroborating evidence only, off by default.

## 8. Privacy model & Protected-mode implications (Q8)

Project metadata is itself sensitive — private repo names, project names, historical
project relationships, and lifecycle can reveal a lot. Therefore:

- **Do not** create a silent server-readable project registry. That would weaken the
  zero-knowledge guarantee Protected Memory establishes.
- The portable registry lives inside the bundle, so it follows the bundle's mode:

| Design                                              | What the Stack server learns                                                                                                                                                 |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Registry inside bundle, **Protected** (recommended) | Nothing beyond existing Protected metadata: ciphertext size, generation number, timestamps. **No** project names, repo identities, aliases, relationships, or lifecycle.     |
| Registry inside bundle, **Standard**                | Same as today's Standard bundle: the server _can_ read project identities/lifecycle, exactly as it can already read Standard Memory manifests. Disclosed; no new capability. |
| Separate server-side registry table (**rejected**)  | Would expose project graph + lifecycle even for Protected users. Rejected.                                                                                                   |

No crypto changes are proposed; the registry simply reuses the existing bundle
envelope. (See [ADR 0003](./adr/0003-protection-modes-and-passkey-recovery.md).)

## 9. Git identity rules

Preserve the proven behavior (canonical Git remote → cross-path auto-match) while being
conservative about equivalence. Grounded in `canonicalGitIdentity`:

- **Normalization.** Accept `https://`, `ssh://`, and scp (`git@host:owner/repo`) forms.
  Strip embedded credentials (never keep secrets), strip a trailing `.git`, lowercase
  the **host**, drop ports, and reduce to `host/owner/repo`. Canonical string is
  `host/owner/repo`.
- **HTTPS vs SSH** of the same repo normalize to the same canonical value → same
  identity. Correct and desired.
- **Case.** Host is lowercased. Owner/repo case is provider-dependent; V0 compares the
  canonical case-insensitively (matching current `projectIdentityMatches`). Documented
  as a deliberate leniency; a stricter provider-aware rule is a later-phase option.
- **Missing origin / no remote** → no Git claim; the project is `local` (legacy) or
  identified by Project ID only.
- **Multiple / ambiguous remotes.** Do not assume `origin` is canonical without care.
  If multiple remotes disagree, that is **CANDIDATE**, not VERIFIED — surface, don't
  guess.
- **Two similar URLs are not assumed equivalent.** Only exact canonical equality is a
  match. Look-alikes (`repo` vs `repo-fork`, different owners) are different projects.
- **Repository transfer / owner-org rename / URL change.** Represent as a **historical**
  Git claim plus a new **current** Git claim on the _same_ logical project — but adding
  that relationship requires an **authoritative basis** (explicit user confirmation, or
  a provider-verified redirect), never a guess. Until then the new remote is a separate
  logical project or a CANDIDATE.
- **Forks / repurposing.** A fork has a different remote → a different logical project by
  default. Merging a fork's identity into the original is only via a confirmed alias.

## 10. Project-side marker (evaluation only — do NOT implement)

An optional `.stack/project.json` containing only `{ "projectId": "prj_..." }`:

- **Pros:** rides with the code across machines/clones; makes identity portable even
  without Git; helps disaster recovery.
- **Cons / threats:** mutates the repo; a committed marker is **copied by clones,
  copies, and forks**, so three unrelated checkouts would all claim one Project ID
  (accidental duplication → looks like multiple checkouts or an identity conflict); an
  **attacker can spoof** a marker to try to redirect a restore. Projects without Git
  still work, but a committed marker in a shared repo becomes shared identity for every
  collaborator, which may be undesired.
- **Verdict:** if ever built, the marker is **corroborating evidence only, never
  authoritative** — it may raise a match to CANDIDATE or corroborate an independent
  strong signal, but it alone never authorizes a write, and a spoofed/duplicated marker
  must be caught by the "one strong identity ↔ one logical project" conflict rule (Q22).
  Default off; likely `.gitignore`d (machine-local) rather than committed. Compared to
  the local registry (private, no repo mutation, but not portable in the repo) and a
  Cloud registry (portable but a privacy surface), the marker is the most portable and
  the least trustworthy; it is a later-phase, opt-in complement, not the primary
  mechanism.

## 11. Legacy `local:` compatibility & generation 3

Existing backups contain identities like `local:C--Users-NT-Desktop-nexus`. These
**remain valid historical references forever.** The fact that
`C:\Users\NT\Desktop\nexus` no longer exists does not invalidate the identity — it just
means the project is unavailable/absent on this machine.

Translation model (mapping/lifecycle decisions live **outside** the immutable backup, in
the registry):

```
legacy Memory identity  (local:<vendorKey>, from an immutable generation)
        ↓ read as
identity alias / historical reference  (legacy-local claim)
        ↓ registry lookup / user confirmation
logical project ID  (prj_...)
        ↓ machine-local binding (if any, this machine)
optional current-machine binding  (a real directory)
        ↓ authorized only when confidence + lifecycle + availability allow
native restore
```

**Generation 3 stays usable indefinitely** with no rewrite. The resolver reads gen-3's
manifest as-is:

```
generation 3 (immutable, Protected)
        ↓ modern resolver understands legacy identity
legacy-local / git claims parsed from the gen-3 manifest
        ↓ optional registry alias + lifecycle overlay (mutable, separate)
current-machine resolution
        ↓
safe restore where authorized; otherwise retained/unavailable
```

Later backups naturally adopt the newer model (Project ID + registry section) while old
generations remain readable. No `decrypt → rewrite manifest → upload replacement` is
ever required. This honors invariants #12–#14.

## 12. Path-reuse threat model (Q13)

`local:<vendorKey>` is **path-derived**, and current `projectIdentityMatches` treats two
`local` identities as the same iff their vendor keys are byte-equal. So:

> Old project at `C:\Users\NT\Desktop\nexus` is deleted. Months later an unrelated
> project is created at `C:\Users\NT\Desktop\nexus`. Its vendor key re-encodes to the
> same `local:C--Users-NT-Desktop-nexus`.

An **exact historical path is therefore NOT sufficient evidence of identity** (Q13:
no). The future resolver must treat a legacy-local/path match as **CANDIDATE only**,
never auto-write into a directory purely because the path re-encodes to a stored vendor
key. To avoid contamination it should require confirmation and prefer corroborating
signals (a matching Git origin, an opt-in marker, or a content fingerprint). _This phase
changes no behavior_; it records path reuse as the concrete hardening for Phase 15B
(§ rollout in `project-recovery-mapping.md`).

## 13. Copies, clones, forks, repurposing (Q20, Q21, Q22, Q23)

| Scenario                                                         | Resolution                                                                                                                                  |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Same project moved** (path changed, same Git remote)        | Git VERIFIED → auto-resolve. Proven today.                                                                                                  |
| **B. Same repo cloned elsewhere** (same remote, new dir)         | Identity VERIFIED; the new dir is another **machine binding / checkout** of one logical project (§ multiple checkouts), not a merge.        |
| **C. Local directory copied**                                    | With same Git remote → treated as an extra checkout (VERIFIED identity, distinct binding). Without Git → CANDIDATE only (no strong signal). |
| **D. Repo forked** (different remote)                            | Different logical project by default. Unify only via a confirmed alias.                                                                     |
| **E. Repo transferred / owner-org renamed** (remote URL changed) | Same logical project via historical+current Git claims — added only with an authoritative basis (Q20); otherwise separate/CANDIDATE.        |
| **F. Dir deleted then recreated with unrelated contents**        | Must **not** match (path-reuse rule, §12).                                                                                                  |
| **G. Project renamed** (folder)                                  | Git resolves it; no-Git rename → CANDIDATE.                                                                                                 |
| **H. Project intentionally abandoned**                           | A lifecycle decision (archive) or simply unavailable — never inferred from a missing dir.                                                   |
| **I. Temporarily absent from this laptop**                       | `missing`/`unbound` availability; Memory preserved; no lifecycle change.                                                                    |

**Q21 (copies/forks contamination):** prevented because (a) only _strong, unambiguous_
identity auto-resolves; (b) path is never strong; (c) restore never merges or overwrites
differing Memory (existing `conflict` semantics, invariant #17); and (d) one strong
identity maps to exactly one logical project.

**Q22 (two logical projects claim one strong identity):** a genuine conflict. The
resolver **refuses automatic resolution**, surfaces both projects, and requires the user
to disambiguate or explicitly merge. It never silently merges (invariant #1).

**Q23 (one logical project, multiple checkouts):** allowed. Multiple machine bindings may
point to one logical project; one is **primary**. Restore targets the primary (or a
user-selected) checkout only — never all — because Claude auto-memory is keyed per
directory and writing into every checkout would duplicate/contaminate. See
`project-recovery-mapping.md`.

## 14. Data model (portable vs machine-local)

Illustrative shapes (not a schema; no code this phase):

```jsonc
// PORTABLE — inside the Memory backup bundle (Protected → encrypted)
{
  "projectRegistryVersion": 1,
  "projects": [
    {
      "projectId": "prj_9x4k...",
      "lifecycle": "active", // active | archived
      "claims": [
        {
          "type": "git",
          "value": "github.com/acme/atlas",
          "grade": "current",
          "provenance": "observed-origin",
          "addedAt": "...",
        },
        {
          "type": "git",
          "value": "github.com/oldacme/atlas",
          "grade": "historical",
          "provenance": "user-confirmed-transfer",
          "addedAt": "...",
        },
        {
          "type": "legacy-local",
          "value": "local:C--Users-NT-Desktop-atlas",
          "grade": "historical",
          "provenance": "gen<=3-manifest",
          "addedAt": "...",
        },
      ],
    },
  ],
}
```

```jsonc
// MACHINE-LOCAL — under Stack home; NEVER uploaded, NEVER in the manifest
{
  "schemaVersion": 1,
  "bindings": {
    "prj_9x4k...": {
      "checkouts": [
        { "dir": "C:\\work\\atlas", "primary": true, "lastSeen": "..." },
      ],
      "deferredUntilMapped": false, // "leave unavailable" memory (see lifecycle doc)
    },
  },
}
```

## 15. Failure modes

- **No portable identity, no confirmed mapping** → UNRESOLVED. Preserve; never guess.
- **Ambiguous Git (multiple disagreeing remotes)** → CANDIDATE; require confirmation.
- **Path reused by an unrelated project** → do not treat path as proof; CANDIDATE at
  most; conflict/no-overwrite rules protect existing Memory.
- **Duplicated marker across clones** → treated as an identity conflict (Q22), resolved
  by the user, never by silent merge.
- **Registry absent** (first run / legacy-only backup) → fall back to Git identity +
  legacy-local aliases; everything else UNRESOLVED.

## 16. Alternatives considered

- **Content-hash / path-hash Project IDs** (rejected: reintroduce path-reuse collisions
  and leak structure; a random opaque ID is safer).
- **Server-readable project registry table** (rejected: breaks Protected zero-knowledge;
  §8).
- **Marker file as the authoritative identity** (rejected: spoofable and copied by
  clones/forks; only ever corroborating; §10).
- **Rewriting old generations into the new model** (rejected: violates immutability and
  is unnecessary; the resolver overlays the registry instead; §11).
- **Auto-mapping local identities by matching folder name/path** (rejected: silent
  guessing; heuristics are CANDIDATE-only; §6, §12).

## 17. Recommended architecture (summary)

Opaque random **Project ID** as the durable spine; **typed identity claims** ranked by a
**confidence model** (verified/confirmed/candidate/unresolved) that is strictly separate
from lifecycle and machine availability; a **hybrid registry** that keeps portable
identity/lifecycle inside the (mode-following) backup bundle and all filesystem paths
machine-local; **Git remains the strong auto-match**, path is never strong; **legacy
`local:` identities are historical aliases** overlaid via the registry so **generation 3
stays usable without rewrite**; and **no silent guessing** anywhere. Lifecycle and the
resolution algorithm follow in the companion docs.
