import { createHash } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

import {
  copySkillTreeEntries,
  enumerateSkillTree,
  hashSkillTreeEntries,
  validateTreePath,
} from '@stack/shared';
import type { SkillTreeEntry } from '@stack/shared';

import { StackStoreError } from './store.js';
import { contentObjectPaths, ingestSkill, verifyStoredSkill } from './store.js';

const BLOCK = 512;
const encoder = new TextEncoder();

export class ArchiveFormatError extends StackStoreError {
  constructor(message: string, options?: ErrorOptions) {
    super('archive-format-invalid', message, options);
    this.name = 'ArchiveFormatError';
  }
}
export class ArchiveIntegrityError extends StackStoreError {
  constructor(
    public readonly expected: string,
    public readonly actual: string,
  ) {
    super(
      'archive-integrity-mismatch',
      `Archive checksum expected ${expected}, but bytes hash to ${actual}.`,
    );
    this.name = 'ArchiveIntegrityError';
  }
}
export class ArchivePathError extends StackStoreError {
  constructor(
    public readonly entryPath: string,
    options?: ErrorOptions,
  ) {
    super(
      'archive-path-unsafe',
      `Archive entry path is unsafe or unsupported: ${entryPath}`,
      options,
    );
    this.name = 'ArchivePathError';
  }
}

const octal = (value: number, length: number): Uint8Array => {
  const text = value.toString(8).padStart(length - 1, '0');
  if (text.length > length - 1)
    throw new ArchiveFormatError(`Numeric tar field overflow: ${value}`);
  return encoder.encode(`${text}\0`);
};

const writeString = (
  block: Uint8Array,
  offset: number,
  value: string,
  length: number,
): void => {
  const bytes = encoder.encode(value);
  if (bytes.length > length)
    throw new ArchiveFormatError(`Tar field overflow at offset ${offset}`);
  block.set(bytes, offset);
};

/** Split a path into ustar name/prefix, throwing if it cannot fit. */
const splitName = (name: string): { name: string; prefix: string } => {
  if (encoder.encode(name).length <= 100) return { name, prefix: '' };
  const parts = name.split('/');
  for (let cut = 1; cut < parts.length; cut += 1) {
    const prefix = parts.slice(0, cut).join('/');
    const remainder = parts.slice(cut).join('/');
    if (
      encoder.encode(prefix).length <= 155 &&
      encoder.encode(remainder).length <= 100
    )
      return { name: remainder, prefix };
  }
  throw new ArchivePathError(name);
};

const header = (
  entryPath: string,
  typeFlag: '0' | '2' | '5',
  size: number,
  linkTarget: string,
): Uint8Array => {
  const block = new Uint8Array(BLOCK);
  const { name, prefix } = splitName(entryPath);
  writeString(block, 0, name, 100);
  block.set(octal(0o644, 8), 100); // mode
  block.set(octal(0, 8), 108); // uid
  block.set(octal(0, 8), 116); // gid
  block.set(octal(size, 12), 124); // size
  block.set(octal(0, 12), 136); // mtime (fixed for determinism)
  block.fill(0x20, 148, 156); // checksum placeholder (spaces)
  block[156] = typeFlag.charCodeAt(0);
  if (linkTarget) writeString(block, 157, linkTarget, 100);
  writeString(block, 257, 'ustar', 6);
  writeString(block, 263, '00', 2);
  writeString(block, 345, prefix, 155);
  let checksum = 0;
  for (const byte of block) checksum += byte;
  block.set(octal(checksum, 8), 148);
  block[155] = 0x20; // trailing space after the null-terminated checksum
  return block;
};

const concat = (chunks: Uint8Array[]): Uint8Array => {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
};

const pad = (size: number): Uint8Array =>
  new Uint8Array((BLOCK - (size % BLOCK)) % BLOCK);

/** Exported so a caller that downloads already-packed archive bytes (e.g. a public Skill
 *  snapshot fetch) can self-compute `archiveHash` for `extractSnapshotArchiveToStore` — the
 *  real tamper-detection boundary there is the separate `contentHash` check against an
 *  independently-sourced expected value, not this archive-internal consistency check. */
export const archiveHashOf = (bytes: Uint8Array): string =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

export type SkillArchive = {
  bytes: Uint8Array;
  archiveHash: string;
  byteSize: number;
};

/** Serialize canonical Skill tree entries into a deterministic ustar archive. */
export const packSkillTreeEntries = (
  entries: SkillTreeEntry[],
): SkillArchive => {
  const sorted = [...entries].sort((left, right) =>
    left.relativePath < right.relativePath
      ? -1
      : left.relativePath > right.relativePath
        ? 1
        : 0,
  );
  const chunks: Uint8Array[] = [];
  for (const entry of sorted) {
    const entryPath = validateTreePath(entry.relativePath);
    if (entry.type === 'file') {
      chunks.push(header(entryPath, '0', entry.content.length, ''));
      chunks.push(new Uint8Array(entry.content));
      chunks.push(pad(entry.content.length));
    } else {
      chunks.push(header(entryPath, '2', 0, entry.target));
    }
  }
  chunks.push(new Uint8Array(BLOCK));
  chunks.push(new Uint8Array(BLOCK));
  const bytes = concat(chunks);
  return { bytes, archiveHash: archiveHashOf(bytes), byteSize: bytes.length };
};

const readField = (block: Uint8Array, offset: number, length: number): string =>
  new TextDecoder()
    .decode(block.subarray(offset, offset + length))
    .replace(/\0.*$/, '')
    .trim();

/** Parse a ustar archive back into canonical Skill tree entries. */
export const unpackSkillTreeEntries = (bytes: Uint8Array): SkillTreeEntry[] => {
  if (bytes.length % BLOCK !== 0)
    throw new ArchiveFormatError('Archive length is not a multiple of 512.');
  const entries: SkillTreeEntry[] = [];
  let offset = 0;
  while (offset + BLOCK <= bytes.length) {
    const block = bytes.subarray(offset, offset + BLOCK);
    offset += BLOCK;
    if (block.every((byte) => byte === 0)) break;
    if (readField(block, 257, 6) !== 'ustar')
      throw new ArchiveFormatError('Archive entry is not ustar-formatted.');
    const name = readField(block, 0, 100);
    const prefix = readField(block, 345, 155);
    const fullName = prefix ? `${prefix}/${name}` : name;
    const typeFlag = String.fromCharCode(block[156] ?? 0);
    const sizeText = readField(block, 124, 12);
    const size = sizeText ? Number.parseInt(sizeText, 8) : 0;
    if (Number.isNaN(size) || size < 0)
      throw new ArchiveFormatError('Archive entry has an invalid size.');
    let relativePath: string;
    try {
      relativePath = validateTreePath(fullName);
    } catch (error) {
      throw new ArchivePathError(fullName, { cause: error } as ErrorOptions);
    }
    if (typeFlag === '2') {
      const target = readField(block, 157, 100);
      assertSafeSymlinkTarget(relativePath, target);
      entries.push({ relativePath, type: 'symlink', target });
    } else if (typeFlag === '0' || typeFlag === '\0' || typeFlag === '') {
      const content = Buffer.from(bytes.subarray(offset, offset + size));
      entries.push({ relativePath, type: 'file', content });
      offset += size + pad(size).length;
    } else if (typeFlag === '5') {
      // Directories are implied by their contents; skip explicit dir entries.
    } else {
      throw new ArchiveFormatError(
        `Unsupported archive entry type: ${typeFlag}`,
      );
    }
  }
  return entries;
};

const assertSafeSymlinkTarget = (relativePath: string, target: string) => {
  const normalized = target.replaceAll('\\', '/');
  if (
    normalized.length === 0 ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:\//.test(normalized)
  )
    throw new ArchivePathError(relativePath);
  const resolved = path.posix.normalize(
    path.posix.join(path.posix.dirname(relativePath), normalized),
  );
  if (resolved.startsWith('..') || resolved === '..')
    throw new ArchivePathError(relativePath);
};

export type PackStoreObjectOptions = { stackHome: string; contentHash: string };

/** Build a transport archive from an immutable Store object. */
export const packStoreObject = async (
  options: PackStoreObjectOptions,
): Promise<SkillArchive> => {
  const verification = await verifyStoredSkill(options);
  if (verification.state !== 'available')
    throw new StackStoreError(
      'store-object-unavailable',
      `Cannot package ${options.contentHash}: ${verification.state}.`,
    );
  const paths = contentObjectPaths(options.stackHome, options.contentHash);
  const entries = await enumerateSkillTree(paths.contentPath);
  return packSkillTreeEntries(entries);
};

export type ExtractSnapshotArchiveOptions = {
  stackHome: string;
  contentHash: string;
  archiveHash: string;
  bytes: Uint8Array;
  now?: () => Date;
};

/**
 * Verify a downloaded archive's transport checksum, safely extract it, prove the
 * canonical Skill content hash matches expectations, and ingest it into the
 * immutable Store. Cloud data is treated as untrusted input throughout.
 */
export const extractSnapshotArchiveToStore = async (
  options: ExtractSnapshotArchiveOptions,
): Promise<{ contentHash: string; reused: boolean }> => {
  const actualArchiveHash = archiveHashOf(options.bytes);
  if (actualArchiveHash !== options.archiveHash)
    throw new ArchiveIntegrityError(options.archiveHash, actualArchiveHash);
  const entries = unpackSkillTreeEntries(options.bytes);
  const treeHash = hashSkillTreeEntries(entries);
  if (treeHash !== options.contentHash)
    throw new ArchiveIntegrityError(options.contentHash, treeHash);
  const paths = contentObjectPaths(options.stackHome, options.contentHash);
  const staging = `${paths.objectDirectory}.extract.${treeHash.slice(7, 23)}.tmp`;
  try {
    await mkdir(path.dirname(paths.objectDirectory), { recursive: true });
    await copySkillTreeEntries(entries, staging);
    const ingested = await ingestSkill({
      stackHome: options.stackHome,
      sourcePath: staging,
      expectedContentHash: options.contentHash,
      ...(options.now ? { now: options.now } : {}),
    });
    return { contentHash: ingested.contentHash, reused: ingested.reused };
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
};
