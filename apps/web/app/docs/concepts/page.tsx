import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Core Concepts',
  description:
    'Skills, STAKs, Agents, Memory, Projects, Machines, and STAK Cloud — the core concepts behind STAK.',
};

export default function DocsConceptsPage() {
  return (
    <>
      <h1>Core Concepts</h1>
      <p>
        STAK is built from a small number of concepts. This page explains
        each conceptually; command syntax lives on the{' '}
        <code>/docs/cli</code> reference and task-oriented walkthroughs live
        on <code>/docs/workflows</code>.
      </p>

      <h2>Skills</h2>
      <p>
        A Skill is a single capability an AI coding agent can use — a piece
        of instructions, context, or tooling that changes how the agent
        behaves. Skills are the unit STAK tracks, reconciles, and shares; a
        machine's desired state (<code>main</code>) is simply the set of
        Skills you want present, and each agent gets its own projection of
        that set.
      </p>

      <h2>STAKs</h2>
      <p>
        A STAK is a named, versioned bundle of Skills. It can live locally
        (a path on disk) or be published publicly as <code>@owner/name</code>.
        Adding a STAK to <code>main</code>, trying it in isolation, and
        publishing one are all separate operations with different blast
        radii — see <code>/docs/sharing</code> for exactly what a public
        STAK does and does not contain.
      </p>

      <h2>Agents</h2>
      <p>
        An Agent is an AI coding CLI that STAK can reconcile Skills into and
        launch — Codex, Claude Code, and Cursor are first-class and treated
        with equal weight; none is a secondary integration. STAK projects
        your desired Skill set into whichever agent you choose to run, and
        can also run a STAK against an agent temporarily without touching
        your normal setup. See <code>/docs/agents</code> for per-agent
        detail.
      </p>

      <h2>Memory</h2>
      <p>
        Memory is an agent's private, durable context — separate from
        Skills, and never part of a published STAK. It is Cloud-backed
        state tied to your account, meant to back up and restore your
        agent's accumulated context across machines, not to be shared or
        made public. Publishing or sharing a STAK never includes Memory.
      </p>

      <h2>Projects</h2>
      <p>
        A Project is a stable logical identity in STAK Cloud, not a folder.
        The directory on your machine where you work on that project is
        only a machine-specific binding to that identity — the same
        logical Project can be mapped to different local paths on different
        machines, and moving or renaming a local directory never changes
        the Project's identity in Cloud.
      </p>

      <h2>Machines</h2>
      <p>
        A Machine is a single computer where you run agents and reconcile
        Skills. Each machine has its own view of <code>main</code>, its own
        local Project mappings, and its own agent installations — STAK
        compares a machine against the shared desired state rather than
        assuming every machine looks the same.
      </p>

      <h2>STAK Cloud</h2>
      <p>
        STAK Cloud is the account-backed service behind sign-in, published
        STAKs, Project identity, and Memory backup/restore. It is what lets
        a STAK, a Project, or an agent's Memory survive a single laptop and
        follow you across machines.
      </p>
    </>
  );
}
