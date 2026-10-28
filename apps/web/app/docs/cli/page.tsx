import type { Metadata } from 'next';

import {
  CLI_REFERENCE_COMMANDS,
  type CliCommandGroup,
} from './cli-reference.data';

export const metadata: Metadata = {
  title: 'CLI Reference',
  description:
    'Full command reference for the STAK CLI (`stak`): every command, its syntax, options, and behavior.',
};

/**
 * Presentation-only content for each documented command. Sourced from
 * docs/commands.md and packages/cli/README.md (Task 2) and kept in sync with
 * them rather than re-derived from scratch — this map does not decide which
 * commands exist (that's CLI_REFERENCE_COMMANDS, the drift-guarded source of
 * truth); it only supplies the prose/syntax/options/examples to render for
 * each one.
 */
interface CommandDetail {
  usage: string;
  purpose: string;
  options?: string[];
  examples: string[];
  notes?: string[];
}

const COMMAND_DETAILS: Record<string, CommandDetail> = {
  login: {
    usage: 'stak login [--api-url <url>] [--label <label>] [--no-browser]',
    purpose: 'Sign in to STAK Cloud.',
    options: [
      '--api-url <url> — override the Cloud API base URL',
      '--label <label> — a human-readable label for this device/session',
      '--no-browser — print the device-authorization URL instead of opening a browser',
    ],
    examples: ['stak login', 'stak login --label "work laptop"'],
    notes: [
      'Browser device-authorization flow; stores an opaque token under $STAK_HOME/auth.json.',
    ],
  },
  logout: {
    usage: 'stak logout',
    purpose: 'Sign out of STAK Cloud on this machine.',
    examples: ['stak logout'],
    notes: [
      'Revokes the server token where reachable and removes the local credential.',
    ],
  },
  whoami: {
    usage: 'stak whoami [--json]',
    purpose: 'Show the signed-in account.',
    options: ['--json — print exactly one JSON document to stdout'],
    examples: ['stak whoami', 'stak whoami --json'],
    notes: ['Never prints the token.'],
  },
  init: {
    usage: 'stak init',
    purpose:
      'Capture the current global Skills as the desired Environment `main`.',
    examples: ['stak init'],
  },
  status: {
    usage: 'stak status [--json] [--verbose]',
    purpose:
      'Show machine vs. `main` vs. STAK Cloud: untracked/modified/missing Skills and sync state.',
    options: [
      '--json — print exactly one JSON document to stdout',
      '--verbose — show detailed internal state',
    ],
    examples: ['stak status', 'stak status --json'],
    notes: [
      'Reports satisfied, modified, missing, not installed, uncertain, untracked, and drift states.',
      'Missing: the Skill was on this machine and is gone (`stak remove` drops it from `main` if deliberate). Not installed: in `main` but never set up here, normal right after `stak pull`; run `stak run <agent>`.',
    ],
  },
  add: {
    usage: 'stak add <selector...>',
    purpose:
      'Stage untracked or modified Skills (and, with `.`, Memory/Projects) into `main`, like `git add`.',
    examples: ['stak add some-skill', 'stak add .'],
    notes: [
      '`stak add .` also stages all eligible current Memory (and, via the same local registry sync, portable Project state) into the local Memory manifest — never contacting Cloud.',
      'Staging is local only; nothing reaches STAK Cloud until `stak push`.',
    ],
  },
  diff: {
    usage: 'stak diff [--json]',
    purpose: 'Compare this machine to `main`.',
    options: ['--json — print exactly one JSON document to stdout'],
    examples: ['stak diff', 'stak diff --json'],
    notes: [
      'Reports satisfied, modified, missing, not installed, uncertain, untracked, and drift states.',
    ],
  },
  scan: {
    usage: 'stak scan [--project] [--json]',
    purpose: 'Read-only discovery of Skills across agent roots.',
    options: [
      '--project — scan this project directory in addition to global agent roots',
      '--json — print exactly one JSON document to stdout',
    ],
    examples: ['stak scan', 'stak scan --project --json'],
    notes: ['Never mutates anything.'],
  },
  open: {
    usage: 'stak open [--print]',
    purpose: "Open the STAK web app's Overview with this machine selected.",
    options: ['--print — print the URL instead of launching a browser'],
    examples: ['stak open', 'stak open --print'],
    notes: [
      'URL is `…/overview?machine=<machineId>` — the machine id is the only thing in the URL; no token, secret, or Memory is ever included.',
      'Makes no network call of its own (web sign-in is handled by the browser) and mutates nothing.',
    ],
  },
  use: {
    usage: 'stak use <stak> [--dry-run] [--json] [--yes]',
    purpose: 'Add a STAK layer to `main`.',
    options: [
      '--dry-run — preview the change without applying it',
      '--json — print exactly one JSON document to stdout',
      '--yes — skip the confirmation prompt (non-interactive use)',
    ],
    examples: ['stak use @owner/name', 'stak use ./local-stak --dry-run'],
    notes: [
      '<stak> may be a local path or a public @owner/name.',
      'Desired-state only — no agent directories are changed.',
      'Remote use reacquires exact references, verifies hashes, and persists the imported version locally so subsequent status/diff/remove work offline.',
      '`use` does not launch an agent.',
    ],
  },
  remove: {
    usage: 'stak remove <name|id> [--yes]',
    purpose: 'Remove a STAK layer from `main`.',
    options: ['--yes — skip the confirmation prompt (non-interactive use)'],
    examples: ['stak remove @owner/name', 'stak remove some-local-stak --yes'],
    notes: ['Skills still required by other layers are preserved.'],
  },
  run: {
    usage: 'stak run <codex|cursor|claude> [--dry-run] [--json] [--yes]',
    purpose:
      "Reconcile `main` into an agent's Skill directory, then launch that agent's CLI with the Skills projected.",
    options: [
      '--dry-run — reconcile and preview without launching',
      '--json — add structured output',
      '--yes — skip the confirmation prompt (non-interactive use)',
    ],
    examples: ['stak run claude', 'stak run codex --dry-run'],
    notes: [
      'Verifies the agent is installed first; protects unmanaged content; removes only healthy STAK-owned bindings.',
      '`stak run codex` launches the Codex CLI (`codex` on your PATH), not the ChatGPT desktop app.',
      'The launcher is shim-safe: on Windows an npm `.cmd`/`.bat` shim is executed without a shell and with argument-array semantics preserved.',
    ],
  },
  try: {
    usage: 'stak try <stak> [options] -- <agent>',
    purpose: 'Run a STAK in an isolated agent environment.',
    options: [
      '--dry-run — prepare and preview without launching',
      '--json — print exactly one JSON document to stdout',
    ],
    examples: [
      'stak try @owner/name -- codex',
      'stak try @owner/name --dry-run -- claude',
      'stak try @owner/name -- cursor',
    ],
    notes: [
      'Supported agents: codex, claude, cursor.',
      'Runs in a temporary HOME plus a temporary agent config/state directory (CODEX_HOME, CLAUDE_CONFIG_DIR, or CURSOR_CONFIG_DIR).',
      '<stak> may be local or public.',
      '`main` and normal bindings are untouched — temporary runtime, cleanup after the session.',
      'Cursor trials require authentication: a normal `agent login` session is detected and reused automatically, or set CURSOR_API_KEY or CURSOR_AUTH_TOKEN.',
    ],
  },
  skill: {
    usage:
      'stak skill update [skill] [--json] | stak skill pause <skill> [--json] | stak skill resume <skill> [--json] | stak skill check [skill] [--json]',
    purpose: 'Manage the Skill lifecycle on this machine.',
    examples: [
      'stak skill update',
      'stak skill pause some-skill',
      'stak skill resume some-skill',
      'stak skill check',
    ],
    notes: [
      '`update` installs approved Skill versions on this machine (no selector reconciles every Skill across every detected agent — Codex, Claude Code, Cursor; a selector narrows to that Skill).',
      '`pause`/`resume` change only machine-local desired state — the projection effect is realized on the next `run` or `skill update`.',
      '`check` only contacts each checkable Skill’s source remote and reports the result to Cloud; requires `stak login`. Never approves, installs, pauses, or resumes anything.',
    ],
  },
  project: {
    usage:
      'stak project [list] [--json] | stak project map <project> <directory> [--json] [-y|--yes] | stak project name <project> <name> [--json] | stak project archive <project> [--json] [-y|--yes] | stak project unarchive <project> [--json]',
    purpose:
      'Review logical projects (derived from recovered Memory) and map recovered Memory to a directory on this machine.',
    examples: [
      'stak project',
      'stak project map my-app ~/code/my-app',
      'stak project archive my-app --yes',
    ],
    notes: [
      '`list` is the default subcommand, so `stak project` on its own is equivalent to `stak project list`.',
      '`map` is a local binding only; the path is never shared as project identity. Refused when the directory belongs to a different repository (git-conflict) or already belongs to another logical project (identity-conflict).',
      '`name` sets presentation metadata only — never the Project ID, mapping, or restore behavior. Refused for Git-identified projects, and for empty, too-long (200 characters max), or path-like names.',
      '`archive`/`unarchive` are reversible and mirror the lifecycle change to STAK Cloud when signed in; if offline or unreachable, the failure is reported so you can re-run once connected.',
      'Lifecycle (active/archived) is independent of whether a project is currently available on this machine.',
    ],
  },
  memory: {
    usage:
      'stak memory scan [--json] [--verbose] | stak memory backup [--json] | stak memory status [--json] [--verbose] | stak memory recover [--backup <n>] [--passkey] [--recovery-file <path>] [--json] | stak memory restore [--dry-run] [--json] [--verbose] | stak memory protect [--passkey] [--recovery-file <path>] [--json] | stak memory history [--json]',
    purpose:
      'Private, local, durable agent context — separate from shareable Skills and never publishable.',
    examples: ['stak memory scan', 'stak memory backup', 'stak memory status'],
    notes: [
      '`scan` is read-only discovery of portable Claude memory on this machine; changes nothing.',
      '`backup` copies allowlisted memory into STAK’s private store (read-only capture; native Claude files are never modified) and, when signed in, also uploads it to STAK Cloud. Commits the manifest last.',
      '`status` shows the last memory backup.',
      '`recover` downloads the private memory store from STAK Cloud onto this machine (requires sign-in). Use `recover` for explicit or history-based recovery, or when Memory is Protected; a fresh machine normally gets its Memory from `stak pull` instead.',
      '`restore` writes private memory into native agent Memory files. Local only — never talks to Cloud. Only writes absent targets; a differing existing target is reported as a conflict and left untouched (never merged).',
      '`protect` enables client-side encrypted (Protected) Cloud backup, optionally with a passkey or recovery file.',
      '`history` shows your Memory backup history (newest first).',
      'Memory is currently scoped to Claude Code; Codex and Cursor memory support is planned.',
    ],
  },
  push: {
    usage: 'stak push [--dry-run] [--json] [--yes] [--verbose]',
    purpose:
      'Push main (Skills + staged Memory) to STAK Cloud, creating a new version automatically.',
    options: [
      '--dry-run — preview the push without uploading or committing',
      '--json — emit structured JSON for dry-run',
      '--yes — create the cloud version non-interactively',
      '--verbose — show detailed cloud internals',
    ],
    examples: ['stak push', 'stak push --dry-run'],
    notes: [
      'Synchronizes STAGED Skills and Memory only — nothing unstaged moves silently; run `stak add .` first to stage Memory.',
      'Optimistic conflict protection; no-op when unchanged. Does not change agent bindings.',
    ],
  },
  pull: {
    usage: 'stak pull [--dry-run] [--json] [--yes] [--verbose]',
    purpose:
      'Pull the latest main (Skills + Memory) from STAK Cloud — the normal new-machine recovery path.',
    options: [
      '--dry-run — preview the pull without downloading or mutating main',
      '--json — emit structured JSON for dry-run',
      '--yes — restore local main non-interactively',
      '--verbose — show detailed cloud internals',
    ],
    examples: ['stak pull', 'stak pull --yes'],
    notes: [
      'Restores `main`, Skills, and the latest staged private Memory generation. Reference reacquisition plus a private snapshot download, all verified, then an atomic commit. Does not change agent bindings. Memory is restored on a machine with no local Memory yet; if local Memory already exists here, use `stak memory recover` instead.',
    ],
  },
  publish: {
    usage: 'stak publish <stak> [--slug <slug>] [--dry-run] [--json] [--yes]',
    purpose:
      'Publish a public STAK as @owner/name from a local source or an active local layer.',
    options: [
      '--slug <slug> — choose the published slug explicitly',
      '--dry-run — preview without applying',
      '--json — print exactly one JSON document to stdout',
      '--yes — skip the confirmation prompt (non-interactive use)',
    ],
    examples: ['stak publish ./my-stak --slug my-stak', 'stak publish main'],
  },
};

const GROUP_ORDER: CliCommandGroup[] = [
  'Authentication',
  'Environment',
  'STAKs',
  'Projects',
  'Memory',
  'Cloud & Publishing',
];

const commandsByGroup = (group: CliCommandGroup) =>
  CLI_REFERENCE_COMMANDS.filter((c) => c.group === group);

export default function CliReferencePage() {
  return (
    <>
      <h1>CLI Reference</h1>
      <p className="stak-docs-muted">
        Every command registered by the STAK CLI (<code>stak</code>). All
        mutating commands follow: intent → plan → preview → approval → apply →
        result. Mutations require confirmation; pass <code>--yes</code> for
        non-interactive use — it never bypasses conflicts, integrity failures,
        or privacy blocks. <code>--json</code> (where noted) prints exactly one
        JSON document to stdout and nothing else; it never contains tokens,
        secrets, or signed URLs.
      </p>

      {GROUP_ORDER.map((group) => (
        <section key={group}>
          <h2>{group}</h2>
          {commandsByGroup(group).map(({ name }) => {
            const detail = COMMAND_DETAILS[name];
            if (!detail) return null;
            return (
              <div
                key={name}
                className="stak-docs-card"
                style={{ marginBottom: 10 }}
              >
                <div className="stak-docs-card-title">
                  <code>{name}</code>
                </div>
                <p>{detail.purpose}</p>
                <pre>
                  <code>{detail.usage}</code>
                </pre>
                {detail.options && detail.options.length > 0 ? (
                  <>
                    <p className="stak-docs-muted">Options:</p>
                    <ul>
                      {detail.options.map((option) => (
                        <li key={option}>{option}</li>
                      ))}
                    </ul>
                  </>
                ) : null}
                <p className="stak-docs-muted">Examples:</p>
                <pre>
                  <code>{detail.examples.join('\n')}</code>
                </pre>
                {detail.notes && detail.notes.length > 0 ? (
                  <>
                    <p className="stak-docs-muted">Notes:</p>
                    <ul>
                      {detail.notes.map((note) => (
                        <li key={note}>{note}</li>
                      ))}
                    </ul>
                  </>
                ) : null}
              </div>
            );
          })}
        </section>
      ))}

      <section>
        <h2>stak try — precision example</h2>
        <pre>
          <code>{`stak try

Run a STAK in an isolated agent environment.

Usage:
  stak try <stak> [options] -- <agent>

Supported agents: codex, claude, cursor

Examples:
  stak try @owner/name -- codex
  stak try @owner/name --dry-run -- claude
  stak try @owner/name -- cursor

Behavior:
  - main unchanged
  - normal bindings unchanged
  - temporary runtime
  - cleanup after session`}</code>
        </pre>
      </section>

      <section>
        <h2>stak use — precision example</h2>
        <pre>
          <code>{`stak use

\`use\` does not launch an agent.

Typical workflow:
  stak use @owner/name
  stak run claude`}</code>
        </pre>
      </section>
    </>
  );
}
