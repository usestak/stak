# Memory Lock — Design

**Status:** approved design, 2026-10-25. Follow-up to PR #10 (STAK-native Project Memory).

## 1. The problem

Several STAK commands read, change and save the same local Memory files without
coordinating:

- the canonical store: `main.json`, `base.json`, `merge.json`, projections
- the registry
- `current.json`

If two of these commands overlap, the last one to save wins and the other's changes
are silently lost. In the worst case, `stak add .` erases what a concurrent
`stak pull` just merged. The next `stak push` then deletes those documents from
Cloud for every machine.

A command can also scan your project's Memory files and then write them a moment
later, so it can act on a picture that is already out of date.

## 2. The fix in one sentence

One **Memory lock** per STAK home, held by each command that changes Memory from its
first Memory read to its last write, so these commands run one after another instead
of interleaving.

## 3. How it behaves

### 3.1 The lock file

`<STAK home>/memory/.memory.lock` is a small JSON file:

| Field | Meaning |
|---|---|
| `lockId` | Random unique value generated when the lock is taken. It identifies this specific holding of the lock. |
| `pid` | Process ID of the holder |
| `hostname` | Machine name of the holder |
| `startedAt` | When the lock was taken (ISO time) |
| `command` | The STAK command holding it, for example `stak pull` |

The lock is taken by creating the file with exclusive-create, so the create fails if
the file already exists. This is the same mechanism `withMainMutationLock` uses for
Skills.

The lock file is machine-local. It must never be included in a Cloud bundle or a
Stack bundle (add it to the state exclude list, the same way as projections).

### 3.2 Who takes it

These commands wrap their Memory work in the lock: `stak add`, `stak push` (its
Memory part), `stak pull`, `stak memory backup`, `stak memory recover`,
`stak memory restore`, `stak memory resolve`, `stak memory materialize` and
`stak memory protect`.

- **What it covers.** The lock is held from the command's first Memory read to its
  last Memory write. That includes the gap between scanning native files and writing
  them.
- **Read-only commands skip it.** `stak status`, `stak memory diff` and
  `stak memory history` only read, so they don't take the lock. They may briefly
  show a mix of before and after, which is display only.
- **Only the top-level command takes it.** Inner functions never take the lock, which
  rules out a command deadlocking on its own lock.
- **It is separate from the Skills lock.** The Skills lock fails fast, so the two
  locks can never wait on each other.

### 3.3 When the lock is busy

The command checks again every 200 ms, for up to 10 seconds. If the lock is still
held, it stops before changing anything:

> Another STAK command (`stak pull`, started 12s ago) is changing Memory. Try again
> when it finishes.

### 3.4 Releasing the lock

When the work finishes, successfully or not, the command reads the lock file and
removes it **only if its `lockId` is still the one this command created**. It never
removes the path blindly. If the `lockId` differs, for example because someone ran
`stak memory unlock --force`, the command leaves that lock alone.

On Ctrl+C (SIGINT) and SIGTERM, the command releases its own lock the same way before
exiting.

Cleanup cannot be guaranteed for every way a process ends. SIGKILL, power loss and a
killed terminal can all leave the lock behind. That is why §3.5 and §3.6 exist.

### 3.5 Leftover locks after a crash

When the lock is busy, the waiting command checks whether the holder is still alive:

- **Same machine, and the recorded `pid` is not running:** the lock is a leftover.
  The command clears it, prints one line ("Cleared a leftover Memory lock from
  `stak pull` (process 1234, no longer running)."), and continues.
- **Same machine, and the `pid` is running:** the lock is respected. A live process
  holding the lock is never overridden automatically, even if the PID might have been
  reused (see §3.6).
- **Different `hostname`** (a STAK home on a shared drive): never cleared
  automatically.

**Clearing safely, when two waiters spot the same leftover lock:**

1. Create a short-lived guard file, `.memory.lock.clearing`, with exclusive-create.
   Only the process that creates it may clear the lock. Any other process goes back
   to waiting.
2. Re-read `.memory.lock`. Remove it only if its `lockId` is still the leftover one
   that was inspected. Otherwise someone has already replaced it, and it is left
   alone.
3. Remove the guard file, then take the lock normally.

A guard file older than 30 seconds is itself treated as a leftover and removed, so a
crash in the middle of clearing can't block everyone forever.

### 3.6 Escape hatch: `stak memory unlock`

In rare cases a leftover lock looks held. The main case is that the crashed process's
PID has been reused by an unrelated program.

`stak memory unlock`:

- shows the lock's `command`, `pid`, `hostname` and how long ago it started;
- removes the lock if the recorded process is not running;
- refuses if a process with that PID is running, saying it may be a real STAK command
  in progress;
- `stak memory unlock --force` removes it anyway, after a clear warning that doing
  this while a real STAK command is running can lose Memory changes.

Removal uses the same `lockId` check as §3.4. If there is no lock, it says so and
exits successfully.

## 4. Where the code lives

- **`@stack/memory`:**
  - `withMemoryLock(stackHome, command, fn)` (acquire, wait, clear leftovers, release
    by `lockId`, signal handlers);
  - `readMemoryLock(stackHome)`;
  - `unlockMemory(stackHome, { force })`.
- **`@memstk/cli`:** wraps each command in §3.2 at its top-level handler, adds
  `stak memory unlock`, and renders the busy and leftover messages.
- **New error code:** `memory-locked` (the busy timeout). A refused unlock is
  reported with its own clear message.

## 5. Testing

- **Unit tests:**
  - take and release the lock;
  - release removes only a lock with our own `lockId`;
  - wait then stop after the timeout;
  - a leftover lock with a dead PID is cleared;
  - a live PID is respected;
  - a different hostname is never cleared;
  - two processes race to clear the same leftover, and only one clears it while the
    other's fresh lock survives;
  - a stale guard file is removed;
  - unlock refuses with a live PID, and `--force` removes;
  - the lock file is excluded from Cloud and Stack bundles.
- **Real multi-process tests:** separate Node processes against one STAK home and
  the in-memory backend, started together:

  ```text
  add + pull          (the known data-loss bug)
  add + push
  pull + push
  materialize + pull
  ```

  Each pair must run one after the other, never interleaved. No Memory document may
  be lost, and the final state must equal running the two commands back to back in
  some order.
- **Signal test:** a child process holding the lock gets SIGINT, and the lock is
  removed.

## 6. Out of scope

- Locking for Skills, which already has its own lock.
- Coordination across machines, which Cloud's `expectedParent` already handles.
- Making read-only commands wait.
