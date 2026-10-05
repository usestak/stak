/**
 * Machine status derivation (Phase P1) — pure, no I/O.
 *
 * STAK has no daemon: a machine's status is derived from its LAST CHECK-IN plus the
 * account's approved ("desired") skill versions. Paused skills are not "Ready", so they
 * never count toward Up to date / Updates waiting. The approved-version store itself
 * arrives in P2 (skill lifecycle); this function takes it as input so the derivation is
 * complete and testable now and the read model wires real desired versions later.
 *
 * Frozen language (see docs/0.1.0-contract.md §10):
 *  - Up to date    — checked in AND Memory backed up AND no Ready skill behind its
 *                    approved version. Always shown with the check-in time.
 *  - Updates waiting — some Ready skill's approved version differs from the installed one.
 *  - Last seen <time> — the check-in timestamp; never "online/offline".
 */

export type InstalledSkill = { skillId: string; installedVersion: string };

/** Account-side approved (desired) version of a skill, and whether it is paused. */
export type ApprovedSkill = {
  skillId: string;
  approvedVersion: string;
  paused: boolean;
};

export type MachineCheckinFacts = {
  lastCheckinAt: string | null;
  memoryBackedUp: boolean;
  skills: InstalledSkill[];
};

export type MachineStatus =
  'never-checked-in' | 'up-to-date' | 'updates-waiting' | 'checked-in'; // checked in, versions current, but Memory not backed up

export type DerivedMachineState = {
  status: MachineStatus;
  lastSeen: string | null;
  upToDate: boolean;
  /** skillIds of Ready skills whose approved version isn't installed on this machine. */
  updatesWaiting: string[];
};

/**
 * Derive a machine's state from its check-in facts and the account's approved skills.
 * Only Ready (non-paused) approved skills are considered. A skill a machine has not
 * reported counts as behind (its approved version is "waiting" to install there).
 */
export const deriveMachineState = (
  facts: MachineCheckinFacts,
  approved: ApprovedSkill[],
): DerivedMachineState => {
  if (facts.lastCheckinAt === null)
    return {
      status: 'never-checked-in',
      lastSeen: null,
      upToDate: false,
      updatesWaiting: [],
    };

  const installed = new Map(
    facts.skills.map((s) => [s.skillId, s.installedVersion]),
  );
  const updatesWaiting = approved
    .filter((a) => !a.paused) // paused skills aren't Ready → excluded
    .filter((a) => installed.get(a.skillId) !== a.approvedVersion)
    .map((a) => a.skillId);

  if (updatesWaiting.length > 0)
    return {
      status: 'updates-waiting',
      lastSeen: facts.lastCheckinAt,
      upToDate: false,
      updatesWaiting,
    };

  // Versions current. "Up to date" additionally requires Memory backed up.
  return {
    status: facts.memoryBackedUp ? 'up-to-date' : 'checked-in',
    lastSeen: facts.lastCheckinAt,
    upToDate: facts.memoryBackedUp,
    updatesWaiting: [],
  };
};
