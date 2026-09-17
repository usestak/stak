import { parse } from 'yaml';

import { skillMetadataSchema, type SkillMetadata } from '@stack/spec';

export type ParseSkillFileResult =
  | { metadata: SkillMetadata; error?: never }
  | { metadata?: never; error: string };

export const parseSkillFile = (source: string): ParseSkillFileResult => {
  const normalized = source.replaceAll('\r\n', '\n');
  if (!normalized.startsWith('---\n'))
    return { error: 'Missing YAML frontmatter opening delimiter' };
  const closing = normalized.indexOf('\n---', 4);
  if (closing < 0)
    return { error: 'Missing YAML frontmatter closing delimiter' };
  try {
    const parsed = skillMetadataSchema.safeParse(
      parse(normalized.slice(4, closing)) as unknown,
    );
    if (!parsed.success) {
      const fields = parsed.error.issues
        .map((issue) => issue.path.join('.') || 'frontmatter')
        .join(', ');
      return { error: `Invalid required metadata: ${fields}` };
    }
    return { metadata: parsed.data };
  } catch (error) {
    return {
      error: `Invalid YAML: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
};
