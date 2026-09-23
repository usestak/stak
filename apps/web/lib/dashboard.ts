import { CloudServiceError, type CloudService } from '@stack/cloud-server';

import { getCloudService } from './cloud-service';

/** The single Cloud method the dashboard reads; injectable for tests. */
export type DashboardService = Pick<CloudService, 'getEnvironment'>;

// V0.1 has a single private environment per user: `main`. The dashboard presents
// it as one Stack; the shape is future-proofed for more.
const PRIVATE_ENVIRONMENTS = ['main'] as const;

export type WebStackSummary = {
  slug: string;
  name: string;
  skillCount: number;
  cloudVersion: number | null;
  updatedAt: string | null;
};

export type WebStackSkill = {
  name: string;
  description?: string;
  source?: string;
};

export type WebStackDetail = WebStackSummary & {
  skills: WebStackSkill[];
};

/** Signals a real Cloud fetch failure (not a missing/absent Stack). */
export class DashboardLoadError extends Error {
  constructor() {
    super('Could not load your Stacks.');
    this.name = 'DashboardLoadError';
  }
}

const webAuth = (userId: string) => ({ userId, tokenId: 'web-session' });

const isNotFound = (error: unknown): boolean =>
  error instanceof CloudServiceError &&
  error.code === 'remote-environment-not-found';

const skillsFromBundle = (bundle: {
  resolved: { skills: Record<string, { name: string; description?: string }> };
}): WebStackSkill[] =>
  Object.values(bundle.resolved.skills)
    .map((skill) => ({
      name: skill.name,
      ...(skill.description ? { description: skill.description } : {}),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

const loadEnvironment = async (
  service: DashboardService,
  userId: string,
  name: string,
) => {
  try {
    return await service.getEnvironment(webAuth(userId), name);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw new DashboardLoadError();
  }
};

/** All private Stacks the signed-in user has in Cloud (empty if none pushed). */
export const listUserStacks = async (
  userId: string,
  service: DashboardService = getCloudService(),
): Promise<WebStackSummary[]> => {
  const summaries: WebStackSummary[] = [];
  for (const name of PRIVATE_ENVIRONMENTS) {
    const environment = await loadEnvironment(service, userId, name);
    if (!environment) continue;
    const latest = environment.latest;
    summaries.push({
      slug: name,
      name,
      skillCount: latest
        ? Object.keys(latest.bundle.resolved.skills).length
        : 0,
      cloudVersion: latest ? latest.version.versionNumber : null,
      updatedAt: latest ? latest.version.createdAt : null,
    });
  }
  return summaries;
};

/** One private Stack with its resolved Skills, or null when it does not exist. */
export const getUserStack = async (
  userId: string,
  slug: string,
  service: DashboardService = getCloudService(),
): Promise<WebStackDetail | null> => {
  if (
    !PRIVATE_ENVIRONMENTS.includes(
      slug as (typeof PRIVATE_ENVIRONMENTS)[number],
    )
  )
    return null;
  const environment = await loadEnvironment(service, userId, slug);
  if (!environment) return null;
  const latest = environment.latest;
  return {
    slug,
    name: slug,
    skillCount: latest ? Object.keys(latest.bundle.resolved.skills).length : 0,
    cloudVersion: latest ? latest.version.versionNumber : null,
    updatedAt: latest ? latest.version.createdAt : null,
    skills: latest ? skillsFromBundle(latest.bundle) : [],
  };
};
