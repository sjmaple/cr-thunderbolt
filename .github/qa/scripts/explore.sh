#!/usr/bin/env bash

# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

# One exploratory QA session, as the weekly workflow runs it, against a stack started with stack.sh.
#
#   .github/qa/scripts/explore.sh prompt <session> <out-dir>         print the session prompt (the workflow uses it)
#   .github/qa/scripts/explore.sh run <session> <out-dir> [max-usd]  run the session locally with `claude -p` ($2)
#   .github/qa/scripts/explore.sh journey [<case>]                   print this week's free-session case, or check one
#
# A session is <charter>-<platform>, e.g. c4-skills-projects-phone, or free-<case>-<platform> for the free session of a
# case in journeys.json (platform ids are in platforms.json and never contain a hyphen), e.g.
# `run "free-$(.github/qa/scripts/explore.sh journey)-phone" qa-out` for this week's case on the phone.
# `run` needs ANTHROPIC_API_KEY. It writes <out-dir>/<session>/{findings,repro,attempts}/ (the explorer), mcp/ (the
# browser's screenshots and console logs),
# execution.json + session.json (metrics) and transcript.json (the tool calls, for the coverage check).
# The platform sets the viewport and the MCP config. The two-device charter needs
# QA_MCP_CONFIG='.github/qa/mcp.json .github/qa/mcp-two-devices.json' (its second browser).
# Keep the claude flags in step with the explore job in .github/workflows/qa-weekly.yml.

set -euo pipefail
cd "$(dirname "$0")/../../.."

# One field of a platform in platforms.json.
platform() {
  jq --exit-status --raw-output --arg id "$1" ".[] | select(.id == \$id) | .$2" .github/qa/platforms.json ||
    { echo "unknown platform: $1" >&2; exit 1; }
}

# A free session's case: the given id, or this week's. Unix weeks start on Thursday, so consecutive Monday runs take
# consecutive cases and every case runs once before any repeats.
journey() {
  jq --exit-status --raw-output --arg id "$1" --argjson week $(($(date +%s) / 604800)) \
    'if $id == "" then .[$week % length].id else .[] | select(.id == $id) | .id end' .github/qa/journeys.json ||
    { echo "unknown case: $1" >&2; exit 1; }
}

# The shared prefix comes first and is identical for every session, so sessions can reuse its prompt cache.
prompt() {
  # Platform ids have no hyphen, so the last part of a session id names the platform and the rest the charter.
  local viewport base=${1%-*} id=${1##*-}
  viewport=$(platform "$id" viewport)
  cat .github/qa/prompt.md
  # The model's "random" addresses repeat across sessions, so each run gets its own.
  # shellcheck disable=SC2016 # the backticks are Markdown
  printf '\n## Your run\n\n- Charter id: `%s`\n- Output directory: `%s/%s`\n- Fresh addresses: `qa-%s-%s-<n>@thunderbolt.test`, n = 1, 2, 3…\n\n' \
    "$1" "$2" "$1" "$1" "$(date +%s)"
  if [[ $1 == free-* ]]; then
    local case_id
    case_id=$(journey "${base#free-}")
    # shellcheck disable=SC2016 # the backticks are Markdown
    printf '## Your case (free session)\n\nPlatform: `%s`, a %s screen.\n\n```json\n' "$id" "$viewport"
    jq --arg id "$case_id" '.[] | select(.id == $id) | del(.pt)' .github/qa/journeys.json
    printf '```\n'
    return
  fi
  # shellcheck disable=SC2016 # the backticks are Markdown
  printf 'Platform: `%s`, a %s screen.\n\n' "$id" "$viewport"
  cat ".github/qa/charters/$base.md"
  printf '\n## Functions to test\n\nEach id, then the outcome that shows the function works.\n\n'
  # shellcheck disable=SC2016 # jq string interpolation
  jq --raw-output --arg charter "$base" \
    '.[$charter][] | "- `\(.id)`: \(.outcome)\(if .reload then " (after a reload)" else "" end)"' .github/qa/functions.json
}

run() {
  local session=$1 out=$2 dir=$2/$1 config
  QA_CHARTER=$session
  QA_MCP_VIEWPORT=$(platform "${session##*-}" viewport)
  : "${QA_MCP_CONFIG:=$(platform "${session##*-}" mcp)}"
  export QA_CHARTER QA_MCP_VIEWPORT QA_MCP_CONFIG
  mkdir -p "$dir"
  config=$(mktemp -d)
  # An empty config dir: no user settings, hooks, memory or login. The exit code is read from the result instead.
  # shellcheck disable=SC2086 # QA_MCP_CONFIG holds one config file per word
  QA_OUT=$out CLAUDE_CONFIG_DIR=$config claude -p "$(prompt "$session" "$out")" \
    --model claude-sonnet-5-5 \
    --setting-sources user \
    --permission-mode dontAsk \
    --tools Write \
    --allowedTools "mcp__playwright__*" "mcp__playwright_b__*" "Edit($out/**)" \
    --disallowedTools mcp__playwright__browser_run_code_unsafe mcp__playwright_b__browser_run_code_unsafe \
    --strict-mcp-config --mcp-config $QA_MCP_CONFIG \
    --max-budget-usd "${3:-2}" --max-turns 400 \
    --output-format stream-json --verbose --no-session-persistence < /dev/null > "$dir/run.jsonl" || true
  rm -rf "$config"
  jq --slurp . "$dir/run.jsonl" > "$dir/execution.json"
  jq --compact-output --from-file .github/qa/transcript.jq "$dir/execution.json" > "$dir/transcript.json"
  bun .github/qa/scripts/report.ts session --execution-file "$dir/execution.json" --charter "$session" --out "$out"
  cat "$dir/session.json"
}

case "${1:-}" in
  prompt) prompt "$2" "$3" ;;
  run) run "$2" "$3" "${4:-2}" ;;
  journey) journey "${2:-}" ;;
  *) echo "usage: $0 prompt <session> <out-dir> | run <session> <out-dir> [max-usd] | journey [<case>]" >&2; exit 2 ;;
esac
