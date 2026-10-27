import { describe, expect, it } from 'vitest';

import {
  channelFor,
  compareVersions,
  isNewerVersion,
  parseVersion,
} from './version.js';

describe('parseVersion', () => {
  it('parses release, prerelease, and build metadata', () => {
    expect(parseVersion('1.2.3')).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: [],
    });
    expect(parseVersion('v0.2.0-beta.3+abc')).toEqual({
      major: 0,
      minor: 2,
      patch: 0,
      prerelease: ['beta', 3],
    });
  });

  it('rejects anything that is not semver', () => {
    for (const bad of [
      '',
      '1.2',
      '1.2.x',
      'latest',
      '01.2.3',
      '1.2.3-',
      '1.2.3-beta..1',
    ])
      expect(parseVersion(bad)).toBeUndefined();
  });
});

describe('compareVersions', () => {
  it('orders by major, minor, patch', () => {
    expect(compareVersions('1.0.0', '0.9.9')).toBe(1);
    expect(compareVersions('0.2.0', '0.10.0')).toBe(-1);
    expect(compareVersions('0.2.1', '0.2.0')).toBe(1);
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
  });

  it('orders prerelease identifiers numerically, not lexically', () => {
    expect(compareVersions('0.2.0-beta.10', '0.2.0-beta.9')).toBe(1);
    expect(compareVersions('0.2.0-beta.9', '0.2.0-beta.3')).toBe(1);
    expect(compareVersions('0.2.0-beta.3', '0.2.0-beta.10')).toBe(-1);
  });

  it('ranks a release above every prerelease of the same version', () => {
    expect(compareVersions('0.2.0', '0.2.0-beta.9')).toBe(1);
    expect(compareVersions('0.2.0-beta.9', '0.2.0')).toBe(-1);
    expect(compareVersions('0.2.0-beta.9', '0.1.2')).toBe(1);
  });

  it('follows the remaining semver prerelease precedence rules', () => {
    // numeric identifiers sort below alphanumeric ones; a longer set wins a tie
    expect(compareVersions('1.0.0-alpha', '1.0.0-alpha.1')).toBe(-1);
    expect(compareVersions('1.0.0-alpha.1', '1.0.0-alpha.beta')).toBe(-1);
    expect(compareVersions('1.0.0-alpha.beta', '1.0.0-beta')).toBe(-1);
    expect(compareVersions('1.0.0-rc.1', '1.0.0-beta.11')).toBe(1);
    // build metadata is ignored
    expect(compareVersions('1.0.0+a', '1.0.0+b')).toBe(0);
  });

  it('returns undefined when either side is not semver', () => {
    expect(compareVersions('nope', '1.0.0')).toBeUndefined();
    expect(compareVersions('1.0.0', '')).toBeUndefined();
  });
});

describe('isNewerVersion', () => {
  it('is true only for a strictly newer valid version (never a downgrade)', () => {
    expect(isNewerVersion('0.2.0-beta.4', '0.2.0-beta.3')).toBe(true);
    expect(isNewerVersion('0.2.0-beta.3', '0.2.0-beta.3')).toBe(false);
    expect(isNewerVersion('0.1.2', '0.2.0-beta.3')).toBe(false);
    expect(isNewerVersion('garbage', '0.2.0-beta.3')).toBe(false);
  });
});

describe('channelFor', () => {
  it('maps a prerelease to the beta dist-tag and a release to latest', () => {
    expect(channelFor('0.2.0-beta.3')).toBe('beta');
    expect(channelFor('1.0.0-rc.1')).toBe('beta');
    expect(channelFor('0.1.2')).toBe('latest');
    expect(channelFor('1.0.0+build.5')).toBe('latest');
  });
});
