import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh }),
}));

const { realtimeHandlers, removeChannel, createSupabaseBrowserClient } =
  vi.hoisted(() => {
    const realtimeHandlers: Record<string, Array<() => void>> = {};
    const removeChannel = vi.fn();
    const fakeChannel = {
      on: (_event: string, config: { table: string }, handler: () => void) => {
        (realtimeHandlers[config.table] ??= []).push(handler);
        return fakeChannel;
      },
      subscribe: vi.fn(() => fakeChannel),
    };
    const fakeClient = {
      channel: vi.fn(() => fakeChannel),
      removeChannel,
    };
    const createSupabaseBrowserClient = vi.fn(() => fakeClient);
    return { realtimeHandlers, removeChannel, createSupabaseBrowserClient };
  });

vi.mock('../supabase-browser', () => ({
  createSupabaseBrowserClient,
}));

import { useStakSync } from './use-stak-sync';
import { SYNC_CHANNEL_NAME, emitSync } from './stak-sync';

function Mounted({
  enabled = true,
  freshKey,
  focusMinIntervalMs = 0,
}: {
  enabled?: boolean;
  freshKey?: string;
  focusMinIntervalMs?: number;
}) {
  useStakSync({ enabled, freshKey, focusMinIntervalMs });
  return null;
}

const setHidden = (hidden: boolean) => {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => (hidden ? 'hidden' : 'visible'),
  });
  document.dispatchEvent(new Event('visibilitychange'));
};

afterEach(() => {
  cleanup();
  refresh.mockClear();
  removeChannel.mockClear();
  for (const key of Object.keys(realtimeHandlers)) delete realtimeHandlers[key];
});

describe('useStakSync', () => {
  it('refreshes when another tab broadcasts an invalidation', async () => {
    render(<Mounted />);
    const sender = new BroadcastChannel(SYNC_CHANNEL_NAME);

    sender.postMessage({ domains: ['staks'], at: Date.now() });

    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    sender.close();
  });

  it('does not double-refresh when this same tab is the one that emitted the signal', async () => {
    render(<Mounted />);

    // Simulate what every mutation call site does: emitSync from the SAME module instance
    // this test file and use-stak-sync.ts both import, i.e. the same "tab".
    emitSync(['staks']);

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(refresh).not.toHaveBeenCalled();
  });

  it('still refreshes for a broadcast whose source is a different tab', async () => {
    render(<Mounted />);
    const sender = new BroadcastChannel(SYNC_CHANNEL_NAME);

    sender.postMessage({
      domains: ['staks'],
      at: Date.now(),
      source: 'other-tab-id',
    });

    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    sender.close();
  });

  it('refreshes when the tab becomes visible again', async () => {
    render(<Mounted />);

    setHidden(true);
    setHidden(false);

    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });

  it('refreshes when the window regains focus', async () => {
    render(<Mounted />);

    window.dispatchEvent(new Event('focus'));

    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });

  it('does not refresh on initial mount', async () => {
    render(<Mounted />);

    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(refresh).not.toHaveBeenCalled();
  });

  it('stops reacting to broadcasts after unmount', async () => {
    const { unmount } = render(<Mounted />);
    const sender = new BroadcastChannel(SYNC_CHANNEL_NAME);
    unmount();

    sender.postMessage({ domains: ['staks'], at: Date.now() });
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(refresh).not.toHaveBeenCalled();
    sender.close();
  });

  it('refreshes on an authenticated Realtime invalidation while the tab stays focused', async () => {
    render(<Mounted />);

    realtimeHandlers.user_stacks[0]();

    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });

  it('coalesces a BroadcastChannel signal and a Realtime signal into one refresh', async () => {
    render(<Mounted />);
    const sender = new BroadcastChannel(SYNC_CHANNEL_NAME);

    sender.postMessage({
      domains: ['staks'],
      at: Date.now(),
      source: 'other-tab',
    });
    realtimeHandlers.machines[0]();

    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    sender.close();
  });

  it('cleans up the Realtime subscription on unmount', () => {
    const { unmount } = render(<Mounted />);
    unmount();

    expect(removeChannel).toHaveBeenCalledTimes(1);
  });

  it('stays usable if creating the browser Supabase client throws', () => {
    createSupabaseBrowserClient.mockImplementationOnce(() => {
      throw new Error('no session yet');
    });

    expect(() => render(<Mounted />)).not.toThrow();
  });

  it('skips focus refreshes while the page data is still fresh', async () => {
    render(<Mounted focusMinIntervalMs={60_000} />);

    window.dispatchEvent(new Event('focus'));
    setHidden(true);
    setHidden(false);

    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(refresh).not.toHaveBeenCalled();
  });

  it('never throttles another tab broadcast, even while fresh', async () => {
    render(<Mounted focusMinIntervalMs={60_000} />);
    const sender = new BroadcastChannel(SYNC_CHANNEL_NAME);

    sender.postMessage({ domains: ['staks'], at: Date.now(), source: 'x' });

    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    sender.close();
  });

  it('keeps one Realtime subscription across navigations (freshKey changes)', () => {
    createSupabaseBrowserClient.mockClear();
    const { rerender } = render(<Mounted freshKey="/overview" />);
    rerender(<Mounted freshKey="/skills" />);
    rerender(<Mounted freshKey="/machines" />);

    expect(createSupabaseBrowserClient).toHaveBeenCalledTimes(1);
    expect(removeChannel).not.toHaveBeenCalled();
  });

  it('does nothing while disabled (signed-out or public routes)', async () => {
    createSupabaseBrowserClient.mockClear();
    render(<Mounted enabled={false} />);
    window.dispatchEvent(new Event('focus'));

    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(refresh).not.toHaveBeenCalled();
    expect(createSupabaseBrowserClient).not.toHaveBeenCalled();
  });
});
