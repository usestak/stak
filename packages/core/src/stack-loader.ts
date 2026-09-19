import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { parse as parseYaml } from 'yaml';

import { detectProvenance, parseSkillFile } from '@stack/scanner';
import { hashSkillDirectory } from '@stack/shared';
import { importedStackVersionSchema, stackManifestSchema } from '@stack/spec';
import type {
  ImportedStackVersion,
  SkillSource,
  StackSkillRequirement,
} from '@stack/spec';

import { selectRestorationStrategy } from './restoration.js';

export class StackCompositionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'StackCompositionError';
  }
}
export class StackCycleError extends StackCompositionError {
  constructor(chain: string[]) {
    super('stack-cycle', `Stack extends cycle: ${chain.join(' -> ')}`);
    this.name = 'StackCycleError';
  }
}

const stable = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
};
const digest = (value: unknown) =>
  `sha256:${createHash('sha256').update(stable(value)).digest('hex')}`;
const portableSource = (source: SkillSource): SkillSource => {
  if (
    source.type !== 'git' ||
    !source.remote ||
    (!path.win32.isAbsolute(source.remote) &&
      !path.posix.isAbsolute(source.remote) &&
      !source.remote.startsWith('file:'))
  )
    return source;
  return {
    type: 'git',
    revision: source.revision,
    path: source.path,
    ...(source.clean === undefined ? {} : { clean: source.clean }),
  };
};
const manifestPath = async (input: string) => {
  const resolved = path.resolve(input);
  try {
    return (await stat(resolved)).isDirectory()
      ? path.join(resolved, 'stack.yaml')
      : resolved;
  } catch (error) {
    throw new StackCompositionError(
      'stack-manifest-not-found',
      `Stack manifest was not found: ${resolved}`,
      { cause: error },
    );
  }
};

export type LoadedLocalStack = {
  version: ImportedStackVersion;
  sources: Map<string, string>;
};

export const loadLocalStack = async (
  input: string,
): Promise<LoadedLocalStack> => {
  const visited = new Map<string, LoadedLocalStack>();
  const visit = async (
    reference: string,
    chain: string[],
  ): Promise<LoadedLocalStack> => {
    const file = await manifestPath(reference);
    const canonical = path.resolve(file);
    if (chain.includes(canonical))
      throw new StackCycleError([...chain, canonical]);
    const cached = visited.get(canonical);
    if (cached) return cached;
    let manifest: ReturnType<typeof stackManifestSchema.parse>;
    try {
      manifest = stackManifestSchema.parse(
        parseYaml(await readFile(canonical, 'utf8')),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        throw new StackCompositionError(
          'stack-manifest-not-found',
          `Stack manifest was not found: ${canonical}`,
          { cause: error },
        );
      throw new StackCompositionError(
        'stack-manifest-invalid',
        `Stack manifest is invalid: ${canonical}`,
        { cause: error },
      );
    }
    const directory = path.dirname(canonical);
    const parents: LoadedLocalStack[] = [];
    for (const item of manifest.extends) {
      if (/^(?:@|https?:|git:|ssh:)/i.test(item))
        throw new StackCompositionError(
          'stack-extend-not-local',
          `Only local extends paths are supported: ${item}`,
        );
      parents.push(
        await visit(path.resolve(directory, item), [...chain, canonical]),
      );
    }
    const requirements: StackSkillRequirement[] = parents.flatMap(
      (item) => item.version.requirements,
    );
    const sources = new Map<string, string>();
    for (const parent of parents)
      for (const pair of parent.sources) sources.set(pair[0], pair[1]);
    const skippedOptional = parents.flatMap(
      (item) => item.version.skippedOptional,
    );
    for (const declared of manifest.skills) {
      const skillPath = path.resolve(directory, declared.path);
      try {
        const parsed = parseSkillFile(
          await readFile(path.join(skillPath, 'SKILL.md'), 'utf8'),
        );
        if ('error' in parsed) throw new Error(parsed.error);
        const contentHash = (await hashSkillDirectory(skillPath)).hash;
        const source = await detectProvenance(skillPath);
        const recordedSource = portableSource(source);
        const seed = digest({
          stack: manifest.name,
          name: parsed.metadata.name,
          contentHash,
          requirement: declared.requirement,
        });
        const id = `req_${seed.slice(7, 31)}`;
        const restoration = selectRestorationStrategy({
          contentHash,
          sources: [source],
          snapshotId: `snap_${seed.slice(7, 31)}`,
        });
        requirements.push({
          id,
          name: parsed.metadata.name,
          requirement: declared.requirement,
          contentHash,
          metadata: parsed.metadata,
          restoration,
          observedSources: [recordedSource],
          ...(restoration.strategy === 'reference'
            ? { preferredSource: recordedSource }
            : {}),
          originStackName: manifest.name,
        });
        sources.set(id, skillPath);
      } catch (error) {
        if (declared.requirement === 'optional') {
          skippedOptional.push({
            stackName: manifest.name,
            path: declared.path,
            reason: error instanceof Error ? error.message : String(error),
          });
          continue;
        }
        throw new StackCompositionError(
          (error as NodeJS.ErrnoException).code === 'ENOENT'
            ? 'stack-skill-not-found'
            : 'stack-skill-invalid',
          `Required Stack Skill is invalid: ${declared.path}`,
          { cause: error },
        );
      }
    }
    const inheritedStacks = parents.map((item) => ({
      name: item.version.name,
      versionHash: item.version.versionHash,
    }));
    const uniqueRequirements = [
      ...new Map(requirements.map((item) => [item.id, item])).values(),
    ];
    const uniqueSkippedOptional = [
      ...new Map(
        skippedOptional.map((item) => [JSON.stringify(item), item]),
      ).values(),
    ];
    const semantic = {
      name: manifest.name,
      description: manifest.description,
      requirements: uniqueRequirements,
      inheritedStacks,
      skippedOptional: uniqueSkippedOptional,
    };
    const version = importedStackVersionSchema.parse({
      schemaVersion: 1,
      ...semantic,
      versionHash: digest(semantic),
    });
    const loaded = { version, sources };
    visited.set(canonical, loaded);
    return loaded;
  };
  return visit(input, []);
};

export const stackVersionHash = (
  value: Omit<ImportedStackVersion, 'schemaVersion' | 'versionHash'>,
) => digest(value);
