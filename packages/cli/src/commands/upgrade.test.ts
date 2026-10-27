import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

import { installCommandFor, type PackageManager } from '../update/install.js';
import {
  isPermissionFailure,
  registerUpgradeCommand,
  UpgradeError,
  type InstallRunResult,
  type UpgradeCommandDependencies,
} from './upgrade.js';

const harness = (overrides: Partial<UpgradeCommandDependencies> = {}) => {
  let output = '';
  const runInstall = vi.fn<UpgradeCommandDependencies['runInstall']>(
    async (): Promise<InstallRunResult> => ({ exitCode: 0 }),
  );
  const confirm = vi.fn(async () => true);
  const latestVersion = vi.fn(async () => '0.2.0-beta.4');
  const dependencies: UpgradeCommandDependencies = {
    currentVersion: '0.2.0-beta.3',
    latestVersion,
    detectPackageManager: (): PackageManager => 'npm',
    installCommand: installCommandFor,
    runInstall,
    confirm,
    writeOut: (value) => {
      output += value;
    },
    ...overrides,
  };
  const program = new Command().exitOverride();
  registerUpgradeCommand(program, dependencies);
  return {
    run: (...args: string[]) =>
      program.parseAsync(['node', 'stak', 'upgrade', ...args]),
    output: () => output,
    runInstall:
      (overrides.runInstall as typeof runInstall | undefined) ?? runInstall,
    confirm: (overrides.confirm as typeof confirm | undefined) ?? confirm,
    latestVersion:
      (overrides.latestVersion as typeof latestVersion | undefined) ??
      latestVersion,
  };
};

describe('stak upgrade', () => {
  it('reports up to date and installs nothing', async () => {
    const h = harness({ latestVersion: vi.fn(async () => '0.2.0-beta.3') });
    await h.run();
    expect(h.output()).toBe(
      'Current: 0.2.0-beta.3\nLatest (beta): 0.2.0-beta.3\nSTAK is up to date.\n',
    );
    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.runInstall).not.toHaveBeenCalled();
  });

  it('never offers a downgrade', async () => {
    const h = harness({ latestVersion: vi.fn(async () => '0.2.0-beta.2') });
    await h.run('--yes');
    expect(h.output()).toContain('STAK is up to date.');
    expect(h.runInstall).not.toHaveBeenCalled();
  });

  it('looks up the channel of the installed version', async () => {
    const beta = harness();
    await beta.run('--dry-run');
    expect(beta.latestVersion).toHaveBeenCalledWith('beta');

    const stable = harness({
      currentVersion: '0.1.1',
      latestVersion: vi.fn(async () => '0.1.2'),
    });
    await stable.run('--dry-run');
    expect(stable.latestVersion).toHaveBeenCalledWith('latest');
    expect(stable.output()).toContain('Would run: npm i -g @memstk/cli@latest');
  });

  it('--dry-run prints the command and changes nothing', async () => {
    const h = harness();
    await h.run('--dry-run');
    expect(h.output()).toBe(
      'Current: 0.2.0-beta.3\nLatest (beta): 0.2.0-beta.4\n\n' +
        'Would run: npm i -g @memstk/cli@beta\nNo changes were made.\n',
    );
    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.runInstall).not.toHaveBeenCalled();
  });

  it('shows the exact command and stops when the confirmation is declined', async () => {
    const h = harness({ confirm: vi.fn(async () => false) });
    await h.run();
    expect(h.output()).toContain('This will run: npm i -g @memstk/cli@beta');
    expect(h.confirm).toHaveBeenCalledOnce();
    expect(h.output()).toContain('Cancelled. No changes were made.');
    expect(h.runInstall).not.toHaveBeenCalled();
  });

  it('runs the install after confirmation', async () => {
    const h = harness();
    await h.run();
    expect(h.confirm).toHaveBeenCalledOnce();
    expect(h.runInstall).toHaveBeenCalledOnce();
    expect(h.output()).toContain('STAK 0.2.0-beta.4 installed.');
  });

  it('--yes runs the npm command without prompting', async () => {
    const h = harness();
    await h.run('--yes');
    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.runInstall).toHaveBeenCalledWith({
      packageManager: 'npm',
      command: 'npm',
      args: ['i', '-g', '@memstk/cli@beta'],
      display: 'npm i -g @memstk/cli@beta',
    });
  });

  it('--yes runs the pnpm command for a pnpm install', async () => {
    const h = harness({ detectPackageManager: () => 'pnpm' });
    await h.run('-y');
    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.runInstall).toHaveBeenCalledWith({
      packageManager: 'pnpm',
      command: 'pnpm',
      args: ['add', '-g', '@memstk/cli@beta'],
      display: 'pnpm add -g @memstk/cli@beta',
    });
  });

  it('a non-zero exit fails and shows the command to run manually', async () => {
    const h = harness({ runInstall: vi.fn(async () => ({ exitCode: 1 })) });
    const failure = h.run('--yes');
    await expect(failure).rejects.toBeInstanceOf(UpgradeError);
    await expect(failure).rejects.toThrow(
      'The update exited with code 1. Run it yourself:\n  npm i -g @memstk/cli@beta',
    );
    await expect(failure).rejects.not.toThrow(/administrator/);
  });

  it('adds an administrator/sudo hint on a permission error', async () => {
    const eacces = harness({
      runInstall: vi.fn(async () => ({ exitCode: 243 })),
    });
    await expect(eacces.run('--yes')).rejects.toThrow(
      /Run it yourself:\n {2}npm i -g @memstk\/cli@beta\n.*administrator.*sudo/,
    );
    const eperm = harness({
      runInstall: vi.fn(async () => ({ exitCode: null, errorCode: 'EPERM' })),
    });
    await expect(eperm.run('--yes')).rejects.toThrow(
      /could not start \(EPERM\)/,
    );
  });

  it('fails clearly when the registry cannot be reached', async () => {
    const h = harness({
      latestVersion: vi.fn(async () => {
        throw new Error('fetch failed');
      }),
    });
    await expect(h.run()).rejects.toThrow(/Could not check the npm registry/);
    expect(h.runInstall).not.toHaveBeenCalled();
  });
});

describe('isPermissionFailure', () => {
  it('recognises EACCES/EPERM spawn errors and npm permission exit codes', () => {
    expect(isPermissionFailure({ exitCode: null, errorCode: 'EACCES' })).toBe(
      true,
    );
    expect(isPermissionFailure({ exitCode: null, errorCode: 'EPERM' })).toBe(
      true,
    );
    expect(isPermissionFailure({ exitCode: 243 })).toBe(true);
    expect(isPermissionFailure({ exitCode: 4294963248 })).toBe(true);
    expect(isPermissionFailure({ exitCode: 1 })).toBe(false);
    expect(isPermissionFailure({ exitCode: null, errorCode: 'ENOENT' })).toBe(
      false,
    );
  });
});
