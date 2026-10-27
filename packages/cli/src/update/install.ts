import { PACKAGE_NAME, type Env } from './check.js';
import type { ReleaseChannel } from './version.js';

export type PackageManager = 'npm' | 'pnpm';

export type InstallCommand = {
  packageManager: PackageManager;
  command: string;
  args: string[];
  /** The exact command line, as shown to the user. */
  display: string;
};

const looksLikePnpmPath = (value: string | undefined): boolean => {
  if (!value) return false;
  const normalised = value.replace(/\\/g, '/').toLowerCase();
  // pnpm global installs live under `…/pnpm/global/<n>/node_modules/…` (and its virtual
  // store `…/.pnpm/…`); npm globals live under `…/npm/node_modules` or `…/lib/node_modules`.
  return (
    normalised.includes('/.pnpm/') ||
    normalised.includes('/pnpm/global/') ||
    normalised.includes('/pnpm-global/') ||
    /\/pnpm\/[^/]*\/?node_modules\//.test(normalised)
  );
};

/**
 * How was this CLI installed? Checks the package's own path (and `process.argv[1]`) first,
 * then `npm_execpath`. Anything unrecognised defaults to npm.
 */
export const detectPackageManager = (context: {
  packagePaths: ReadonlyArray<string | undefined>;
  env: Env;
}): PackageManager => {
  if (context.packagePaths.some(looksLikePnpmPath)) return 'pnpm';
  const execPath = context.env.npm_execpath?.replace(/\\/g, '/').toLowerCase();
  if (
    execPath &&
    /(?:^|\/)pnpm(?:\.c?js|\.cmd|\.exe)?$|\/pnpm\//.test(execPath)
  )
    return 'pnpm';
  return 'npm';
};

export const installCommandFor = (
  packageManager: PackageManager,
  channel: ReleaseChannel,
): InstallCommand => {
  const target = `${PACKAGE_NAME}@${channel}`;
  const args =
    packageManager === 'pnpm' ? ['add', '-g', target] : ['i', '-g', target];
  return {
    packageManager,
    command: packageManager,
    args,
    display: [packageManager, ...args].join(' '),
  };
};
