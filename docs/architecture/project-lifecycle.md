# Stack Project Lifecycle & Machine Availability (Phase 15A architecture)

- **Status:** Proposed — architecture/specification only. No production behavior
  changes in this phase. Version 0.1.0 unchanged.
- **Date:** 2026-09-27
- **Companion docs:** [`project-identity.md`](./project-identity.md),
  [`project-recovery-mapping.md`](./project-recovery-mapping.md),
  [ADR 0004](./adr/0004-durable-logical-project-identity.md).

## 1. Problem statement

Today Stack has a single overloaded signal — `project-not-found` — that stands in for
"no portable identity," "not checked out on this machine," "deleted locally," and
"retired by the user." Because these are conflated, Stack cannot tell a project the user
walked away from apart from one that is simply on another laptop, and it risks either
nagging forever or (worse) guessing a destination. This document models two of the four
Phase-15 dimensions — **project lifecycle** (the user's stance) and **machine
availability** (this machine's state) — as separate axes, and defines archive/retire and
deletion semantics.

### Real dogfood motivation

In the deployment-doc §5 dogfood, 20 files from 8 local-only projects were retained but
unresolved. Later review established that at least one of those projects (**Nexus**) had
been **deliberately deleted** before the run. So "not found" spanned genuinely different
states. **Filesystem deletion is machine state, not necessarily logical-project
deletion** — a deleted directory says nothing about whether the user still considers the
project alive, or whether it exists on another machine. Stack must stop inferring
lifecycle from availability.

## 2. Goals & non-goals

**Goals:** a minimal lifecycle model; a separate machine-availability model; archive that
never deletes Memory; an honest deletion story given immutable backups; a persisted
"leave unavailable" choice that prevents nagging without falsely retiring a project;
optional private cross-machine sync of lifecycle.

**Non-goals:** a project-management system; a `deleted` lifecycle state; any deletion
implementation this phase; inferring lifecycle from the filesystem.

## 3. The two axes are orthogonal (Q2)

- **Project lifecycle** answers _"Does the user still consider this project active?"_ It
  is a property of the **logical project**, the same on every machine (portable, in the
  registry).
- **Machine availability** answers _"Is this project present on THIS machine, and
  where?"_ It is **machine-local**, may differ per machine, and never changes the global
  lifecycle.

All combinations are valid and non-contradictory:

|              | Present                             | Missing                            | Unbound                            |
| ------------ | ----------------------------------- | ---------------------------------- | ---------------------------------- |
| **Active**   | normal working copy                 | on another disk / temporarily gone | active project, not on this laptop |
| **Archived** | archived but still checked out here | archived and not present           | archived, never bound here         |

A missing binding must **never** flip lifecycle to archived/deleted (invariant #3, #4).

## 4. Project lifecycle model (minimum)

Two states plus a separate destructive operation. We deliberately do **not** add a
`deleted` lifecycle state.

- **ACTIVE** — the project is part of the user's active set. Included in backups;
  eligible for automatic restore (subject to identity/availability); surfaced normally.
- **ARCHIVED** — the user has explicitly said they are no longer actively working on it.
  Historical Memory is **retained**. Stack stops prompting to map it during recovery. It
  still exists as a logical project and can be reactivated or restored on demand.

**Filesystem deletion is not a lifecycle state.** Hard deletion of Stack metadata/Memory
is a separate explicit destructive operation (§7), never a lifecycle value.

### 4.1 Terminology recommendation — "archived" (Q, lifecycle wording)

Use **"archived"** as the user-facing word, not "retired."

- "Archived" is familiar (GitHub, email, files), clearly **reversible**, and does not
  imply the Memory is gone.
- "Retired" reads as more final and invites the wrong mental model (that the project or
  its Memory is being ended). We reserve stronger language for **hard delete**.

The registry stores the machine value `"archived"`; docs and CLI say "archive" /
"unarchive."

### 4.2 Lifecycle questions answered

- **Can a project be reactivated?** Yes — `unarchive` sets it back to active. Cheap and
  non-destructive (Q17).
- **Are archived projects still recoverable manually?** Yes — always, on explicit
  request.
- **Do archived projects participate in normal automatic restore?** No, by default. They
  are skipped in the default `restore` and never prompt for mapping, but the user can
  explicitly restore them.
- **Does backup keep including archived project Memory?** Yes — archiving does not stop
  backup or delete Memory. (A future opt-in "stop backing up new Memory for this
  project" is a _separate_ control from lifecycle; §7.) Immutable generations already
  containing the project are untouched regardless.
- **Cloud retention?** Unchanged from ADR 0003: generations are immutable; retirement of
  a generation is soft-delete + bounded retention, not instant erasure. Archiving a
  _project_ changes none of that.
- **Does lifecycle sync across machines?** Lifecycle is portable (in the bundle), so it
  propagates privately when a machine pulls a newer generation. It is **not** a live
  cross-device push; it converges through normal backup/recovery. Bindings and
  availability never sync.
- **How is accidental retirement undone?** `unarchive`. Because archive is
  non-destructive, an accidental archive loses nothing (Q17, Q18).

## 5. Machine availability model (Q1 machine half, Q19)

Availability is computed per machine from the machine-local bindings + a filesystem
check. Recommended terms (replacing "BOUND/MISSING" etc.):

| State         | Meaning                                                                                                                                                               |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **PRESENT**   | A binding exists and the bound directory currently exists. Ready to restore into.                                                                                     |
| **MISSING**   | A binding exists but the directory is currently absent (unplugged drive, deleted checkout, different OS session). Preserve; do not conclude anything about lifecycle. |
| **UNBOUND**   | No binding on this machine. The project may be fully valid elsewhere.                                                                                                 |
| **CANDIDATE** | One or more possible local directories exist but none is authorized yet (heuristic match).                                                                            |

Plus a persisted per-machine choice, not an availability state per se:

- **DEFERRED ("leave unavailable")** — the user reviewed an unresolved project on this
  machine and chose to leave it unavailable for now. Remembered so Stack does not nag,
  without marking the project archived (Q15). Cleared when the user later maps it.

**"Project does not exist" is never stored** merely because a path is missing (invariant
#3). Q19: a project absent on one machine is simply `unbound`/`missing` there and stays
`present`/active elsewhere; nothing global changes.

## 6. Archived / retired Memory semantics

Strong principle: **archive ≠ delete.** Historical Memory remains recoverable unless the
user explicitly hard-deletes it.

- **Does archived-project Memory stay in normal backups?** Yes (see §4.2). Immutable
  generations are never rewritten.
- **Does it appear separately in status?** Yes — `stack project` groups archived
  projects separately (e.g. "Archived (2)") so they do not clutter the active view.
- **Does restore skip it by default?** Yes — default `restore` skips archived projects
  and does not prompt; explicit restore still works.
- **Reactivation?** `unarchive` (§4.2).
- **Retention vs immutable generations?** Archiving touches only the mutable registry
  overlay; the generations that already contain the project are immutable and unaffected.

## 7. Deletion semantics (Q18, Q27 — architecture only, honest limits)

These are five **distinct** operations. Only the last is a true destructive delete; none
is implied by archiving or by a missing directory.

1. **Remove local binding** — machine-local only. Forgets _where_ the project is on this
   machine. Nothing portable changes; Memory is untouched.
2. **Archive the logical project** — lifecycle → archived. Stops prompts; keeps
   everything (§6).
3. **Stop backing up new Memory for the project** — a separate opt-in switch. Future
   backups omit the project's _new_ files; existing generations are untouched.
4. **Remove current project metadata** — drop the project from the _current_ registry
   (and future bundles). Prior immutable generations still contain it and remain
   recoverable.
5. **Destroy recoverable Cloud Memory (hard delete)** — the only genuinely destructive
   operation; explicit and confirmed, separate from lifecycle.

### 7.1 What "delete Memory" can honestly guarantee

Because historical generations are **immutable** (and, for Protected, client-side
encrypted), Stack cannot retroactively rewrite bytes already committed to prior
generations. Honest guarantees:

- We can **stop including** the project in new generations (op 3/4) — immediate and
  reliable going forward.
- We can **retire** existing generations (soft-delete + bounded retention), after which
  stored payloads are deleted on the retention schedule — **not** instant global
  erasure. This matches ADR 0003's disclosed stance.
- For **Protected** Memory, the practical erasure primitive is **crypto-shredding**:
  destroy the MMK/DEK wrappers so the ciphertext becomes undecryptable. This approximates
  deletion even where retained ciphertext bytes persist, but it is only as strong as our
  assurance that no copy of the key/plaintext survives; we disclose that retained
  ciphertext may exist within the retention window.
- We will **not** claim instant, global, irreversible deletion. Hard delete is a
  deliberate, confirmed, and honestly-bounded operation, designed (not implemented) in a
  later phase.

## 8. Failure modes

- **User archives the wrong project** → `unarchive`; nothing lost (non-destructive).
- **Drive with the checkout is unplugged** → `missing`, not archived/deleted; Memory
  preserved.
- **Lifecycle diverges across machines before convergence** → last committed generation's
  lifecycle wins on pull; because archive is non-destructive, divergence is safe and
  self-heals. Bindings never sync, so they never conflict across machines.
- **Hard delete requested on a Protected backup** → crypto-shred wrappers + retire
  generations; disclose retention limits rather than overclaiming erasure.

## 9. Recommended model (summary)

Two orthogonal axes: **lifecycle** (`active` | `archived`, portable, non-destructive,
reversible) and **machine availability** (`present` | `missing` | `unbound` |
`candidate`, machine-local) plus a per-machine **deferred** choice. No `deleted`
lifecycle state; deletion is five distinct operations of which only hard delete is
destructive, with honest, retention-bounded guarantees against immutable, possibly
Protected generations.
