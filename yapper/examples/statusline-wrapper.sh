#!/bin/bash
# statusline-wrapper.sh — append yapper's status to your existing Claude Code status line.
#
# Setup:
#   1) Set BASE_STATUSLINE below to your current status line command (empty = none).
#   2) chmod +x this file.
#   3) In ~/.claude/settings.json set:
#        "statusLine": { "type": "command", "command": "/absolute/path/to/statusline-wrapper.sh" }
#
# Kept as a wrapper so neither yapper's updates nor your base status line's self-updater clobber it.

INPUT=$(cat)

# --- your existing status line (edit this) ---
BASE_STATUSLINE="$HOME/.claude/statusline-command.sh"

BASE=""
if [[ -n "$BASE_STATUSLINE" && -x "$BASE_STATUSLINE" ]]; then
  BASE=$(printf '%s' "$INPUT" | "$BASE_STATUSLINE")
fi

# yapper segment — find the installed script version-agnostically (newest install wins)
YAP=""
YAPPER=$(ls -t "$HOME"/.claude/plugins/cache/*/yapper/*/scripts/yapper.mjs 2>/dev/null | head -1)
if [[ -n "$YAPPER" ]] && command -v node >/dev/null 2>&1; then
  YAP=$(node "$YAPPER" statusline 2>/dev/null)
fi

if [[ -n "$BASE" && -n "$YAP" ]]; then
  printf '%s \033[2m│\033[0m %s' "$BASE" "$YAP"
else
  printf '%s%s' "$BASE" "$YAP"
fi
