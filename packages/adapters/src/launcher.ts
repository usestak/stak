import spawn from 'cross-spawn';

export type LaunchSpawnOptions = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  shell: false;
  stdio: 'inherit';
};

/**
 * Spawn a detected agent executable, transparently handling Windows `.cmd`/`.bat`
 * npm shims (which Node refuses to spawn with `shell:false` since the CVE-2024-27980
 * fix). cross-spawn keeps argument-array semantics and never enables a shell: on
 * Windows it invokes `cmd.exe` itself with `shell:false` plus its own tested
 * argument escaping, so no user-controlled value is interpolated into a shell
 * command string. On Unix it spawns the target directly. Native `.exe` and
 * shebang executables are unaffected.
 */
export const spawnShimSafe = (
  file: string,
  args: string[],
  options: LaunchSpawnOptions,
): Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }> =>
  new Promise((resolve, reject) => {
    const child = spawn(file, args, options);
    child.once('error', reject);
    child.once('close', (exitCode, signal) => resolve({ exitCode, signal }));
  });

/**
 * Probe an executable's `--version` output, shim-safe, with a short timeout.
 * Never throws: an unreadable or shim-incompatible probe resolves to undefined
 * so detection can still report the agent as installed.
 */
export const probeVersion = (
  file: string,
  args: string[],
  timeoutMs = 3000,
): Promise<string | undefined> =>
  new Promise((resolve) => {
    let child;
    try {
      child = spawn(file, args, {
        shell: false,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      resolve(undefined);
      return;
    }
    let output = '';
    child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.once('error', () => {
      clearTimeout(timer);
      resolve(undefined);
    });
    child.once('close', () => {
      clearTimeout(timer);
      resolve(output.trim() || undefined);
    });
  });
