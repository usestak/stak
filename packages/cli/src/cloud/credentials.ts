import { randomUUID } from 'node:crypto';
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

export type StoredCredential = {
  schemaVersion: 1;
  token: string;
  tokenId?: string;
  userId?: string;
  githubUsername?: string;
  displayName?: string;
  avatarUrl?: string;
  apiUrl?: string;
  createdAt: string;
};

export interface CredentialStore {
  read(): Promise<StoredCredential | null>;
  write(credential: StoredCredential): Promise<void>;
  clear(): Promise<void>;
}

const isCredential = (value: unknown): value is StoredCredential =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { token?: unknown }).token === 'string' &&
  (value as { token: string }).token.length > 0;

/**
 * File-backed credential storage under $STACK_HOME/auth.json. Writes are atomic
 * and, where supported, restricted to owner read/write. The plaintext token is
 * only ever written to this file — never logged, thrown, or serialized into
 * JSON output or cloud bundles. Windows at-rest protection is a future hardening
 * item (see cloud setup docs).
 */
export const fileCredentialStore = (stackHome: string): CredentialStore => {
  const file = path.join(stackHome, 'auth.json');
  return {
    read: async () => {
      try {
        const parsed = JSON.parse(await readFile(file, 'utf8')) as unknown;
        return isCredential(parsed) ? parsed : null;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    },
    write: async (credential) => {
      await mkdir(path.dirname(file), { recursive: true });
      const temporary = path.join(
        path.dirname(file),
        `.auth.${randomUUID()}.tmp`,
      );
      try {
        await writeFile(temporary, `${JSON.stringify(credential, null, 2)}\n`, {
          encoding: 'utf8',
          flag: 'wx',
          mode: 0o600,
        });
        await chmod(temporary, 0o600).catch(() => undefined);
        await rename(temporary, file);
        await chmod(file, 0o600).catch(() => undefined);
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }
    },
    clear: async () => {
      await rm(file, { force: true });
    },
  };
};
