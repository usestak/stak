# Contributing to STAK

Thanks for your interest in contributing to STAK. The project is in public
beta — the CLI and Cloud model are actively evolving, so expect some rough
edges and welcome ones too.

## Before you start

- For small fixes (typos, docs, obvious bugs), open a PR directly.
- For anything larger (new commands, behavior changes, schema changes),
  open an issue first so we can discuss the approach before you invest time.

## Development setup

See [docs/getting-started.md](docs/getting-started.md) and
[docs/technical-build-spec.md](docs/technical-build-spec.md) for local
environment setup, the monorepo layout, and how to run the CLI and web app
locally.

## Pull requests

- Keep PRs focused — one change per PR.
- Include tests for behavior changes.
- Make sure `pnpm lint`, `pnpm typecheck`, and the relevant test suite pass
  before requesting review.
- Describe *why* the change is needed, not just what changed.

## Reporting bugs

Open a GitHub issue with repro steps, expected vs. actual behavior, your OS,
and the STAK CLI version (`stak --version`).

## Security issues

Do not open a public issue for security vulnerabilities. See
[SECURITY.md](SECURITY.md) for how to report them privately.

## Code of conduct

Be respectful and constructive. We don't have a separate formal code of
conduct document yet at this stage of the project — treat others the way
you'd want to be treated in any professional open-source community.
