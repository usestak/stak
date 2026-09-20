import { randomUUID } from 'node:crypto';

import { publicSlugSchema } from '@stack/spec';
import type {
  PublicStackBundle,
  PublishPublicStackVersionResponse,
} from '@stack/spec';
import type { CloudClient, PublicStackClient } from '@stack/cloud-client';

import {
  buildPublicStackBundle,
  resolvePublishSource,
} from './public-stack.js';
import { StackCompositionError } from './stack-loader.js';

export type PublishClient = Pick<CloudClient, 'me'> &
  Pick<PublicStackClient, 'getPublicStack' | 'publishPublicStackVersion'>;

export type PublishPlan = {
  slug: string;
  displayName: string;
  description: string;
  bundle: PublicStackBundle;
  origin: 'local' | 'layer';
  ownerHandle: string | null;
  remoteExists: boolean;
  noop: boolean;
  expectedLatestVersionId: string | null;
  skillCount: number;
  referenceCount: number;
  sourceRemotes: string[];
};

export const preparePublish = async (options: {
  stackHome: string;
  input: string;
  slug?: string;
  client: PublishClient;
}): Promise<PublishPlan> => {
  const source = await resolvePublishSource({
    stackHome: options.stackHome,
    input: options.input,
  });
  // Eligibility (snapshot/credential/non-portable) is enforced here and cannot
  // be bypassed by --yes because it throws before any preview or mutation.
  const bundle = buildPublicStackBundle(source.version);

  const slug =
    options.slug ??
    (publicSlugSchema.safeParse(source.version.name).success
      ? source.version.name
      : undefined);
  if (!slug)
    throw new StackCompositionError(
      'invalid-slug',
      `Stack name "${source.version.name}" is not a valid public slug. Pass --slug <slug>.`,
    );
  if (!publicSlugSchema.safeParse(slug).success)
    throw new StackCompositionError('invalid-slug', `Invalid slug: ${slug}`);

  const me = await options.client.me();
  const handle = me.handle ?? null;
  let remoteExists = false;
  let noop = false;
  let expectedLatestVersionId: string | null = null;
  if (handle) {
    const existing = await options.client.getPublicStack(handle, slug);
    if (existing?.latest) {
      remoteExists = true;
      expectedLatestVersionId = existing.latest.version.versionId;
      if (existing.latest.version.versionHash === bundle.stack.versionHash)
        noop = true;
    }
  }
  const sourceRemotes = [
    ...new Set(
      bundle.requirements.map(
        (requirement) => requirement.restoration.reference.remote,
      ),
    ),
  ].sort();
  return {
    slug,
    displayName: source.version.name,
    description: source.version.description,
    bundle,
    origin: source.origin,
    ownerHandle: handle,
    remoteExists,
    noop,
    expectedLatestVersionId,
    skillCount: bundle.requirements.length,
    referenceCount: bundle.requirements.length,
    sourceRemotes,
  };
};

export const applyPublish = async (options: {
  plan: PublishPlan;
  client: PublishClient;
  idempotencyKey?: string;
}): Promise<PublishPublicStackVersionResponse> =>
  options.client.publishPublicStackVersion(options.plan.slug, {
    slug: options.plan.slug,
    displayName: options.plan.displayName,
    description: options.plan.description,
    bundle: options.plan.bundle,
    expectedLatestVersionId: options.plan.expectedLatestVersionId,
    idempotencyKey: options.idempotencyKey ?? randomUUID(),
  });
