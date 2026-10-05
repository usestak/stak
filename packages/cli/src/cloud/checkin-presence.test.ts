import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  emptyRegistry,
  resolveOrMintProject,
  setBinding,
  writeLocalRegistry,
  type ProjectIdentity,
} from '@stack/memory';

import { listProjects } from '../memory/project-ops.js';
import { projectPresenceFrom } from './checkin.js';

const roots: string[] = [];
const temp = async () => {
  const r = await mkdtemp(path.join(tmpdir(), 'stak-presence-'));
  roots.push(r);
  return r;
};
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((r) => rm(r, { recursive: true, force: true })),
  );
});

const git = (canonical: string): ProjectIdentity => ({
  kind: 'git',
  canonical,
  host: canonical.split('/')[0] as string,
  owner: canonical.split('/')[1] as string,
  repo: canonical.split('/')[2] as string,
});
const local = (vendorKey: string): ProjectIdentity => ({
  kind: 'local',
  vendorKey,
});

/** Presence for a stackHome, reusing the exact Phase 15 availability resolver. */
const presence = async (
  stackHome: string,
  candidates: { dir: string; gitRemote?: string }[],
) =>
  projectPresenceFrom(await listProjects({ stackHome, projects: candidates }));

describe('check-in project presence uses real Phase 15 availability (review #1)', () => {
  it('a Git-canonical project with NO binding is present when its checkout is a candidate', async () => {
    const stackHome = await temp();
    let counter = 0;
    const { registry, projectId } = resolveOrMintProject(
      emptyRegistry(),
      git('github.com/acme/atlas'),
      () => `prj_${(counter++).toString(36).padStart(26, '0')}`,
    );
    await writeLocalRegistry(stackHome, registry); // NO binding written
    const checkoutDir = await temp();
    const result = await presence(stackHome, [
      { dir: checkoutDir, gitRemote: 'https://github.com/acme/atlas.git' },
    ]);
    expect(result).toEqual([{ projectId, present: true }]);
  });

  it('an explicitly mapped local project is present', async () => {
    const stackHome = await temp();
    let counter = 0;
    const minted = resolveOrMintProject(
      emptyRegistry(),
      local('C--old-nexus'),
      () => `prj_${(counter++).toString(36).padStart(26, '0')}`,
    );
    const dir = await temp();
    const bound = setBinding(minted.registry, {
      projectId: minted.projectId,
      dir,
      boundAt: '2026-10-05T00:00:00.000Z',
      provenance: 'user-map',
    });
    await writeLocalRegistry(stackHome, bound);
    const result = await presence(stackHome, []);
    expect(result).toEqual([{ projectId: minted.projectId, present: true }]);
  });

  it('a known project with no binding and no matching checkout is not present', async () => {
    const stackHome = await temp();
    let counter = 0;
    const { registry, projectId } = resolveOrMintProject(
      emptyRegistry(),
      git('github.com/acme/atlas'),
      () => `prj_${(counter++).toString(36).padStart(26, '0')}`,
    );
    await writeLocalRegistry(stackHome, registry);
    // No candidate checkout, no binding → unavailable → present: false.
    const result = await presence(stackHome, []);
    expect(result).toEqual([{ projectId, present: false }]);
  });
});
