import { describe, expect, it } from 'vitest';
import type { MachineSummary } from '@stack/spec';
import {
  resolveViewingMachineId,
  machineOption,
  statusLabel,
  machineDot,
  displayAgent,
  displayName,
} from './machine-context.js';

const A1 = '00000000-0000-4000-8000-0000000000a1';
const B2 = '00000000-0000-4000-8000-0000000000b2';

const machine = (over: Partial<MachineSummary> = {}): MachineSummary => ({
  machineId: A1,
  name: 'Atlas',
  platform: 'darwin',
  arch: 'arm64',
  agentsDetected: ['Claude Code'],
  firstSeenAt: new Date().toISOString(),
  lastCheckinAt: new Date().toISOString(),
  memoryBackedUp: true,
  revoked: false,
  status: 'up-to-date',
  updatesWaiting: [],
  projectsPresent: 7,
  ...over,
});

describe('resolveViewingMachineId', () => {
  it('prefers a valid requested machine', () => {
    const active = [machine({ machineId: A1 }), machine({ machineId: B2 })];
    expect(resolveViewingMachineId(active, B2)).toBe(B2);
  });
  it('ignores an unknown requested machine id', () => {
    const active = [machine({ machineId: A1 }), machine({ machineId: B2 })];
    expect(resolveViewingMachineId(active, 'not-a-real-id')).toBeUndefined();
  });
  it('auto-selects the single active machine when none requested', () => {
    const active = [machine({ machineId: A1 })];
    expect(resolveViewingMachineId(active, undefined)).toBe(A1);
  });
  it('returns undefined when multiple machines and none requested', () => {
    const active = [machine({ machineId: A1 }), machine({ machineId: B2 })];
    expect(resolveViewingMachineId(active, undefined)).toBeUndefined();
  });

  // Launch UX fix (persisted active-machine preference): the persisted value
  // (now sourced from a cookie as a navigation fallback, not just the URL) is
  // never trusted on its own — it only ever reaches this function as
  // `requested`, which is validated against the CALLER'S OWN per-request
  // `active` list. These two cases are the actual safety guarantee for a
  // stale/revoked/cross-account cookie value, regardless of where it came
  // from.
  it('rejects a persisted selection that is no longer in the active list (revoked/deleted machine), falling back to the chooser when more than one machine remains', () => {
    const C3 = '00000000-0000-4000-8000-0000000000c3';
    const active = [machine({ machineId: A1 }), machine({ machineId: C3 })];
    // B2 was presumably valid once (e.g. revoked since) - it must never be
    // trusted just because it was "remembered", and with 2+ remaining active
    // machines this must NOT silently auto-select either.
    expect(resolveViewingMachineId(active, B2)).toBeUndefined();
  });

  it('rejects a persisted selection belonging to a different account (cross-user isolation)', () => {
    const C3 = '00000000-0000-4000-8000-0000000000c3';
    // Account B's active machines never include A1 - a cookie carried over
    // from a previous login on the same browser must be ignored exactly like
    // any other invalid id, never silently honored, even when account B also
    // has multiple machines (so this isn't just the single-machine
    // auto-select path masking the check).
    const accountBActive = [
      machine({ machineId: B2 }),
      machine({ machineId: C3 }),
    ];
    expect(resolveViewingMachineId(accountBActive, A1)).toBeUndefined();
  });

  it('with exactly one owned machine, a stale/foreign requested id never leaks through - it still resolves to the one machine this account actually owns', () => {
    const active = [machine({ machineId: A1 })];
    // B2 here stands in for ANY untrusted requested value (stale, revoked, or
    // another account's id) - the result is always the caller's own single
    // active machine, never the untrusted input itself.
    expect(resolveViewingMachineId(active, B2)).toBe(A1);
  });
});

describe('machineDot / statusLabel', () => {
  it('up-to-date is ready/green with a time', () => {
    const m = machine({ status: 'up-to-date' });
    expect(machineDot(m)).toBe('ready');
    expect(statusLabel(m)).toMatch(/^Up to date/);
  });
  it('never-checked-in is neutral, never claims online/offline', () => {
    const m = machine({ status: 'never-checked-in', lastCheckinAt: null });
    expect(machineDot(m)).toBe('neutral');
    expect(statusLabel(m)).toBe('No check-in yet');
  });
});

describe('displayAgent', () => {
  it('maps the raw AgentId to a friendly product name', () => {
    expect(displayAgent('codex')).toBe('Codex');
    expect(displayAgent('cursor')).toBe('Cursor');
    expect(displayAgent('claude')).toBe('Claude Code');
  });
  it('passes an unknown id through unchanged rather than guessing', () => {
    expect(displayAgent('some-future-agent')).toBe('some-future-agent');
  });
});

describe('machineOption', () => {
  it('never exposes a raw path or secret, only name/meta/status', () => {
    const opt = machineOption(machine());
    expect(opt).toEqual({
      machineId: A1,
      name: 'Atlas',
      secondary: expect.stringContaining('·'),
      statusLabel: expect.any(String),
    });
  });
});

describe('displayName', () => {
  it('shows the bare name when no disambiguation list is given', () => {
    expect(displayName(machine({ name: 'DELL' }))).toBe('DELL');
  });

  it('shows the bare name when it is unique across the active list', () => {
    const all = [
      machine({ machineId: A1, name: 'DELL' }),
      machine({ machineId: B2, name: 'Atlas' }),
    ];
    expect(displayName(all[0]!, all)).toBe('DELL');
  });

  it('appends a deterministic short discriminator when two machines share a name — e.g. two isolated STAK homes on the same physical laptop', () => {
    const all = [
      machine({ machineId: A1, name: 'DELL' }),
      machine({ machineId: B2, name: 'DELL' }),
    ];
    const first = displayName(all[0]!, all);
    const second = displayName(all[1]!, all);
    expect(first).toMatch(/^DELL · [0-9A-F]{4}$/);
    expect(second).toMatch(/^DELL · [0-9A-F]{4}$/);
    expect(first).not.toBe(second);
  });

  it('derives the discriminator from the stable machineId, not list order', () => {
    const all = [
      machine({ machineId: A1, name: 'DELL' }),
      machine({ machineId: B2, name: 'DELL' }),
    ];
    const reversed = [all[1]!, all[0]!];
    expect(displayName(all[0]!, all)).toBe(displayName(all[0]!, reversed));
  });

  it('never exposes the full raw machineId', () => {
    const all = [
      machine({ machineId: A1, name: 'DELL' }),
      machine({ machineId: B2, name: 'DELL' }),
    ];
    expect(displayName(all[0]!, all)).not.toContain(A1);
  });
});
