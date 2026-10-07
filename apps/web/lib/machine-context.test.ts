import { describe, expect, it } from 'vitest';
import type { MachineSummary } from '@stack/spec';
import {
  resolveViewingMachineId,
  machineOption,
  statusLabel,
  machineDot,
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
