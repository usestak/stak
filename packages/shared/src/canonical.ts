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
