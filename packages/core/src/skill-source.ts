import { createHash } from 'node:crypto';

import type { SkillTreeEntry } from '@stack/shared';
import {
  environmentLockSchema,
  environmentManifestSchema,
  machineEnvironmentBaselineSchema,
} from '@stack/spec';
import type { EnvironmentLock, LockedSkill, SnapshotReason } from '@stack/spec';

import { persistMainState, withMainMutationLock } from './composition.js';
import { resolveSkillSelector } from './composition.js';
import type { SkillSelectorResult } from './composition.js';
import { loadMainEnvironment } from './state.js';
import { spawnGit, type GitExecutor } from './git-reference.js';

/* -------------------------------------------------------------------------- */
/* Source-latest resolution (P2, contract §5)                                 */
/* -------------------------------------------------------------------------- */

/**
 * The three facts the lifecycle keeps DISTINCT are SOURCE (what the upstream resolves to now),
 * APPROVED/DESIRED (the immutable imported version in the lock) and INSTALLED (what a machine
 * last reported at check-in). This resolver answers only the SOURCE question for one Skill.
 *
 * - `same` / `different` are reported ONLY for a checkable Git-backed source that records a
 *   tracked ref (the SOURCE LOCATOR). STAK re-resolves THAT EXACT ref — never the repository
 *   default branch as a global fallback — and compares the resolved revision to the approved
 *   revision by EXACT IDENTITY (never lexical/numeric/semver ordering of hashes). Two Skills
 *   from the same repo on different refs therefore resolve independently.
 * - Everything else FAILS CLOSED as `uncheckable`: an exact-commit-pinned reference (no tracked
 *   ref) is `pinned` (intentionally not update-trackable; a moving default branch must not
 *   invent an update); Local/dirty/ambiguous/unreachable never yield a false "different". The
 *   P3 read model maps every `uncheckable` to "Can't check for updates from this source".
 */
export type SourceLatestResult =
  | { status: 'same'; approvedRevision: string; sourceRevision: string }
  | { status: 'different'; approvedRevision: string; sourceRevision: string }
  | {
      status: 'uncheckable';
      reason: 'local' | 'dirty' | 'ambiguous' | 'unreachable' | 'pinned';
    };

/** Map a snapshot restoration reason to why its source cannot be checked for updates. */
const snapshotUncheckable = (
  reason: SnapshotReason,
): Extract<SourceLatestResult, { status: 'uncheckable' }> => {
  switch (reason) {
    case 'local':
      return { status: 'uncheckable', reason: 'local' };
    case 'modified-source':
      return { status: 'uncheckable', reason: 'dirty' };
    case 'ambiguous-source':
      return { status: 'uncheckable', reason: 'ambiguous' };
    case 'unknown-source':
    case 'non-portable-source':
      return { status: 'uncheckable', reason: 'unreachable' };
  }
};

/**
 * Resolve a specific Git ref on a remote to its exact revision, or null if the ref is missing
 * or the remote is unreachable. This is the SOURCE LOCATOR resolution; the ref is whatever the
 * Skill actually tracks (a branch, tag, or other ref), never substituted with the default
 * branch.
 */
export type ResolveRemoteRef = (input: {
  remote: string;
  ref: string;
}) => Promise<string | null>;

/**
 * Default ref resolver: `git ls-remote <remote> <ref> <ref>^{}`, shell:false, non-interactive,
 * never prompting for credentials. Returns the exact COMMIT the ref points at, or null on any
 * failure / ref-not-found (treated as unreachable — never a false "update available").
 *
 * ANNOTATED TAGS: `ls-remote` lists the tag-object SHA for `refs/tags/x` and the peeled commit
 * for `refs/tags/x^{}`. STAK's approved revision is the peeled commit, so we prefer the `^{}`
 * line when present and never compare against the tag-object SHA (which would be a false
 * update). Lightweight tags and branches have no peeled line, so the plain ref SHA is used.
 */
export const gitLsRemoteRef =
  (gitExecutor: GitExecutor = spawnGit): ResolveRemoteRef =>
  async ({ remote, ref }) => {
    try {
      const result = await gitExecutor(
        ['ls-remote', remote, ref, `${ref}^{}`],
        {
          cwd: process.cwd(),
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        },
      );
      if (result.exitCode !== 0) return null;
      const byName = new Map<string, string>();
      for (const line of result.stdout.split('\n')) {
        const [sha, name] = line.trim().split(/\s+/);
        if (sha && name && /^[0-9a-f]{7,64}$/i.test(sha)) byName.set(name, sha);
      }
      // Prefer the peeled commit (annotated tag) over the tag-object / plain ref SHA.
      return byName.get(`${ref}^{}`) ?? byName.get(ref) ?? null;
    } catch {
      return null;
    }
  };

/**
 * Resolve whether a newer source revision exists for one approved Skill. A reference-backed
 * Skill that records a tracked ref re-resolves THAT ref and compares by exact revision
 * identity; a reference with no tracked ref is `pinned` (not trackable); snapshot-backed Skills
 * (Local, dirty, ambiguous, unreachable) fail closed.
 */
export const resolveSkillSourceLatest = async (options: {
  locked: Pick<LockedSkill, 'restoration'>;
  resolveRemoteRef?: ResolveRemoteRef;
}): Promise<SourceLatestResult> => {
  const { restoration } = options.locked;
  if (restoration.strategy === 'snapshot')
    return snapshotUncheckable(restoration.reason);
  const { reference } = restoration;
  const approvedRevision = reference.revision;
  // No tracked ref ⇒ exact-commit-pinned: do NOT guess the default branch.
  if (reference.ref === undefined)
    return { status: 'uncheckable', reason: 'pinned' };
  const resolveRef = options.resolveRemoteRef ?? gitLsRemoteRef();
  const sourceRevision = await resolveRef({
    remote: reference.remote,
    ref: reference.ref,
  });
  if (sourceRevision === null)
    return { status: 'uncheckable', reason: 'unreachable' };
  // Exact-identity comparison only — never lexical/numeric ordering of revisions.
  return sourceRevision === approvedRevision
    ? { status: 'same', approvedRevision, sourceRevision }
    : { status: 'different', approvedRevision, sourceRevision };
};

/* -------------------------------------------------------------------------- */
/* Public-stack source-latest (P2, contract §5 — versioned sources)            */
/* -------------------------------------------------------------------------- */

/**
 * A Skill that originates from a public Stack is NOT update-checked with Git ref logic — the
 * source of truth is the public registry's published VERSIONS. The stable SOURCE LOCATOR is
 * `@owner/slug` (+ `publicStackId`); the APPROVED version is the immutable `versionHash` (with
 * `publicVersionId` corroborating). This boundary defines the semantics; the transport that
 * fetches the latest published version is supplied by P3 (a registry client/service), so P2
 * proves it with an injected fake and does not fabricate data.
 */
export type PublicStackLocator = {
  owner: string;
  slug: string;
  publicStackId: string;
};
export type PublicStackVersionId = {
  publicVersionId: string;
  versionHash: string;
};
/** P3-supplied: the latest published version for a public Stack, or null if unavailable. */
export type PublicStackLatestResolver = (
  locator: PublicStackLocator,
) => Promise<PublicStackVersionId | null>;

/**
 * Resolve whether a newer published public-Stack version exists, by IMMUTABLE VERSION IDENTITY
 * (`versionHash`), never Git semantics or ordering. Same published version → `same`; a
 * different published version → `different` (a newer approved candidate for the Skill rides
 * that version); an unavailable / removed / ambiguous source fails closed as `uncheckable`
 * (P3 renders "Can't check for updates from this source").
 */
export const resolvePublicStackSourceLatest = async (options: {
  approved: PublicStackVersionId;
  locator: PublicStackLocator;
  fetchLatest: PublicStackLatestResolver;
}): Promise<SourceLatestResult> => {
  const latest = await options.fetchLatest(options.locator);
  if (latest === null) return { status: 'uncheckable', reason: 'unreachable' };
  // Identity comparison on the immutable version hash — no Git ref logic, no ordering.
  return latest.versionHash === options.approved.versionHash
    ? {
        status: 'same',
        approvedRevision: options.approved.versionHash,
        sourceRevision: latest.versionHash,
      }
    : {
        status: 'different',
        approvedRevision: options.approved.versionHash,
        sourceRevision: latest.versionHash,
      };
};

/* -------------------------------------------------------------------------- */
/* Candidate diff (P2, contract §5)                                            */
/* -------------------------------------------------------------------------- */

export type SkillFileChangeKind = 'added' | 'modified' | 'removed';
export type SkillFileChange = {
  relativePath: string;
  kind: SkillFileChangeKind;
};
export type SkillTreeDiff = { changed: boolean; files: SkillFileChange[] };

const entryFingerprint = (entry: SkillTreeEntry): string => {
  const hash = createHash('sha256').update(entry.type).update('\0');
  hash.update(entry.type === 'file' ? entry.content : entry.target);
  return hash.digest('hex');
};

/**
 * Pure per-file diff between APPROVED immutable content and a CANDIDATE exact source revision.
 * It compares two already-materialized trees (approved from the content-addressed store, the
 * candidate reacquired at an exact revision) — never arbitrary mutable working-tree state.
 * Reports added / modified / removed files; identical trees yield `changed: false`.
 */
export const diffSkillTrees = (
  approved: SkillTreeEntry[],
  candidate: SkillTreeEntry[],
): SkillTreeDiff => {
  const approvedByPath = new Map(
    approved.map((entry) => [entry.relativePath, entryFingerprint(entry)]),
  );
  const candidateByPath = new Map(
    candidate.map((entry) => [entry.relativePath, entryFingerprint(entry)]),
  );
  const files: SkillFileChange[] = [];
  for (const [relativePath, candidateHash] of candidateByPath) {
    const approvedHash = approvedByPath.get(relativePath);
    if (approvedHash === undefined) files.push({ relativePath, kind: 'added' });
    else if (approvedHash !== candidateHash)
      files.push({ relativePath, kind: 'modified' });
  }
  for (const relativePath of approvedByPath.keys())
    if (!candidateByPath.has(relativePath))
      files.push({ relativePath, kind: 'removed' });
  // Code-point ordering (not locale) so the diff is deterministic across platforms, matching
  // how skill trees are hashed.
  const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  files.sort(
    (a, b) => order(a.relativePath, b.relativePath) || order(a.kind, b.kind),
  );
  return { changed: files.length > 0, files };
};

/** A candidate source revision's content, tied to its exact revision identity. */
export type CandidateRevision = {
  revision: string;
  contentHash: string;
  entries: SkillTreeEntry[];
};

export type SkillSourceDiff = {
  entryId: string;
  approvedContentHash: string;
  sourceRevision: string;
  candidateContentHash: string;
  tree: SkillTreeDiff;
};

/* -------------------------------------------------------------------------- */
/* Approval (P2 core service; P3 exposes the account-side write)               */
/* -------------------------------------------------------------------------- */

/**
 * Approving a source version means: import the exact immutable source revision, PRESERVE
 * source/provenance, and set STAK's approved/desired version for a stable entryId to the new
 * immutable content. It NEVER mutates another machine's installed state or projection (this
 * writes only local desired state), and it never silently overwrites dirty local content — a
 * snapshot-backed (Local/dirty/ambiguous) Skill is refused with `not-checkable`.
 *
 * The prior imported version stays in the content-addressed Store (immutable versions are
 * preserved); this only advances the lock's approved pointer for the selected Skill.
 */
export type ApproveSkillResult =
  | {
      status: 'ok';
      entryId: string;
      previousContentHash: string;
      approvedContentHash: string;
      sourceRevision: string;
      changed: boolean;
    }
  | { status: 'not-found' }
  | { status: 'ambiguous'; matches: string[] }
  | { status: 'not-checkable'; reason: 'local' | 'dirty' | 'ambiguous' };

/** Import a candidate revision's content into the Store (returns whether it was reused). */
export type IngestCandidate = (
  candidate: CandidateRevision,
) => Promise<{ reused: boolean }>;

const notCheckableFor = (
  reason: SnapshotReason,
): Extract<ApproveSkillResult, { status: 'not-checkable' }> => {
  switch (reason) {
    case 'local':
      return { status: 'not-checkable', reason: 'local' };
    case 'ambiguous-source':
    case 'unknown-source':
    case 'non-portable-source':
      return { status: 'not-checkable', reason: 'ambiguous' };
    case 'modified-source':
      return { status: 'not-checkable', reason: 'dirty' };
  }
};

export const approveSkillSourceVersion = async (options: {
  stackHome: string;
  selector: string;
  candidate: CandidateRevision;
  ingest: IngestCandidate;
}): Promise<ApproveSkillResult> => {
  const current = await loadMainEnvironment({ stackHome: options.stackHome });
  const resolved: SkillSelectorResult = resolveSkillSelector(
    current.lock,
    options.selector,
  );
  if (resolved.status !== 'ok') return resolved;
  const { entryId } = resolved;
  const locked = current.lock.skills[entryId];
  if (!locked) return { status: 'not-found' };
  // Never silently overwrite dirty/local content: approval applies only to a reference-backed
  // (checkable, portable) Skill.
  if (locked.restoration.strategy === 'snapshot')
    return notCheckableFor(locked.restoration.reason);

  const previousContentHash = locked.contentHash;
  if (previousContentHash === options.candidate.contentHash)
    return {
      status: 'ok',
      entryId,
      previousContentHash,
      approvedContentHash: previousContentHash,
      sourceRevision: options.candidate.revision,
      changed: false,
    };

  // Import the exact immutable source revision BEFORE advancing the approved pointer; a failure
  // here throws and leaves the prior approved version intact.
  await options.ingest(options.candidate);

  const nextLocked: LockedSkill = {
    ...locked,
    contentHash: options.candidate.contentHash,
    localContent: {
      available: true,
      contentHash: options.candidate.contentHash,
    },
    // Preserve provenance (remote + path); advance only the exact revision + expected hash.
    restoration: {
      strategy: 'reference',
      reference: {
        ...locked.restoration.reference,
        revision: options.candidate.revision,
        expectedContentHash: options.candidate.contentHash,
      },
    },
  };
  const lock: EnvironmentLock = {
    ...current.lock,
    skills: { ...current.lock.skills, [entryId]: nextLocked },
  };
  await withMainMutationLock(options.stackHome, current, () =>
    persistMainState(options.stackHome, {
      manifest: environmentManifestSchema.parse(current.manifest),
      lock: environmentLockSchema.parse(lock),
      baseline: machineEnvironmentBaselineSchema.parse(current.baseline),
    }),
  );
  return {
    status: 'ok',
    entryId,
    previousContentHash,
    approvedContentHash: options.candidate.contentHash,
    sourceRevision: options.candidate.revision,
    changed: true,
  };
};
