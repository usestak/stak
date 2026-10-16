import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh }),
}));

type Handler = () => void;

const {
  handlersByTable,
  subscribedFilters,
  removeChannel,
  createSupabaseBrowserClient,
} = vi.hoisted(() => {
  const handlersByTable: Record<string, Handler[]> = {};
  const subscribedFilters: string[] = [];
  const removeChannel = vi.fn();
  const fakeChannel = {
    on: (
      _event: string,
      config: { table: string; filter?: string },
      handler: Handler,
    ) => {
      (handlersByTable[config.table] ??= []).push(handler);
      if (config.filter) subscribedFilters.push(config.filter);
      return fakeChannel;
    },
    subscribe: vi.fn(() => fakeChannel),
  };
  const fakeClient = {
    channel: vi.fn(() => fakeChannel),
    removeChannel,
  };
  const createSupabaseBrowserClient = vi.fn(() => fakeClient);
  return {
    handlersByTable,
    subscribedFilters,
    removeChannel,
    createSupabaseBrowserClient,
  };
});

vi.mock('../supabase-browser', () => ({
  createSupabaseBrowserClient,
}));

import { usePublicStackSync, usePublicProfileSync } from './public-stak-sync';

function MountedStack({ stackId }: { stackId: string }) {
  usePublicStackSync(stackId);
  return null;
}

function MountedProfile({ ownerHandle }: { ownerHandle: string }) {
  usePublicProfileSync(ownerHandle);
  return null;
}

afterEach(() => {
  cleanup();
  refresh.mockClear();
  removeChannel.mockClear();
  for (const key of Object.keys(handlersByTable)) delete handlersByTable[key];
  subscribedFilters.length = 0;
});

describe('usePublicStackSync', () => {
  it('subscribes public_stacks and public_stack_versions filtered to the viewed stack', () => {
    render(<MountedStack stackId="stack-123" />);

    expect(subscribedFilters).toEqual([
      'stack_id=eq.stack-123',
      'stack_id=eq.stack-123',
    ]);
  });

  it('refreshes when a matching public_stacks event fires (e.g. republish/unpublish)', async () => {
    render(<MountedStack stackId="stack-123" />);

    handlersByTable.public_stacks[0]();

    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });

  it('refreshes when a matching public_stack_versions event fires', async () => {
    render(<MountedStack stackId="stack-123" />);

    handlersByTable.public_stack_versions[0]();

    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });

  it('cleans up the channel on unmount', () => {
    const { unmount } = render(<MountedStack stackId="stack-123" />);
    unmount();

    expect(removeChannel).toHaveBeenCalledTimes(1);
  });

  it('stays usable if the browser client throws', () => {
    createSupabaseBrowserClient.mockImplementationOnce(() => {
      throw new Error('offline');
    });

    expect(() => render(<MountedStack stackId="stack-123" />)).not.toThrow();
  });
});

describe('usePublicProfileSync', () => {
  it('subscribes public_stacks filtered to the owner handle', () => {
    render(<MountedProfile ownerHandle="alice" />);

    expect(subscribedFilters).toEqual(['owner_handle=eq.alice']);
  });

  it('refreshes when a matching event fires', async () => {
    render(<MountedProfile ownerHandle="alice" />);

    handlersByTable.public_stacks[0]();

    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });
});
