/**
 * Remote Memory (Phase 14B): Standard/Protected Cloud backup & recovery domain.
 *
 * Pure domain + crypto — no CLI, web, or cloud-provider concerns. Storage
 * providers implement `RemoteMemoryBackend`; the CLI orchestrates these functions.
 */
export * from './secure-file.js';
export * from './cipher.js';
export * from './kdf.js';
export * from './bundle-codec.js';
export * from './mmk.js';
export * from './recovery-methods.js';
export * from './bridge.js';
export * from './backend.js';
export * from './modes.js';
export * from './local-key-store.js';
