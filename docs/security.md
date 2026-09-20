# Security

This document describes Stack's security model and the boundaries it does and
does not enforce. It makes no absolute claims ("perfectly secure"); it states
what is actually verified.

## Ownership and unmanaged content

Stack owns only content it created, recorded in a machine-level binding registry
(`$STACK_HOME/state/machines/<id>/bindings.json`) by normalized target path,
Environment entry id, and installed content hash. Filesystem similarity alone
never transfers ownership. Unmanaged or externally-modified content is never
overwritten or deleted without explicit approval; conflicting states block.

## Content integrity

Skill content is content-addressed (`sha256:...`) over its files and symlinks.
The Store is immutable and re-hashed on read. Every restore (pull, remote use,
remote try, reference reacquisition, snapshot extraction) verifies the exact
expected hash before the content is trusted or committed.

## Filesystem path fencing (Phase 6.1)

Trial and controlled test/demo mutations are fenced to explicitly created,
Stack-owned temporary roots. Paths are normalized, canonically resolved, and
checked with platform-aware containment before any write or cleanup. Failure to
prove ownership aborts the operation. Real-home canaries guard against accidental
writes to the user's actual HOME.

## Trial isolation boundary

`stack try` runs in a disposable scratch workspace with a temporary HOME,
`USERPROFILE`, and `CODEX_HOME`; `main`, normal bindings, and normal user Skill
roots are byte-for-byte invariant. This is isolation from your setup, not full
process sandboxing: an agent's built-in/system capabilities, administrator
configuration, and OS keyring access may remain available.

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

## What Stack never uploads

Portable/public payloads never contain: absolute machine paths, HOME/STACK_HOME/
CODEX_HOME, binding paths, Machine baseline/placements, local snapshot ids,
CLI tokens, Git credentials, `auth.json`, or agent authentication. Public Stacks
additionally never carry snapshot bytes. Serialization tests assert the absence
of these strings.

## Telemetry

Stack sends no product analytics or telemetry. Cloud commands contact only the
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
