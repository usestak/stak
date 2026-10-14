# Security

This document describes STAK's security model and the boundaries it does and
does not enforce. It makes no absolute claims ("perfectly secure"); it states
what is actually verified.

## Ownership and unmanaged content

STAK owns only content it created, recorded in a machine-level binding registry
(`$STACK_HOME/state/machines/<id>/bindings.json`) by normalized target path,
Environment entry id, and installed content hash. Filesystem similarity alone
never transfers ownership. Unmanaged or externally-modified content is never
overwritten or deleted without explicit approval; conflicting states block.

### Vendor-managed Skills

STAK does not own, import, snapshot, back up, or publish Claude account-synced
Skills under `~/.claude/skills/synced/` — these are managed by Claude/claude.ai
and may be added, updated, or removed independently. The scanner excludes that
reserved subtree from Skill discovery, so synced Skills never become STAK-owned
direct Skills and never appear as untracked in `stak status`. STAK does not
disable or interfere with Claude syncing; it simply ignores the reserved
location. Claude's `~/.claude/skills/.trash/` is ignored for the same reason — it
holds inactive/recoverable copies of disabled synced Skills. The Codex `.system/`
bundled-Skill subtree is excluded on the same principle. Matching is
case-insensitive and applies only to the reserved directory immediately under
each Skill root. STAK never deletes or rewrites any of these vendor-managed
files.

## Content integrity

Skill content is content-addressed (`sha256:...`) over its files and symlinks.
The Store is immutable and re-hashed on read. Every restore (pull, remote use,
remote try, reference reacquisition, snapshot extraction) verifies the exact
expected hash before the content is trusted or committed.

## Filesystem path fencing (Phase 6.1)

Trial and controlled test/demo mutations are fenced to explicitly created,
STAK-owned temporary roots. Paths are normalized, canonically resolved, and
checked with platform-aware containment before any write or cleanup. Failure to
prove ownership aborts the operation. Real-home canaries guard against accidental
writes to the user's actual HOME.

## Trial isolation boundary

`stack try` runs in a disposable scratch workspace with a temporary HOME,
`USERPROFILE`, and `CODEX_HOME`; `main`, normal bindings, and normal user Skill
roots are byte-for-byte invariant. This is isolation from your setup, not full
process sandboxing: an agent's built-in/system capabilities, administrator
configuration, and OS keyring access may remain available.

### Runtime cleanup ownership

The trial runtime lives entirely under `$STACK_HOME/runtime/<sessionId>/`
(`session.json` marker plus `workspace/`, `home/`, and `codex-home/`). Cleanup is
**marker-last** and component-by-component: after the child process fully closes,
STAK removes each known owned child individually, verifies nothing unexpected
remains, and only then deletes the `session.json` ownership marker and the empty
session root. The trusted marker is therefore never lost while other owned
artifacts remain — the state (runtime exists, marker gone) that Phase 6.1 safety
rules refuse to auto-clean can no longer be created.

After the child fully closes, cleanup waits a small bounded settling period
before the first delete, then retries transient Windows deletion errors (`EPERM`,
`EBUSY`, `ENOTEMPTY`, …) a bounded number of times — never forever, and never by
weakening path containment or force-deleting anything whose ownership cannot be
proven. STAK never terminates descendant processes: it does not kill by PID,
by command line, or by resemblance to a trial. If a component still cannot be
removed, the marker is preserved and its status set to `cleanup-failed` with a
**safe, secret-free diagnostic** (failing component, filesystem error code,
timestamp — never file contents, config, or auth material). The runtime stays
provably STAK-owned so it can be retried later.

Because the marker survives, cleanup is genuinely resumable: before creating a
new runtime, `stack try` conservatively re-scans `$STACK_HOME/runtime` and
retries only prior runtimes that carry a valid marker with status
`cleanup-failed` and whose id matches the directory (paths re-validated, then the
same marker-last cleanup). Unmarked, corrupt, forged, non-`cleanup-failed`, or
outside-`STACK_HOME` directories are never touched, and Phase 6.1 never
auto-deletes an unmarked directory merely because it resembles a trial runtime.
There is no age-based deletion and no broad `stack clean` command.

### Trial config isolation

Only allowlisted Codex root state is bridged into the trial's temporary
`codex-home` — `auth.json` (copied verbatim) and `config.toml` /
`*.config.toml`. Bridged TOML is **sanitized**: personal plugin, marketplace,
and hook tables (`[plugins]`, `[[marketplaces]]`, `[hooks]`, and root-scope
`plugins`/`marketplaces` assignments) are stripped so a Skill trial never
inherits personal plugin-marketplace sources. This matters because Codex
refreshes configured marketplaces at startup — cloning them (background `git`)
into `$CODEX_HOME` — which would both leak the personal environment into the
trial and keep the disposable runtime busy. Only auth and basic launch/model
settings survive; everything else in the file is preserved verbatim, and the
user's real `config.toml` is never modified. Disabling plugins is deliberately
not relied upon, since marketplace refresh can still run for disabled plugins.

## Child-process execution audit

All external processes are spawned with `shell:false` and argument arrays — no
user-controlled string is ever concatenated into a shell command.

| Process        | Where                   | shell | args    | notes                                                                                        |
| -------------- | ----------------------- | ----- | ------- | -------------------------------------------------------------------------------------------- |
| `git`          | reference reacquisition | false | array   | remote/revision as discrete argv; `GIT_TERMINAL_PROMPT=0`; temp workdir; exact hash verified |
| `git`          | provenance detection    | false | array   | `-C <dir>` read-only queries                                                                 |
| agent CLI      | `stack run` launch      | false | inherit | interactive; shim-safe launcher; inherits stdio; env & cwd preserved                         |
| agent CLI      | detection (`--version`) | false | array   | shim-safe probe; 3s timeout; output validated                                                |
| Codex          | `stack try` launch      | false | inherit | shim-safe launcher; temporary HOME/CODEX_HOME                                                |
| browser opener | `stack login`           | false | array   | best-effort; URL also printed                                                                |

### Windows npm shims

Agent CLIs installed via npm (Codex, Cursor Agent, Claude Code) are frequently
`.cmd`/`.bat` batch shims rather than native `.exe` files. Since the
CVE-2024-27980 fix, Node refuses to spawn a batch file with `shell:false`
(it throws `EINVAL`). Detection succeeds regardless because it only probes the
filesystem, so the failure appears only at launch. The agent launcher therefore
routes every launch and `--version` probe through
[`cross-spawn`](https://github.com/moxystudio/node-cross-spawn), which is the
sole launch path for all agents. On Windows cross-spawn invokes `cmd.exe`
**itself with `shell:false`** and applies its own well-tested argument escaping
(`windowsVerbatimArguments`), so:

- **not every launched file is a native binary** — a launched target may be a
  batch shim executed via `cmd.exe`, but never through an interpolated shell
  command string;
- argument-array semantics are preserved end to end — arguments reach the child
  verbatim, and shell metacharacters (`&`, `;`, `|`, `>`) are never interpreted
  (asserted by a no-injection test);
- native `.exe` and Unix shebang executables are spawned directly, unchanged.

A regression test asserts `git` is spawned with `shell:false` and argv arrays
even for shell-metacharacter-laden remotes. A cross-platform launcher test builds
a real npm-style shim in a fenced temp directory (a `.cmd` on Windows, a shebang
script on Unix — never a real global npm path) and verifies argument roundtrip,
`cwd`/environment preservation, exit-code propagation, no shell injection, and —
on Windows — that a direct `shell:false` `.cmd` spawn throws `EINVAL` while the
shim-safe launcher succeeds.

## URLs

- OAuth `next` targets are constrained to same-origin relative paths
  (open-redirect protection).
- The cloud client requires HTTPS outside localhost, uses explicit timeouts, and
  refuses to follow redirects (`redirect: 'error'`) so the bearer token cannot
  leak to another origin.
- Public source remotes are validated before publication: embedded credentials,
  `file://`, local/loopback remotes, and unsafe schemes are rejected (even with
  `--yes`). Public pages render source links only for credential-free http(s).

## Archive extraction

Snapshot archives are verified by transport checksum and canonical Skill-tree
hash before ingest, and extracted only into a staging root. Path traversal
(`../`, absolute, drive, escaping symlinks) is rejected. Cloud data is treated as
untrusted input.

## Cloud authorization

The CLI authenticates with a browser device flow: a confidential device secret
(stored only as a hash server-side) and a human user code that cannot authorize
on its own. The issued opaque `stk_` token is stored only as a hash server-side.
Every private and publish operation derives the user identity from the token; a
client can never act as another user by changing an id. Public reads are
anonymous and expose only intentional public metadata.

## What STAK never uploads

Portable/public payloads never contain: absolute machine paths, HOME/STACK_HOME/
CODEX_HOME, binding paths, Machine baseline/placements, local snapshot ids,
CLI tokens, Git credentials, `auth.json`, or agent authentication. Public Stacks
additionally never carry snapshot bytes. Serialization tests assert the absence
of these strings.

## Telemetry

STAK sends no product analytics or telemetry. Cloud commands contact only the
configured `STACK_API_URL`. External agents/services you run have their own
independent policies.

## Dependency and license posture

- `pnpm audit --prod`: **no known vulnerabilities** at release-candidate time
  (Next.js pinned to a patched 15.5.x; Next's transitive `postcss`/`sharp`
  overridden to patched versions — the web app uses neither a CSS pipeline nor
  `next/image`).
- The published CLI bundle has **no runtime dependencies** (zod, commander, and
  yaml are bundled in).
- Production dependency licenses observed are permissive (MIT / ISC / Apache-2.0;
  `caniuse-lite` is CC-BY-4.0, a data license). No copyleft (GPL/AGPL) production
  dependencies were observed. This is a factual inventory, not legal advice.

## Reporting

See [SECURITY.md](../SECURITY.md).
