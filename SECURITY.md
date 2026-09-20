# Security policy

## Reporting a vulnerability

> TODO (release blocker): a security contact has not yet been decided. Before the
> public release, replace this section with a real reporting channel (a dedicated
> email such as `security@<domain>` or a GitHub private security advisory link).

Until then, report suspected vulnerabilities privately to the repository owner
through a private channel — **do not** open a public issue for security reports.

When reporting, please include:

- affected version / commit
- environment (OS, Node version)
- reproduction steps or a proof of concept
- impact assessment

**Do not include secrets** (tokens, service-role keys, private keys, `auth.json`
contents) in a report. Redact them.

## Scope

Stack's security model and boundaries are documented in
[docs/security.md](docs/security.md), including the child-process execution
audit, path fencing, content verification, cloud authorization, and the list of
data Stack never uploads.

## Supported versions

V0.1 is a pre-release. Only the latest release candidate is supported for
security fixes.
