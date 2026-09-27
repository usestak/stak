import { readFile } from 'node:fs/promises';

import { assertPathWithin } from '@stack/shared';

import type { ProjectIdentity } from '../domain.js';
import { readMemoryManifest, memoryStorePaths } from '../store.js';
import { atomicWriteFile } from '../remote/secure-file.js';
import {
  emptyRegistry,
  localRegistrySchema,
  mergePortableSnapshot,
  portableRegistrySnapshotSchema,
  resolveOrMintProject,
  toPortableSnapshot,
  type LocalRegistry,
  type PortableRegistrySnapshot,
  type RegistryConflict,
} from './registry.js';

export class RegistryStoreError extends Error {
  constructor(
    public readonly code: 'registry-corrupt' | 'snapshot-corrupt',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'RegistryStoreError';
  }
}

const canonicalJson = (value: unknown): Buffer =>
  Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');

/** Load the machine-local registry, or an empty one when none exists. */
export const readLocalRegistry = async (
  stackHome: string,
): Promise<LocalRegistry> => {
  const file = memoryStorePaths(stackHome).localProjectRegistry;
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return emptyRegistry();
    throw error;
  }
  try {
    return localRegistrySchema.parse(JSON.parse(raw));
  } catch (error) {
    throw new RegistryStoreError(
      'registry-corrupt',
      'The local project registry is malformed.',
      { cause: error },
    );
  }
};

/** Persist the machine-local registry atomically, fenced to the memory store. */
export const writeLocalRegistry = async (
  stackHome: string,
  registry: LocalRegistry,
): Promise<void> => {
  const paths = memoryStorePaths(stackHome);
  await assertPathWithin({
    ownedRoot: paths.root,
    proposedPath: paths.localProjectRegistry,
  });
  await atomicWriteFile(
    paths.localProjectRegistry,
    canonicalJson(localRegistrySchema.parse(registry)),
  );
};

/** Read the portable snapshot embedded in the store (null when absent). */
export const readPortableSnapshot = async (
  stackHome: string,
): Promise<PortableRegistrySnapshot | null> => {
  const file = memoryStorePaths(stackHome).projectRegistrySnapshot;
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    return portableRegistrySnapshotSchema.parse(JSON.parse(raw));
  } catch (error) {
    throw new RegistryStoreError(
      'snapshot-corrupt',
      'The portable project-registry snapshot is malformed.',
      { cause: error },
    );
  }
};

/** Write the portable snapshot to the store (captured by the next bundle). */
export const writePortableSnapshot = async (
  stackHome: string,
  snapshot: PortableRegistrySnapshot,
): Promise<void> => {
  const paths = memoryStorePaths(stackHome);
  await assertPathWithin({
    ownedRoot: paths.manifests,
    proposedPath: paths.projectRegistrySnapshot,
  });
  await atomicWriteFile(
    paths.projectRegistrySnapshot,
    canonicalJson(portableRegistrySnapshotSchema.parse(snapshot)),
  );
};

/** Distinct project identities referenced by the current manifest. */
const manifestProjectIdentities = async (
  stackHome: string,
): Promise<ProjectIdentity[]> => {
  const manifest = await readMemoryManifest(stackHome);
  const out: ProjectIdentity[] = [];
  const seen = new Set<string>();
  for (const item of manifest?.items ?? []) {
    if (item.scope !== 'project' || !item.project) continue;
    const key =
      item.project.kind === 'git'
        ? `git:${item.project.canonical.toLowerCase()}`
        : `local:${item.project.vendorKey ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item.project);
  }
  return out;
};

/**
 * Backup-time registry sync. Resolves/mints a stable Project ID for every project
 * identity in the current manifest (including legacy `local:` identities whose
 * directories may no longer exist — lazy migration), persists the machine-local
 * registry, and writes the PORTABLE snapshot the bundle will carry. Never records a
 * filesystem path in the snapshot.
 */
export const syncRegistryForBackup = async (options: {
  stackHome: string;
  mint?: () => string;
}): Promise<{ registry: LocalRegistry; minted: number }> => {
  let registry = await readLocalRegistry(options.stackHome);
  let minted = 0;
  for (const identity of await manifestProjectIdentities(options.stackHome)) {
    const result = resolveOrMintProject(registry, identity, options.mint);
    registry = result.registry;
    if (result.minted) minted += 1;
  }
  await writeLocalRegistry(options.stackHome, registry);
  await writePortableSnapshot(options.stackHome, toPortableSnapshot(registry));
  return { registry, minted };
};

/**
 * Recover-time registry reconciliation. If the recovered bundle carried a portable
 * snapshot, merge it into the local registry (preserving Project IDs, detecting
 * strong-identity conflicts, never creating a binding). Otherwise fall back to lazy
 * migration: mint Project IDs from the recovered manifest's identities. Recovered
 * state can never inject a filesystem path binding.
 */
export const reconcileRegistryAfterRecover = async (options: {
  stackHome: string;
  mint?: () => string;
}): Promise<{ registry: LocalRegistry; conflicts: RegistryConflict[] }> => {
  const snapshot = await readPortableSnapshot(options.stackHome);
  if (!snapshot) {
    const { registry } = await syncRegistryForBackup({
      stackHome: options.stackHome,
      ...(options.mint ? { mint: options.mint } : {}),
    });
    return { registry, conflicts: [] };
  }
  const local = await readLocalRegistry(options.stackHome);
  const merged = mergePortableSnapshot(local, snapshot);
  await writeLocalRegistry(options.stackHome, merged.registry);
  return { registry: merged.registry, conflicts: merged.conflicts };
};
