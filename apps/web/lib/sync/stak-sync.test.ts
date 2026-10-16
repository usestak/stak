import { afterEach, describe, expect, it } from 'vitest';

import { SYNC_CHANNEL_NAME, emitSync, type SyncMessage } from './stak-sync';

const openChannels: BroadcastChannel[] = [];
const track = (channel: BroadcastChannel) => {
  openChannels.push(channel);
  return channel;
};

afterEach(() => {
  while (openChannels.length > 0) openChannels.pop()?.close();
});

describe('emitSync', () => {
  it('delivers a domains+timestamp invalidation to another listener on the channel', async () => {
    const listener = track(new BroadcastChannel(SYNC_CHANNEL_NAME));
    const received = new Promise<SyncMessage>((resolve) => {
      listener.onmessage = (event: MessageEvent<SyncMessage>) =>
        resolve(event.data);
    });

    emitSync(['staks', 'sidebar']);

    const message = await received;
    expect(message.domains).toEqual(['staks', 'sidebar']);
    expect(typeof message.at).toBe('number');
  });

  it('never sends entity content — only the domain list and a timestamp', async () => {
    const listener = track(new BroadcastChannel(SYNC_CHANNEL_NAME));
    const received = new Promise<SyncMessage>((resolve) => {
      listener.onmessage = (event: MessageEvent<SyncMessage>) =>
        resolve(event.data);
    });

    emitSync(['publication']);

    const message = await received;
    expect(Object.keys(message).sort()).toEqual(['at', 'domains']);
  });

  it('is a no-op for an empty domain list', async () => {
    const listener = track(new BroadcastChannel(SYNC_CHANNEL_NAME));
    let gotMessage = false;
    listener.onmessage = () => {
      gotMessage = true;
    };

    emitSync([]);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(gotMessage).toBe(false);
  });
});
