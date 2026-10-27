/**
 * A small, dependency-free semver subset for the update reminder: parse, compare (with full
 * prerelease precedence, semver §11), and pick the npm dist-tag a version belongs to.
 */

export type ParsedVersion = {
  major: number;
  minor: number;
  patch: number;
  prerelease: Array<string | number>;
};

export type ReleaseChannel = 'latest' | 'beta';

const NUMERIC = /^(?:0|[1-9]\d*)$/;
const VERSION =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export const parseVersion = (value: string): ParsedVersion | undefined => {
  const match = VERSION.exec(value.trim());
  if (!match) return undefined;
  const prerelease: Array<string | number> = [];
  if (match[4] !== undefined) {
    for (const identifier of match[4].split('.')) {
      if (/^\d+$/.test(identifier)) {
        // Numeric identifiers must not have leading zeros (semver §9).
        if (!NUMERIC.test(identifier)) return undefined;
        prerelease.push(Number(identifier));
      } else prerelease.push(identifier);
    }
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease,
  };
};

const sign = (value: number): -1 | 0 | 1 =>
  value > 0 ? 1 : value < 0 ? -1 : 0;

const compareIdentifiers = (
  left: string | number,
  right: string | number,
): -1 | 0 | 1 => {
  if (typeof left === 'number' && typeof right === 'number')
    return sign(left - right);
  // Numeric identifiers always have lower precedence than alphanumeric ones.
  if (typeof left === 'number') return -1;
  if (typeof right === 'number') return 1;
  return left < right ? -1 : left > right ? 1 : 0;
};

/** -1, 0 or 1 like a sort comparator; `undefined` when either side is not semver. */
export const compareVersions = (
  left: string,
  right: string,
): -1 | 0 | 1 | undefined => {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return undefined;
  const core =
    sign(a.major - b.major) ||
    sign(a.minor - b.minor) ||
    sign(a.patch - b.patch);
  if (core !== 0) return core;
  // A release ranks above any prerelease of the same major.minor.patch.
  if (a.prerelease.length === 0 || b.prerelease.length === 0)
    return sign(b.prerelease.length - a.prerelease.length);
  for (const [index, left] of a.prerelease.entries()) {
    const right = b.prerelease[index];
    if (right === undefined) break;
    const result = compareIdentifiers(left, right);
    if (result !== 0) return result;
  }
  return sign(a.prerelease.length - b.prerelease.length);
};

/** True only when `candidate` is strictly newer than `current` — never suggests a downgrade. */
export const isNewerVersion = (candidate: string, current: string): boolean =>
  compareVersions(candidate, current) === 1;

/** A prerelease build (e.g. `0.2.0-beta.3`) follows the `beta` dist-tag; a release follows `latest`. */
export const channelFor = (version: string): ReleaseChannel => {
  const parsed = parseVersion(version);
  return parsed && parsed.prerelease.length > 0 ? 'beta' : 'latest';
};
