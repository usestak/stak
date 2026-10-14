# Security policy

## Reporting a vulnerability

Report suspected vulnerabilities through **GitHub Private Vulnerability
Reporting** on the `usestak/stak` repository (Security → Report a vulnerability).
**Do not** open a public GitHub issue for security reports.

> A dedicated `security@usestak.app` address is **not active yet** and must not be
> used until the production domain is configured; use GitHub private reporting
> until then.
>
> Manual pre-release requirement: enable Private Vulnerability Reporting in the
> `usestak/stak` repository settings (Settings → Security → Private vulnerability
> reporting). This cannot be verified from the local repository.

When reporting, please include:

- affected version / commit
- environment (OS, Node version)
- reproduction steps or a proof of concept
- impact assessment

**Do not include secrets** (tokens, service-role keys, private keys, `auth.json`
contents) in a report. Redact them.

## Scope

Memory STAK's security model and boundaries are documented in
[docs/security.md](docs/security.md), including the child-process execution
audit, path fencing, content verification, cloud authorization, and the list of
data Memory STAK never uploads.

## Supported versions

V0.1 is a pre-release. Only the latest release candidate is supported for
security fixes.
