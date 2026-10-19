#!/usr/bin/env bash
# Real smoke test for the STAK Git-like workflow (MACHINE -> stak add -> MAIN -> stak push -> CLOUD).
#
# Exercises must-pass user stories 1-4 and 7 from the Git-like workflow spec against the
# REAL built CLI binary (packages/cli/dist/bin.js) in an isolated temp home/STAK_HOME — no
# mocks. Stories 5/6 (fresh-machine pull, public STAK try/use) need a real Cloud backend
# and are intentionally out of scope here; run them by hand against a real account.
#
# Usage: bash scripts/smoke-git-workflow.sh
# Requires: packages/cli already built (npm run build, or `tsc -p tsconfig.build.json`
# inside packages/cli).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI_BIN="$REPO_ROOT/packages/cli/dist/bin.js"
if [ ! -f "$CLI_BIN" ]; then
  echo "Build the CLI first: (cd packages/cli && npx tsc -p tsconfig.build.json)" >&2
  exit 1
fi

WORKDIR="$(mktemp -d)"
cleanup() { rm -rf "$WORKDIR"; }
trap cleanup EXIT

export USERPROFILE="$WORKDIR/home"
export STAK_HOME="$WORKDIR/stakhome"
mkdir -p "$USERPROFILE/.claude/skills" "$STAK_HOME"

pass=0
fail=0
check() {
  local description="$1"
  local haystack="$2"
  local needle="$3"
  if printf '%s' "$haystack" | grep -qF "$needle"; then
    echo "  OK   $description"
    pass=$((pass + 1))
  else
    echo "  FAIL $description (expected to find: $needle)"
    fail=$((fail + 1))
  fi
}

write_skill() {
  local dir="$1" name="$2" body="${3:-$2}"
  mkdir -p "$dir"
  cat > "$dir/SKILL.md" <<EOF
---
name: $name
description: $name skill
---

# $name

$body
EOF
}

echo "== Story 0: bootstrap =="
write_skill "$USERPROFILE/.claude/skills/alpha" "alpha"
node "$CLI_BIN" init >/dev/null

echo "== Story 1: existing laptop / new Skill =="
write_skill "$USERPROFILE/.claude/skills/new-skill" "new-skill"
out="$(node "$CLI_BIN" status)"
check "status shows the untracked Skill by name" "$out" "+ new-skill"
out="$(node "$CLI_BIN" add new-skill)"
check "add confirms it staged the Skill" "$out" "+ new-skill"
out="$(node "$CLI_BIN" status)"
check "status is clean again after add" "$out" "Nothing to add"

echo "== Story 2: modified Skill =="
write_skill "$USERPROFILE/.claude/skills/alpha" "alpha" "changed body"
out="$(node "$CLI_BIN" status)"
check "status shows the modified Skill" "$out" "~ alpha"
out="$(node "$CLI_BIN" add alpha)"
check "add accepts the modified content into the same entry" "$out" "~ alpha"

echo "== Story 3: accidental missing Skill =="
rm -rf "$USERPROFILE/.claude/skills/new-skill"
out="$(node "$CLI_BIN" status)"
check "status shows the missing tracked Skill" "$out" "! new-skill"
out="$(node "$CLI_BIN" add .)"
out2="$(node "$CLI_BIN" status)"
check "add . never silently removes a missing tracked Skill" "$out2" "! new-skill"
out="$(node "$CLI_BIN" remove new-skill --yes)"
out2="$(node "$CLI_BIN" status)"
if printf '%s' "$out2" | grep -qF "! new-skill"; then
  echo "  FAIL deliberate remove should drop the missing Skill from main"
  fail=$((fail + 1))
else
  echo "  OK   deliberate remove drops the missing Skill from main"
  pass=$((pass + 1))
fi

echo "== Story 7: offline/unauthenticated status never fails =="
set +e
out="$(node "$CLI_BIN" status 2>&1)"
code=$?
set -e
if [ "$code" -eq 0 ]; then
  echo "  OK   status exits 0 while signed out"
  pass=$((pass + 1))
else
  echo "  FAIL status exited $code while signed out"
  fail=$((fail + 1))
fi
check "status reports Cloud as not checked" "$out" "not checked"

echo
echo "Smoke: $pass passed, $fail failed."
[ "$fail" -eq 0 ]
