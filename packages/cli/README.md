# @memstk/cli

**STAK — the control plane for portable AI agent environments.**

STAK discovers the Agent Skills you have accumulated across Codex, Cursor, and
Claude Code, captures them as a portable environment, restores them on any
machine, safely composes additional stacks, backs up your private agent Memory,
and lets you try someone else's stack without disturbing your setup.

> **Looking for the latest features?** This is the stable release line. The
> active Public Beta adds a unified Git-like workflow (`stak add` / `stak push`
> syncing Skills and Memory together in one step) and more — install it with
> `npm install -g @memstk/cli@beta`. See https://www.memstk.com/beta.

## Install

```bash
npm install -g @memstk/cli
```

The package installs a single self-contained `stak` command (no runtime
dependencies).

## Commands

```bash
stak scan                 # discover installed Agent Skills (read-only)
stak init                 # capture your current setup as the `main` environment
stak status               # show whether your setup is ready on this machine
stak use <stak>           # compose a local or public (@owner/name) STAK into main
stak run codex            # project your setup into an agent and launch it
stak try <stak> -- codex  # try a STAK in an isolated scratch session
stak login                # sign in to STAK Cloud
stak push / stak pull     # sync your main setup with the Cloud
stak memory backup        # back up private agent Memory (Standard or Protected)
stak project              # review logical projects and map recovered memory
stak skill update         # install approved Skill versions on this machine
stak open                 # open the STAK web app with this machine selected
```

Run `stak --help` or `stak <command> --help` for details.

See the full CLI reference: https://www.memstk.com/docs/cli

## Links

- Repository: https://github.com/usestak/stak
- Issues: https://github.com/usestak/stak/issues
- License: MIT
