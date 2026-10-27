import type {
  EnvironmentLock,
  EnvironmentManifest,
  EnvironmentStackLayer,
  ImportedStackVersion,
  RequirementOrigin,
  ResolvedEnvironment,
  ResolvedEnvironmentSkill,
} from '@stack/spec';

type ResolveOptions = {
  manifest: EnvironmentManifest;
  lock: EnvironmentLock;
  versions: Map<string, ImportedStackVersion>;
  idFactory: () => string;
};
type Candidate = Omit<ResolvedEnvironmentSkill, 'entryId' | 'origins'> & {
  origin: RequirementOrigin;
  required: boolean;
};

const versionKey = (layer: EnvironmentStackLayer) =>
  `${layer.stackId}\0${layer.versionHash}`;

export const resolveEnvironment = (
  options: ResolveOptions,
): ResolvedEnvironment => {
  const candidates: Candidate[] = [];
  for (const entry of options.manifest.skills) {
    const locked = options.lock.skills[entry.id];
    if (!locked) continue;
    candidates.push({
      name: entry.name,
      contentHash: locked.contentHash,
      metadata: locked.metadata ?? {
        name: entry.name,
        description: locked.description,
      },
      restoration: locked.restoration,
      observedSources: locked.observedSources,
      ...(locked.preferredSource
        ? { preferredSource: locked.preferredSource }
        : {}),
      origin: { type: 'direct', entryId: entry.id },
      required: true,
    });
  }
  for (const layer of options.manifest.stacks) {
    const version = options.versions.get(versionKey(layer));
    if (!version)
      throw new Error(`Imported Stack version is missing: ${layer.name}`);
    for (const requirement of version.requirements)
      candidates.push({
        name: requirement.name,
        contentHash: requirement.contentHash,
        metadata: requirement.metadata,
        restoration: requirement.restoration,
        observedSources: requirement.observedSources,
        ...(requirement.preferredSource
          ? { preferredSource: requirement.preferredSource }
          : {}),
        origin: {
          type: 'stack',
          layerId: layer.id,
          stackId: layer.stackId,
          stackName: requirement.originStackName,
          requirementId: requirement.id,
          requirement: requirement.requirement,
        },
        required: requirement.requirement === 'required',
      });
  }
  const selected = new Map<
    string,
    { candidate: Candidate; origins: RequirementOrigin[] }
  >();
  const skipped: ResolvedEnvironment['skipped'] = [];
  const conflicts: ResolvedEnvironment['conflicts'] = [];
  const renamed: ResolvedEnvironment['renamed'] = [];
  // Candidates are pushed main's own direct Skills first, then each Stack layer in manifest
  // order (`[...current.manifest.stacks, layer]` in composition.ts always appends the Stack
  // being newly added last) — so when two required candidates of the same name collide here,
  // `current` is always whatever was already selected (main, or an earlier-added layer) and
  // `candidate` is always the newcomer. Disambiguating the newcomer, never what was already
  // there, is what keeps this deterministic and least-surprising.
  const disambiguate = (name: string, stackName: string): string => {
    let candidateName = `${stackName}-${name}`;
    let suffix = 2;
    while (selected.has(candidateName))
      candidateName = `${stackName}-${name}-${suffix++}`;
    return candidateName;
  };
  for (const candidate of candidates) {
    const current = selected.get(candidate.name);
    if (!current) {
      selected.set(candidate.name, { candidate, origins: [candidate.origin] });
      continue;
    }
    if (current.candidate.contentHash === candidate.contentHash) {
      current.origins.push(candidate.origin);
      const observedSources = [
        ...current.candidate.observedSources,
        ...candidate.observedSources,
      ].filter(
        (source, index, all) =>
          all.findIndex(
            (item) => JSON.stringify(item) === JSON.stringify(source),
          ) === index,
      );
      if (
        current.candidate.restoration.strategy === 'snapshot' &&
        candidate.restoration.strategy === 'reference'
      )
        current.candidate = { ...candidate, observedSources };
      else current.candidate = { ...current.candidate, observedSources };
      continue;
    }
    if (current.candidate.required && candidate.required) {
      // Both required, different content, same name: rather than block resolution entirely,
      // keep both — the newcomer is selected under a name disambiguated by its originating
      // Stack, so neither the Skill already in place nor the one being pulled in is lost.
      // Only a Stack-sourced newcomer can be disambiguated this way (its `stackName` is what
      // makes the new name meaningful and deterministic); a direct Skill colliding with
      // another direct Skill — which should not happen, since main's own Skill names are
      // already kept unique — has no such name to borrow, so it still falls back to a
      // reported conflict rather than inventing one.
      if (candidate.origin.type === 'stack') {
        const renamedTo = disambiguate(
          candidate.name,
          candidate.origin.stackName,
        );
        renamed.push({
          name: candidate.name,
          renamedTo,
          contentHash: candidate.contentHash,
          origin: candidate.origin,
        });
        selected.set(renamedTo, {
          candidate: { ...candidate, name: renamedTo },
          origins: [candidate.origin],
        });
        continue;
      }
      conflicts.push({
        name: candidate.name,
        candidates: [
          {
            contentHash: current.candidate.contentHash,
            origins: current.origins,
          },
          { contentHash: candidate.contentHash, origins: [candidate.origin] },
        ],
      });
      continue;
    }
    if (current.candidate.required) {
      skipped.push({
        name: candidate.name,
        contentHash: candidate.contentHash,
        origin: candidate.origin,
        reason: 'required-wins',
      });
      continue;
    }
    if (candidate.required) {
      skipped.push({
        name: current.candidate.name,
        contentHash: current.candidate.contentHash,
        origin: current.origins[0],
        reason: 'required-wins',
      });
      selected.set(candidate.name, { candidate, origins: [candidate.origin] });
      continue;
    }
    skipped.push({
      name: candidate.name,
      contentHash: candidate.contentHash,
      origin: candidate.origin,
      reason: 'optional-conflict',
    });
  }
  const oldByIdentity = new Map(
    Object.entries(options.lock.skills).map(([id, skill]) => [
      `${skill.name}\0${skill.contentHash}`,
      id,
    ]),
  );
  const skills = [...selected.values()]
    .map(({ candidate, origins }) => {
      const direct = origins.find(
        (item): item is Extract<RequirementOrigin, { type: 'direct' }> =>
          item.type === 'direct',
      );
      const entryId =
        direct?.entryId ??
        oldByIdentity.get(`${candidate.name}\0${candidate.contentHash}`) ??
        `skill_${options.idFactory()}`;
      return {
        entryId,
        name: candidate.name,
        contentHash: candidate.contentHash,
        metadata: candidate.metadata,
        restoration: candidate.restoration,
        observedSources: candidate.observedSources,
        ...(candidate.preferredSource
          ? { preferredSource: candidate.preferredSource }
          : {}),
        origins,
      };
    })
    .sort(
      (a, b) =>
        a.name.localeCompare(b.name) ||
        a.contentHash.localeCompare(b.contentHash),
    );
  return { name: options.manifest.name, skills, skipped, conflicts, renamed };
};

export const importedVersionKey = versionKey;
