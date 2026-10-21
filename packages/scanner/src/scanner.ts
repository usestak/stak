import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import { scanResultSchema } from '@stack/spec';
import type {
  DiscoveredSkill,
  NameCollision,
  ScanDiagnostic,
  ScanResult,
  ScannedRoot,
  SkillLocation,
  SkillRoot,
  SkillSource,
} from '@stack/spec';

import { parseSkillFile } from './frontmatter.js';
import { hashSkillDirectory } from './hash.js';
import { detectProvenance } from './provenance.js';
import { isReservedRootSubtree } from './roots.js';

const maxDepth = 32;
const sourceRank: Record<SkillSource['type'], number> = {
  unknown: 0,
  local: 1,
  git: 2,
};
export type ScanSkillsOptions = { roots: SkillRoot[] };

/**
 * Hashing a Skill's content and detecting its Git provenance are the two
 * expensive steps of inspecting an occurrence (full-tree read+hash, and a
 * `git` subprocess spawn). Symlinked duplicates resolve to the same physical
 * `contentPath`, so this cache makes sure that work runs once per unique
 * physical directory within a scan, not once per discovered location.
 */
type ContentInspection = {
  parsed: ReturnType<typeof parseSkillFile>;
  hashed: { hash: string; nestedSymlinks: string[] };
  source: SkillSource;
};

const inspectContent = (
  contentPath: string,
  cache: Map<string, Promise<ContentInspection>>,
  provenanceCache: Map<string, boolean>,
): Promise<ContentInspection> => {
  const cached = cache.get(contentPath);
  if (cached) return cached;
  const computed = (async (): Promise<ContentInspection> => {
    const parsed = parseSkillFile(
      await readFile(path.join(contentPath, 'SKILL.md'), 'utf8'),
    );
    const hashed = await hashSkillDirectory(contentPath);
    const source = await detectProvenance(contentPath, provenanceCache);
    return { parsed, hashed, source };
  })();
  cache.set(contentPath, computed);
  return computed;
};

/**
 * Runs `fn` over `items` with at most `limit` in flight at once, returning
 * results in input order. Occurrence inspection is I/O- and subprocess-bound
 * (file reads, `git` spawns), so overlapping them cuts wall-clock scan time
 * without changing what gets computed.
 */
const mapWithConcurrency = async <T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> => {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
};

const discoverPaths = async (
  root: SkillRoot,
  diagnostics: ScanDiagnostic[],
) => {
  const found: Array<{ path: string; realPath?: string }> = [];
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > maxDepth) {
      diagnostics.push({
        severity: 'warning',
        code: 'max-depth-reached',
        message: `Stopped after ${maxDepth} directory levels`,
        path: directory,
      });
      return;
    }
    const stats = await lstat(directory);
    if (stats.isSymbolicLink()) {
      const resolved = await realpath(directory);
      if (!(await stat(resolved)).isDirectory()) return;
      if ((await readdir(resolved)).includes('SKILL.md'))
        found.push({ path: directory, realPath: resolved });
      else
        diagnostics.push({
          severity: 'warning',
          code: 'organizational-symlink-skipped',
          message:
            'Skipped directory symlink that does not directly expose a Skill',
          path: directory,
        });
      return;
    }
    if (!stats.isDirectory()) return;
    const entries = await readdir(directory, { withFileTypes: true });
    if (entries.some((entry) => entry.name === 'SKILL.md' && entry.isFile())) {
      found.push({ path: directory });
      return;
    }
    for (const entry of entries.sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      if (depth === 0 && isReservedRootSubtree(root.rootKind, entry.name))
        continue;
      if (
        entry.name !== '.git' &&
        (entry.isDirectory() || entry.isSymbolicLink())
      )
        await visit(path.join(directory, entry.name), depth + 1);
    }
  };
  await visit(root.path, 0);
  return found;
};

const inspectOccurrence = async (
  root: SkillRoot,
  visiblePath: string,
  resolvedPath: string | undefined,
  contentCache: Map<string, Promise<ContentInspection>>,
  provenanceCache: Map<string, boolean>,
) => {
  const contentPath = resolvedPath ?? visiblePath;
  const diagnostics: ScanDiagnostic[] = [];
  const { parsed, hashed, source } = await inspectContent(
    contentPath,
    contentCache,
    provenanceCache,
  );
  const location: SkillLocation = {
    path: visiblePath,
    rootPath: root.path,
    rootKind: root.rootKind,
    scope: root.scope,
    isSymlink: resolvedPath !== undefined,
    ...(resolvedPath ? { realPath: resolvedPath } : {}),
    source,
  };
  for (const nestedPath of hashed.nestedSymlinks) {
    diagnostics.push({
      severity: 'warning',
      code: 'nested-symlink-not-followed',
      message: 'Nested symlink was hashed as link metadata and not followed',
      path: path.join(visiblePath, nestedPath),
    });
  }
  if ('error' in parsed)
    diagnostics.push({
      severity: 'error',
      code: 'invalid-skill-metadata',
      message: parsed.error,
      path: path.join(visiblePath, 'SKILL.md'),
    });
  else if (parsed.metadata.name !== path.basename(visiblePath))
    diagnostics.push({
      severity: 'warning',
      code: 'skill-name-mismatch',
      message: `Declared name '${parsed.metadata.name}' differs from directory '${path.basename(visiblePath)}'`,
      path: visiblePath,
    });
  const skill: DiscoveredSkill = {
    contentHash: hashed.hash,
    ...('metadata' in parsed ? { metadata: parsed.metadata } : {}),
    valid: 'metadata' in parsed,
    source,
    locations: [location],
  };
  return { skill, diagnostics };
};

const summarize = (
  roots: ScannedRoot[],
  skills: DiscoveredSkill[],
  collisions: NameCollision[],
  diagnostics: ScanDiagnostic[],
): ScanResult['summary'] => ({
  roots: {
    scanned: roots.filter((root) => root.status === 'scanned').length,
    missing: roots.filter((root) => root.status === 'missing').length,
    failed: roots.filter((root) => root.status === 'failed').length,
  },
  uniqueSkillContents: skills.length,
  locations: skills.reduce((count, skill) => count + skill.locations.length, 0),
  validSkills: skills.filter((skill) => skill.valid).length,
  invalidSkills: skills.filter((skill) => !skill.valid).length,
  exactDuplicateContents: skills.filter((skill) => skill.locations.length > 1)
    .length,
  nameCollisions: collisions.length,
  diagnostics: {
    errors: diagnostics.filter((item) => item.severity === 'error').length,
    warnings: diagnostics.filter((item) => item.severity === 'warning').length,
    info: diagnostics.filter((item) => item.severity === 'info').length,
  },
  provenance: {
    git: skills.filter((skill) => skill.source.type === 'git').length,
    local: skills.filter((skill) => skill.source.type === 'local').length,
    unknown: skills.filter((skill) => skill.source.type === 'unknown').length,
  },
});

const occurrenceConcurrency = 8;

export const scanSkills = async ({
  roots,
}: ScanSkillsOptions): Promise<ScanResult> => {
  const scannedRoots: ScannedRoot[] = [];
  const diagnostics: ScanDiagnostic[] = [];
  const byHash = new Map<string, DiscoveredSkill>();
  const contentCache = new Map<string, Promise<ContentInspection>>();
  // Shared across the whole scan, not per content path: Skill locations commonly share long
  // ancestor chains (a global root, home, …), so this avoids re-`stat`-ing the same directory
  // for `.git` once per distinct physical Skill location that happens to live under it.
  const provenanceCache = new Map<string, boolean>();
  const pending: Array<{
    root: SkillRoot;
    path: string;
    realPath?: string;
  }> = [];
  for (const root of roots) {
    try {
      const rootStats = await lstat(root.path);
      if (!rootStats.isDirectory() && !rootStats.isSymbolicLink())
        throw new Error('Root is not a directory');
      const paths = await discoverPaths(root, diagnostics);
      scannedRoots.push({
        ...root,
        status: 'scanned',
        skillLocations: paths.length,
      });
      for (const skillPath of paths) pending.push({ root, ...skillPath });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        scannedRoots.push({ ...root, status: 'missing', skillLocations: 0 });
      else {
        const message = error instanceof Error ? error.message : String(error);
        scannedRoots.push({
          ...root,
          status: 'failed',
          skillLocations: 0,
          error: message,
        });
        diagnostics.push({
          severity: 'error',
          code: 'root-scan-failed',
          message,
          path: root.path,
        });
      }
    }
  }
  const outcomes = await mapWithConcurrency(
    pending,
    occurrenceConcurrency,
    async (skillPath) => {
      try {
        return {
          occurrence: await inspectOccurrence(
            skillPath.root,
            skillPath.path,
            skillPath.realPath,
            contentCache,
            provenanceCache,
          ),
        };
      } catch (error) {
        return {
          error: {
            severity: 'error' as const,
            code: 'skill-scan-failed' as const,
            message: error instanceof Error ? error.message : String(error),
            path: skillPath.path,
          },
        };
      }
    },
  );
  for (const outcome of outcomes) {
    if ('error' in outcome) {
      diagnostics.push(outcome.error);
      continue;
    }
    diagnostics.push(...outcome.occurrence.diagnostics);
    const existing = byHash.get(outcome.occurrence.skill.contentHash);
    if (existing) {
      existing.locations.push(...outcome.occurrence.skill.locations);
      if (
        sourceRank[outcome.occurrence.skill.source.type] >
        sourceRank[existing.source.type]
      )
        existing.source = outcome.occurrence.skill.source;
    } else
      byHash.set(
        outcome.occurrence.skill.contentHash,
        outcome.occurrence.skill,
      );
  }
  const skills = [...byHash.values()].sort((a, b) =>
    a.contentHash < b.contentHash ? -1 : a.contentHash > b.contentHash ? 1 : 0,
  );
  const hashesByName = new Map<string, Set<string>>();
  for (const skill of skills) {
    if (!skill.metadata) continue;
    const hashes = hashesByName.get(skill.metadata.name) ?? new Set<string>();
    hashes.add(skill.contentHash);
    hashesByName.set(skill.metadata.name, hashes);
  }
  const nameCollisions = [...hashesByName]
    .filter(([, hashes]) => hashes.size > 1)
    .map(([name, hashes]) => ({ name, contentHashes: [...hashes].sort() }));
  for (const collision of nameCollisions)
    diagnostics.push({
      severity: 'warning',
      code: 'skill-name-collision',
      message: `Declared name '${collision.name}' has ${collision.contentHashes.length} different content hashes`,
    });
  return scanResultSchema.parse({
    roots: scannedRoots,
    skills,
    nameCollisions,
    diagnostics,
    summary: summarize(scannedRoots, skills, nameCollisions, diagnostics),
  });
};
