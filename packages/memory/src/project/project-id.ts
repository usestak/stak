import { randomBytes } from 'node:crypto';

/**
 * Stable logical Project IDs (Phase 15B).
 *
 * A Project ID is the opaque, durable spine of a logical project (see
 * `docs/architecture/project-identity.md`). It is:
 *   - opaque and random (128 bits of CSPRNG entropy)
 *   - provider-neutral (no "claude" or any provider encoded)
 *   - independent of path, username, machine, folder name, and file contents
 *   - stable after creation
 *
 * It is NEVER derived from a Git remote, a filesystem path, or content — Git is an
 * identity *claim* associated with the logical project, not the ID itself.
 */

export const PROJECT_ID_PREFIX = 'prj_' as const;

/** 128 bits of entropy. */
export const PROJECT_ID_ENTROPY_BYTES = 16;

/** Crockford base32 alphabet (lowercased, excludes i/l/o/u to stay unambiguous). */
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

/** 128 bits / 5 bits-per-symbol = 25.6 → 26 symbols. */
export const PROJECT_ID_SYMBOLS = Math.ceil((PROJECT_ID_ENTROPY_BYTES * 8) / 5);

export const PROJECT_ID_PATTERN = new RegExp(
  `^${PROJECT_ID_PREFIX}[${ALPHABET}]{${PROJECT_ID_SYMBOLS}}$`,
);

/** Encode raw bytes as fixed-width Crockford base32 (no padding). */
const encodeBase32 = (bytes: Uint8Array): string => {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(value >>> bits) & 0b11111];
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 0b11111];
  return out;
};

/**
 * Mint a new logical Project ID. `entropy` is injectable ONLY for deterministic
 * tests; production always draws fresh CSPRNG bytes. There is deliberately no path,
 * name, or content parameter — the ID cannot depend on any of them.
 */
export const mintProjectId = (entropy?: Uint8Array): string => {
  const bytes = entropy ?? randomBytes(PROJECT_ID_ENTROPY_BYTES);
  if (bytes.length !== PROJECT_ID_ENTROPY_BYTES)
    throw new Error(
      `Project ID entropy must be ${PROJECT_ID_ENTROPY_BYTES} bytes.`,
    );
  return `${PROJECT_ID_PREFIX}${encodeBase32(bytes).slice(0, PROJECT_ID_SYMBOLS)}`;
};

/** Whether a string is a well-formed Project ID. */
export const isProjectId = (value: unknown): value is string =>
  typeof value === 'string' && PROJECT_ID_PATTERN.test(value);

/** A short, display-only form of a Project ID (never used for matching). */
export const shortProjectId = (projectId: string): string =>
  `${projectId.slice(0, PROJECT_ID_PREFIX.length + 6)}…`;
