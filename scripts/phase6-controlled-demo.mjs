import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  launchCodexTryRuntime,
  prepareCodexTryRuntime,
} from '../packages/adapters/dist/index.js';
import {
  preserveTrialStack,
  resolveTrialStack,
} from '../packages/core/dist/index.js';
import {
  createOwnedTestRoot,
  hashSkillDirectory,
} from '../packages/shared/dist/index.js';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const owned = await createOwnedTestRoot('stack-phase6-demo-');
console.log(`Owned temporary root: ${owned.rootPath}`);

try {
  const stackDemoUserHome = path.join(owned.rootPath, 'user-home');
  const stackDemoStackHome = path.join(owned.rootPath, 'stack-home');
  const userSentinel = path.join(
    stackDemoUserHome,
    '.agents',
    'skills',
    'do-not-touch',
    'SKILL.md',
  );
  const legacySentinel = path.join(
    stackDemoUserHome,
    '.codex',
    'skills',
    'do-not-touch',
    'SKILL.md',
  );
  await owned.writeText(userSentinel, 'normal-user-sentinel');
  await owned.writeText(legacySentinel, 'legacy-user-sentinel');
  const before = await hashSkillDirectory(stackDemoUserHome);

  const trial = await resolveTrialStack({
    input: path.join(repositoryRoot, 'fixtures', 'stacks', 'frontend'),
  });
  await preserveTrialStack({ stackHome: stackDemoStackHome, trial });
  const preparation = await prepareCodexTryRuntime({
    stackHome: stackDemoStackHome,
    trial: trial.resolved,
    homeDir: stackDemoUserHome,
    env: {},
  });
  await launchCodexTryRuntime({
    stackHome: stackDemoStackHome,
    preparation,
    detection: {
      agent: 'codex',
      installed: true,
      executablePath: 'fake-codex',
    },
    spawnProcess: async (_file, _args, options) => {
      await access(path.join(options.cwd, '.agents', 'skills'));
      if (options.env.HOME !== preparation.session.runtimeHomePath)
        throw new Error('Fake Codex did not receive the isolated HOME.');
      if (options.env.CODEX_HOME !== preparation.session.runtimeCodexHomePath)
        throw new Error('Fake Codex did not receive the isolated CODEX_HOME.');
      return { exitCode: 0, signal: null };
    },
  });

  const after = await hashSkillDirectory(stackDemoUserHome);
  if (after.hash !== before.hash)
    throw new Error('The fake real-home tree changed during the trial.');
  if ((await readFile(userSentinel, 'utf8')) !== 'normal-user-sentinel')
    throw new Error('The normal user Skill sentinel changed.');
  if ((await readFile(legacySentinel, 'utf8')) !== 'legacy-user-sentinel')
    throw new Error('The legacy user Skill sentinel changed.');
  console.log(
    'Fenced trial completed; fake real-home sentinels are unchanged.',
  );
} finally {
  await owned.cleanup();
  console.log('Owned temporary root cleaned.');
}
