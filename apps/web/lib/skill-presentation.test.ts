import { describe, expect, it } from 'vitest';

import {
  cliSkillSelector,
  machineReconciliation,
  sourceCheckNote,
  sourcePresentation,
} from './skill-presentation.js';

describe('sourceCheckNote', () => {
  it('distinguishes not-checked, cannot-check, and check-failed; no-update/update-available get no note', () => {
    expect(sourceCheckNote('not-checked')).toBe(
      "Updates haven't been checked yet.",
    );
    expect(sourceCheckNote('cannot-check')).toBe(
      "Can't check for updates from this source.",
    );
    expect(sourceCheckNote('check-failed')).toBe('Check failed.');
    expect(sourceCheckNote('no-update')).toBeUndefined();
    expect(sourceCheckNote('update-available')).toBeUndefined();
  });
});

describe('sourcePresentation', () => {
  it('Local never implies a checkable upstream', () => {
    expect(sourcePresentation({ kind: 'local', checkable: false })).toEqual({
      primary: 'Local source',
      secondary: 'No upstream repository recorded.',
    });
  });

  it('a known Git provider with owner/repo', () => {
    expect(
      sourcePresentation({
        kind: 'git',
        checkable: true,
        host: 'github.com',
        ownerRepo: 'acme/skills',
        trackedRef: 'refs/heads/main',
      }),
    ).toEqual({
      primary: 'GitHub · acme/skills',
      secondary: 'tracked ref: refs/heads/main',
    });
  });

  it('a self-hosted Git host shows the host verbatim (already safe)', () => {
    expect(
      sourcePresentation({
        kind: 'git',
        checkable: false,
        host: 'git.internal.example',
        ownerRepo: 'team/tool',
      }),
    ).toEqual({ primary: 'git.internal.example · team/tool' });
  });

  it('a git source with no parsed host/ownerRepo falls back to a generic label, never a raw string', () => {
    expect(sourcePresentation({ kind: 'git', checkable: false })).toEqual({
      primary: 'Git source',
    });
  });

  it('a snapshot source explains its original source is not tracked', () => {
    expect(sourcePresentation({ kind: 'snapshot', checkable: false })).toEqual({
      primary: 'Unresolved source',
      secondary: "This Skill's original source isn't tracked.",
    });
  });
});

describe('machineReconciliation', () => {
  const approved = 'sha256:' + 'a'.repeat(64);
  const other = 'sha256:' + 'b'.repeat(64);

  it('not reported when the machine has not checked in', () => {
    expect(
      machineReconciliation(
        { machineId: 'm1', installedVersion: approved },
        approved,
        false,
      ),
    ).toEqual({ state: 'not-reported', label: 'Not reported' });
  });

  it('not reported when checked in but no install record for this Skill', () => {
    expect(machineReconciliation(undefined, approved, true)).toEqual({
      state: 'not-reported',
      label: 'Not reported',
    });
  });

  it('not installed when the machine explicitly reports no installed version', () => {
    expect(
      machineReconciliation(
        { machineId: 'm1', installedVersion: null },
        approved,
        true,
      ),
    ).toEqual({ state: 'not-installed', label: 'Not installed' });
  });

  it('matches approved when installed === approved', () => {
    expect(
      machineReconciliation(
        { machineId: 'm1', installedVersion: approved },
        approved,
        true,
      ),
    ).toEqual({ state: 'matches-approved', label: 'Matches approved' });
  });

  it('approved version not installed when installed !== approved', () => {
    expect(
      machineReconciliation(
        { machineId: 'm1', installedVersion: other },
        approved,
        true,
      ),
    ).toEqual({
      state: 'wrong-version',
      label: 'Approved version not installed',
    });
  });
});

describe('cliSkillSelector', () => {
  const all = [
    { skillId: 'skill_aaa', name: 'agent-browser' },
    { skillId: 'skill_bbb', name: 'review-pr' },
    { skillId: 'skill_ccc', name: 'review-pr' },
  ];

  it('prefers the display name when it is unique across the viewer’s Skills', () => {
    expect(cliSkillSelector('skill_aaa', 'agent-browser', all)).toBe(
      'agent-browser',
    );
  });

  it('falls back to the stable entryId when the name is ambiguous', () => {
    expect(cliSkillSelector('skill_bbb', 'review-pr', all)).toBe('skill_bbb');
    expect(cliSkillSelector('skill_ccc', 'review-pr', all)).toBe('skill_ccc');
  });
});
