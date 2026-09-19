import { referenceRecordSchema, restorationStrategySchema } from '@stack/spec';
import type {
  RestorationStrategy,
  SkillSource,
  SnapshotReason,
} from '@stack/spec';

export type SelectRestorationStrategyOptions = {
  contentHash: string;
  sources: SkillSource[];
  snapshotId: string;
};

export const selectRestorationStrategy = (
  options: SelectRestorationStrategyOptions,
): RestorationStrategy => {
  const eligible = new Map<
    string,
    ReturnType<typeof referenceRecordSchema.parse>
  >();
  for (const source of options.sources) {
    if (
      source.type !== 'git' ||
      source.clean !== true ||
      source.remote === undefined
    )
      continue;
    const parsed = referenceRecordSchema.safeParse({
      remote: source.remote,
      revision: source.revision,
      path: source.path,
      expectedContentHash: options.contentHash,
    });
    if (parsed.success)
      eligible.set(
        `${parsed.data.remote}\0${parsed.data.revision}\0${parsed.data.path}`,
        parsed.data,
      );
  }
  if (eligible.size === 1)
    return restorationStrategySchema.parse({
      strategy: 'reference',
      reference: [...eligible.values()][0],
    });

  let reason: SnapshotReason;
  if (eligible.size > 1) reason = 'ambiguous-source';
  else if (
    options.sources.some(
      (source) => source.type === 'git' && source.clean !== true,
    )
  )
    reason = 'modified-source';
  else if (options.sources.some((source) => source.type === 'git'))
    reason = 'non-portable-source';
  else if (options.sources.some((source) => source.type === 'unknown'))
    reason = 'unknown-source';
  else reason = 'local';
  return restorationStrategySchema.parse({
    strategy: 'snapshot',
    snapshotId: options.snapshotId,
    reason,
  });
};
