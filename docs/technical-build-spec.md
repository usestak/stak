# Stack V0 Technical Build Specification

**Status:** Approved for development
**Version:** 0.1
**Product Foundation:** Frozen
**Primary language:** TypeScript
**Initial runtime:** Node.js 22+
**Initial agents:** Codex, Cursor, Claude Code

---

## 1. Development Objective

Build the smallest technically sound version of Stack that proves the core thesis:

> A developer can discover their accumulated Agent Skills, preserve them as a portable Environment, restore them, compose additional Stacks safely, and test another developer's Stack without destroying their existing setup.

V0 must prioritize:

1. reliability
2. filesystem safety
3. reproducibility
4. transparent behavior
5. cross-agent architecture
6. simple CLI UX

Do not attempt to build the entire long-term Stack platform.

---

## 2. V0 Definition of Done

### Scenario A: Discover

A developer has Skills across supported locations.

They run:

```bash
stack scan
```

Stack reports:

```text
Found 24 unique Skills across 3 agents.

Cursor        18
Codex         15
Claude Code   13

Shared        11
Unknown source 3
```

---

### Scenario B: Establish Desired State

The developer runs:

```bash
stack init
```

Stack creates:

```text
Environment: main
```

representing the desired local setup.

---

### Scenario C: Detect Drift

The developer runs:

```bash
stack status
```

and:

```bash
stack diff
```

Stack identifies:

```text
missing
modified
untracked
conflicting
```

Skills.

---

### Scenario D: Restore

Stack can restore managed Skills from references or snapshots and verify resulting hashes.

---

### Scenario E: Compose

The user runs:

```bash
stack use @someone/frontend
```

Stack:

1. resolves the Stack
2. compares it with the active Environment
3. deduplicates compatible Skills
4. identifies conflicts
5. previews changes
6. requests approval
7. applies transactionally

---

### Scenario F: Try Safely

The user runs:

```bash
stack try @someone/frontend -- codex
```

Stack creates a temporary Environment and launches Codex with access to those Skills.

`main` remains unchanged.

---

### Scenario G: Cloud Portability

Machine A:

```bash
stack push
```

Machine B:

```bash
stack pull
```

Machine B reconstructs the Environment with matching managed Skill hashes.

---

## 3. Technical Principles

### 3.1 Stack Owns Canonical State

Vendor directories are integration targets.

They are not Stack's database.

Canonical Stack state lives under:

```text
~/.stack/
```

---

### 3.2 Use the Existing Agent Skill Format

Stack does not invent a replacement for `SKILL.md`.

A Skill remains an existing Agent Skill directory.

Stack records metadata around it.

---

### 3.3 Core Logic Must Be Agent-Neutral

Do not scatter:

```ts
if (agent === "codex")
```

throughout the codebase.

Vendor-specific behavior belongs in adapters.

---

### 3.4 Local Must Work Without Cloud

These features must work offline:

```text
scan
init
status
diff
local restore
local Stack resolution
local try
```

Cloud is an enhancement, not a prerequisite.

---

## 4. Architecture

```text
                    STACK CLOUD
                         │
                         │ HTTPS
                         ▼
                 ┌──────────────┐
                 │  Stack CLI   │
                 └──────┬───────┘
                        │
             ┌──────────┴──────────┐
             │                     │
             ▼                     ▼
       Stack Core              Local State
             │                     │
     ┌───────┼────────┐       ~/.stack/
     │       │        │
     ▼       ▼        ▼
  Scanner Resolver  Store
     │       │        │
     └───────┴────┬───┘
                  │
              Adapters
          ┌───────┼────────┐
          ▼       ▼        ▼
        Codex   Cursor    Claude
```

---

## 5. Technology Stack

### Monorepo

Use:

```text
pnpm
Turborepo
TypeScript
```

### Runtime

```text
Node.js >= 22
```

Use ESM throughout.

### CLI

Recommended:

```text
commander
@clack/prompts
picocolors
ora
```

CLI handlers should orchestrate.

Core business logic belongs outside the CLI package.

### Validation

Use:

```text
zod
```

for:

* manifests
* lockfiles
* local state
* API payloads
* configuration

### YAML

Use:

```text
yaml
```

for editable manifests.

### Testing

Use:

```text
vitest
```

with filesystem fixtures and temporary directories.

### Cloud

Recommended:

```text
Next.js
Supabase Postgres
Supabase Auth
Supabase Storage
```

The CLI communicates through an HTTP API.

It must not depend directly on Supabase internals.

---

## 6. Repository Structure

```text
stack/
│
├── apps/
│   └── web/
│
├── packages/
│   ├── cli/
│   │   └── src/
│   │       ├── commands/
│   │       ├── ui/
│   │       └── index.ts
│   │
│   ├── core/
│   │   └── src/
│   │       ├── environment/
│   │       ├── stack/
│   │       ├── skill/
│   │       ├── resolver/
│   │       ├── transaction/
│   │       └── plan/
│   │
│   ├── scanner/
│   │   └── src/
│   │       ├── scanner.ts
│   │       ├── roots.ts
│   │       ├── provenance.ts
│   │       └── hash.ts
│   │
│   ├── adapters/
│   │   └── src/
│   │       ├── types.ts
│   │       ├── codex/
│   │       ├── cursor/
│   │       └── claude/
│   │
│   ├── spec/
│   │   └── src/
│   │       ├── stack.schema.ts
│   │       ├── environment.schema.ts
│   │       ├── lock.schema.ts
│   │       └── skill.schema.ts
│   │
│   ├── store/
│   │   └── src/
│   │       ├── content-store.ts
│   │       ├── snapshots.ts
│   │       └── cache.ts
│   │
│   ├── cloud-client/
│   │   └── src/
│   │
│   └── shared/
│       └── src/
│
├── fixtures/
│   ├── skills/
│   ├── environments/
│   ├── stacks/
│   └── machines/
│
├── docs/
│   ├── product-foundation.md
│   └── technical-build-spec.md
│
├── package.json
├── pnpm-workspace.yaml
├── turbo.json
└── tsconfig.base.json
```

---

## 7. Package Responsibilities

### `@stack/core`

Contains:

```text
Skill
Stack
Environment
resolution
conflicts
plans
transactions
drift
revisions
```

No CLI prompts.

No React.

No Supabase imports.

---

### `@stack/scanner`

Read-only discovery.

Returns structured data.

Never modifies vendor Skill directories.

---

### `@stack/adapters`

Translates Stack's canonical Environment into agent-specific behavior.

---

### `@stack/spec`

Canonical schemas.

This package should eventually be independently publishable.

---

### `@stack/store`

Handles:

* immutable Skill content
* content hashes
* snapshots
* cached source content
* runtime materialization

---

### `@stack/cloud-client`

Typed HTTP client for hosted Stack services.

---

### `@stack/cli`

Presentation and command orchestration only.

---

## 8. Local Filesystem

Use:

```text
~/.stack/
```

Suggested structure:

```text
~/.stack/
│
├── config.json
├── machine.json
│
├── environments/
│   ├── main/
│   │   ├── environment.yaml
│   │   ├── stack.lock.json
│   │   └── revisions/
│   │
│   └── work/
│
├── store/
│   └── sha256/
│
├── snapshots/
├── cache/
├── runtime/
│
└── state/
    └── bindings.json
```

Support:

```text
STACK_HOME
```

to override the default location.

---

## 9. Machine Identity

On first use, generate a random UUID.

Store:

```json
{
  "schemaVersion": 1,
  "machineId": "uuid",
  "createdAt": "ISO_DATE",
  "platform": "win32",
  "arch": "x64"
}
```

Do not use hardware serial numbers or invasive fingerprinting.

---

## 10. Skill Identity

Skill names are not globally unique.

Canonical Skill identity should include provenance.

Conceptually:

```text
source + sourcePath + skillName
```

Example:

```text
github:owner/repository:/skills/frontend-design
```

---

## 11. Skill Record

Conceptual shape:

```ts
type SkillRecord = {
  id: string
  name: string
  description?: string

  source: SkillSource

  contentHash: string

  discoveredAt: string

  locations: SkillLocation[]

  agents: AgentId[]

  scope: "global" | "project"

  managed: boolean

  status:
    | "healthy"
    | "modified"
    | "unknown-source"
    | "invalid"
}
```

---

## 12. Skill Source

Use a discriminated union.

```ts
type SkillSource =
  | GitSource
  | LocalSource
  | SnapshotSource
  | UnknownSource
```

Example Git source:

```ts
{
  type: "git",
  remote: "https://github.com/example/repo.git",
  revision: "commit-sha",
  path: "skills/design"
}
```

Snapshot:

```ts
{
  type: "snapshot",
  snapshotId: "snap_..."
}
```

---

## 13. Environment Model

`main` is an Environment.

It can contain:

```text
direct Skills
+
Stacks
+
overrides
```

Example:

```yaml
schemaVersion: 1

name: main

skills:
  - skill: github:foo/bar:/skills/debugging

stacks:
  - "@temi/frontend"
  - "@temi/web3"

overrides: {}
```

---

## 14. Stack Manifest

Use:

```text
stack.yaml
```

Example:

```yaml
schemaVersion: 1

name: creative-frontend

description: >
  Frontend environment for polished interactive web applications.

extends:
  - "@temi/frontend"

skills:
  - source: github:example/design-skills
    path: skills/design-engineering
    requirement: required

  - source: github:example/threejs
    path: skills/threejs
    requirement: optional
```

Do not place resolved hashes in the human-edited manifest.

---

## 15. Lockfile

Use:

```text
stack.lock.json
```

Example:

```json
{
  "schemaVersion": 1,
  "resolvedAt": "2026-09-17T20:00:00Z",
  "skills": {
    "github:example/design-skills:/skills/design-engineering": {
      "revision": "a53e...",
      "contentHash": "sha256:...",
      "source": "https://github.com/example/design-skills.git"
    }
  }
}
```

The lockfile is the reproducibility layer.

---

## 16. Resolved Environment

Conceptual type:

```ts
type ResolvedEnvironment = {
  environmentId: string

  skills: ResolvedSkill[]

  stacks: ResolvedStack[]

  skippedOptionalSkills: ResolvedSkill[]

  overrides: EnvironmentOverride[]

  warnings: ResolutionWarning[]
}
```

Given identical input and lock data, resolution should be deterministic.

---

## 17. Scanner Roots

Initial global roots:

```text
~/.agents/skills
~/.cursor/skills
~/.claude/skills
$CODEX_HOME/skills
```

Fallback:

```text
~/.codex/skills
```

Potential project roots:

```text
.agents/skills
.cursor/skills
.claude/skills
.codex/skills
```

Default:

```bash
stack scan
```

focuses on global Skills.

Optional:

```bash
stack scan --project
```

includes project Skills.

Project Skills must not automatically enter global `main`.

### Physical Location vs Agent Visibility

Scanner root information records where a Skill physically exists. It does
not assert which agents can consume that Skill. For example, a Skill under
`~/.codex/skills` has the `codex` physical root kind even when another agent
can consume Codex-compatible Skills. Likewise, `~/.agents/skills` is the
shared standard root and does not represent an agent named `agents`.

Effective agent visibility is derived capability information owned by agent
adapters. It is not part of a Skill's canonical physical identity.

### Portable Environment vs Machine Placement State

The scanner's current observation, the portable desired Environment, and the
Machine-specific placement baseline are separate forms of state:

```text
Machine discovery             ScanResult
Portable desired state        Environment manifest + lockfile
Machine observation baseline  Per-Machine Environment state
```

The portable Environment and lock identify logical Skills and resolved content.
They must not contain absolute paths to vendor Skill directories on the Machine
that created them. Observed paths, physical root kinds, symlink targets, and
initial placement belong in per-Machine state under:

```text
~/.stack/state/machines/<machineId>/environments/<environment>.json
```

Logical Skill drift and physical placement drift are also distinct. A desired
content hash is satisfied when it remains available in any successfully observed
supported global root. Removing one of several duplicate placements is placement
drift, not a missing logical Skill. A desired Skill is modified only when baseline
location evidence associates changed content with a previously observed
occurrence. Failed roots make the observation uncertain and must not be converted
into a definite missing result.

---

## 18. Scanner Algorithm

For each root:

1. verify directory exists
2. locate directories containing `SKILL.md`
3. parse frontmatter
4. validate metadata
5. determine scope
6. calculate tree hash
7. inspect provenance
8. detect duplicates
9. associate agents
10. return structured records

The scanner is read-only.

---

## 19. Content Hashing

Use SHA-256.

Hash the complete Skill directory.

Algorithm:

1. recursively enumerate files
2. remove ignored filesystem noise
3. sort paths lexicographically
4. normalize separators to `/`
5. hash path + contents deterministically

Ignore:

```text
.git/
.DS_Store
Thumbs.db
```

Do not ignore:

```text
scripts
assets
references
```

Those are part of the Skill.

### Local Preservation vs Portable Restoration

Every valid Skill imported into an Environment is preserved locally by its exact
content hash, regardless of provenance. Local preservation and portable
restoration strategy are separate facts:

```text
local preservation  immutable bytes available under ~/.stack/store
portable strategy   reference or snapshot metadata used to reacquire those bytes
```

The content-addressed layout is:

```text
~/.stack/store/sha256/<first-two-hex>/<full-hex>/
  content/
  object.json
```

`content/` contains only the canonical Skill tree. `object.json` is Stack metadata
and is not part of the Skill hash. Existing objects are verified before reuse and
are never silently overwritten or repaired when corrupt.

The deterministic tree enumeration and hashing primitive is shared by Scanner and
Store. Store ingestion and materialization therefore use the same ignored noise,
path normalization, file ordering, file bytes, and nested-symlink metadata as
discovery.

### Reference and Snapshot Eligibility

`reference` requires one unambiguous Git observation with a portable HTTPS, SSH,
Git, or SCP-style remote, an exact revision, a repository-relative Skill path, and
a subtree that is clean relative to that revision. Stack determines cleanliness
from local Git state without fetching or contacting the remote. A portable remote
may be public or private; Phase 3 does not attempt to determine accessibility.

When this evidence is incomplete, dirty, local, unknown, non-portable, or
ambiguous, Stack selects `snapshot`. Local snapshot records live under:

```text
~/.stack/snapshots/<snapshotId>.json
```

A snapshot record points to an immutable content-store hash and does not duplicate
the Skill bytes. Cloud archive creation and upload remain deferred.

`stack init` must preserve and verify every included desired Skill before the
complete Environment becomes visible. `stack status` and `stack diff` verify store
objects read-only and report `available`, `missing`, or `corrupt` independently
from logical Machine drift.

Public restore commands remain deferred. Phase 3 materialization is an internal
engine for controlled targets only; writing actual Codex, Cursor, or Claude Skill
roots remains the responsibility of Phase 4+ adapters.

---

## 20. Provenance Detection

Order:

### 1. Existing installer metadata

Use trustworthy lock/installer metadata where available.

### 2. Git metadata

Determine:

```text
remote
commit
relative path
```

### 3. Symlink target

Resolve the target for provenance inspection.

### 4. Local

If only local:

```text
source.type = local
```

### 5. Unknown

If provenance cannot be established:

```text
source.type = unknown
```

Never guess.

---

## 21. Reference vs Snapshot

### Reference

Use when Stack can reliably reacquire the Skill.

Record:

```text
source
revision
path
hash
```

### Snapshot

Use when the Skill is:

* local
* modified
* source-less
* unavailable
* otherwise not reproducible

Snapshot the complete Skill directory.

---

## 22. Content-Addressed Store

Canonical Skill content:

```text
~/.stack/store/sha256/<hash>
```

Example:

```text
~/.stack/store/sha256/
└── 73/
    └── 73a88f...
        ├── SKILL.md
        ├── scripts/
        └── references/
```

Store contents are immutable.

Changed content receives a new hash.

---

## 23. Agent Adapter Contract

### Phase 4 Codex Binding Behavior

Codex currently discovers personal user Skills from:

```text
$HOME/.agents/skills
```

This is Stack's V0 target for newly created Codex bindings. It is resolved from
the actual user home and is independent of `STACK_HOME`.

Legacy Codex locations remain discovery-only:

```text
$CODEX_HOME/skills
~/.codex/skills
```

Stack continues scanning non-system user Skills in those locations, but excludes
the top-level `.system/` subtree because Codex owns those bundled Skills. Stack
does not migrate legacy Skills automatically and does not scan or manage Codex
admin/system locations such as `/etc/codex/skills` in V0.

Binding ownership is Machine-specific and stored under:

```text
$STACK_HOME/state/machines/<machineId>/bindings/codex.json
```

A target is Stack-managed only when this registry records the exact target and
Environment entry. Matching filesystem bytes do not transfer ownership. An
identical unmanaged target may satisfy Codex availability while remaining
external; differing unmanaged content is a blocking conflict.

Codex binding state is separate from Environment status. Environment status asks
whether desired bytes exist in any supported Machine root. Binding status asks
whether those bytes are available at Codex's current user target. Adapter writes
do not refresh the Environment placement baseline, so a new binding may appear as
additional placement drift in later status output.

`stack run codex` loads `main`, detects Codex before mutation, plans and previews
bindings, requires approval for writes, materializes only from the immutable
Store, records ownership atomically, verifies managed bindings, and launches the
normal Codex executable. `--dry-run` performs detection and planning only.
Project `.agents/skills` discovery remains Codex's responsibility during launch.
Isolated homes and `stack try` remain Phase 6 work.

Every adapter implements:

```ts
interface AgentAdapter {
  id: AgentId

  detect(): Promise<AgentDetection>

  discoverSkills(): Promise<SkillLocation[]>

  planBindings(
    environment: ResolvedEnvironment
  ): Promise<BindingPlan>

  applyBindings(
    plan: BindingPlan
  ): Promise<ApplyResult>

  removeBindings(
    plan: BindingPlan
  ): Promise<ApplyResult>

  launch?(
    context: LaunchContext
  ): Promise<number>
}
```

---

## 24. Adapter Priority

Implement in this order:

```text
1. Codex
2. Cursor
3. Claude Code
```

This is implementation order only.

The architecture must remain generic.

---

## 25. Binding Strategy

Canonical content remains under:

```text
~/.stack/store/
```

Agent-facing copies are bindings/materializations.

Track them in:

```text
$STACK_HOME/state/machines/<machineId>/bindings/codex.json
```

Example:

```json
{
  "codex": {
    "frontend-design": {
      "contentHash": "sha256:...",
      "target": "C:/Users/.../.agents/skills/frontend-design"
    }
  }
}
```

Do not consider these copies canonical.

---

## 26. Unmanaged Skills

Before modifying an existing destination, check whether Stack owns it.

If the path exists but is absent from Stack's binding registry:

```text
UNMANAGED
```

Stop and ask.

Example:

```text
Conflict

frontend-design already exists.

Stack does not manage this directory.

Choose:

Import existing Skill
Keep existing Skill
Replace it
Cancel
```

Never silently overwrite it.

---

## 27. Resolver Input

Resolver receives:

```text
active Environment
+
requested Stack
+
lock information
+
overrides
```

---

## 28. Resolution Plan

Conceptual:

```ts
type ResolutionPlan = {
  satisfied: ResolvedSkill[]
  additions: ResolvedSkill[]
  removals: ResolvedSkill[]
  updates: ResolvedSkill[]
  conflicts: Conflict[]
  skipped: ResolvedSkill[]
}
```

---

## 29. V0 Resolver Complexity

Do not build a general SAT solver.

V0 supports:

```text
exact revisions
same-content deduplication
simple compatibility
explicit conflicts
required/optional
overrides
```

Advanced version range solving can come later.

---

## 30. Conflict Rules

### Same canonical Skill + same hash

Deduplicate.

### Same canonical Skill + incompatible revision/hash

Conflict.

### Same target name + different canonical Skill

Name collision.

### Optional conflicting Skill

Can be skipped after disclosure.

### Existing unmanaged target

Ownership conflict.

Requires explicit user choice.

---

## 31. `stack scan`

Responsibilities:

1. detect supported agents
2. discover Skills
3. parse and validate
4. hash
5. infer provenance
6. deduplicate
7. display result

Example:

```text
Scanning...

✓ Cursor
✓ Codex
✓ Claude Code

24 unique Skills found

Verified source      18
Local                 3
Unknown source        3

Duplicates            7
```

No account required.

No network required for basic scan.

---

## 32. `stack init`

Creates:

```text
Environment: main
```

from discovered Skills.

Example:

```bash
stack init
```

Output:

```text
24 Skills found

Import into main?

✓ 21
○ 3 project-only excluded
```

Writes:

```text
~/.stack/environments/main/environment.yaml
~/.stack/environments/main/stack.lock.json
```

---

## 33. `stack status`

Compares desired Environment with Machine state.

Example:

```text
main

✓ 20 satisfied

Missing
- agent-browser

Modified
~ frontend-design

Untracked
+ experiment-skill
```

---

## 34. `stack diff`

Detailed comparison.

Should show where applicable:

```text
desired hash
actual hash
source
revision
affected agents
ownership
```

Never mutates.

---

## 35. `stack use`

Example:

```bash
stack use @someone/frontend
```

Flow:

```text
Fetch Stack
↓
Resolve
↓
Generate Plan
↓
Preview
↓
Confirm
↓
Snapshot current managed state
↓
Apply
↓
Verify
↓
Commit revision
```

No filesystem changes occur before approval.

---

## 36. `stack remove`

Example:

```bash
stack remove @someone/frontend
```

Resolver determines which Skills become orphaned.

Example:

```text
Removing @someone/frontend

12 Skills referenced

8 still required elsewhere
4 no longer required

Remove 4 unused Skills?
```

---

## 37. `stack try`

Example:

```bash
stack try @someone/frontend -- codex
```

Flow:

```text
Fetch Stack
↓
Resolve
↓
Create temporary Environment
↓
Materialize runtime Skills
↓
Launch target agent
↓
Run session
↓
Exit
↓
Clean runtime
```

`main` must remain unchanged.

---

## 38. Isolation Strategy

V0 isolation is:

> Skill Environment isolation.

Not full process isolation.

Runtime root:

```text
~/.stack/runtime/<session-id>/
```

Example:

```text
runtime/
└── try_0182/
    ├── environment.json
    ├── skills/
    └── workspace/
```

Agent adapters determine how those Skills are exposed.

---

## 39. Scratch Testing First

Initial `stack try` should launch agents inside a Stack-controlled temporary workspace.

Example:

```text
~/.stack/runtime/<session>/workspace
```

This proves isolation before solving all existing-project edge cases.

---

## 40. Existing Project Testing

After scratch mode works, support something like:

```bash
stack try @someone/frontend -- codex --cwd .
```

Requirements:

* existing project remains intact
* temporary Skill exposure is injected safely
* existing project Skills are never overwritten
* cleanup occurs after exit
* interruption recovery is supported

---

## 41. `stack run`

Example:

```bash
stack run codex
```

Launch selected agent using the active Environment.

Future:

```bash
stack run cursor
stack run claude
```

The adapter decides the concrete process invocation.

---

## 42. Transactions

Filesystem changes must be transactional.

Before applying:

1. calculate full plan
2. validate destinations
3. record rollback metadata
4. snapshot required managed state

Then apply.

If an operation fails:

```text
rollback
```

Do not knowingly leave a half-applied Environment.

---

## 43. Transaction Model

Conceptual:

```ts
type Transaction = {
  id: string

  createdAt: string

  operations: Operation[]

  rollbackOperations: Operation[]

  status:
    | "planned"
    | "applying"
    | "committed"
    | "rolled-back"
    | "failed"
}
```

---

## 44. Environment Revisions

Every successful Environment mutation creates a revision.

Examples:

```text
init
use
remove
pull
override
```

Example:

```json
{
  "revision": 7,
  "parent": 6,
  "reason": "use:@someone/frontend",
  "createdAt": "..."
}
```

Full user-facing rollback may come later, but revision storage should begin early.

---

## 45. Cloud Timing

Do not build cloud first.

Cloud work starts after these are reliable:

```text
scan
init
status
diff
local store
local restore
resolver
Codex adapter
stack try
```

---

## 46. Cloud Data Model

Initial tables:

```text
users
profiles
stacks
stack_versions
environments
environment_versions
snapshots
machines
cli_auth_sessions
```

Do not add organization/team tables in V0.

---

## 47. Stack Versions

Published Stack versions are immutable.

Example:

```text
@temi/frontend

v1
v2
v3
```

Each version contains:

```text
manifest
lock information
creator
createdAt
```

---

## 48. Snapshot Storage

Private snapshots may live in object storage.

Example:

```text
snapshots/<user-id>/<hash>.tar.gz
```

Database stores metadata.

Use authenticated, short-lived downloads.

Never expose private snapshot URLs publicly.

---

## 49. CLI Authentication

Recommended:

```bash
stack login
```

Flow:

```text
CLI creates auth session
↓
Browser opens Stack
↓
User authenticates with GitHub
↓
Web approves session
↓
CLI receives credential
```

Do not require manual API key copy/paste.

---

## 50. Credential Storage

Prefer OS credential storage.

Abstract credential persistence so V0 implementation can later be replaced without changing CLI behavior.

Never log credentials.

---

## 51. Cloud API

Use versioned routes.

Example:

```text
POST /api/v1/cli/auth/start
GET  /api/v1/cli/auth/session/:id

GET  /api/v1/stacks/:owner/:name
POST /api/v1/stacks
POST /api/v1/stacks/:id/versions

GET  /api/v1/environments/:name
PUT  /api/v1/environments/:name

POST /api/v1/snapshots
GET  /api/v1/snapshots/:id/download
```

---

## 52. `stack push`

Direction:

```text
Machine → Cloud
```

Uploads:

```text
Environment manifest
lockfile
revision metadata
required private snapshots
```

Do not upload vendor Skill directories blindly.

---

## 53. `stack pull`

Flow:

```text
Fetch Environment
↓
Resolve references
↓
Download required snapshots
↓
Compare Machine
↓
Preview
↓
Confirm
↓
Apply transaction
↓
Verify
```

---

## 54. `stack publish`

Creates a reusable Stack.

Do not automatically publish `main`.

User must intentionally select what becomes public or shareable.

---

## 55. Public Stack Safety

Before publishing, inspect metadata for:

```text
private sources
snapshot references
local absolute paths
obvious credentials in metadata
```

Warn or block where appropriate.

Stack cannot guarantee that arbitrary Skill text itself contains no secret, so do not falsely claim full secret scanning.

---

## 56. CLI UX Rule

Every mutating operation follows:

```text
Intent
↓
Plan
↓
Preview
↓
Approval
↓
Apply
↓
Result
```

Example:

```text
stack use @emil/frontend

Already satisfied     8
Add                    5
Update                 1
Conflict               0

Apply to main?

Yes
No
View details
```

---

## 57. Structured Output

Important commands should support or be designed to support:

```text
--json
```

Especially:

```text
scan
status
diff
```

Core code returns objects.

CLI formatting converts those objects to human-readable output.

---

## 58. Error Model

Use typed errors.

Examples:

```text
SkillParseError
SkillSourceError
UnmanagedPathConflict
ResolutionConflict
IntegrityMismatch
AgentNotInstalled
CloudAuthenticationError
TransactionFailure
```

Do not make callers parse error strings.

---

## 59. Logging

Human-friendly by default.

Debug mode:

```bash
stack scan --debug
```

or:

```text
STACK_DEBUG=1
```

Never log:

```text
auth tokens
secret values
private snapshot contents
```

---

## 60. Security Boundary

Skills may include executable scripts.

Installing a Stack may therefore introduce executable developer tooling.

V0 must:

* show source
* show unknown provenance
* preserve hashes
* verify expected content
* never execute bundled Skill scripts merely as part of installation
* never imply public membership means safety

---

## 61. Trust Labels

Good:

```text
Source verified
Hash matched
Source unavailable
Local Skill
Modified locally
```

Avoid unsupported claims like:

```text
Safe
Trusted
Secure
```

unless those properties were actually verified.

---

# DEVELOPMENT PHASES

## 62. Phase 0: Repository Foundation

Goal:

> Create a clean base Codex can safely extend.

Implement:

```text
pnpm monorepo
Turborepo
TypeScript
ESM
ESLint
Prettier
Vitest
shared tsconfig
```

Packages:

```text
cli
core
scanner
adapters
spec
store
cloud-client
shared
```

Also:

```text
apps/web
fixtures
docs
CI
```

### Acceptance Criteria

These must all succeed:

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

No real product functionality yet.

---

## 63. Phase 1: Scanner

Implement:

```bash
stack scan
```

Features:

* detect roots
* locate Skills
* parse `SKILL.md`
* validate frontmatter
* determine agent
* calculate hashes
* detect duplicates
* determine scope
* infer basic provenance
* human output
* JSON output

### Acceptance Criteria

Fixtures containing duplicated Skills across agent directories return the correct unique Skill count and locations.

---

## 64. Phase 2: Local Environment

Implement:

```bash
stack init
stack status
stack diff
```

Add:

* Machine identity
* Environment schema
* lockfile
* desired vs actual comparison

### Acceptance Criteria

Delete a managed Skill.

`stack status` reports it missing.

Modify one.

`stack status` reports it modified.

Add an unrelated Skill.

`stack status` reports it untracked.

---

## 65. Phase 3: Store and Restore

Implement:

```text
content-addressed store
reference restoration
snapshot creation
materialization
integrity verification
```

### Acceptance Criteria

Scan fixture environment.

Save canonical content.

Delete original Skills.

Restore.

Resulting hashes match originals.

---

## 66. Phase 4: Codex Adapter

Implement:

```text
detect
discover
plan bindings
apply
remove
verify
launch
```

### Acceptance Criteria

A Stack-managed Skill becomes available in a newly launched Codex session.

Existing unmanaged Skill directories are never silently overwritten.

---

## 67. Phase 5: Resolver and `stack use`

Implement:

```bash
stack use <local-stack>
stack remove <stack>
```

Initially use local fixture Stacks.

Implement:

* dedupe
* required/optional
* conflict detection
* overrides
* preview
* transactions
* rollback

### Acceptance Criteria

Shared exact Skills resolve once.

Incompatible Skills create a conflict.

No mutation occurs before approval.

---

## 68. Phase 6: `stack try`

Implement:

```bash
stack try <stack> -- codex
```

Start with scratch workspace isolation.

### Acceptance Criteria

Codex launches with temporary Stack Skills.

After exit:

```text
main
```

is byte-for-byte unchanged.

---

## 69. Phase 7: Cursor and Claude Adapters

Create adapter conformance tests.

Each adapter should implement supported parts of:

```text
detect
discover
apply
verify
remove
launch
```

Do not assume all vendors behave identically.

---

## 70. Phase 8: Cloud

Build:

```text
web account
GitHub auth
CLI login
push
pull
private snapshot upload
Stack publishing
Stack retrieval
```

### Acceptance Criteria

Machine A pushes.

Machine B pulls.

Managed Skill hashes match.

---

## 71. Phase 9: Public Stack Flow

Implement:

```bash
stack publish
stack use @owner/name
stack try @owner/name -- codex
```

Web route:

```text
/@owner/stack-name
```

Display:

```text
description
Skills
sources
supported agents
latest version
usage command
```

No ranking or marketplace required.

---

## 72. Phase 10: Hardening

Test:

```text
Windows
macOS
Linux
interrupted transaction
invalid SKILL.md
deleted upstream source
private source
corrupted lockfile
permissions errors
missing agent
unknown provenance
duplicate Skill names
path casing differences
network failures
modified local Skill
```

---

## 73. Explicitly Deferred

Codex must not build these during V0 unless explicitly instructed later:

```text
Teams
Organizations
SSO
MCP management
Rules management
Hooks management
General prompt management
IDE extension management
OS packages
API key management
Billing
Marketplace ranking
Recommendation engine
AI semantic conflict detection
Security scanning engine
Fleet management
Mobile app
```

---

## 74. Fixtures

Create Skill fixtures:

```text
fixtures/skills/react-v1/
fixtures/skills/react-v2/
fixtures/skills/local-custom/
fixtures/skills/invalid-metadata/
fixtures/skills/with-script/
fixtures/skills/with-assets/
```

Machine fixtures:

```text
fixtures/machines/clean/
fixtures/machines/duplicates/
fixtures/machines/conflict/
fixtures/machines/drift/
```

Stack fixtures:

```text
fixtures/stacks/base/
fixtures/stacks/frontend/
fixtures/stacks/conflicting/
```

---

## 75. Adapter Contract Tests

Use a shared conformance suite.

Conceptually:

```ts
runAdapterContractTests(() => new CodexAdapter())
runAdapterContractTests(() => new CursorAdapter())
runAdapterContractTests(() => new ClaudeAdapter())
```

Vendor-specific tests can exist in addition to shared contract tests.

---

## 76. Critical Invariants

These must become automated tests.

### Invariant 1

Scanning never mutates agent directories.

### Invariant 2

Canonical store content is immutable.

### Invariant 3

Unmanaged content is never overwritten without explicit approval.

### Invariant 4

Failed transactions restore the previous managed state.

### Invariant 5

Removing one Stack cannot remove a Skill still required elsewhere.

### Invariant 6

`stack try` cannot mutate `main`.

### Invariant 7

The same locked Environment resolves deterministically.

### Invariant 8

Hash mismatch is surfaced rather than silently accepted.

### Invariant 9

Cloud is not required for normal local operation.

---

## 77. Milestone 1

> Stack can reconstruct the user's current Skill environment.

Demo:

```bash
stack scan
```

Expected quality:

```text
Scanning your agent setup...

✓ Codex
✓ Cursor
✓ Claude Code

Found 27 unique Skills

                     Cursor   Codex   Claude
frontend-design        ✓        ✓       ✓
playwright             ✓        ✓
debugging              ✓                ✓
agent-browser          ✓        ✓       ✓

Sources

21 Git-backed
3 local
2 unknown
1 modified

No changes were made.
```

Do not proceed until this is reliable.

---

## 78. Milestone 2

> Stack understands desired state.

Demo:

```bash
stack init
stack status
```

Delete a managed Skill manually.

Then:

```bash
stack status
```

must report it missing.

---

## 79. Milestone 3

> Stack can restore.

Demo:

```text
save
delete
restore
verify hashes
```

The original laptop-loss use case now works locally.

---

## 80. Milestone 4

> Stacks compose.

Demo:

```bash
stack use ./fixtures/stacks/frontend
```

Example:

```text
8 already satisfied
5 added
1 optional skipped
0 conflicts
```

---

## 81. Milestone 5

> Try without fear.

Demo:

```bash
stack try ./fixtures/stacks/frontend -- codex
```

Codex launches.

Temporary Skills work.

Exit.

Then:

```bash
stack status
```

returns:

```text
main
✓ unchanged
```

---

## 82. Milestone 6

> The Environment survives the machine.

Machine A:

```bash
stack push
```

Machine B:

```bash
stack pull
```

The same Environment returns.

---

## 83. Development Rule

Implementation discoveries may change:

```text
filesystem mechanics
adapter implementation
library choices
API details
internal representations
```

They should not casually change:

```text
Skill
Stack
Environment
Machine
```

or the frozen product semantics.

Any such change requires an explicit product decision.

---

## 84. Source of Truth

If implementation documents conflict:

```text
1. Product Foundation
2. Technical Build Specification
3. Stack manifest/specification
4. Code comments
```

The codebase should eventually be brought back into consistency with the documentation.

---

## 85. Immediate Development Scope

Begin with:

```text
PHASE 0
Repository foundation

PHASE 1
Scanner
```

Do not begin with:

```text
website
authentication
cloud sync
sharing UI
teams
billing
```

The first question Stack must answer reliably is:

> What Agent Skills does this developer actually have right now?

---

## 86. V0 North Star

The first complete workflow is:

```bash
# Discover my setup
stack scan

# Make it my desired environment
stack init

# See whether my machine matches it
stack status

# Add someone else's Stack
stack use @someone/frontend

# Or test it safely
stack try @someone/frontend -- codex

# Save my environment
stack push
```

New machine:

```bash
stack login
stack pull
```

The user's Agent Skill Environment returns.

That is Stack V0.

---

## 87. Phase 5 Local Stack Composition

A local Stack is authored as a directory containing `stack.yaml`. Its `skills[].path`
and local `extends` values are resolved relative to that manifest only while importing.
They are never copied into portable Environment or lock state.

An import produces an immutable resolved version at:

```text
$STACK_HOME/stacks/<stack-id>/versions/<version-hash>/
```

The logical `stack_<uuid>` identity is independent of its authoring path. The version
hash is SHA-256 over canonical meaningful data: name, description, resolved
requirements, requirement kinds, hashes, restoration metadata, inherited versions,
and explicit optional skips. Paths, timestamps, Machine identity, and temporary state
are excluded.

`environment.yaml` keeps ordered Stack layers, while `stack.lock.json` is the complete
resolved Environment. Resolution is direct Skills first, then Stack layers in manifest
order and requirements in imported-version order. A name and exact content hash dedupe
and retain every requirement origin. Required content beats optional content. Different
required hashes in one name slot are a hard conflict; different optional hashes retain
the first candidate and record the later candidate as skipped. Direct Skills are
required. Persistent override UX is deferred.

`stack use` and `stack remove` mutate desired Environment state only. Imported versions
and content-store objects remain after removal. They never write agent roots. Agent
bindings are reconciled later by `stack run <agent>`; for Codex this includes removal
of healthy stale Stack-owned bindings, while modified or unmanaged content is retained
and blocks destructive reconciliation.

Phase 5 supports local filesystem bundles only. Registry identifiers, remote lookup,
publishing, garbage collection, Stack update UX, and `stack try` remain deferred.

---

## 88. Phase 6 Ephemeral Codex Trials

`stack try <local-stack> -- codex` resolves the requested Stack and its local extends
graph as a temporary Environment. It does not inherit direct Skills, Stack layers, or
overrides from `main`, and it does not persist an Environment layer or Machine baseline.

Each run uses a unique directory beneath `$STACK_HOME/runtime/try_<id>/` containing a
disposable scratch workspace, temporary user home, temporary `CODEX_HOME`, and validated
session metadata. Trial Skills are real directories at
`workspace/.agents/skills/<skill-name>` materialized from the immutable Store. The Store
may retain newly ingested objects as a cache after the trial; this does not activate them.

The Codex child process receives the scratch workspace as cwd and temporary `HOME`,
`USERPROFILE`, and `CODEX_HOME` values. The parent environment is not mutated. Only
allowlisted root Codex state is bridged: `config.toml`, `auth.json`, and root
`*.config.toml` files. Skills, sessions, logs, history, plugin caches, and arbitrary
directories are not copied, and runtime state is never synchronized back.

This provides isolation from `main` and the user's normal user-level Skill environment.
It is not full process isolation: Codex built-in/system capabilities, administrator
configuration, and OS-keyring access may remain available. Normal user Skill roots,
the normal Codex binding registry, portable Environment files, locks, and Machine
baseline are byte-for-byte invariant across a trial.

Dry-run performs detection, validation, hashing, and resolution only. It creates no
runtime or Store content. Completed, failed, and non-zero-exit sessions are cleaned.
Unknown or potentially live orphan runtime directories are not deleted automatically.
Existing-project mode, keeping a scratch workspace, remote Stacks, and automatic Stack
adoption remain deferred.

### Phase 6 filesystem safety fence

Trial and controlled test/demo fixture mutation is fenced to explicitly created,
Stack-owned temporary roots. Paths are normalized, canonically resolved where possible,
and checked with platform-aware containment rules before writes or cleanup. Failure to
prove path ownership aborts the operation and leaves uncertain paths untouched. Trial
preparation also proves that its temporary HOME, temporary `CODEX_HOME`, workspace, and
workspace Skill root remain separated from real user Skill locations before creating
the runtime. These restrictions do not apply to the intentional, separately owned
`stack run codex` binding workflow.

---

## 89. Phase 7 Multi-Agent Physical Bindings

Binding ownership is Machine-specific and physical. The registry at
`$STACK_HOME/state/machines/<machineId>/bindings.json` records Environment entry,
installed hash, normalized target path, and physical root kind; an agent does not
exclusively own a record.

Codex and Cursor intentionally share `$HOME/.agents/skills`. Cursor writes only to
that local root, avoiding `$HOME/.cursor/skills`, whose Cloud Agent synchronization
policy could expose private/local content. Cursor may inspect `.cursor/skills`,
`.claude/skills`, and legacy `.codex/skills` as read-only visibility evidence. Exact
copies may externally satisfy a requirement; same-name differing copies are a
blocking visibility conflict. Cursor never reconciles those compatibility roots.

Claude Code uses `$HOME/.claude/skills` as its separate personal binding root. Plugin,
enterprise, bundled, project, and administrator Skills remain unmanaged. Verification
therefore proves Stack's personal filesystem binding, not effective precedence under
every organization policy.

`stack run codex`, `stack run cursor`, and `stack run claude` project the same resolved
`main` Environment. Environment status remains agent-neutral. The pre-release Codex-
specific registry was replaced rather than migrated. `stack try` remains Codex-only;
cross-agent trials and cloud work are deferred.

---

## 90. Phase 8 Cloud Portability

Cloud stores portable desired state, never Machine installation state. The flow is
frozen: Cloud Environment → local desired `main` → agent reconciliation → Machine
bindings. `stack pull` restores desired state only; it never mutates agent Skill
roots, which remain the job of `stack run <agent>`.

The unit stored per Environment version is a cloud-neutral `CloudEnvironmentBundle`:
the portable manifest, the resolved lock with snapshot restorations normalized to
content hashes, every active imported Stack version, the private snapshot content
requirements, and a deterministic digest over the manifest, resolution, and imported
versions (excluding timestamps, Machine ids, and paths). Bundles never contain
absolute paths, home/STACK_HOME/CODEX_HOME values, binding paths, credentials, or
local snapshot ids. Reference Skills are reacquired from their exact Git
remote+revision+path and hash-verified; private/local Skills travel as content-addressed
snapshot archives in a private bucket. On pull, all content is acquired and verified
into the immutable Store before any desired state is committed; local snapshot ids and
the Machine baseline are regenerated for the pulling Machine, and imported Stack layers
are reconstructed so `stack remove` still works.

The CLI authenticates with a browser device flow (confidential device secret hashed
server-side; human user code that cannot authorize on its own) and stores an opaque
`stk_` token whose hash is all the server keeps. Authorization is always server-derived
from the token; a user can never reach another user's Environment, version, snapshot,
or machine metadata. Environment version commits are atomic and optimistic
(`expectedLatestVersionId`) with idempotency keys; conflicts (`RemoteEnvironmentConflict`,
`LocalEnvironmentConflict`, unsynced-remote/unsynced-local) block rather than overwrite,
and `--yes` never bypasses them. Local commands remain fully functional without login,
`STACK_API_URL`, or network. Public publishing, `@owner/name` resolution, marketplace,
teams, billing, and `stack switch` remain deferred to later phases.
---

## 91. Phase 9 Public Stack Publishing

Publication is not Environment sync. `stack push`/`stack pull` manage the user's
private portable Environment; `stack publish <stack>` creates a separate, public,
reusable Stack. `main` is never published automatically — publication always starts
from an explicit local Stack source (a `stack.yaml` directory/file) or an active
local Stack layer. Republishing a layer that was itself imported from a public
Stack is refused in V0.

Public Stack versions are reference-only. If any resolved requirement is
snapshot-backed (local, modified, unknown, ambiguous, or otherwise non-portable),
publication blocks with a clear privacy/reproducibility error — public snapshot
byte publishing is intentionally unsupported in V0. Each published Skill carries an
exact portable reference (remote, revision, repository-relative path, expected
content hash). Source remotes are validated before publication: embedded
credentials, `file://`, local paths, and loopback hosts are rejected (even with
`--yes`), while SSH/SCP references are allowed and displayed as text. The preview
states that source URLs will be public and that repository accessibility is not
verified.

Public identity is `@owner/name`. The owner handle is reserved (derived from the
GitHub username, normalized) separately from the internal user UUID and is stable
for V0; publication fails clearly if a unique handle cannot be obtained. Slugs use
a conservative `[a-z0-9][a-z0-9-_]{0,62}` rule and must be given via `--slug` when
the Stack name is not slug-safe. The immutable `PublicStackBundle` (name,
description, reference-only requirements, inherited metadata, deterministic
version hash, and integrity digest) is self-contained: it never carries authoring
or machine paths, Machine IDs, local snapshot IDs, baselines, bindings,
credentials, or private Environment metadata. Clients recompute the digest and
version hash and reject inconsistent data before any Store or Environment change.

Public API reads (`GET /api/v1/stacks/:owner/:slug`, `.../versions/:n`,
`/api/v1/profiles/:owner`) are unauthenticated and expose only intentional public
metadata; publishing (`POST /api/v1/stacks/:slug/versions`) requires the CLI token
and derives the owner server-side — clients can never publish under another owner.
Public versions are immutable and append-only; the latest pointer moves under
atomic optimistic (`expectedLatestVersionId`) commits with idempotency keys, so
concurrent publishers conflict rather than overwrite. Public read access never
grants access to private Environments or snapshots, which remain a separate
security domain.

`stack use @owner/name` and `stack try @owner/name -- codex` resolve a public
Stack through one internal source abstraction (local or public) that produces the
same portable resolved version. Remote use fetches and verifies the version,
reacquires every reference through the same Phase 8 exact, hash-verified,
`shell:false` Git restoration component, ingests into the Store, persists the
imported version locally, and adds the layer transactionally — any failure leaves
`main` unchanged (Store cache objects may remain). After a successful import,
`stack status`, `stack diff`, `stack remove`, and `stack run <agent>` work offline;
an already-active public Stack is never silently updated (explicit updates are
deferred). Remote trials reacquire references into the Store and run inside the
Phase 6/6.1 isolated runtime without touching `main` or bindings. Using or trying a
public Stack never executes the Skills' scripts as part of acquisition. Public
snapshot storage, forking/republishing, and `stack switch` remain deferred.
