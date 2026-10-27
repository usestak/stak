import { describe, expect, it } from 'vitest';

import { detectPackageManager, installCommandFor } from './install.js';

describe('detectPackageManager', () => {
  const npmPaths = [
    'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@memstk\\cli\\dist\\bin.js',
    '/usr/local/lib/node_modules/@memstk/cli/dist/bin.js',
    '/home/me/.nvm/versions/node/v22.0.0/lib/node_modules/@memstk/cli/dist/bin.js',
  ];
  const pnpmPaths = [
    'C:\\Users\\me\\AppData\\Local\\pnpm\\global\\5\\node_modules\\@memstk\\cli\\dist\\bin.js',
    'C:\\Users\\me\\AppData\\Local\\pnpm\\global\\5\\.pnpm\\@memstk+cli@0.2.0-beta.3\\node_modules\\@memstk\\cli\\dist\\bin.js',
    '/home/me/.local/share/pnpm/global/5/node_modules/@memstk/cli/dist/bin.js',
    '/Users/me/Library/pnpm/global/5/.pnpm/@memstk+cli@0.2.0/node_modules/@memstk/cli/dist/bin.js',
  ];

  it.each(npmPaths)('recognises an npm global install: %s', (packagePath) => {
    expect(detectPackageManager({ packagePaths: [packagePath], env: {} })).toBe(
      'npm',
    );
  });

  it.each(pnpmPaths)('recognises a pnpm global install: %s', (packagePath) => {
    expect(detectPackageManager({ packagePaths: [packagePath], env: {} })).toBe(
      'pnpm',
    );
  });

  it('falls back to npm_execpath', () => {
    expect(
      detectPackageManager({
        packagePaths: [undefined],
        env: { npm_execpath: '/home/me/.local/share/pnpm/pnpm.cjs' },
      }),
    ).toBe('pnpm');
    expect(
      detectPackageManager({
        packagePaths: [],
        env: { npm_execpath: '/usr/lib/node_modules/npm/bin/npm-cli.js' },
      }),
    ).toBe('npm');
  });

  it('defaults to npm when it cannot tell', () => {
    expect(
      detectPackageManager({ packagePaths: ['/opt/stak/bin.js'], env: {} }),
    ).toBe('npm');
  });
});

describe('installCommandFor', () => {
  it('builds the npm and pnpm global install commands for a channel', () => {
    expect(installCommandFor('npm', 'beta').display).toBe(
      'npm i -g @memstk/cli@beta',
    );
    expect(installCommandFor('pnpm', 'latest')).toEqual({
      packageManager: 'pnpm',
      command: 'pnpm',
      args: ['add', '-g', '@memstk/cli@latest'],
      display: 'pnpm add -g @memstk/cli@latest',
    });
  });
});
