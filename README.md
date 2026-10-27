<picture>
  <source media="(prefers-color-scheme: dark)" srcset="apps/web/public/brand/stak-symbol-dark.svg">
  <img src="apps/web/public/brand/stak-symbol-light.svg" alt="Memory STAK" width="64" height="64">
</picture>

# STAK

Portable Skills and Memory for your AI coding agents.

AI coding agents increasingly depend on Skills, instructions, project
context, and Memory. That environment normally lives on one machine and is
hard to reproduce, move, or share. STAK gives it a portable identity: a
canonical record of your Skills that you can carry, project into any
supported agent, and share safely with others.

**Public Beta · v0.2.0-beta.1.** The CLI and Cloud model are actively evolving during the beta.

## Install

```bash
npm install -g @memstk/cli@beta
stak login
stak init
stak status
```

`npm` `latest` intentionally still points at `0.1.2` — the Public Beta lives on the `@beta` dist-tag.

The CLI tells you when an update is available, and `stak upgrade` installs it.

(`npx stack` is an unrelated project — not Memory STAK.)

## 60-second quick start

Try a STAK without touching your normal setup:

```bash
stak try @stephentony100/frontend-test -- claude
```

This resolves the STAK, launches Claude Code with it projected into an
isolated runtime, and cleans up afterward — your main setup is untouched.

Like it? Add it for real:

```bash
stak use @stephentony100/frontend-test
stak run codex
```

`use` resolves and adds the STAK to your main desired state — it does not
launch an agent. `run` projects main into the agent you name and launches it.

## Try vs. Use

|                   | Try                         | Use                       |
| ----------------- | --------------------------- | ------------------------- |
| Changes main      | No                          | Yes                       |
| Launches an agent | Yes                         | No (pair with `stak run`) |
| Runtime           | Temporary, cleaned up after | Persistent                |

## Supported agents

|             | run | try |
| ----------- | --- | --- |
| Codex       | yes | yes |
| Claude Code | yes | yes |
| Cursor      | yes | yes |

## Everyday workflow

```bash
stak status
stak add .
stak push
```

## Move to another machine

```bash
npm install -g @memstk/cli@beta
stak login
stak pull
stak status
```

Skills move across Claude Code, Cursor, and Codex. During the Public Beta,
Project Memory portability supports Claude Code — see
[`docs/memory.md`](docs/memory.md).

## Skills, Memory, Projects, Machines

- **Skills** — the portable instructions and context a STAK carries. They
  resolve, verify, and project into any supported agent the same way.
- **Memory** — private, Cloud-backed state for your agents. Memory is never
  published with a public STAK.
- **Project** — a stable logical Cloud identity for your desired setup. A
  local directory is just one machine's binding to it.
- **Machine** — one binding point (among potentially several) for the same
  Project — its own local bindings and placements, never uploaded.

## Sharing

Public STAKs contain selected portable Skill snapshots (each Skill pinned by
content hash at publish time; a Git source revision, when available, is
preserved as metadata, not the pin itself). They never include Memory,
Projects, machine state, credentials, or local filesystem paths.

## Privacy & security

STAK only owns content it created and tracks in a local binding registry;
unmanaged or externally-modified content is never overwritten without
approval. Private snapshots stay private, but every published Skill — git-tracked or
not — publishes as an immutable, content-addressed snapshot pinned by
content hash; publishing requires that you've pushed that content first.
See [docs/security.md](docs/security.md) for the full model.

## How it works

STAK keeps a single canonical, content-addressed record of your desired
Skills and projects it into each agent's Skill directory without ever
overwriting content it does not own. See [docs/architecture/](docs/architecture/)
for design notes and ADRs.

## Documentation

- Website: https://www.memstk.com
- Docs: https://www.memstk.com/docs
- CLI Reference: https://www.memstk.com/docs/cli
- npm: [@memstk/cli](https://www.npmjs.com/package/@memstk/cli)
- Feedback: use the in-app feedback form at [memstk.com/feedback](https://www.memstk.com/feedback) or [open an issue](https://github.com/usestak/stak/issues)

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) and
[docs/getting-started.md](docs/getting-started.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Security

See [SECURITY.md](SECURITY.md).

## License

MIT — see [LICENSE](LICENSE).
