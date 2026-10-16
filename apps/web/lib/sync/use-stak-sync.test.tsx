import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh }),
}));

import { useStakSync } from './use-stak-sync';
import { SYNC_CHANNEL_NAME } from './stak-sync';

function Mounted() {
  useStakSync();
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
});

describe('useStakSync', () => {
  it('refreshes when another tab broadcasts an invalidation', async () => {
    render(<Mounted />);
    const sender = new BroadcastChannel(SYNC_CHANNEL_NAME);

    sender.postMessage({ domains: ['staks'], at: Date.now() });

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
});
