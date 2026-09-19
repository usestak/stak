import { spawn } from 'node:child_process';

import {
  AuthenticationExpiredError,
  CloudUnavailableError,
  NotAuthenticatedError,
  createCloudClient,
  type CloudAuthClient,
  type CloudClient,
} from '@stack/cloud-client';
import {
  applyPull,
  applyPush,
  getOrCreateMachineIdentity,
  preparePull,
  preparePush,
  type ApplyPullResult,
  type ApplyPushResult,
  type PullPlan,
  type PushPlan,
} from '@stack/core';
import type { MeResponse } from '@stack/spec';

import { resolveCloudBaseUrl } from './config.js';
import type { CredentialStore } from './credentials.js';

export type CloudClientFactory = (options: {
  baseUrl: string;
  token?: string;
}) => CloudClient & CloudAuthClient;

export type CloudOperationsDeps = {
  stackHome: string;
  env: NodeJS.ProcessEnv;
  credentials: CredentialStore;
  writeOut: (value: string) => void;
  createClient?: CloudClientFactory;
  now?: () => Date;
  openBrowser?: (url: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  machine?: () => Promise<{
    machineId: string;
    platform: string;
    arch: string;
  }>;
};

const defaultCreateClient: CloudClientFactory = (options) =>
  createCloudClient(options);

const defaultOpenBrowser = async (url: string): Promise<void> => {
  try {
    const command =
      process.platform === 'win32'
        ? { file: 'cmd', args: ['/c', 'start', '', url] }
        : process.platform === 'darwin'
          ? { file: 'open', args: [url] }
          : { file: 'xdg-open', args: [url] };
    const child = spawn(command.file, command.args, {
      stdio: 'ignore',
      detached: true,
      shell: false,
    });
    child.unref();
  } catch {
    /* best-effort; the URL is always printed for manual use */
  }
};

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

const defaultMachine = async (stackHome: string) => {
  const identity = await getOrCreateMachineIdentity({ stackHome });
  return {
    machineId: identity.machineId,
    platform: identity.platform,
    arch: identity.arch,
  };
};

const displayName = (user: {
  githubUsername?: string | undefined;
  displayName?: string | undefined;
  userId: string;
}) => user.displayName ?? user.githubUsername ?? user.userId;

export type LoginResult = { user: MeResponse; apiUrl: string };

export const performLogin = async (
  deps: CloudOperationsDeps,
  options: { apiUrl?: string; label?: string; openBrowser?: boolean },
): Promise<LoginResult> => {
  const baseUrl = resolveCloudBaseUrl({
    env: deps.env,
    ...(options.apiUrl ? { override: options.apiUrl } : {}),
  });
  const client = (deps.createClient ?? defaultCreateClient)({ baseUrl });
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? defaultSleep;
  const machine = await (
    deps.machine ?? (() => defaultMachine(deps.stackHome))
  )();

  const start = await client.authStart({
    machine,
    ...(options.label ? { label: options.label } : {}),
  });
  deps.writeOut(
    `Opening Stack in your browser...\n\nIf it does not open, visit:\n\n${start.verificationUri}\n\nCode:\n${start.userCode}\n\nWaiting for authorization...\n`,
  );
  if (options.openBrowser !== false)
    await (deps.openBrowser ?? defaultOpenBrowser)(
      start.verificationUriComplete,
    );

  const deadline = new Date(start.expiresAt).getTime();
  let interval = start.intervalMs;
  while (now().getTime() < deadline) {
    await sleep(interval);
    const result = await client.authToken({ deviceSecret: start.deviceSecret });
    if (result.status === 'pending') continue;
    if (result.status === 'slow_down') {
      interval *= 2;
      continue;
    }
    if (result.status === 'denied')
      throw new NotAuthenticatedError('Authorization was denied.');
    if (result.status === 'expired')
      throw new AuthenticationExpiredError(
        'The login request expired before it was approved.',
      );
    await deps.credentials.write({
      schemaVersion: 1,
      token: result.token,
      tokenId: result.tokenId,
      userId: result.user.userId,
      ...(result.user.githubUsername
        ? { githubUsername: result.user.githubUsername }
        : {}),
      ...(result.user.displayName
        ? { displayName: result.user.displayName }
        : {}),
      ...(result.user.avatarUrl ? { avatarUrl: result.user.avatarUrl } : {}),
      apiUrl: baseUrl,
      createdAt: now().toISOString(),
    });
    deps.writeOut(`\n✓ Signed in as ${displayName(result.user)}\n`);
    return { user: result.user, apiUrl: baseUrl };
  }
  throw new AuthenticationExpiredError(
    'Timed out waiting for browser authorization.',
  );
};

export type LogoutResult = { wasSignedIn: boolean; remoteRevoked: boolean };

export const performLogout = async (
  deps: CloudOperationsDeps,
): Promise<LogoutResult> => {
  const credential = await deps.credentials.read();
  if (!credential) return { wasSignedIn: false, remoteRevoked: false };
  let remoteRevoked = false;
  try {
    const baseUrl = resolveCloudBaseUrl({
      env: deps.env,
      ...(credential.apiUrl ? { storedApiUrl: credential.apiUrl } : {}),
    });
    const client = (deps.createClient ?? defaultCreateClient)({
      baseUrl,
      token: credential.token,
    });
    await client.authRevoke();
    remoteRevoked = true;
  } catch {
    /* Offline or unreachable: fall back to local-only sign-out. */
  }
  await deps.credentials.clear();
  return { wasSignedIn: true, remoteRevoked };
};

export type WhoamiResult = MeResponse & { source: 'server' | 'local' };

export const performWhoami = async (
  deps: CloudOperationsDeps,
): Promise<WhoamiResult> => {
  const credential = await deps.credentials.read();
  if (!credential) throw new NotAuthenticatedError();
  const baseUrl = resolveCloudBaseUrl({
    env: deps.env,
    ...(credential.apiUrl ? { storedApiUrl: credential.apiUrl } : {}),
  });
  const client = (deps.createClient ?? defaultCreateClient)({
    baseUrl,
    token: credential.token,
  });
  try {
    return { ...(await client.me()), source: 'server' };
  } catch (error) {
    if (error instanceof CloudUnavailableError && credential.userId)
      return {
        userId: credential.userId,
        ...(credential.githubUsername
          ? { githubUsername: credential.githubUsername }
          : {}),
        ...(credential.displayName
          ? { displayName: credential.displayName }
          : {}),
        source: 'local',
      };
    throw error;
  }
};

const authenticatedClient = async (
  deps: CloudOperationsDeps,
): Promise<CloudClient> => {
  const credential = await deps.credentials.read();
  if (!credential) throw new NotAuthenticatedError();
  const baseUrl = resolveCloudBaseUrl({
    env: deps.env,
    ...(credential.apiUrl ? { storedApiUrl: credential.apiUrl } : {}),
  });
  return (deps.createClient ?? defaultCreateClient)({
    baseUrl,
    token: credential.token,
  });
};

export const cloudPreparePush = async (
  deps: CloudOperationsDeps,
): Promise<PushPlan> =>
  preparePush({
    stackHome: deps.stackHome,
    client: await authenticatedClient(deps),
  });

export const cloudApplyPush = async (
  deps: CloudOperationsDeps,
  plan: PushPlan,
): Promise<ApplyPushResult> =>
  applyPush({
    stackHome: deps.stackHome,
    plan,
    client: await authenticatedClient(deps),
  });

export const cloudPreparePull = async (
  deps: CloudOperationsDeps,
): Promise<PullPlan> =>
  preparePull({
    stackHome: deps.stackHome,
    client: await authenticatedClient(deps),
  });

export const cloudApplyPull = async (
  deps: CloudOperationsDeps,
  plan: PullPlan,
): Promise<ApplyPullResult> =>
  applyPull({
    stackHome: deps.stackHome,
    plan,
    client: await authenticatedClient(deps),
  });
