import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { snapshotRecordSchema } from '@stack/spec';
import type {
  BaselineLocation,
  DiscoveredSkill,
  EnvironmentLock,
  EnvironmentManifest,
  MachineEnvironmentBaseline,
  ScanResult,
  SnapshotRecord,
} from '@stack/spec';
import { ingestSkill } from '@stack/store';
import type { IngestSkillOptions, IngestSkillResult } from '@stack/store';

import { sourceEvidence } from './initialize.js';
import { selectRestorationStrategy } from './restoration.js';
import { persistMainState, withMainMutationLock } from './composition.js';
import { loadMainEnvironment } from './state.js';
import type { LoadedEnvironmentState } from './state.js';
import { statusMainEnvironment } from './status.js';

export type SkillAddTarget = {
  kind: 'new' | 'modified';
  name: string;
  contentHash: string;
  /** Present only when kind === 'modified': the existing, stable entryId being updated. */
  entryId?: string;
  sourcePath: string;
  globalLocations: BaselineLocation[];
};

export type SkillAddIssue =
  | { status: 'not-found'; selector: string }
  | { status: 'ambiguous'; selector: string; candidates: string[] }
  | { status: 'invalid'; selector: string }
  | { status: 'stack-origin'; selector: string; name: string }
  | { status: 'already-satisfied'; selector: string; name: string }
  | { status: 'missing'; selector: string; name: string }
  /** Tracked in main but never installed on this machine (e.g. right after `stak pull`). */
  | { status: 'not-installed'; selector: string; name: string };

export type PrepareSkillAddOptions = {
  stackHome: string;
  scanResult: ScanResult;
  /** A list of Skill name selectors, or `'.'` to stage every eligible untracked/modified Skill. */
  selectors: string[] | '.';
  now?: () => Date;
  idFactory?: () => string;
};

export type SkillAddProposal = {
  stackHome: string;
  current: LoadedEnvironmentState;
  manifest: EnvironmentManifest;
  lock: EnvironmentLock;
  baseline: MachineEnvironmentBaseline;
  targets: SkillAddTarget[];
  issues: SkillAddIssue[];
  snapshotRecords: SnapshotRecord[];
  ingestions: Array<{ sourcePath: string; expectedContentHash: string }>;
};

const validDiscovered = (
  scanResult: ScanResult,
): Array<DiscoveredSkill & { metadata: NonNullable<DiscoveredSkill['metadata']> }> =>
  scanResult.skills.filter(
    (skill): skill is DiscoveredSkill & { metadata: NonNullable<DiscoveredSkill['metadata']> } =>
      skill.valid &&
      skill.metadata !== undefined &&
      skill.locations.some((location) => location.scope === 'global'),
  );

const globalLocationsOf = (skill: DiscoveredSkill): BaselineLocation[] =>
  skill.locations
    .filter((location) => location.scope === 'global')
    .map((location) => ({ ...location, contentHash: skill.contentHash }));

const sourcePathOf = (skill: DiscoveredSkill): string => {
  const locations = globalLocationsOf(skill).sort((left, right) =>
    left.path.localeCompare(right.path),
  );
  const first = locations[0];
  if (!first)
    throw new Error(`No global source location exists for ${skill.contentHash}.`);
  return first.realPath ?? first.path;
};

/**
 * Resolve one `stak add <selector>` name against the current main state and a live scan,
 * reusing `statusMainEnvironment`'s classification so `add` always agrees with what `status`
 * just reported. Never mutates anything.
 */
const resolveSelector = (
  current: LoadedEnvironmentState,
  status: Awaited<ReturnType<typeof statusMainEnvironment>>,
  scanResult: ScanResult,
  selector: string,
): { status: 'ok'; target: SkillAddTarget } | SkillAddIssue => {
  const untrackedMatches = status.untracked.filter(
    (item) => item.name === selector,
  );
  // A name already tracked in main takes priority over a same-named untracked match —
  // otherwise a changed-in-place direct Skill, or a name that collides with an active
  // STAK layer's requirement, would be silently treated as a brand-new entry instead of
  // being routed through the modified/missing/stack-origin checks below.
  const lockedEntry = Object.entries(current.lock.skills).find(
    ([, locked]) => locked.name === selector,
  );
  // A name that is simultaneously tracked in main AND matched by untracked, differently
  // hashed content is a genuine collision (the same declared name pointing at two distinct
  // Skills) — fail closed and show both rather than silently preferring one.
  if (lockedEntry && untrackedMatches.length > 0) {
    const [, locked] = lockedEntry;
    return {
      status: 'ambiguous',
      selector,
      candidates: [
        `${locked.contentHash} (tracked in main)`,
        ...untrackedMatches.map(
          (item) => `${item.contentHash} (${item.locations.map((l) => l.path).join(', ')})`,
        ),
      ],
    };
  }
  if (!lockedEntry) {
    if (untrackedMatches.length > 1) {
      const distinctHashes = new Set(untrackedMatches.map((item) => item.contentHash));
      if (distinctHashes.size > 1)
        return {
          status: 'ambiguous',
          selector,
          candidates: untrackedMatches.map(
            (item) => `${item.contentHash} (${item.locations.map((l) => l.path).join(', ')})`,
          ),
        };
    }
    const untracked = untrackedMatches[0];
    if (untracked) {
      const discovered = validDiscovered(scanResult).find(
        (skill) => skill.contentHash === untracked.contentHash,
      );
      if (!discovered)
        throw new Error(`Untracked Skill ${selector} missing from scan result.`);
      return {
        status: 'ok',
        target: {
          kind: 'new',
          name: discovered.metadata.name,
          contentHash: discovered.contentHash,
          sourcePath: sourcePathOf(discovered),
          globalLocations: globalLocationsOf(discovered),
        },
      };
    }
  }
  if (lockedEntry) {
    const [entryId, locked] = lockedEntry;
    const skillStatus = status.skills.find((item) => item.entryId === entryId);
    if (!skillStatus || skillStatus.state === 'satisfied')
      return { status: 'already-satisfied', selector, name: selector };
    if (skillStatus.state === 'not-installed')
      return { status: 'not-installed', selector, name: selector };
    if (skillStatus.state !== 'modified' || !skillStatus.currentHash)
      return { status: 'missing', selector, name: selector };
    const isDirectOnly =
      locked.origins === undefined ||
      locked.origins.some((origin) => origin.type === 'direct');
    if (!isDirectOnly)
      return { status: 'stack-origin', selector, name: selector };
    const discovered = validDiscovered(scanResult).find(
      (skill) => skill.contentHash === skillStatus.currentHash,
    );
    if (!discovered)
      throw new Error(`Modified Skill ${selector} missing from scan result.`);
    return {
      status: 'ok',
      target: {
        kind: 'modified',
        name: locked.name,
        contentHash: discovered.contentHash,
        entryId,
        sourcePath: sourcePathOf(discovered),
        globalLocations: globalLocationsOf(discovered),
      },
    };
  }

  // An invalid Skill's frontmatter may be too broken to recover a display name, so also
  // match by the discovered directory's own basename (what the user actually typed).
  const invalid = status.invalidSkills.find(
    (item) =>
      item.name === selector ||
      item.locations.some((location) => path.basename(location.path) === selector),
  );
  if (invalid) return { status: 'invalid', selector };

  return { status: 'not-found', selector };
};

export const prepareSkillAdd = async (
  options: PrepareSkillAddOptions,
): Promise<SkillAddProposal> => {
  const current = await loadMainEnvironment({ stackHome: options.stackHome });
  const status = await statusMainEnvironment({
    stackHome: options.stackHome,
    scanResult: options.scanResult,
  });

  const selectors =
    options.selectors === '.'
      ? [
          ...status.untracked.map((item) => item.name),
          ...status.skills
            .filter((item) => item.state === 'modified')
            .map((item) => item.name),
        ]
      : options.selectors;

  const targets: SkillAddTarget[] = [];
  const issues: SkillAddIssue[] = [];
  const seenNames = new Set<string>();
  for (const selector of selectors) {
    if (seenNames.has(selector)) continue;
    seenNames.add(selector);
    const resolved = resolveSelector(current, status, options.scanResult, selector);
    if (resolved.status === 'ok') {
      // `add .` silently skips Skills it cannot stage for structural reasons (e.g. a
      // modified Skill whose only origin is an active STAK layer); an explicit
      // single-selector `add <skill>` surfaces the same case as an issue instead.
      targets.push(resolved.target);
    } else if (
      options.selectors === '.' &&
      (resolved.status === 'stack-origin' || resolved.status === 'already-satisfied')
    ) {
      continue;
    } else {
      issues.push(resolved);
    }
  }

  const idFactory = options.idFactory ?? randomUUID;
  const manifest: EnvironmentManifest = {
    ...current.manifest,
    skills: [...current.manifest.skills],
  };
  const lock: EnvironmentLock = {
    ...current.lock,
    skills: { ...current.lock.skills },
  };
  const baseline: MachineEnvironmentBaseline = {
    ...current.baseline,
    skills: { ...current.baseline.skills },
  };
  const snapshotRecords: SnapshotRecord[] = [];
  const ingestions: Array<{ sourcePath: string; expectedContentHash: string }> = [];
  const now = (options.now ?? (() => new Date()))().toISOString();

  for (const target of targets) {
    const entryId = target.entryId ?? `skill_${idFactory()}`;
    const discovered = validDiscovered(options.scanResult).find(
      (skill) => skill.contentHash === target.contentHash,
    );
    if (!discovered)
      throw new Error(`Discovered Skill missing for ${target.name}.`);
    const evidence = sourceEvidence(
      target.globalLocations.map((location) => location.source),
    );
    const snapshotId = `snap_${entryId.slice('skill_'.length)}`;
    const restoration = selectRestorationStrategy({
      contentHash: target.contentHash,
      sources: target.globalLocations.map((location) => location.source),
      snapshotId,
    });
    if (restoration.strategy === 'snapshot')
      snapshotRecords.push(
        snapshotRecordSchema.parse({
          schemaVersion: 1,
          snapshotId,
          environmentEntryId: entryId,
          contentHash: target.contentHash,
          createdAt: now,
          reason: restoration.reason,
        }),
      );
    if (target.kind === 'new')
      manifest.skills.push({ id: entryId, name: target.name, requirement: 'required' });
    lock.skills[entryId] = {
      name: discovered.metadata.name,
      description: discovered.metadata.description,
      contentHash: target.contentHash,
      metadata: {
        name: discovered.metadata.name,
        description: discovered.metadata.description,
      },
      localContent: { available: true, contentHash: target.contentHash },
      restoration,
      origins: [{ type: 'direct', entryId }],
      ...evidence,
    };
    baseline.skills[entryId] = {
      contentHash: target.contentHash,
      locations: target.globalLocations,
    };
    ingestions.push({
      sourcePath: target.sourcePath,
      expectedContentHash: target.contentHash,
    });
    target.entryId = entryId;
  }

  return {
    stackHome: options.stackHome,
    current,
    manifest,
    lock,
    baseline,
    targets,
    issues,
    snapshotRecords,
    ingestions,
  };
};

const writeSnapshotRecordIfAbsent = async (
  stackHome: string,
  record: SnapshotRecord,
): Promise<void> => {
  const directory = path.join(stackHome, 'snapshots');
  const final = path.join(directory, `${record.snapshotId}.json`);
  const staging = path.join(directory, `.${record.snapshotId}.${randomUUID()}.tmp`);
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(staging, `${JSON.stringify(record, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return;
    throw error;
  }
  try {
    await rename(staging, final);
  } catch (error) {
    await rm(staging, { force: true }).catch(() => undefined);
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return;
    throw error;
  }
};

export type ApplySkillAddOptions = {
  now?: () => Date;
  ingest?(options: IngestSkillOptions): Promise<IngestSkillResult>;
};

export const applySkillAdd = async (
  proposal: SkillAddProposal,
  options: ApplySkillAddOptions = {},
): Promise<SkillAddProposal> => {
  if (proposal.targets.length === 0) return proposal;
  await withMainMutationLock(proposal.stackHome, proposal.current, async () => {
    const ingest = options.ingest ?? ingestSkill;
    for (const job of proposal.ingestions)
      await ingest({
        stackHome: proposal.stackHome,
        sourcePath: job.sourcePath,
        expectedContentHash: job.expectedContentHash,
        ...(options.now ? { now: options.now } : {}),
      });
    for (const record of proposal.snapshotRecords)
      await writeSnapshotRecordIfAbsent(proposal.stackHome, record);
    await persistMainState(proposal.stackHome, {
      manifest: proposal.manifest,
      lock: proposal.lock,
      baseline: proposal.baseline,
    });
  });
  return proposal;
};
