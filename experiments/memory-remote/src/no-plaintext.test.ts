import { rm } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { InMemoryRemoteBackend } from './backend.js';
import { SECRET_MARKER, writeSyntheticStore } from './fixtures.js';
import { generateRecoveryKey, normalizeRecoveryKey } from './recovery-key.js';
import { protect, type SpikeEvent } from './protect.js';

describe('no plaintext or key material leaks', () => {
  it('keeps memory plaintext, project identity, and the recovery key off the wire and out of logs', async () => {
    const source = await writeSyntheticStore({
      projects: 2,
      filesPerProject: 2,
    });
    const backend = new InMemoryRemoteBackend();
    const recoveryKey = generateRecoveryKey();
    const events: SpikeEvent[] = [];

    await protect({
      stackHome: source.stackHome,
      backend,
      userId: 'user-123',
      recoveryKey,
      generation: 0,
      log: (event) => events.push(event),
    });

    const logText = JSON.stringify(events);
    const remoteText = JSON.stringify(backend.inspect());
    const haystack = `${logText}\n${remoteText}`;

    // Memory content never appears in the clear anywhere off-device.
    expect(haystack).not.toContain(SECRET_MARKER);
    // Project/repo identity lives only inside the encrypted bundle.
    expect(haystack).not.toContain('github.com/example');
    expect(haystack).not.toContain('proj0');
    // The recovery key (and its normalized form) never leaves the device.
    expect(haystack).not.toContain(recoveryKey);
    expect(haystack).not.toContain(normalizeRecoveryKey(recoveryKey));

    // The remote record only carries opaque routing metadata.
    const [record] = backend.inspect().records;
    expect(record).toBeDefined();
    if (record) {
      expect(record.ciphertextLocator).toMatch(/^mem\/user-123\/[0-9a-f-]+$/);
      expect(record.ciphertextSha256).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(record.cryptoVersion).toBe('stack-mem-cipher-v1');
    }

    await rm(source.stackHome, { recursive: true, force: true });
  });
});
