---
description: Control Yapper text-to-speech (on/off/status/test/voices/voice/model)
argument-hint: [on|off|toggle|status|test|voices|voice <id|name>|model <id>|maxchars <n>|speed <x>]
allowed-tools: Bash(node:*)
---

Run the Yapper control CLI and report its output to the user verbatim:

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/yapper.mjs" $ARGUMENTS`
