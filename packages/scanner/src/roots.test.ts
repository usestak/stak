import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveScanRoots } from './roots.js';

describe('resolveScanRoots', () => {
  it('returns the four physical global roots with a Codex fallback', () => {
    const roots = resolveScanRoots({
      cwd: path.resolve('workspace'),
      env: {},
      homeDir: path.resolve('home'),
    });

    expect(roots).toEqual([
      {
        path: path.resolve('home', '.agents', 'skills'),
        rootKind: 'agents',
        scope: 'global',
      },
      {
        path: path.resolve('home', '.cursor', 'skills'),
        rootKind: 'cursor',
        scope: 'global',
      },
      {
        path: path.resolve('home', '.claude', 'skills'),
        rootKind: 'claude',
        scope: 'global',
      },
      {
        path: path.resolve('home', '.codex', 'skills'),
        rootKind: 'codex',
        scope: 'global',
      },
    ]);
  });

  it('uses CODEX_HOME without changing the physical root kind', () => {
    const codexHome = path.resolve('custom-codex');
    const roots = resolveScanRoots({
      cwd: path.resolve('workspace'),
      env: { CODEX_HOME: codexHome },
      homeDir: path.resolve('home'),
    });

    expect(roots.at(-1)).toEqual({
      path: path.join(codexHome, 'skills'),
      rootKind: 'codex',
      scope: 'global',
    });
  });

  it('adds only direct project roots when requested', () => {
    const cwd = path.resolve('workspace');
    const roots = resolveScanRoots({
      cwd,
      env: {},
      homeDir: path.resolve('home'),
      includeProject: true,
    });

    expect(roots.slice(4)).toEqual([
      {
        path: path.join(cwd, '.agents', 'skills'),
        rootKind: 'agents',
        scope: 'project',
      },
      {
        path: path.join(cwd, '.cursor', 'skills'),
        rootKind: 'cursor',
        scope: 'project',
      },
      {
        path: path.join(cwd, '.claude', 'skills'),
        rootKind: 'claude',
        scope: 'project',
      },
      {
        path: path.join(cwd, '.codex', 'skills'),
        rootKind: 'codex',
        scope: 'project',
      },
    ]);
  });
});
