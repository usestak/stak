// Phase 7 controlled cross-agent demonstration.
//
// Runs ENTIRELY inside a Phase 6.1 fenced, owned temporary root. It never writes
// to the real user HOME: temporary HOME and temporary STACK_HOME both live under
// the owned root, and every mutation flows through adapters given those explicit
// paths. Fake Codex/Cursor/Claude executables prove detection without spawning.

import { access, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import {
  ClaudeAdapter,
  CodexAdapter,
  CursorAdapter,
  readBindingRegistry,
} from '../packages/adapters/dist/index.js';
import {
  createOwnedTestRoot,
  hashSkillDirectory,
} from '../packages/shared/dist/index.js';
import {
  ingestSkill,
  verifyStoredSkill,
} from '../packages/store/dist/index.js';

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const missing = async (target) => {
  try {
    await stat(target);
    return false;
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    throw error;
  }
};

const owned = await createOwnedTestRoot('stack-phase7-demo-');
console.log(`Owned temporary root: ${owned.rootPath}`);

try {
  const homeDir = path.join(owned.rootPath, 'user-home');
  const stackHome = path.join(owned.rootPath, 'stack-home');
  const machineId = '00000000-0000-4000-8000-000000000000';

  // --- Fenced canaries -----------------------------------------------------
  const cursorSentinel = path.join(
    homeDir,
    '.cursor',
    'skills',
    'do-not-touch',
    'SKILL.md',
  );
  await owned.writeText(cursorSentinel, 'cursor-sync-root-sentinel');
  const cursorSentinelBefore = await readFile(cursorSentinel, 'utf8');

  const unmanagedCanary = path.join(
    homeDir,
    '.agents',
    'skills',
    'hand-authored',
    'SKILL.md',
  );
  await owned.writeText(
    unmanagedCanary,
    '---\nname: hand-authored\ndescription: canary\n---\nuser owned\n',
  );
  const unmanagedCanaryBefore = await readFile(unmanagedCanary, 'utf8');

  // --- Fake executables + detection ---------------------------------------
  const fakeBin = path.join(owned.rootPath, 'bin');
  const fakeExecutables = {
    codex: path.join(fakeBin, 'codex'),
    agent: path.join(fakeBin, 'agent'),
    claude: path.join(fakeBin, 'claude'),
  };
  for (const [name, file] of Object.entries(fakeExecutables))
    await owned.writeText(file, `#!/bin/sh\necho ${name}\n`);
  const detection = {
    findExecutable: async (name) => fakeExecutables[name],
    runVersion: async (file) =>
      file.endsWith('agent')
        ? 'cursor-agent 1.0.0'
        : `${path.basename(file)} 1.0.0`,
  };

  // --- main with foo and bar ----------------------------------------------
  const skills = [];
  for (const [index, name] of ['foo', 'bar'].entries()) {
    const source = path.join(owned.rootPath, 'sources', name);
    await owned.writeText(
      path.join(source, 'SKILL.md'),
      `---\nname: ${name}\ndescription: demo\n---\n${name}\n`,
    );
    const contentHash = (await hashSkillDirectory(source)).hash;
    await ingestSkill({
      stackHome,
      sourcePath: source,
      expectedContentHash: contentHash,
    });
    skills.push({ entryId: `skill_demo000${index}`, name, contentHash });
  }
  const environment = { name: 'main', machineId, skills };
  const codex = new CodexAdapter({ stackHome, homeDir, detection });
  const cursor = new CursorAdapter({ stackHome, homeDir, detection });
  const claude = new ClaudeAdapter({ stackHome, homeDir, detection });

  const codexDetection = await codex.detect();
  const cursorDetection = await cursor.detect();
  const claudeDetection = await claude.detect();
  assert(
    codexDetection.installed &&
      cursorDetection.installed &&
      claudeDetection.installed,
    'All three fake agents should be detected.',
  );
  assert(
    cursorDetection.executablePath === fakeExecutables.agent,
    'Cursor should prefer the validated `agent` executable.',
  );

  // --- stack run codex --yes ----------------------------------------------
  await codex.applyBindings(await codex.planBindings(environment), machineId);
  for (const name of ['foo', 'bar'])
    await access(path.join(homeDir, '.agents', 'skills', name));

  // --- stack run cursor --dry-run (recognizes shared, zero duplicates) -----
  const cursorDryRun = await cursor.planBindings(environment);
  assert(
    cursorDryRun.operations.every((item) => item.state === 'already-managed'),
    'Cursor must recognize every Codex-created shared binding.',
  );
  const afterCodex = await readBindingRegistry({ stackHome, machineId });
  assert(
    afterCodex.bindings.length === 2,
    'Only two shared physical bindings should exist after Codex.',
  );

  // --- stack run claude --yes (separate physical root) ---------------------
  await claude.applyBindings(await claude.planBindings(environment), machineId);
  for (const name of ['foo', 'bar'])
    await access(path.join(homeDir, '.claude', 'skills', name));
  const afterClaude = await readBindingRegistry({ stackHome, machineId });
  assert(
    afterClaude.bindings.filter((item) => item.targetRoot === 'agents')
      .length === 2 &&
      afterClaude.bindings.filter((item) => item.targetRoot === 'claude')
        .length === 2,
    'Claude must add its own bindings without disturbing the shared ones.',
  );

  // --- Remove one desired requirement (drop bar) and reconcile ------------
  const reduced = { ...environment, skills: [skills[0]] };
  const cursorRemoval = await cursor.applyBindings(
    await cursor.planBindings(reduced),
    machineId,
  );
  const claudeRemoval = await claude.applyBindings(
    await claude.planBindings(reduced),
    machineId,
  );
  assert(
    cursorRemoval.removed.length === 1 && claudeRemoval.removed.length === 1,
    'Each adapter should remove exactly its own stale bar binding.',
  );

  // --- Verifications -------------------------------------------------------
  // Stale healthy bindings removed from both roots.
  assert(
    await missing(path.join(homeDir, '.agents', 'skills', 'bar')),
    'Stale shared bar binding must be removed.',
  );
  assert(
    await missing(path.join(homeDir, '.claude', 'skills', 'bar')),
    'Stale Claude bar binding must be removed.',
  );
  // Still-desired bindings remain in both roots.
  await access(path.join(homeDir, '.agents', 'skills', 'foo'));
  await access(path.join(homeDir, '.claude', 'skills', 'foo'));
  const finalRegistry = await readBindingRegistry({ stackHome, machineId });
  assert(
    finalRegistry.bindings.length === 2,
    'Exactly one shared and one Claude foo binding should remain.',
  );

  // Store remains intact for BOTH foo and bar (immutable, still one object each).
  for (const skill of skills) {
    const preservation = await verifyStoredSkill({
      stackHome,
      contentHash: skill.contentHash,
    });
    assert(
      preservation.state === 'available',
      `Store object for ${skill.name} must remain intact (${preservation.state}).`,
    );
  }

  // Unmanaged canary under ~/.agents untouched.
  assert(
    (await readFile(unmanagedCanary, 'utf8')) === unmanagedCanaryBefore,
    'Unmanaged ~/.agents canary must be byte-for-byte unchanged.',
  );
  // ~/.cursor/skills privacy sentinel byte-for-byte untouched.
  assert(
    (await readFile(cursorSentinel, 'utf8')) === cursorSentinelBefore,
    'Cursor privacy sentinel must be byte-for-byte unchanged.',
  );

  console.log(
    'PASS: Codex/Cursor share one ~/.agents binding per Skill; Claude keeps a ' +
      'separate ~/.claude binding; stale healthy bindings were reconciled away; ' +
      'still-desired bindings, the Store, the unmanaged canary, and the ' +
      '~/.cursor privacy sentinel are all intact.',
  );
} finally {
  await owned.cleanup();
  console.log('Owned temporary root cleaned.');
}
