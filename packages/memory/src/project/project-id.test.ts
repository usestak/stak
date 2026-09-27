import { describe, expect, it } from 'vitest';

import {
  PROJECT_ID_ENTROPY_BYTES,
  PROJECT_ID_PATTERN,
  PROJECT_ID_SYMBOLS,
  isProjectId,
  mintProjectId,
  shortProjectId,
} from './project-id.js';

describe('logical Project ID', () => {
  it('has the expected opaque, provider-neutral format', () => {
    const id = mintProjectId();
    expect(id).toMatch(PROJECT_ID_PATTERN);
    expect(id.startsWith('prj_')).toBe(true);
    expect(id.length).toBe('prj_'.length + PROJECT_ID_SYMBOLS);
    expect(isProjectId(id)).toBe(true);
    // Provider-neutral: never encodes a provider or "claude".
    expect(id).not.toContain('claude');
  });

  it('draws a full 128 bits of entropy', () => {
    expect(PROJECT_ID_ENTROPY_BYTES).toBe(16);
    // 16 bytes → 128 bits → 26 base32 symbols.
    expect(PROJECT_ID_SYMBOLS).toBe(26);
  });

  it('is unique across many samples', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 5000; i += 1) ids.add(mintProjectId());
    expect(ids.size).toBe(5000);
  });

  it('takes no path/name/content input — it cannot be path-derived', () => {
    // The signature accepts only optional raw entropy (for tests); there is no
    // path, folder, remote, or content parameter, so the ID cannot depend on any.
    expect(mintProjectId.length).toBeLessThanOrEqual(1);
    // Two IDs "for the same project" (same path would be irrelevant) still differ.
    expect(mintProjectId()).not.toBe(mintProjectId());
  });

  it('round-trips deterministically from fixed entropy', () => {
    const entropy = Uint8Array.from(
      Array.from({ length: PROJECT_ID_ENTROPY_BYTES }, (_, i) => i * 7 + 1),
    );
    const a = mintProjectId(entropy);
    const b = mintProjectId(Uint8Array.from(entropy));
    expect(a).toBe(b); // stable serialization for identical entropy
    expect(isProjectId(a)).toBe(true);
  });

  it('rejects malformed ids and offers a display-only short form', () => {
    expect(isProjectId('prj_')).toBe(false);
    expect(isProjectId('nope')).toBe(false);
    expect(isProjectId(42)).toBe(false);
    expect(shortProjectId(mintProjectId())).toMatch(/^prj_.{6}…$/);
  });
});
