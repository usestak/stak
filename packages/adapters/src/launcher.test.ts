import { spawn as nodeSpawn } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  AgentLaunchFailedError,
  ClaudeAdapter,
  CodexAdapter,
  CursorAdapter,
  launchAgent,
  probeVersion,
  spawnShimSafe,
} from './index.js';

const onWindows = process.platform === 'win32';
const roots: string[] = [];
const temp = async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stack-launch-'));
  roots.push(root);
  return root;
};
afterEach(async () =>
  Promise.all(
    roots.splice(0).map((r) => rm(r, { recursive: true, force: true })),
  ),
);

const AGENT_JS = `
const fs = require('fs');
const argv = process.argv.slice(2);
if (argv[0] === '--version') { process.stdout.write('fake-agent 9.9.9 (cursor)\\n'); process.exit(0); }
const out = process.env.OUT_FILE;
if (out) fs.writeFileSync(out, JSON.stringify({ argv, cwd: process.cwd(), marker: process.env.MARKER ?? null }));
const exitArg = argv.find((a) => a.startsWith('--exit='));
process.exit(exitArg ? Number(exitArg.slice('--exit='.length)) : 0);
`;

// Build a real npm-style shim (a .cmd on Windows, a shebang script on Unix) in a
// directory whose name contains a space, backed by a harmless Node script.
const makeShim = async (root: string): Promise<string> => {
  const binDir = path.join(root, 'bin dir');
  await mkdir(binDir, { recursive: true });
  await writeFile(path.join(binDir, 'agent.js'), AGENT_JS);
  if (onWindows) {
    const shim = path.join(binDir, 'fake-agent.cmd');
    await writeFile(shim, '@echo off\r\nnode "%~dp0agent.js" %*\r\n');
    return shim;
  }
  const shim = path.join(binDir, 'fake-agent');
  await writeFile(
    shim,
    `#!/bin/sh\nexec node "$(dirname "$0")/agent.js" "$@"\n`,
  );
  await chmod(shim, 0o755);
  return shim;
};

const launchOptions = (
  cwd: string,
  out: string,
  extra: NodeJS.ProcessEnv = {},
) => ({
  cwd,
  env: { ...process.env, OUT_FILE: out, MARKER: 'marker-value', ...extra },
  shell: false as const,
  stdio: 'inherit' as const,
});

describe('shim-safe launcher', () => {
  it('launches a shim in a path with spaces, preserving cwd and environment', async () => {
    const root = await temp();
    const shim = await makeShim(root);
    const out = path.join(root, 'out.json');
    const cwd = path.join(root, 'work');
    await mkdir(cwd, { recursive: true });
    const result = await spawnShimSafe(shim, [], launchOptions(cwd, out));
    expect(result.exitCode).toBe(0);
    const record = JSON.parse(await readFile(out, 'utf8'));
    expect(path.resolve(record.cwd)).toBe(path.resolve(cwd));
    expect(record.marker).toBe('marker-value');
  });

  it('passes arguments verbatim without shell interpretation', async () => {
    const root = await temp();
    const shim = await makeShim(root);
    const out = path.join(root, 'out.json');
    // A shell metacharacter payload that would create a file if interpreted.
    const injection = onWindows ? '& echo pwned> INJECTED' : '; touch INJECTED';
    await spawnShimSafe(
      shim,
      ['plain', 'a b c', injection],
      launchOptions(root, out),
    );
    const record = JSON.parse(await readFile(out, 'utf8'));
    expect(record.argv).toEqual(['plain', 'a b c', injection]);
    // The injection payload must not have executed.
    await expect(stat(path.join(root, 'INJECTED'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('propagates the child exit code', async () => {
    const root = await temp();
    const shim = await makeShim(root);
    const out = path.join(root, 'out.json');
    const result = await spawnShimSafe(
      shim,
      ['--exit=7'],
      launchOptions(root, out),
    );
    expect(result.exitCode).toBe(7);
  });

  it('probes --version through the shim', async () => {
    const root = await temp();
    const shim = await makeShim(root);
    expect(await probeVersion(shim, ['--version'])).toMatch(
      /fake-agent 9\.9\.9/,
    );
  });

  it('surfaces a typed error when the executable does not exist', async () => {
    await expect(
      launchAgent({
        agent: 'codex',
        detection: {
          agent: 'codex',
          installed: true,
          executablePath: path.join(await temp(), 'does-not-exist'),
        },
        cwd: process.cwd(),
        env: process.env,
      }),
    ).rejects.toBeInstanceOf(AgentLaunchFailedError);
  });

  it.each([
    ['codex', CodexAdapter],
    ['cursor', CursorAdapter],
    ['claude', ClaudeAdapter],
  ] as const)(
    'the %s adapter launches through the shim-safe helper',
    async (id, Adapter) => {
      const root = await temp();
      const shim = await makeShim(root);
      const out = path.join(root, `${id}.json`);
      const adapter = new Adapter({
        stackHome: path.join(root, 'stack'),
        homeDir: path.join(root, 'home'),
        detect: async () => ({
          agent: id,
          installed: true,
          executablePath: shim,
        }),
      });
      // Default launcher (no spawnProcess override) must handle the shim.
      const result = await adapter.launch({
        cwd: root,
        env: { ...process.env, OUT_FILE: out, MARKER: id },
      });
      expect(result).toMatchObject({ agent: id, exitCode: 0 });
      expect(JSON.parse(await readFile(out, 'utf8')).marker).toBe(id);
    },
  );

  (onWindows ? it : it.skip)(
    'regression: Node shell:false cannot spawn a .cmd directly, but the helper can',
    async () => {
      const root = await temp();
      const shim = await makeShim(root);
      const out = path.join(root, 'out.json');
      // Node refuses to spawn a `.cmd` with shell:false since the CVE-2024-27980
      // fix. It surfaces as EINVAL — thrown synchronously or emitted as 'error'.
      const nodeError = await new Promise<Error | null>((resolve) => {
        try {
          const child = nodeSpawn(shim, [], { shell: false, stdio: 'ignore' });
          child.once('error', (e) => resolve(e));
          child.once('close', () => resolve(null));
        } catch (error) {
          resolve(error as Error);
        }
      });
      expect(nodeError).toBeInstanceOf(Error);
      expect((nodeError as NodeJS.ErrnoException).code).toBe('EINVAL');
      const result = await spawnShimSafe(shim, [], launchOptions(root, out));
      expect(result.exitCode).toBe(0);
    },
  );
});
