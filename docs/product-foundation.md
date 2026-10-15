# STAK Product Foundation v0.1

## 1. Product Summary

**STAK is the control plane for portable AI agent environments.**

It helps developers discover, preserve, compose, restore, share, and safely synchronize the skills that make up their AI agent setup across machines and supported agents.

The core promise is:

**Your agent setup should survive your laptop.**

The broader vision is:

**Your skills. Your setup. Any agent. Any machine.**

---

## 2. The Problem

Developers increasingly build highly personalized AI agent environments over time.

These environments may contain skills for:

* frontend development
* design engineering
* testing
* browser automation
* debugging
* blockchain development
* code review
* security
* research
* deployment
* project-specific workflows

These skills are often installed gradually based on project needs.

After several months, the developer may have a highly effective setup distributed across tools such as:

* Codex
* Cursor
* Claude Code
* other compatible agents

However, this environment is usually tied to the developer's machine.

This creates several problems.

### 2.1 Loss

If the laptop is lost, stolen, damaged, replaced, or reformatted, the developer may no longer remember:

* which skills were installed
* where they came from
* which versions were being used
* which agents used each skill
* which skills had been manually modified
* which private skills existed only locally

Rebuilding the environment manually may be difficult or impossible.

### 2.2 Fragmentation

Skills may exist across different directories and agents.

A developer may not even have a complete picture of their current environment.

### 2.3 Sharing

A developer may want to share their setup with a friend, colleague, teammate, or community.

Today, this may require sharing:

* multiple GitHub repositories
* installation commands
* configuration instructions
* agent-specific setup steps

There is no simple representation of:

> This is the environment I use.

### 2.4 Drift

Over time, the local machine may stop matching the environment the developer intended to maintain.

Skills can be:

* added
* removed
* updated
* modified
* duplicated
* replaced

The developer may not know what has changed.

### 2.5 Teams

Organizations increasingly need developers and agents to operate with shared:

* coding standards
* testing practices
* internal workflows
* security procedures
* company-specific skills

There is currently no simple way to define, distribute, update, and audit such an environment across a team.

---

## 3. Product Thesis

Installing a skill is becoming easier.

The harder problem is managing the complete environment created by many skills over time.

STAK therefore operates above the skill distribution layer.

STAK is not primarily:

* a skill marketplace
* another skills directory
* a GitHub replacement
* a package repository
* a simple backup utility

STAK manages the **state of the user's agent environment**.

The central distinction is:

> A skill manager understands what can be installed.

> STAK understands what your environment is supposed to look like.

---

## 4. Core Product Model

STAK uses four main concepts.

### 4.1 Skill

A **Skill** is an individual capability that can be made available to an AI agent.

Examples:

* React best practices
* frontend design
* browser automation
* debugging
* accessibility review

A Skill may originate from:

* a public repository
* a private repository
* a local directory
* another supported source

---

### 4.2 STAK

A **STAK** is a versioned and shareable declaration of related Skills and their requirements.

Examples:

```text
@temi/base
@temi/frontend
@temi/creative-frontend
@acme/security
```

A STAK may contain information such as:

* included Skills
* Skill versions
* required Skills
* optional Skills
* supported agents
* compatibility information
* source information
* update policies

A STAK can be:

* private
* shared privately
* public

A STAK is reusable and composable.

---

### 4.3 Environment

An **Environment** is the resolved combination of one or more STAKs and direct Skills.

Example:

```text
@temi/base
+
@temi/frontend
+
@temi/web3
```

The Environment represents the **desired state**.

It answers:

> What should be available to my agents on this machine?

A developer may maintain multiple Environments.

Examples:

```text
main
work
web3
experimental
try-emil-frontend
```

`main` is the user's default Environment.

It represents the setup the user normally wants available.

It does not mean every Skill STAK has ever discovered.

---

### 4.4 Machine

A **Machine** represents the actual local state.

The Machine may differ from the desired Environment.

Example:

```text
Desired Environment

25 Skills

Actual Machine

23 expected Skills
2 missing
1 outdated
3 untracked
```

This difference is called **environment drift**.

The conceptual hierarchy is:

```text
Skill
  ↓
STAK
  ↓
Environment
  ↓
Machine
```

---

## 5. Core Product Principles

### 5.1 Discover Before Configure

STAK should begin by understanding what the developer already has.

The first experience should not require manually creating a manifest.

The user should be able to run:

```bash
stak scan
```

and see their current agent environment reconstructed.

---

### 5.2 Never Silently Break a Working Environment

Using someone else's STAK must never silently overwrite incompatible Skills or unmanaged local files.

STAK should always:

1. resolve
2. preview
3. validate
4. apply
5. verify

Destructive or conflicting operations require explicit approval.

---

### 5.3 Desired State Over Installation History

STAK should not merely remember:

> You once installed these Skills.

It should understand:

> This is what your Environment should currently contain.

---

### 5.4 Reproducibility Matters

Where possible, STAK should preserve:

* source
* version
* commit
* checksum
* installation requirements

Restoring an Environment should reproduce the intended setup rather than blindly downloading the newest available versions.

---

### 5.5 Local Work Belongs to the User

If STAK encounters a Skill or file it does not manage, it should not modify or delete it without permission.

Unmanaged local content is protected by default.

---

### 5.6 Composition Over Duplication

Multiple STAKs should be able to share Skills.

If two STAKs require the same compatible Skill, STAK should deduplicate it.

Example:

```text
@temi/base
  └── playwright

@temi/frontend
  └── playwright
```

The resulting Environment contains one resolved Skill.

---

### 5.7 Portability Without Lock-In

The local CLI, STAK specification, and essential restoration format should remain open and portable.

A developer should not lose access to their Environment if the hosted STAK service becomes unavailable.

---

## 6. Main User Personas

### 6.1 Individual Developer

A developer who gradually installs Skills across projects.

Primary needs:

* discover existing Skills
* back up the environment
* restore it on another machine
* understand drift
* experiment safely

### 6.2 Power User / Creator

A developer with a curated workflow who wants to share it.

Primary needs:

* build reusable STAKs
* publish selected Skills
* maintain versions
* let others safely use their setup

### 6.3 Team

An engineering team that wants consistent agent capabilities across developers.

Primary needs:

* shared STAKs
* private Skills
* required Skills
* version control
* update management
* organizational policies
* environment visibility

Team functionality is part of the long-term direction, not the initial V0 scope.

---

## 7. First Five-Minute Experience

### Step 1: Scan

The user runs:

```bash
stak scan
```

STAK checks supported Skill locations.

Example:

```text
Found 28 Skills across 3 agents.

Cursor
26 Skills

Codex
24 Skills

Claude Code
23 Skills

28 unique Skills

19 shared across multiple agents
5 Cursor only
3 Claude Code only
1 Codex only
```

The intended reaction is:

> I forgot I even had some of these.

This is the first major product moment.

---

### Step 2: Create the Default Environment

The user creates:

```text
Environment: main
```

from the current working setup.

The first scan can bootstrap `main`.

The user may choose:

```text
Save this Environment?

→ Save everything
  Review first
```

---

### Step 3: Authenticate

Authentication happens after local value has been demonstrated.

Example:

```text
Your Environment is ready locally.

Sign in to:
• back it up
• restore it elsewhere
• sync changes
• share selected STAKs
```

---

### Step 4: Push

The user runs:

```bash
stak push
```

Example result:

```text
main saved.

28 Skills
3 supported agents
23 verified sources
4 pinned versions
1 private local Skill
```

The second major product moment is:

> If I lose this laptop now, my setup survives.

---

### Step 5: Restore Preview

STAK shows how the Environment would behave elsewhere.

Example:

```text
Restoring main would provide:

Cursor
26 Skills

Codex
24 Skills

Claude Code
23 Skills
```

The third major product moment is:

> This Environment can follow me.

---

## 8. Command Semantics

### `stak scan`

```bash
stak scan
```

Discovers Skills and supported agent configurations on the current machine.

Does not mutate the machine.

---

### `stak init`

```bash
stak init
```

Creates the default Environment, normally `main`, from discovered Skills.

---

### `stak status`

```bash
stak status
```

Shows whether the active Machine matches the desired Environment.

---

### `stak diff`

```bash
stak diff
```

Shows exactly what differs between desired and actual state.

---

### `stak push`

```bash
stak push
```

Saves local Environment state to STAK Cloud.

Direction:

```text
Machine → Cloud
```

---

### `stak pull`

```bash
stak pull
```

Restores or applies saved Environment state to the current Machine.

Direction:

```text
Cloud → Machine
```

---

### `stak use`

```bash
stak use @someone/frontend
```

Adds a STAK to the currently active Environment.

If `main` is active:

```text
Current main
+
@someone/frontend
↓
Resolve
↓
Preview
↓
Apply
↓
Updated main
```

The imported STAK remains part of the Environment until removed.

---

### `stak remove`

```bash
stak remove @someone/frontend
```

Removes that STAK from the active Environment.

Skills still required elsewhere remain available.

---

### `stak try`

```bash
stak try @someone/frontend
```

Creates a temporary isolated Environment containing that STAK and its requirements.

`main` remains untouched.

This is for real testing, not just previewing.

---

### `stak run`

```bash
stak run codex
```

Launches an agent with access to the active Environment.

The agent adapter is responsible for exposing the correct Skills.

---

### Direct Try

```bash
stak try @someone/frontend -- codex
```

Conceptually:

```text
Fetch STAK
↓
Resolve
↓
Create isolated Environment
↓
Expose Skills to Codex
↓
Launch Codex
↓
Test
↓
Exit
↓
main remains unchanged
```

---

### `stak switch`

```bash
stak switch main
```

Changes the active Environment.

---

### `stak publish`

```bash
stak publish
```

Creates a reusable, shareable STAK from selected parts of an Environment.

The user's entire `main` Environment is never automatically published.

---

## 9. Main vs STAK

This distinction is frozen.

`main` is an **Environment**.

It may contain:

```text
direct Skills
+
referenced STAKs
+
overrides
```

Example:

```text
Environment: main

Direct Skills
- debugging
- private-design-review

STAKs
- @temi/frontend
- @temi/web3
```

A STAK is a reusable unit that can be added to an Environment.

An Environment is the resolved setup a user wants active.

---

## 10. STAK Composition

STAKs are composable.

Example:

```text
@temi/base
+
@temi/frontend
+
@temi/web3
```

STAKs may also extend other STAKs.

Example:

```text
@temi/creative-frontend

extends:
@temi/frontend
```

with additional Skills such as:

* motion
* Three.js
* visual QA
* design engineering

---

## 11. Conflict Philosophy

The governing rule is:

> STAKs compose optimistically, but conflicts are resolved explicitly.

---

### 11.1 Identical Requirements

If two STAKs require the same Skill and exact compatible version:

```text
@temi/base
requires v2.4

@james/frontend
requires v2.4
```

STAK installs or exposes one resolved copy.

---

### 11.2 Compatible Requirements

If both requirements can be satisfied by the same version, STAK resolves them automatically.

---

### 11.3 Incompatible Requirements

Example:

```text
@temi/frontend
requires v2.4

@james/frontend
requires v3.1
```

STAK must not silently choose.

It should present options such as:

```text
Recommended:
Create a separate Environment

Other options:
Keep your existing version
Use the imported version
Review
Cancel
```

---

### 11.4 Overrides

Users may override a STAK requirement in their Environment.

Example:

```text
@james/frontend
expects frontend-design v4

Environment override
frontend-design v5
```

The original STAK remains unchanged.

STAK should make clear that the resulting Environment differs from the author's original resolution.

---

### 11.5 Unmanaged Files

STAK does not modify files it does not own without explicit approval.

---

### 11.6 Required and Optional Skills

V0 supports:

```text
required
optional
```

Optional Skills may be skipped when they conflict or cannot be installed.

---

## 12. Safe Changes

Environment mutations follow:

```text
Resolve
↓
Preview
↓
Validate
↓
Snapshot
↓
Apply
↓
Verify
↓
Commit
```

If application fails:

```text
Rollback
```

STAK should avoid leaving partially modified Environments.

---

## 13. Skill Ownership

STAK should know why each managed Skill exists.

Example:

```text
playwright

Managed by STAK

Required by:
@temi/frontend
@acme/engineering
```

If a STAK is removed, STAK can determine whether the Skill is still required elsewhere.

---

## 14. Skill Storage Models

STAK supports two restoration strategies.

### 14.1 Reference

Used when STAK can reliably fetch the Skill again.

Stored information may include:

```text
repository
revision
path
checksum
```

### 14.2 Snapshot

Used when a Skill is:

* local
* modified
* source-less
* unavailable remotely
* otherwise not safely reproducible

STAK stores a private immutable snapshot.

Private snapshots must never become public without explicit user action.

---

## 15. Public and Private STAKs

The user's default Environment is private.

Example:

```text
main
PRIVATE
```

Users can create curated public STAKs from their Environment.

Example:

```text
@temi/creative-frontend
PUBLIC
```

This avoids accidentally exposing:

* private Skills
* company Skills
* local workflows
* experimental content

---

## 16. Isolated Testing

`stak try` creates a temporary Environment.

Example:

```bash
stak try @emil/frontend -- codex
```

STAK creates something conceptually like:

```text
Environment: try-emil-frontend

Source:
@emil/frontend

main:
UNCHANGED
```

The temporary Environment contains:

1. the requested STAK
2. any STAK it extends
3. required dependencies
4. selected optional dependencies

It does not automatically inherit every Skill from `main`.

The purpose is to test whether the STAK itself behaves as intended.

---

## 17. Agent Access During `stak try`

The target agent must actually be able to use the isolated Skills.

Therefore STAK needs an agent launch layer.

Example:

```bash
stak run codex
```

or:

```bash
stak try @someone/frontend -- codex
```

The agent adapter exposes the Environment to that agent.

Conceptually:

```text
Environment
↓
Agent Adapter
↓
Codex / Cursor / Claude Code
↓
Agent session
```

This makes isolation real rather than conceptual.

---

## 18. Temporary Environments

Temporary Environments are disposable by default.

After testing:

```text
Test complete.

main
✓ unchanged

Options:
Use this STAK in main
Keep test Environment
Discard
```

Future versions may allow:

```bash
stak keep try-emil-frontend --name design-test
```

This is not required for early V0.

---

## 19. Environment Isolation

V0 isolation means:

> Skill environment isolation.

It does not mean full VM, container, or OS process isolation.

STAK can materialize isolated Skills into a STAK-controlled runtime/workspace and launch the selected agent against it.

Agent-specific details remain inside adapters.

The STAK specification does not expose vendor filesystem mechanics.

---

## 20. Open Source and Hosted Product Boundary

STAK should be both an open-source developer tool and a hosted product.

### Open Source

The open-source layer should include:

* CLI
* STAK specification
* local scanner
* local resolver
* agent adapters
* local installer/materializer
* local diff
* essential restoration functionality

### Hosted Product

The hosted layer may include:

* accounts
* cloud backup
* private STAKs
* public profiles
* STAK registry
* STAK history
* sharing
* team STAKs
* organizational policy
* compatibility data
* audit logs
* fleet visibility

The CLI earns trust and distribution.

The hosted product creates the long-term business.

---

## 21. V0 Scope

STAK V0 focuses on **Agent Skills**.

V0 should support:

1. scanning supported Skill directories
2. identifying unique Skills
3. detecting which agents use each Skill
4. recording Skill sources where possible
5. recording versions and hashes
6. creating `main`
7. local desired-state management
8. local restoration
9. diff and drift detection
10. creating and using STAKs
11. basic conflict handling
12. isolated `stak try`
13. public/private STAK concepts
14. reference and snapshot restoration
15. cloud push/pull after the local product works

---

## 22. Explicit V0 Non-Goals

STAK V0 will not manage:

* API keys
* environment secrets
* models
* MCP servers
* VS Code extensions
* shell dotfiles
* Git configuration
* Node packages
* operating system packages
* full IDE settings
* arbitrary prompts
* billing
* teams
* organizations
* SSO
* marketplace ranking
* AI semantic conflict detection

The initial boundary is:

> STAK manages Agent Skills and the information required to reproducibly expose those Skills to supported agents.

---

## 23. Initial Supported Agents

Priority:

1. Codex
2. Cursor
3. Claude Code

The specification must remain agent-neutral.

---

## 24. Environment Drift

Environment drift is the difference between:

```text
Desired Environment
```

and:

```text
Current Machine
```

STAK should surface:

```text
Satisfied
Missing
Modified
Outdated
Untracked
Conflicting
```

---

## 25. Environment Health

STAK may summarize state descriptively.

Example:

```text
Environment Health

✓ 24 Skills satisfied
⚠ 2 modified
✕ 1 missing
```

Avoid arbitrary gamified scoring.

---

## 26. Provenance

STAK should determine, where possible:

```text
Where did this Skill come from?
What revision was used?
Has it changed?
Can STAK reproduce it?
```

If provenance is unknown, STAK should say so.

It should never guess.

---

## 27. Core Product Moments

### Recognition

> STAK found everything I installed.

Triggered by:

```bash
stak scan
```

### Security

> If I lose this machine, my Environment survives.

Triggered by local preservation and eventually:

```bash
stak push
```

### Portability

> I can reproduce or share this setup anywhere.

Triggered by restore, `stak use`, and public STAKs.

### Safe Exploration

> I can try someone else's setup without breaking mine.

Triggered by:

```bash
stak try
```

---

## 28. Product Positioning

Primary:

> **Your agent setup should survive your laptop.**

Supporting:

> **Your skills. Your setup. Any agent. Any machine.**

Technical:

> **STAK is the control plane for AI agent environments.**

Developer explanation:

> STAK gives your AI agent setup a portable, versioned, reproducible home.

---

## 29. What STAK Is Not

STAK is not:

* another AI Skill marketplace
* another GitHub
* a generic package manager
* a generic dotfiles manager
* an AI agent
* a prompt marketplace
* a replacement for existing Skill distribution systems

STAK should integrate with the ecosystem rather than own every layer.

---

## 30. Long-Term Direction

If the Skill-focused product succeeds, STAK may later expand to broader agent environment primitives such as:

```text
Skills
MCP servers
Rules
Hooks
Commands
Agent configuration
```

The long-term possibility is:

> A portable developer-agent environment that follows the user across tools and machines.

This expansion should only happen after the Skill-focused product proves valuable.

---

## 31. Validation Framework

### A. Recovery

Do developers care about preserving and restoring their accumulated agent setup?

If not, reconsider the core product.

### B. Sharing

Do developers want to use environments created by other developers?

If yes, STAK gains organic distribution.

### C. Standardization

Do teams want developers to operate with shared agent environments?

If yes, STAK has a strong commercial path.

---

## 32. Business Direction

Expected progression:

```text
Open-source CLI
        ↓
Individual cloud product
        ↓
Public STAK ecosystem
        ↓
Team environments
        ↓
Organizational control plane
```

Individual usage creates adoption.

Sharing creates distribution.

Teams create the strongest commercial opportunity.

---

## 33. Frozen Product Model

From this point forward, the following concepts are considered frozen for V0:

```text
Skill
STAK
Environment
Machine
```

and the primary command model:

```text
scan
init
status
diff
use
remove
try
run
switch
push
pull
publish
```

Implementation discoveries may alter technical details.

They should not redefine the product model without an explicit product decision.

---

## 34. Next Stage

The Product Foundation is complete.

Implementation work should now focus on:

1. repository foundation
2. scanner
3. local Environment model
4. content storage and restore
5. Codex adapter
6. resolver and composition
7. isolated `stak try`
8. Cursor and Claude adapters
9. cloud portability
10. public STAK flow

Future ideas should be evaluated against:

> Does this strengthen STAK's core job of making AI agent environments portable, reproducible, composable, and safe?

If not, it stays outside V0.