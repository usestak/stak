import { canonicalJson } from '@stack/shared';
import type { PortableLockedSkill } from '@stack/spec';

/**
 * Source-latest result for one Skill. P5a note: the Skills read model no longer consumes a
 * Cloud-side checker at all (it reads only the persisted, CLI-reported check), so nothing in
 * the product service produces or calls these today; the types live here, with their only
 * remaining user, rather than in product-service.ts.
 */
export type SourceLatest =
  | { status: 'same' }
  | { status: 'different'; sourceRevision: string }
  | { status: 'uncheckable' };
export type SkillSourceChecker = (input: {
  skillId: string;
  restoration: PortableLockedSkill['restoration'];
}) => Promise<SourceLatest>;

/**
 * Bounded request-time cache for source-latest checks (P3 §5). Source resolution (git
 * ls-remote / public-registry lookups) is slow and must not run synchronously on every
 * dashboard request, but STAK runs NO background daemon. This wraps an inner checker with a
 * short TTL keyed by the EXACT source identity (skillId + restoration, including the approved
 * revision), so advancing the approved version invalidates the entry. It FAILS CLOSED: an
 * inner error yields `uncheckable` and is never cached as `no-update`, and a stale entry past
 * its TTL is re-resolved.
 */
export type CachedSourceCheckerConfig = {
  inner: SkillSourceChecker;
  ttlMs: number;
  now: () => Date;
};

export const createCachedSourceChecker = (
  config: CachedSourceCheckerConfig,
): SkillSourceChecker & { checkedAt: (key: string) => string | null } => {
  const cache = new Map<string, { atMs: number; result: SourceLatest }>();
  const keyOf = (input: Parameters<SkillSourceChecker>[0]): string =>
    canonicalJson({ skillId: input.skillId, restoration: input.restoration });

  const checker: SkillSourceChecker = async (input) => {
    const key = keyOf(input);
    const nowMs = config.now().getTime();
    const cached = cache.get(key);
    if (cached && nowMs - cached.atMs < config.ttlMs) return cached.result;
    let result: SourceLatest;
    try {
      result = await config.inner(input);
    } catch {
      // Fail closed: never cache an error as a definitive answer.
      return { status: 'uncheckable' };
    }
    cache.set(key, { atMs: nowMs, result });
    return result;
  };

  return Object.assign(checker, {
    checkedAt: (key: string): string | null => {
      const entry = cache.get(key);
      return entry ? new Date(entry.atMs).toISOString() : null;
    },
  });
};
