# @stack/experiment-memory-remote

**Phase 14B0 architecture spike — NOT production.** An isolated prototype for
encrypted **remote** Memory backup and disaster recovery: how private agent
Memory (Phase 14A) survives total loss of the original machine.

- **Nothing here is wired into the CLI or web app.** No shipping code imports this
  package. It exists only to prove an approach and to be type-checked, linted,
  tested, and built by the normal pipeline.
- **Synthetic fixtures only.** No real user Memory is ever read or uploaded.
- **No secrets in source.** Option B/C wrappers read config from env and are
  skipped by default; no live network test is claimed to have passed.

Full write-up and decision: [`docs/architecture/memory-remote-spike.md`](../../docs/architecture/memory-remote-spike.md).

## What it demonstrates (Option A — Stack Cloud + client-side envelope encryption)

`protect → recover`, fully offline, proving **original plaintext hash == recovered
plaintext hash** after: bundle → encrypt → simulate remote → discard local key
state → recover with recovery material → decrypt → restore via Phase 14A.

Separated concerns (Stack owns the domain model; backends are replaceable):

| Module             | Concern                                                                   |
| ------------------ | ------------------------------------------------------------------------- |
| `bundle-codec.ts`  | `MemoryBackupCodec` — canonical, byte-exact bundle ⇄ Phase 14A store      |
| `cipher.ts`        | `MemoryCipher` — AES-256-GCM AEAD, random nonce, AAD-authenticated header |
| `recovery-key.ts`  | `RecoveryKeyProvider` — recovery key → scrypt KEK → wrap/unwrap DEK       |
| `backend.ts`       | `RemoteMemoryBackend` plugin interface + in-memory simulation             |
| `protect.ts`       | End-to-end `protect` / `recover` orchestration                            |
| `seal-walrus.ts`   | Option B sketch (Seal + Walrus), env-gated, not wired                     |
| `walrus-memory.ts` | Option C sketch (Walrus Memory), env-gated, not wired                     |

## Run

```
pnpm --filter @stack/experiment-memory-remote test
pnpm --filter @stack/experiment-memory-remote typecheck
pnpm --filter @stack/experiment-memory-remote lint
pnpm --filter @stack/experiment-memory-remote build
```

## Opt-in Option B/C integration (developer's own testnet; no secrets committed)

Integration tests are skipped unless you set env vars pointing at YOUR OWN setup,
e.g. `STACK_SPIKE_SEAL_WALRUS=1` plus package/key-server/relay ids. Signing and
wallet material are the developer's responsibility and must never be placed in
Stack's server or committed. See the source of `seal-walrus.ts` / `walrus-memory.ts`.
