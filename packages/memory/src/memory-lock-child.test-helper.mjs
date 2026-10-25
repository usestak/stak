import { appendFile } from 'node:fs/promises';
import { withMemoryLock } from '../dist/memory-lock.js';

const [stackHome, name, log, mode] = process.argv.slice(2);
if (mode === 'hold') {
  // Signal test: hold the lock with real signal handlers until killed.
  await withMemoryLock(stackHome, `child ${name}`, async () => {
    process.stdout.write('ready\n');
    await new Promise(() => {});
  }, { timeoutMs: 5_000, pollMs: 20 });
} else {
  await withMemoryLock(stackHome, `child ${name}`, async () => {
    await appendFile(log, `${name}:start\n`);
    await new Promise((r) => setTimeout(r, 150));
    await appendFile(log, `${name}:end\n`);
  }, { timeoutMs: 5_000, pollMs: 20, installSignalHandlers: false });
}
