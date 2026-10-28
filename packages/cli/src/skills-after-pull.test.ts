/**
 * Skills after `stak pull` on a new machine.
 *
 * `stak pull` restores `main` and the Skill Store but, by design, never touches agent
 * directories (`stak run <agent>` installs them). Until then every Skill in `main` is
 * "not installed here yet" — NOT "missing on disk". Status must never tell the user to
 * `stak remove` those Skills, and neither `add .` nor `push` may treat them as deletions.
 * The genuine case (a Skill that WAS installed on this machine and was then deleted)
 * still reports missing and still offers `stak remove`.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { FilesystemSkillAdapter } from '@stack/adapters';
import { createCloudClient } from '@stack/cloud-client';
import {
  createCloudService,
  createInMemoryBlobStore,
  createInMemoryRepository,
  createInProcessFetch,
  type CloudService,
} from '@stack/cloud-server';
import {
  applySkillAdd,
  initializeMainEnvironment,
  loadMainEnvironment,
  prepareSkillAdd,
  statusMainEnvironment,
} from '@stack/core';
import { resolveScanRoots, scanSkills } from '@stack/scanner';
import { hashSkillDirectory } from '@stack/shared';

import type { CredentialStore, StoredCredential } from './cloud/credentials.js';
import {
  cloudApplyPull,
  cloudApplyPush,
  cloudPreparePull,
  cloudPreparePush,
  performLogin,
  type CloudOperationsDeps,
} from './cloud/operations.js';
import { renderSkillAdd } from './ui/add.js';
import { renderDiff, renderStatus } from './ui/environment.js';

const roots: string[] = [];
const temp = async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stak-skills-after-pull-'));
  roots.push(root);
  return root;
};
afterEach(async () =>
  Promise.all(
    roots.splice(0).map((r) => rm(r, { recursive: true, force: true })),
  ),
);

const USER = '00000000-0000-4000-8000-00000000aaaa';
const SKILLS = ['alpha', 'beta', 'gamma'];

const makeCloud = () => {
  const service = createCloudService({
    repository: createInMemoryRepository(),
    blobStore: createInMemoryBlobStore(),
    appUrl: 'http://localhost:3000',
    ticketSecret: 'skills-after-pull-secret',
  });
  const fetchImpl = createInProcessFetch(service);
  const createClient = (options: { baseUrl: string; token?: string }) =>
    createCloudClient({
      baseUrl: options.baseUrl,
      ...(options.token ? { token: options.token } : {}),
      fetchImpl,
    });
  return { service, createClient };
};

const inMemoryCredentials = (): CredentialStore => {
  let credential: StoredCredential | null = null;
  return {
    read: async () => credential,
    write: async (value) => {
      credential = value;
    },
    clear: async () => {
      credential = null;
    },
  };
};

const seedSkill = async (dir: string, name: string) => {
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} skill\n---\n${name} v1\n`,
  );
  return (await hashSkillDirectory(dir)).hash;
};

/** A Machine: its own STAK home plus its own (fake) user home with agent roots. */
type Machine = {
  stackHome: string;
  homeDir: string;
  deps: CloudOperationsDeps;
  credentials: CredentialStore;
};

const makeMachine = (
  root: string,
  label: string,
  createClient: CloudOperationsDeps['createClient'],
): Machine => {
  const stackHome = path.join(root, `${label}-stak`);
  const homeDir = path.join(root, `${label}-home`);
  const credentials = inMemoryCredentials();
  return {
    stackHome,
    homeDir,
    credentials,
    deps: {
      stackHome,
      env: { STACK_API_URL: 'http://localhost' },
      credentials,
      writeOut: () => {},
      ...(createClient ? { createClient } : {}),
      sleep: async () => {},
    },
  };
};

const loginAs = async (service: CloudService, machine: Machine) =>
  performLogin(
    {
      ...machine.deps,
      openBrowser: async (url: string) => {
        const code = new URL(url).searchParams.get('code');
        if (code)
          await service.approveCliAuth({
            userCode: code,
            profile: { userId: USER, githubUsername: 'alice' },
          });
      },
    },
    {},
  );

const scan = (machine: Machine) =>
  scanSkills({
    roots: resolveScanRoots({
      homeDir: machine.homeDir,
      env: {},
      includeProject: false,
    }),
  });

const status = async (machine: Machine) =>
  statusMainEnvironment({
    stackHome: machine.stackHome,
    scanResult: await scan(machine),
  });

/** `stak add .` exactly as the CLI runs it: prepare, then apply. */
const addAll = async (machine: Machine) => {
  const proposal = await prepareSkillAdd({
    stackHome: machine.stackHome,
    scanResult: await scan(machine),
    selectors: '.',
  });
  await applySkillAdd(proposal);
  return proposal;
};

/** `stak run codex` minus the launch: project main into ~/.agents/skills. */
const runCodexSetup = async (machine: Machine) => {
  const state = await loadMainEnvironment({ stackHome: machine.stackHome });
  const adapter = new FilesystemSkillAdapter({
    stackHome: machine.stackHome,
    homeDir: machine.homeDir,
  });
  const environment = {
    name: state.manifest.name,
    machineId: state.machine.machineId,
    skills: Object.entries(state.lock.skills).map(([entryId, locked]) => ({
      entryId,
      name: locked.name,
      contentHash: locked.contentHash,
    })),
  };
  const plan = await adapter.planBindings(environment);
  expect(plan.blocking).toBe(false);
  await adapter.applyBindings(plan, state.machine.machineId);
};

/** Machine A: three Skills in ~/.agents/skills, `stak init`-equivalent via `add .`, push. */
const setupFirstMachine = async (
  root: string,
  service: CloudService,
  createClient: CloudOperationsDeps['createClient'],
) => {
  const machine = makeMachine(root, 'a', createClient);
  for (const name of SKILLS)
    await seedSkill(
      path.join(machine.homeDir, '.agents', 'skills', name),
      name,
    );
  await initializeMainEnvironment({
    stackHome: machine.stackHome,
    scanResult: await scan(machine),
  });
  await loginAs(service, machine);
  const push = await cloudApplyPush(
    machine.deps,
    await cloudPreparePush(machine.deps),
  );
  expect(push.versionNumber).toBe(1);
  return machine;
};

/** Machine B: a fresh STAK home and an empty user home, then `stak pull --yes`. */
const setupFreshPulledMachine = async (
  root: string,
  service: CloudService,
  createClient: CloudOperationsDeps['createClient'],
) => {
  const machine = makeMachine(root, 'b', createClient);
  await mkdir(machine.homeDir, { recursive: true });
  await loginAs(service, machine);
  const pull = await cloudApplyPull(
    machine.deps,
    await cloudPreparePull(machine.deps),
  );
  expect(pull.status).toBe('restored');
  return machine;
};

const skillNamesInMain = async (machine: Machine) => {
  const state = await loadMainEnvironment({ stackHome: machine.stackHome });
  return Object.values(state.lock.skills)
    .map((skill) => skill.name)
    .sort();
};

describe('Skills after `stak pull` on a new machine', () => {
  it('status reports pulled Skills as not installed here yet, never as missing, and never suggests `stak remove`', async () => {
    const root = await temp();
    const { service, createClient } = makeCloud();
    await setupFirstMachine(root, service, createClient);
    const b = await setupFreshPulledMachine(root, service, createClient);

    const result = await status(b);
    expect(result.skills.map((skill) => skill.state)).toEqual([
      'not-installed',
      'not-installed',
      'not-installed',
    ]);
    expect(result.summary.notInstalled).toBe(3);
    expect(result.summary.missing).toBe(0);

    const output = renderStatus(result);
    expect(output).not.toContain('missing on disk');
    expect(output).not.toContain('stak remove');
    expect(output).not.toContain('stak add');
    expect(output).toContain('3 skills in main not installed here yet.');
    expect(output).toContain('Run `stak run <agent>`');
    expect(output).toContain('Nothing to add.');

    const diff = renderDiff({ ...result, entries: result.skills });
    expect(diff).not.toContain('Missing');
    expect(diff).toContain('3 skills in main not installed here yet.');
  });

  it('`stak add .` on that machine stages nothing and removes nothing from main', async () => {
    const root = await temp();
    const { service, createClient } = makeCloud();
    await setupFirstMachine(root, service, createClient);
    const b = await setupFreshPulledMachine(root, service, createClient);
    const before = await loadMainEnvironment({ stackHome: b.stackHome });

    const proposal = await addAll(b);
    expect(proposal.targets).toEqual([]);
    expect(proposal.issues).toEqual([]);
    expect(renderSkillAdd(proposal)).toBe('Nothing to add.\n');

    const after = await loadMainEnvironment({ stackHome: b.stackHome });
    expect(after.lock.skills).toEqual(before.lock.skills);
    expect(after.manifest.skills).toEqual(before.manifest.skills);
  });

  it('an explicit `stak add <skill>` explains the Skill is not installed here and does not suggest removal', async () => {
    const root = await temp();
    const { service, createClient } = makeCloud();
    await setupFirstMachine(root, service, createClient);
    const b = await setupFreshPulledMachine(root, service, createClient);

    const proposal = await prepareSkillAdd({
      stackHome: b.stackHome,
      scanResult: await scan(b),
      selectors: ['alpha'],
    });
    expect(proposal.issues).toEqual([
      { status: 'not-installed', selector: 'alpha', name: 'alpha' },
    ]);
    const output = renderSkillAdd(proposal);
    expect(output).not.toContain('stak remove');
    expect(output).toContain('stak run <agent>');
  });

  it('a push from that machine removes nothing from Cloud main', async () => {
    const root = await temp();
    const { service, createClient } = makeCloud();
    await setupFirstMachine(root, service, createClient);
    const b = await setupFreshPulledMachine(root, service, createClient);

    // Unchanged main: push is a no-op.
    expect((await cloudPreparePush(b.deps)).noop).toBe(true);

    // A real change on B (one new Skill), staged with `add .`, then pushed.
    await seedSkill(
      path.join(b.homeDir, '.agents', 'skills', 'delta'),
      'delta',
    );
    const proposal = await addAll(b);
    expect(proposal.targets.map((target) => target.name)).toEqual(['delta']);
    const push = await cloudApplyPush(b.deps, await cloudPreparePush(b.deps));
    expect(push.versionNumber).toBe(2);

    // A third, fresh machine pulls v2 and gets every Skill — nothing was dropped.
    const c = makeMachine(root, 'c', createClient);
    await loginAs(service, c);
    await cloudApplyPull(c.deps, await cloudPreparePull(c.deps));
    expect(await skillNamesInMain(c)).toEqual([
      'alpha',
      'beta',
      'delta',
      'gamma',
    ]);
  });

  it('after `stak run <agent>` installs them, the Skills are satisfied', async () => {
    const root = await temp();
    const { service, createClient } = makeCloud();
    await setupFirstMachine(root, service, createClient);
    const b = await setupFreshPulledMachine(root, service, createClient);

    await runCodexSetup(b);
    const result = await status(b);
    expect(result.skills.every((skill) => skill.state === 'satisfied')).toBe(
      true,
    );
    expect(result.summary.notInstalled).toBe(0);
    expect(renderStatus(result)).toContain('Nothing to add. 3 skills tracked.');
  });

  it('a Skill installed by `stak run` and then deleted from disk is still missing and still offers `stak remove`', async () => {
    const root = await temp();
    const { service, createClient } = makeCloud();
    await setupFirstMachine(root, service, createClient);
    const b = await setupFreshPulledMachine(root, service, createClient);
    await runCodexSetup(b);

    await rm(path.join(b.homeDir, '.agents', 'skills', 'alpha'), {
      recursive: true,
      force: true,
    });
    const result = await status(b);
    const alpha = result.skills.find((skill) => skill.name === 'alpha');
    expect(alpha?.state).toBe('missing');
    expect(result.summary.notInstalled).toBe(0);
    const output = renderStatus(result);
    expect(output).toContain('! alpha  (tracked in main, missing on disk)');
    expect(output).toContain(
      'Run `stak remove <skill>` to deliberately drop a missing Skill from main.',
    );
  });

  it('a Skill captured on the original machine and then deleted from disk is still missing and still offers `stak remove`', async () => {
    const root = await temp();
    const { service, createClient } = makeCloud();
    const a = await setupFirstMachine(root, service, createClient);

    await rm(path.join(a.homeDir, '.agents', 'skills', 'beta'), {
      recursive: true,
      force: true,
    });
    const result = await status(a);
    expect(
      Object.fromEntries(
        result.skills.map((skill) => [skill.name, skill.state]),
      ),
    ).toEqual({ alpha: 'satisfied', beta: 'missing', gamma: 'satisfied' });
    expect(result.summary.notInstalled).toBe(0);
    const output = renderStatus(result);
    expect(output).toContain('! beta  (tracked in main, missing on disk)');
    expect(output).toContain('stak remove <skill>');
    expect(output).not.toContain('not installed here');

    // `add .` still never stages the deletion — removal stays deliberate.
    const proposal = await addAll(a);
    expect(proposal.targets).toEqual([]);
    const after = await loadMainEnvironment({ stackHome: a.stackHome });
    expect(Object.keys(after.lock.skills)).toHaveLength(3);
  });
});
