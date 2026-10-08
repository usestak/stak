import { createHash } from 'node:crypto';
import { mkdir, rm, access } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { enumerateSkillTree, type SkillTreeEntry } from '@stack/shared';

import { diffSkillTrees, type SkillTreeDiff } from './skill-source.js';
import { spawnGit, type GitExecutor } from './git-reference.js';

/* -------------------------------------------------------------------------- */
/* Ephemeral exact-revision materialization (P5a §1/§2 — LOCAL ONLY)           */
/* -------------------------------------------------------------------------- */

/**
 * Shallow-fetch ONE exact immutable revision's Skill subtree into a throwaway temp
 * directory, enumerate it, and clean up — never touches the content-addressed Store
 * (unlike `restoreReference`, which this intentionally does NOT reuse directly: that
 * function also ingests into the local Store, which neither side of a review diff needs).
 * Used for BOTH the approved side and the candidate side — both are independently
 * re-fetchable from the same remote by exact revision, so no Store/prior-restore
 * dependency is required. Runs with the user's own local Git auth; never executed from
 * Cloud.
 */
export const materializeExactRevision = async (options: {
  workRoot: string;
  remote: string;
  revision: string;
  skillPath: string;
  gitExecutor?: GitExecutor;
}): Promise<SkillTreeEntry[]> => {
  const git = options.gitExecutor ?? spawnGit;
  const workDir = path.join(options.workRoot, randomUUID());
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ADVICE_DETACHED_HEAD: '0',
  };
  const run = async (args: string[]) => {
    // `-c core.autocrlf=false` guarantees byte-exact content regardless of the user's global
    // Git config — this materialization feeds content hashing and before/after diff text, so
    // line endings must never be silently rewritten by a local autocrlf setting.
    const result = await git(['-c', 'core.autocrlf=false', ...args], {
      cwd: workDir,
      env,
    });
    if (result.exitCode !== 0)
      throw new Error(
        `git ${args[0]} failed for ${options.remote}@${options.revision}: ${result.stderr.trim() || `exit ${result.exitCode}`}`,
      );
    return result;
  };
  try {
    await mkdir(workDir, { recursive: true });
    await run(['init', '-q']);
    await run(['remote', 'add', 'origin', options.remote]);
    await run(['fetch', '--depth', '1', 'origin', options.revision]);
    await run(['checkout', '-q', '--detach', 'FETCH_HEAD']);

    const normalizedSkillPath = options.skillPath.split('/').join(path.sep);
    const skillDir = path.resolve(workDir, normalizedSkillPath);
    const prefix = `${workDir}${path.sep}`;
    if (skillDir !== workDir && !skillDir.startsWith(prefix))
      throw new Error(
        `Skill path escapes the repository root: ${options.skillPath}`,
      );
    try {
      await access(skillDir);
    } catch {
      throw new Error(
        `Skill path ${options.skillPath} is missing at this revision.`,
      );
    }
    return await enumerateSkillTree(skillDir);
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
};

/* -------------------------------------------------------------------------- */
/* Pure diff + bounds + binary classification (P5a §7/§8/§16)                  */
/* -------------------------------------------------------------------------- */

export type ReviewBounds = {
  maxFiles: number;
  maxTotalBytes: number;
  maxSingleFileBytes: number;
};
/** V0 bounds, frozen in the plan's Global Constraints. */
export const DEFAULT_REVIEW_BOUNDS: ReviewBounds = {
  maxFiles: 200,
  maxTotalBytes: 2 * 1024 * 1024,
  maxSingleFileBytes: 256 * 1024,
};

export type ReviewFileSide = { byteSize: number; hash: string };
export type ReviewArtifactFileRecord = {
  relativePath: string;
  kind: 'added' | 'modified' | 'removed';
  binary: boolean;
  before?: ReviewFileSide;
  after?: ReviewFileSide;
  beforeText?: string;
  afterText?: string;
};
export type ReviewArtifactFilesResult =
  | { status: 'ok'; files: ReviewArtifactFileRecord[] }
  | { status: 'exceeds-bounds' };

/** Heuristic binary classification: a NUL byte in the first 8000 bytes means binary — the
 *  same simple, well-established heuristic Git itself uses, not a MIME/extension guess. */
const isBinary = (content: Buffer): boolean =>
  content.subarray(0, 8000).includes(0);

const sideOf = (content: Buffer): ReviewFileSide => ({
  byteSize: content.length,
  hash: `sha256:${createHash('sha256').update(content).digest('hex')}`,
});

/**
 * Pure: given the two already-materialized trees, compute the bounded review-artifact file
 * list. Reuses `diffSkillTrees` (P2) for the added/modified/removed classification — never
 * reimplements tree diffing. Enforces all three V0 bounds BEFORE producing any output: if any
 * bound is exceeded, no partial/truncated artifact is ever returned (contract §5a/§16).
 */
export const buildReviewArtifactFiles = (
  approved: SkillTreeEntry[],
  candidate: SkillTreeEntry[],
  bounds: ReviewBounds,
): ReviewArtifactFilesResult => {
  const diff: SkillTreeDiff = diffSkillTrees(approved, candidate);
  if (diff.files.length > bounds.maxFiles) return { status: 'exceeds-bounds' };

  // Both files AND symlinks are included here — a symlink's "content" for review-artifact
  // purposes is its target string's bytes. Excluding symlinks would leave a changed/added/
  // removed symlink in `diff.files` (which diffs ALL entry types) with no before/after/content
  // at all, a near-content-free record for what could be a meaningful change.
  type EntryContent = { content: Buffer; isSymlink: boolean };
  const entryContent = (e: SkillTreeEntry): EntryContent =>
    e.type === 'file'
      ? { content: e.content, isSymlink: false }
      : { content: Buffer.from(e.target, 'utf8'), isSymlink: true };
  const approvedByPath = new Map(
    approved.map((e) => [e.relativePath, entryContent(e)]),
  );
  const candidateByPath = new Map(
    candidate.map((e) => [e.relativePath, entryContent(e)]),
  );

  let totalBytes = 0;
  const files: ReviewArtifactFileRecord[] = [];
  for (const change of diff.files) {
    const before = approvedByPath.get(change.relativePath);
    const after = candidateByPath.get(change.relativePath);
    const relevantSides = [before, after].filter(
      (s): s is EntryContent => s !== undefined,
    );
    for (const s of relevantSides)
      if (s.content.length > bounds.maxSingleFileBytes)
        return { status: 'exceeds-bounds' };
    totalBytes += relevantSides.reduce((sum, s) => sum + s.content.length, 0);
    if (totalBytes > bounds.maxTotalBytes) return { status: 'exceeds-bounds' };

    // A symlink on either side forces a binary classification: a symlink's target string is
    // not meaningful prose to diff as a text change, and this correctly suppresses any
    // beforeText/afterText attempt (including for a file<->symlink type change at the same
    // path, which is also a mixed-type change).
    const binary =
      relevantSides.some((s) => s.isSymlink) ||
      relevantSides.some((s) => isBinary(s.content));
    const record: ReviewArtifactFileRecord = {
      relativePath: change.relativePath,
      kind: change.kind,
      binary,
      ...(before
        ? {
            before: sideOf(before.content),
            ...(binary ? {} : { beforeText: before.content.toString('utf8') }),
          }
        : {}),
      ...(after
        ? {
            after: sideOf(after.content),
            ...(binary ? {} : { afterText: after.content.toString('utf8') }),
          }
        : {}),
    };
    files.push(record);
  }
  return { status: 'ok', files };
};
