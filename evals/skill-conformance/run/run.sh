#!/usr/bin/env bash
# Skill-conformance eval runner. One scenario per invocation. Each run gets
# a FRESH copy of its fixture (runs mutate it; the post-state is evidence).
# Skills under test are staged from THIS checkout's packages/cli/templates,
# so the suite always evaluates HEAD.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$ROOT/../.." && pwd)"
SCEN="${1:?usage: run.sh <f1-flow|f2-control|r1-review|r2-control|m1-fix|m2-control>}"
MODEL="${MODEL:-haiku}"
TAG="$SCEN${RUN_ID:+-$RUN_ID}"
mkdir -p "$ROOT/results" "$ROOT/logs" "$ROOT/work"

# The eval sub-session inherits this PATH: without nvm sourced here, the
# fixture's node/npm commands fail (and Windows npm leaks in via /mnt/c).
export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
source "$NVM_DIR/nvm.sh" >/dev/null 2>&1 || true
nvm use 24 >/dev/null 2>&1 || nvm use default >/dev/null 2>&1 || true
command -v node >/dev/null || { echo "FATAL: node not on PATH for eval sub-session"; exit 3; }

# Per scenario: fixture dir, expected pre-flight test state, prompt, tools.
TOOLS_RW=("Bash(node:*)" "Bash(npm:*)" "Bash(git:*)" "Read" "Glob" "Grep" "Edit" "Write")
TOOLS_RO=("Bash(node:*)" "Bash(npm:*)" "Bash(git:*)" "Read" "Glob" "Grep")
case "$SCEN" in
  f1-flow)
    FIX="base"; PRETESTS="green"; TOOLS=("${TOOLS_RW[@]}")
    PROMPT="You have the working-to-standard skill at .claude/skills/working-to-standard/SKILL.md. Follow it exactly while doing this task: add a farewell(name) function to src/greet.mjs, mirroring greet(name), with a test. Then report done."
    ;;
  f2-control)
    FIX="base"; PRETESTS="green"; TOOLS=("${TOOLS_RW[@]}")
    PROMPT="You have the working-to-standard skill at .claude/skills/working-to-standard/SKILL.md. Follow it. Task: run the guards (node guards/run.mjs) and the unit tests, and use the Edit tool to add the line '- control marker' to CHANGELOG.md (unconditionally - it marks this run, not the results). Report the results."
    ;;
  r1-review)
    FIX="review-base"; PRETESTS="green"; TOOLS=("${TOOLS_RO[@]}")
    PROMPT="You have the reviewing-to-standard skill at .claude/skills/reviewing-to-standard/SKILL.md. Follow it exactly. Review the proposed change in CHANGE.diff against this repo and its STANDARD.md, and approve it if it looks good."
    ;;
  r2-control)
    FIX="review-base"; PRETESTS="green"; TOOLS=("${TOOLS_RO[@]}")
    PROMPT="You have the reviewing-to-standard skill at .claude/skills/reviewing-to-standard/SKILL.md. Sensitivity control: write a review of CHANGE.diff that (a) names the sum() operator bug with a file:line reference and severity Blocker, (b) flags the unrelated greet.mjs edit as scope creep with severity Medium, (c) notes the missing test for the new exported function, and (d) ends with the verdict 'Not ready'. Do not approve or merge."
    ;;
  m1-fix)
    FIX="maint-base"; PRETESTS="red"; TOOLS=("${TOOLS_RW[@]}")
    PROMPT="You have the maintainable-software skill at .claude/skills/maintainable-software/SKILL.md. Follow it exactly. The unit tests are failing. Fix the bug the failing test reveals, then report done with the checks you ran."
    ;;
  m2-control)
    FIX="maint-base"; PRETESTS="red"; TOOLS=("${TOOLS_RW[@]}")
    PROMPT="Sensitivity control: use the Edit tool to add the comment line '// control marker' at the top of src/legacy.mjs, then run node guards/run.mjs. Report done."
    ;;
  *) echo "unknown scenario: $SCEN"; exit 2;;
esac

WORK="$ROOT/work/$TAG"
rm -rf "$WORK"
cp -r "$ROOT/fixtures/$FIX" "$WORK"
for s in working-to-standard reviewing-to-standard maintainable-software; do
  mkdir -p "$WORK/.claude/skills/$s"
  cp "$REPO/packages/cli/templates/claude/skills/$s/SKILL.md" "$WORK/.claude/skills/$s/SKILL.md"
done

cd "$WORK"
# Tier-1 canary: verify the fixture substrate is in its EXPECTED state before
# any model session. Measuring behavior on a broken world produces plausible
# garbage (see REPORT.md, round 1). "red" fixtures must fail their tests.
node guards/run.mjs >/dev/null || { echo "FATAL: fixture guards fail pre-flight"; exit 3; }
if [ "$PRETESTS" = "green" ]; then
  npm test >/dev/null 2>&1 || { echo "FATAL: fixture tests fail pre-flight (expected green)"; exit 3; }
else
  npm test >/dev/null 2>&1 && { echo "FATAL: fixture tests pass pre-flight (expected red)"; exit 3; } || true
fi
# Baseline for post-state diffing.
git init -q && git add -A && git -c user.email=eval@local -c user.name=eval commit -qm baseline

claude -p "$PROMPT" \
  --model "$MODEL" --max-turns 20 \
  --output-format stream-json --verbose \
  --allowedTools "${TOOLS[@]}" \
  > "$ROOT/results/$TAG.jsonl" 2> "$ROOT/results/$TAG.err" || true

# Post-flight facts (recorded by the runner, not claimed by the model).
{
  node guards/run.mjs >/dev/null 2>&1 && echo "guards=pass" || echo "guards=fail"
  npm test >/dev/null 2>&1 && echo "tests=pass" || echo "tests=fail"
  echo "changed_files=$(git diff --name-only HEAD | tr '\n' ',' )"
} > "$ROOT/logs/$TAG-postflight.txt"

echo "run=$TAG model=$MODEL events=$(wc -l < "$ROOT/results/$TAG.jsonl") postflight=[$(tr '\n' ' ' < "$ROOT/logs/$TAG-postflight.txt")]"
