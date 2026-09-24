import { describe, expect, it } from 'vitest';

import {
  SpikeNotWiredError,
  createSealWalrusBackendSketch,
  readSealWalrusConfig,
} from './seal-walrus.js';
import {
  createWalrusMemoryClientSketch,
  readWalrusMemoryConfig,
} from './walrus-memory.js';

describe('Option B/C sketches (offline; integration is opt-in)', () => {
  it('reads no config by default, so integration tests skip cleanly', () => {
    expect(readSealWalrusConfig({})).toBeNull();
    expect(readWalrusMemoryConfig({})).toBeNull();
  });

  it('parses Seal+Walrus config only when fully specified via env (no secrets)', () => {
    const config = readSealWalrusConfig({
      STACK_SPIKE_SEAL_WALRUS: '1',
      STACK_SPIKE_SEAL_PACKAGE_ID: '0xpkg',
      STACK_SPIKE_SEAL_KEY_SERVERS: '0xks1,0xks2',
      STACK_SPIKE_WALRUS_UPLOAD_RELAY:
        'https://upload-relay.testnet.walrus.space',
    });
    expect(config).toMatchObject({
      suiNetwork: 'testnet',
      keyServerObjectIds: ['0xks1', '0xks2'],
      threshold: 2,
    });
  });

  it('parses Walrus Memory config and defaults the namespace', () => {
    const config = readWalrusMemoryConfig({
      STACK_SPIKE_WALRUS_MEMORY: '1',
      STACK_SPIKE_MEMWAL_RELAYER_URL: 'https://relayer.example',
      STACK_SPIKE_MEMWAL_OWNER: '0xowner',
    });
    expect(config).toMatchObject({
      mode: 'managed-relayer',
      namespace: 'default',
    });
  });

  it('sketch backends are not wired and refuse to run offline', () => {
    const seal = createSealWalrusBackendSketch({
      suiNetwork: 'testnet',
      sealPackageId: '0xpkg',
      keyServerObjectIds: ['0xks'],
      threshold: 1,
      walrusUploadRelayUrl: 'https://relay',
      storageEpochs: 12,
    });
    expect(() => seal.protect(new Uint8Array())).toThrowError(
      SpikeNotWiredError,
    );

    const memory = createWalrusMemoryClientSketch({
      mode: 'manual-client',
      relayerUrl: 'https://relayer.example',
      namespace: 'default',
      ownerAddress: '0xowner',
    });
    expect(() => memory.remember('hi')).toThrowError(SpikeNotWiredError);
  });

  // A real integration test would run only when the developer opts in with their
  // OWN testnet setup. It is skipped by default and NEVER asserts a live pass here.
  const sealConfig = readSealWalrusConfig();
  it.skipIf(!sealConfig)(
    'opt-in: Seal+Walrus round trip (developer testnet only)',
    () => {
      // Intentionally unimplemented in the spike. Wiring @mysten/seal + @mysten/walrus
      // and a signer is left to an opt-in harness; do not claim this passed.
      expect(sealConfig).not.toBeNull();
    },
  );
});
