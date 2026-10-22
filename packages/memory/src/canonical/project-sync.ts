import { readMemoryObject, writeMemoryObject } from '../store.js';
import {
  nativeRootsExist,
  scanClaudeProject,
  writeClaudeProject,
  type BoundProject,
  type MaterializeOp,
  type ScanResult,
} from './claude-project-adapter.js';
import { projectMemoryOf, type CanonicalDoc, type CanonicalMainManifest } from './domain.js';
import { namespaceOf } from './paths.js';
import { planSync, type SyncAction, type NativeEntry } from './sync.js';
import { readCanonicalMain, readProjection, writeCanonicalMain, writeProjection } from './store.js';

export type ScanOptionsForAdapter = Parameters<typeof scanClaudeProject>[1];

export type ProjectSyncPlan = {
  actions: SyncAction[];
  sourceConflicts: { canonicalPath: string }[];
  guardedPaths: string[];
};

export const planProjectSync = async (
  project: BoundProject,
  stackHome: string,
  scanOptions: ScanOptionsForAdapter,
): Promise<ProjectSyncPlan> => {
  const claudeHome = (scanOptions as { claudeHome?: string }).claudeHome;
  const roots = await nativeRootsExist(project, claudeHome);
  if (!roots.projectDirExists) return { actions: [], sourceConflicts: [], guardedPaths: [] };

  const scanResult = await scanClaudeProject(project, scanOptions);
  const main = await readCanonicalMain(stackHome);
  const canonicalDocs = projectMemoryOf(main, project.projectId)?.documents ?? [];
  const projectionFile = await readProjection(stackHome, 'claude');
  const projection = projectionFile.projects[project.projectId] ?? {};

  const guardedPaths = roots.notesRootExists
    ? []
    : Object.keys(projection).filter((p) => namespaceOf(p) === 'notes');
  const effectiveProjection =
    guardedPaths.length === 0
      ? projection
      : Object.fromEntries(Object.entries(projection).filter(([p]) => !guardedPaths.includes(p)));

  const native: NativeEntry[] = scanResult.docs.map((d) => ({ path: d.canonicalPath, contentHash: d.contentHash }));
  const actions = planSync({ native, projection: effectiveProjection, canonical: canonicalDocs });
  return { actions, sourceConflicts: scanResult.sourceConflicts, guardedPaths };
};

const upsertDoc = (documents: CanonicalDoc[], doc: CanonicalDoc): CanonicalDoc[] => {
  const index = documents.findIndex((d) => d.path === doc.path);
  if (index === -1) return [...documents, doc];
  const next = [...documents];
  next[index] = doc;
  return next;
};

const withProjectDocuments = (
  main: CanonicalMainManifest,
  projectId: string,
  documents: CanonicalDoc[],
): CanonicalMainManifest => {
  const index = main.projects.findIndex((p) => p.projectId === projectId);
  if (index === -1) return { ...main, projects: [...main.projects, { projectId, documents }] };
  return { ...main, projects: main.projects.map((p, i) => (i === index ? { ...p, documents } : p)) };
};

/** Apply only the import-* actions from a plan (native -> canonical). Leaves
 * materialize- and conflict actions untouched — those are the other command's job. */
export const applyImportActions = async (
  project: BoundProject,
  stackHome: string,
  scanResult: ScanResult,
  actions: SyncAction[],
): Promise<{ imported: string[] }> => {
  const bytesByPath = new Map(scanResult.docs.map((d) => [d.canonicalPath, d.bytes]));
  const main = await readCanonicalMain(stackHome);
  let documents = projectMemoryOf(main, project.projectId)?.documents ?? [];
  const projectionFile = await readProjection(stackHome, 'claude');
  const projection = { ...(projectionFile.projects[project.projectId] ?? {}) };
  const imported: string[] = [];
  const now = new Date().toISOString();

  for (const action of actions) {
    if (action.kind === 'import-edit') {
      const bytes = bytesByPath.get(action.path);
      if (!bytes) continue;
      await writeMemoryObject({ stackHome, contentHash: action.contentHash, bytes });
      documents = upsertDoc(documents, {
        path: action.path,
        state: 'present',
        contentHash: action.contentHash,
        importedFrom: 'claude',
        importedAt: now,
      });
      projection[action.path] = action.contentHash;
      imported.push(action.path);
    } else if (action.kind === 'import-delete') {
      const lastContentHash = projection[action.path];
      if (lastContentHash === undefined) continue; // defensive; planSync never emits this without a known P
      documents = upsertDoc(documents, { path: action.path, state: 'deleted', lastContentHash, deletedAt: now });
      delete projection[action.path];
      imported.push(action.path);
    } else if (action.kind === 'already-synced') {
      projection[action.path] = action.contentHash;
    }
  }

  await writeCanonicalMain(stackHome, withProjectDocuments(main, project.projectId, documents));
  await writeProjection(stackHome, 'claude', {
    schemaVersion: 1,
    projects: { ...projectionFile.projects, [project.projectId]: projection },
  });
  return { imported };
};

/** Apply only the materialize-* actions from a plan (canonical -> native). */
export const applyMaterializeActions = async (
  project: BoundProject,
  stackHome: string,
  actions: SyncAction[],
  claudeHome?: string,
): Promise<{ written: string[]; deleted: string[] }> => {
  const projectionFile = await readProjection(stackHome, 'claude');
  const projection = { ...(projectionFile.projects[project.projectId] ?? {}) };
  const ops: MaterializeOp[] = [];
  for (const action of actions) {
    if (action.kind === 'materialize-write') {
      const bytes = await readMemoryObject({ stackHome, contentHash: action.contentHash });
      ops.push({ kind: 'write', canonicalPath: action.path, bytes });
      projection[action.path] = action.contentHash;
    } else if (action.kind === 'materialize-delete') {
      ops.push({ kind: 'delete', canonicalPath: action.path });
      delete projection[action.path];
    } else if (action.kind === 'already-synced') {
      projection[action.path] = action.contentHash;
    }
  }
  const result = claudeHome
    ? await writeClaudeProject(project, ops, claudeHome)
    : await writeClaudeProject(project, ops);
  await writeProjection(stackHome, 'claude', {
    schemaVersion: 1,
    projects: { ...projectionFile.projects, [project.projectId]: projection },
  });
  return result;
};
