import { createHash } from 'node:crypto';

import { z } from 'zod';

import type { ProjectIdentity } from '../domain.js';
import { projectIdentityKey } from '../project-identity.js';
import { mintProjectId, PROJECT_ID_PATTERN } from './project-id.js';

/**
 * Provider-neutral logical-project registry (Phase 15B).
 *
 * Two clearly separated tiers (see `docs/architecture/project-identity.md` §7):
 *
 *  PORTABLE  — travels inside the Memory backup bundle (mode-following: Standard is
 *    server-readable, Protected is client-side encrypted). Contains only the opaque
 *    Project ID and portable identity claims. NEVER a filesystem path.
 *  MACHINE-LOCAL — stays on the device, never uploaded. Adds bindings (Project ID →
 *    absolute directory) and other machine state.
 *
 * This module is pure (no I/O); persistence lives in `registry-store.ts`.
 */

export const COMPAT_KEY_LABEL = 'stack-project-compat-v1' as const;

/**
 * A portable, opaque compatibility reference for a legacy path-derived identity
 * (`local:<vendorKey>`). It is a domain-separated digest of the canonical legacy
 * identity string, so an old recovered legacy identity transforms LOCALLY into the
 * same lookup key — WITHOUT emitting the raw absolute path into new portable
 * metadata. It is not, and is not claimed to be, cryptographically secret (a digest
 * of a guessable path is guessable); it is an opacity/tidiness measure. Protected
 * mode still encrypts the whole bundle. See `project-recovery-mapping.md`.
 */
export const legacyCompatKey = (identityKey: string): string =>
  `compat:${createHash('sha256')
    .update(`${COMPAT_KEY_LABEL}:${identityKey}`)
    .digest('hex')}`;

export const projectClaimSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('git'), canonical: z.string().min(1) }),
  z.object({ type: z.literal('legacy-compat'), key: z.string().min(1) }),
]);
export type ProjectClaim = z.infer<typeof projectClaimSchema>;

/**
 * Project lifecycle (Phase 15C): the user's organizational stance on a logical project,
 * independent of machine availability. `active` | `archived`. Legacy/pre-15C records omit
 * it and are treated as `active` (see `lifecycleOf`). Archive is reversible and never
 * deletes anything.
 */
export const projectLifecycleSchema = z.enum(['active', 'archived']);
export type ProjectLifecycle = z.infer<typeof projectLifecycleSchema>;

export const portableProjectRecordSchema = z.object({
  projectId: z.string().regex(PROJECT_ID_PATTERN),
  claims: z.array(projectClaimSchema).min(1),
  // Optional so pre-15C records decode safely; absence means `active`.
  lifecycle: projectLifecycleSchema.optional(),
});
export type PortableProjectRecord = z.infer<typeof portableProjectRecordSchema>;

/** A record's effective lifecycle; a missing value (legacy record) is `active`. */
export const lifecycleOf = (
  record: Pick<PortableProjectRecord, 'lifecycle'>,
): ProjectLifecycle => record.lifecycle ?? 'active';

/** The portable snapshot embedded in a Memory bundle. NO bindings, NO paths. */
export const PROJECT_REGISTRY_SNAPSHOT_VERSION = 1 as const;
export const portableRegistrySnapshotSchema = z.object({
  snapshotVersion: z.literal(PROJECT_REGISTRY_SNAPSHOT_VERSION),
  projects: z.array(portableProjectRecordSchema),
});
export type PortableRegistrySnapshot = z.infer<
  typeof portableRegistrySnapshotSchema
>;

/** A machine-local binding: Project ID → an absolute directory on THIS machine. */
export const machineBindingSchema = z.object({
  projectId: z.string().regex(PROJECT_ID_PATTERN),
  dir: z.string().min(1),
  boundAt: z.iso.datetime({ offset: true }),
  provenance: z.literal('user-map'),
});
export type MachineBinding = z.infer<typeof machineBindingSchema>;

/**
 * A machine-local, advisory display-name hint for a Project ID — the safe basename
 * captured the last time Memory backup discovered this project's directory on THIS
 * machine (see `claude-adapter.ts`'s `onLocalProjectResolved`). It is NEVER part of
 * the portable snapshot and NEVER a full path; it exists only so the Cloud `name` sync
 * and `stak project` CLI rendering can show a recognizable name even when the project
 * is not currently bound (`stak project map`) on this machine.
 */
export const projectNameHintSchema = z.object({
  projectId: z.string().regex(PROJECT_ID_PATTERN),
  name: z.string().min(1).max(200),
});
export type ProjectNameHint = z.infer<typeof projectNameHintSchema>;

export const LOCAL_REGISTRY_VERSION = 1 as const;
export const localRegistrySchema = z.object({
  schemaVersion: z.literal(LOCAL_REGISTRY_VERSION),
  projects: z.array(portableProjectRecordSchema),
  bindings: z.array(machineBindingSchema),
  // Optional so pre-existing registry files decode safely; absence means no hints yet.
  nameHints: z.array(projectNameHintSchema).optional(),
});
export type LocalRegistry = z.infer<typeof localRegistrySchema>;

export const emptyRegistry = (): LocalRegistry => ({
  schemaVersion: LOCAL_REGISTRY_VERSION,
  projects: [],
  bindings: [],
  nameHints: [],
});

/* -------------------------------------------------------------------------- */
/* Claims                                                                       */
/* -------------------------------------------------------------------------- */

/** The portable claim that identifies a project identity. */
export const identityClaim = (identity: ProjectIdentity): ProjectClaim =>
  identity.kind === 'git'
    ? { type: 'git', canonical: identity.canonical }
    : {
        type: 'legacy-compat',
        key: legacyCompatKey(projectIdentityKey(identity)),
      };

/** A stable, case-normalized string used to compare two claims for equality. */
export const claimKey = (claim: ProjectClaim): string =>
  claim.type === 'git'
    ? `git:${claim.canonical.toLowerCase()}`
    : `legacy:${claim.key}`;

/** Whether a claim counts as STRONG (a strong claim may auto-resolve when unique). */
export const isStrongClaim = (claim: ProjectClaim): boolean =>
  claim.type === 'git';

const recordKeys = (record: PortableProjectRecord): string[] =>
  record.claims.map(claimKey);

const dedupeClaims = (claims: ProjectClaim[]): ProjectClaim[] => {
  const seen = new Set<string>();
  const out: ProjectClaim[] = [];
  for (const claim of claims) {
    const key = claimKey(claim);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(claim);
  }
  return out;
};

/* -------------------------------------------------------------------------- */
/* Resolution                                                                   */
/* -------------------------------------------------------------------------- */

export type ProjectResolution =
  | { status: 'resolved'; projectId: string }
  | { status: 'conflict'; projectIds: string[] }
  | { status: 'unknown' };

/** Find the logical project for an identity by matching a shared claim key. */
export const resolveProjectForIdentity = (
  registry: LocalRegistry,
  identity: ProjectIdentity,
): ProjectResolution => {
  const key = claimKey(identityClaim(identity));
  const matches = registry.projects.filter((record) =>
    recordKeys(record).includes(key),
  );
  if (matches.length === 0) return { status: 'unknown' };
  const ids = [...new Set(matches.map((record) => record.projectId))];
  if (ids.length > 1) return { status: 'conflict', projectIds: ids };
  return { status: 'resolved', projectId: ids[0] as string };
};

/**
 * Resolve an identity to a Project ID, minting a new one when unknown. Returns the
 * updated registry (new object) plus the resolved id. Never mutates the input.
 * `mint` is injectable for deterministic tests.
 */
export const resolveOrMintProject = (
  registry: LocalRegistry,
  identity: ProjectIdentity,
  mint: () => string = mintProjectId,
): { registry: LocalRegistry; projectId: string; minted: boolean } => {
  const resolution = resolveProjectForIdentity(registry, identity);
  if (resolution.status === 'resolved')
    return { registry, projectId: resolution.projectId, minted: false };
  // A conflict is surfaced by callers; we still do not silently mint over it.
  if (resolution.status === 'conflict')
    return {
      registry,
      projectId: resolution.projectIds[0] as string,
      minted: false,
    };
  const claim = identityClaim(identity);
  const projectId = mint();
  return {
    registry: {
      ...registry,
      projects: [
        ...registry.projects,
        { projectId, claims: [claim], lifecycle: 'active' },
      ],
    },
    projectId,
    minted: true,
  };
};

/* -------------------------------------------------------------------------- */
/* Merge (recovered snapshot → local registry)                                  */
/* -------------------------------------------------------------------------- */

export type RegistryConflict = { claimKey: string; projectIds: string[] };

export type MergeResult = {
  registry: LocalRegistry;
  conflicts: RegistryConflict[];
};

/**
 * Merge a recovered portable snapshot into the local registry, deterministically:
 *  - same Project ID → union compatible claims;
 *  - the SAME strong identity attached to a DIFFERENT Project ID is a CONFLICT — both
 *    records are preserved and the conflict reported; claims are NOT merged across
 *    ids (no last-writer-wins identity merge that could contaminate projects);
 *  - PORTABLE lifecycle comes from the recovered snapshot and is AUTHORITATIVE: for a
 *    Project ID also present locally, the recovered lifecycle replaces the local one
 *    (an explicit Memory recovery makes the selected backup the source of truth for
 *    portable project state, Phase 15C). A recovered pre-lifecycle record carries no
 *    lifecycle field and therefore reads back as `active` (see `lifecycleOf`);
 *  - machine-local bindings are NEVER added, replaced, or injected by recovered
 *    state (a recovered snapshot carries no paths and cannot create a binding), and
 *    are kept exactly as-is regardless of any lifecycle change.
 * Bindings whose Project ID is unknown after merge are retained as-is (harmless).
 */
export const mergePortableSnapshot = (
  local: LocalRegistry,
  snapshot: PortableRegistrySnapshot,
): MergeResult => {
  const projects = local.projects.map((record) => ({
    ...record,
    claims: [...record.claims],
  }));
  const conflicts: RegistryConflict[] = [];

  const claimOwner = (): Map<string, Set<string>> => {
    const owners = new Map<string, Set<string>>();
    for (const record of projects)
      for (const key of recordKeys(record)) {
        const set = owners.get(key) ?? new Set<string>();
        set.add(record.projectId);
        owners.set(key, set);
      }
    return owners;
  };

  for (const incoming of snapshot.projects) {
    const owners = claimOwner();
    const byId = projects.find((r) => r.projectId === incoming.projectId);
    // Does any incoming claim already belong to a DIFFERENT project id?
    const crossOwned = new Set<string>();
    for (const key of recordKeys(incoming))
      for (const owner of owners.get(key) ?? [])
        if (owner !== incoming.projectId) crossOwned.add(owner);

    if (crossOwned.size > 0) {
      for (const key of recordKeys(incoming)) {
        const ids = new Set<string>([incoming.projectId]);
        for (const owner of owners.get(key) ?? []) ids.add(owner);
        if (ids.size > 1)
          conflicts.push({ claimKey: key, projectIds: [...ids].sort() });
      }
      // Preserve both: add the incoming record as its own id if not present, but do
      // NOT merge its claims into the conflicting existing record. The same-id record
      // still adopts the recovered (authoritative) lifecycle.
      if (!byId) projects.push({ ...incoming, claims: [...incoming.claims] });
      else byId.lifecycle = incoming.lifecycle;
      continue;
    }

    if (byId) {
      byId.claims = dedupeClaims([...byId.claims, ...incoming.claims]);
      // Recovered lifecycle is authoritative for portable state; bindings stay local.
      byId.lifecycle = incoming.lifecycle;
    } else projects.push({ ...incoming, claims: [...incoming.claims] });
  }

  // Deduplicate reported conflicts.
  const seen = new Set<string>();
  const dedupedConflicts = conflicts.filter((c) => {
    const sig = `${c.claimKey}|${c.projectIds.join(',')}`;
    if (seen.has(sig)) return false;
    seen.add(sig);
    return true;
  });

  return {
    registry: { ...local, projects, bindings: local.bindings },
    conflicts: dedupedConflicts,
  };
};

/** Extract the portable snapshot (no bindings, no paths) from a local registry. */
export const toPortableSnapshot = (
  registry: LocalRegistry,
): PortableRegistrySnapshot => ({
  snapshotVersion: PROJECT_REGISTRY_SNAPSHOT_VERSION,
  projects: [...registry.projects]
    .map((record) => ({
      projectId: record.projectId,
      claims: [...record.claims].sort((a, b) =>
        claimKey(a) < claimKey(b) ? -1 : 1,
      ),
      // Always serialize an explicit lifecycle so a new backup records it.
      lifecycle: lifecycleOf(record),
    }))
    .sort((a, b) => (a.projectId < b.projectId ? -1 : 1)),
});

/** Set a project's lifecycle (no-op-safe); returns a new registry. */
export const setLifecycle = (
  registry: LocalRegistry,
  projectId: string,
  lifecycle: ProjectLifecycle,
): LocalRegistry => ({
  ...registry,
  projects: registry.projects.map((record) =>
    record.projectId === projectId ? { ...record, lifecycle } : record,
  ),
});

/* -------------------------------------------------------------------------- */
/* Bindings                                                                     */
/* -------------------------------------------------------------------------- */

export const bindingFor = (
  registry: LocalRegistry,
  projectId: string,
): MachineBinding | undefined =>
  registry.bindings.find((binding) => binding.projectId === projectId);

/** Add or replace a machine-local binding for a Project ID. */
export const setBinding = (
  registry: LocalRegistry,
  binding: MachineBinding,
): LocalRegistry => ({
  ...registry,
  bindings: [
    ...registry.bindings.filter((b) => b.projectId !== binding.projectId),
    binding,
  ],
});

/** A registry's name hints, defaulting a pre-existing (field-absent) registry to none. */
export const nameHintsOf = (registry: LocalRegistry): ProjectNameHint[] =>
  registry.nameHints ?? [];

export const nameHintFor = (
  registry: LocalRegistry,
  projectId: string,
): string | undefined =>
  nameHintsOf(registry).find((hint) => hint.projectId === projectId)?.name;

/** Set (or replace) a Project's discovery-time name hint. Never mutates the input. */
export const setNameHint = (
  registry: LocalRegistry,
  projectId: string,
  name: string,
): LocalRegistry => ({
  ...registry,
  nameHints: [
    ...nameHintsOf(registry).filter((hint) => hint.projectId !== projectId),
    { projectId, name },
  ],
});

/** All strong-identity conflicts currently present in a registry. */
export const registryConflicts = (
  registry: LocalRegistry,
): RegistryConflict[] => {
  const owners = new Map<string, Set<string>>();
  for (const record of registry.projects)
    for (const key of recordKeys(record)) {
      const set = owners.get(key) ?? new Set<string>();
      set.add(record.projectId);
      owners.set(key, set);
    }
  const conflicts: RegistryConflict[] = [];
  for (const [key, ids] of owners)
    if (ids.size > 1)
      conflicts.push({ claimKey: key, projectIds: [...ids].sort() });
  return conflicts;
};

export const gitClaimOf = (
  record: PortableProjectRecord,
): Extract<ProjectClaim, { type: 'git' }> | undefined =>
  record.claims.find(
    (c): c is Extract<ProjectClaim, { type: 'git' }> => c.type === 'git',
  );

export const recordFor = (
  registry: LocalRegistry,
  projectId: string,
): PortableProjectRecord | undefined =>
  registry.projects.find((record) => record.projectId === projectId);
