# ADR 0004 — Durable logical-project identity, lifecycle, and recovery mapping

- **Status:** Proposed (Phase 15A architecture). Not implemented; version 0.1.0
  unchanged. No production behavior, schema, migration, or crypto change.
- **Date:** 2026-09-27
- **Context docs:** [`../project-identity.md`](../project-identity.md),
  [`../project-lifecycle.md`](../project-lifecycle.md),
  [`../project-recovery-mapping.md`](../project-recovery-mapping.md).
- **Builds on:** [ADR 0003](./0003-protection-modes-and-passkey-recovery.md)
  (Standard/Protected modes, MMK hierarchy) and the real-Memory acceptance in
  [`../memory-cloud-deployment.md` §5](../memory-cloud-deployment.md).

## Context

Stack Memory V0 was accepted after a real Protected Cloud dogfood: 27 files across 9
projects recovered on a fresh machine; the 1 project with a canonical Git remote
auto-restored (7 files) and the 20 files from 8 local-only projects were correctly
retained but unresolved. The portable identity for a non-Git project is today
`local:<vendorKey>` — the absolute path with separators replaced by `-`
(`encodeClaudeProjectKey`) — which is not portable and collides on path reuse.

A follow-up correction matters: at least one unresolved project (Nexus) had been
**deliberately deleted** locally before the dogfood. So `project-not-found` conflated four
distinct things: no portable identity, not checked out here, deleted locally, and retired
by the user. The core problem is a single overloaded status.

## Decision

1. **Separate four dimensions** and never collapse them into one status: **logical
   identity**, **project lifecycle**, **machine availability**, and **recovery
   resolution**.
2. **Opaque random Project ID** (`prj_` + 128-bit CSPRNG, base32) as the durable spine —
   never derived from path, username, machine, folder, or content; minted once per logical
   project.
3. **Typed identity claims ranked by a confidence model** — `VERIFIED` / `CONFIRMED` /
   `CANDIDATE` / `UNRESOLVED` — kept strictly separate from lifecycle. Only a single
   unambiguous canonical Git remote, an authoritative Project ID, or a prior user
   confirmation authorizes an automatic write; heuristics are CANDIDATE-only.
4. **Path is never strong identity.** Legacy `local:<vendorKey>` identities are permanent
   **historical aliases**; an exact historical path is CANDIDATE only. This closes the
   path-reuse contamination hole.
5. **Minimal lifecycle:** `active` | `archived` (user-facing word **"archived"**;
   reversible; non-destructive). No `deleted` lifecycle state. Hard delete is a separate,
   explicit, confirmed destructive operation.
6. **Machine availability** modeled separately: `present` | `missing` | `unbound` |
   `candidate`, plus a per-machine **deferred** ("leave unavailable") choice. A missing
   directory never changes lifecycle.
7. **Hybrid registry.** Portable state (Project ID, claims, lifecycle, confirmed
   relationships) rides **inside the Memory backup bundle** (mode-following); machine state
   (paths, bindings, availability, deferrals) stays **machine-local** and is never
   uploaded. No new server-readable project table.
8. **Non-blocking recovery.** `restore` writes what is safely resolvable and **retains the
   rest without forcing any decision** (exit 0). Recovered Memory may remain stored
   without a destination, indefinitely. `stack project` reviews unresolved projects;
   `stack project map` records a durable, reversible, machine-local binding.
9. **Generation 3 (and all prior generations) resolve via a registry overlay** — Git
   auto-resolves, legacy aliases resolve via registry/confirmation — with **no
   decrypt→rewrite→re-upload**. Immutable backups stay immutable.
10. **Provider-neutral.** Identity/lifecycle sit above provider Memory; only
    bindings/restore targets are provider-specific.

## Consequences

- **Privacy preserved.** Because the registry rides in the bundle, Protected users leak
  nothing new: project names, repo identities, relationships, and lifecycle stay
  zero-knowledge to the server. Standard users' server visibility is unchanged from
  today's Standard bundle (disclosed).
- **Proven behavior kept.** Canonical Git remote → cross-path auto-match still works and
  is a regression guard.
- **Legacy safe & forever-valid.** `local:` identities remain meaningful; a deleted
  directory no longer implies a dead project; path reuse can no longer silently
  contaminate Memory.
- **Honest deletion.** Against immutable, possibly Protected generations, "delete" means
  stop future inclusion + retire/soft-delete with bounded retention + (Protected)
  crypto-shred — not instant global erasure. Consistent with ADR 0003.
- **Bounded surface.** Two new CLI writes at most in the first slice (`stack project`,
  `stack project map`); lifecycle and hard delete follow later.
- **Cost:** a new portable registry section in the bundle format and a machine-local
  binding store; a two-stage resolver; migration reading legacy aliases. All deferred to
  15B+.

## Alternatives considered

- **Keep path-derived `local:` identity** (rejected: not portable; path-reuse
  contamination).
- **Content/path-hash Project IDs** (rejected: reintroduce collisions, leak structure).
- **Server-readable project registry table** (rejected: breaks Protected
  zero-knowledge).
- **`.stack/project.json` marker as authoritative identity** (rejected: spoofable, copied
  by clones/forks; only ever corroborating, opt-in, later).
- **Rewrite old generations into the new model** (rejected: violates immutability;
  unnecessary given the overlay).
- **Aggressive "N projects need mapping" recovery UX** (rejected: nags about intentionally
  gone projects; recovered Memory needs no destination to be valuable).
- **A `deleted` lifecycle state / inferring deletion from the filesystem** (rejected:
  missing ≠ retired ≠ deleted).

## Rollout

15A: this architecture + ADR (no code). 15B: Project ID + in-bundle registry, machine
bindings, non-blocking restore + `stack project`/`map`, legacy-local read + path-reuse
hardening, gen-3 overlay. 15C+: lifecycle + private cross-machine convergence, Git
transfer reconciliation, opt-in marker, multiple-checkout primary, multi-provider
manifests, hard-delete/crypto-shred. Version stays 0.1.0 until an implementation slice
ships.
