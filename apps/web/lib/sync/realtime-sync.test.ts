import { describe, expect, it, vi } from 'vitest';

import {
  PRIVATE_REALTIME_TABLES,
  subscribePrivateRealtime,
} from './realtime-sync';

type Handler = (payload: unknown) => void;

function createFakeClient() {
  const handlersByTable: Record<string, Handler[]> = {};
  const removeChannel = vi.fn();
  const channel = {
    on: (_event: string, config: { table: string }, handler: Handler) => {
      (handlersByTable[config.table] ??= []).push(handler);
      return channel;
    },
    subscribe: vi.fn(() => channel),
  };
  const client = {
    channel: vi.fn(() => channel),
    removeChannel,
  };
  return { client, handlersByTable, removeChannel };
}

describe('subscribePrivateRealtime', () => {
  it('subscribes to exactly the five approved private tables', () => {
    expect(PRIVATE_REALTIME_TABLES.sort()).toEqual(
      [
        'machine_project_presence',
        'machine_skill_versions',
        'machines',
        'user_stack_versions',
        'user_stacks',
      ].sort(),
    );
  });

  it('never subscribes to memory_backups', () => {
    expect(PRIVATE_REALTIME_TABLES).not.toContain('memory_backups');
  });

  it('maps user_stacks and user_stack_versions events to staks/publication/sidebar/overview', () => {
    const { client, handlersByTable } = createFakeClient();
    const onInvalidate = vi.fn();
    subscribePrivateRealtime(client as never, onInvalidate);

    handlersByTable.user_stacks[0]({ some: 'row-content-to-ignore' });
    expect(onInvalidate).toHaveBeenCalledWith([
      'staks',
      'publication',
      'sidebar',
      'overview',
    ]);

    onInvalidate.mockClear();
    handlersByTable.user_stack_versions[0]({});
    expect(onInvalidate).toHaveBeenCalledWith([
      'staks',
      'publication',
      'sidebar',
      'overview',
    ]);
  });

  it('maps machines events to machines/memory/sidebar/overview', () => {
    const { client, handlersByTable } = createFakeClient();
    const onInvalidate = vi.fn();
    subscribePrivateRealtime(client as never, onInvalidate);

    handlersByTable.machines[0]({});
    expect(onInvalidate).toHaveBeenCalledWith([
      'machines',
      'memory',
      'sidebar',
      'overview',
    ]);
  });

  it('maps machine_skill_versions events to skills/sidebar/overview', () => {
    const { client, handlersByTable } = createFakeClient();
    const onInvalidate = vi.fn();
    subscribePrivateRealtime(client as never, onInvalidate);

    handlersByTable.machine_skill_versions[0]({});
    expect(onInvalidate).toHaveBeenCalledWith([
      'skills',
      'sidebar',
      'overview',
    ]);
  });

  it('maps machine_project_presence events to projects/sidebar/overview', () => {
    const { client, handlersByTable } = createFakeClient();
    const onInvalidate = vi.fn();
    subscribePrivateRealtime(client as never, onInvalidate);

    handlersByTable.machine_project_presence[0]({});
    expect(onInvalidate).toHaveBeenCalledWith([
      'projects',
      'sidebar',
      'overview',
    ]);
  });

  it('never passes the event payload to onInvalidate', () => {
    const { client, handlersByTable } = createFakeClient();
    const onInvalidate = vi.fn();
    subscribePrivateRealtime(client as never, onInvalidate);

    handlersByTable.machines[0]({ sensitive: 'row data' });
    expect(onInvalidate).toHaveBeenCalledWith(expect.any(Array));
    expect(onInvalidate.mock.calls[0]).toHaveLength(1);
  });

  it('returns an unsubscribe function that removes the channel', () => {
    const { client, removeChannel } = createFakeClient();
    const unsubscribe = subscribePrivateRealtime(client as never, vi.fn());

    unsubscribe();
    expect(removeChannel).toHaveBeenCalledTimes(1);
  });
});
