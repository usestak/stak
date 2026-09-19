# Phase 7 adapter design

The portable Environment remains agent-neutral. A machine-level registry owns
physical paths, while adapters provide vendor policy: writable root, additional
read-only visibility roots, executable detection, and launch behavior.

Codex and Cursor share the `agents` physical root. Claude owns only the
`claude` physical root. Cursor may inspect Cursor, Claude, and legacy Codex
roots, but never mutates them. The shared engine handles content verification,
transactional add/update/removal, rollback, registry persistence, and binding
verification.

Cursor reports a visibility conflict whenever same-name visible copies differ.
Exact visible copies may satisfy a requirement without transferring ownership.
The shared registry records normalized physical targets, resolved Environment
entry IDs, installed hashes, and root kinds; adapters are consumers, not owners.
