import { createHash } from 'node:crypto';

/** Deterministic JSON with lexicographically sorted object keys. */
export const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object')
    return JSON.stringify(value ?? null);
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
};

/** sha256 (prefixed) over a canonical JSON serialization. */
export const sha256CanonicalJson = (value: unknown): string =>
  `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;

/**
 * The portable Environment digest, shared by core (bundle build) and cloud-server (account-side
 * desired-state writes) so both compute byte-identical digests. Covers the manifest, the
 * portable resolution, and active imported Stack versions; excludes timestamps, machine ids,
 * paths and sync metadata. Object keys are canonicalized; `importedStackVersions` is an array,
 * so it is explicitly sorted by stackId for order-independence.
 */
export const computeEnvironmentBundleDigest = (input: {
  environment: unknown;
  resolved: { skills: Record<string, unknown> };
  importedStackVersions: { stackId: string }[];
}): string => {
  const skills = Object.fromEntries(
    Object.entries(input.resolved.skills).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    ),
  );
  const importedStackVersions = [...input.importedStackVersions].sort((a, b) =>
    a.stackId < b.stackId ? -1 : a.stackId > b.stackId ? 1 : 0,
  );
  return sha256CanonicalJson({
    schemaVersion: 1,
    environment: input.environment,
    resolved: { schemaVersion: 1, skills },
    importedStackVersions,
  });
};
