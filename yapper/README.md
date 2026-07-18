# Yapper

Reads Claude Code's completed responses aloud using [ElevenLabs](https://elevenlabs.io) text-to-speech.

When Claude finishes a response, Yapper's `Stop` hook grabs the final message, strips the
markdown/code down to something that sounds natural, sends it to ElevenLabs, and plays the
audio — without blocking your next prompt.

## Requirements

- **An ElevenLabs API key** (from <https://elevenlabs.io/app/settings/api-keys>). Provide it either way:
  - Set `apiKey` in `~/.claude/yapper/config.json`, **or**
  - Export `ELEVENLABS_API_KEY` (or `XI_API_KEY`) in the environment Claude Code runs in.

  If both are present, the config `apiKey` wins — an explicit config choice beats whatever might
  be lingering in the environment.
- **Node.js 18+** (uses the built-in `fetch`; no npm dependencies).
- An audio player: **`afplay`** on macOS (built in). On Linux, `ffplay` by default — override
  with `playerCmd` in the config (see below).

## Install

Yapper ships in the [`koester/claude-plugins`](https://github.com/koester/claude-plugins)
marketplace. From inside Claude Code:

```
/plugin marketplace add koester/claude-plugins
/plugin install yapper@koester-plugins
```

Then restart Claude Code (or reload plugins) so the `Stop` hook registers.

<details>
<summary>Install from a local checkout (development)</summary>

```
git clone https://github.com/koester/claude-plugins
/plugin marketplace add /path/to/claude-plugins
/plugin install yapper@koester-plugins
```

</details>

Once installed, configure your API key (see below) and you're set — speaking is on by default.

## Usage

Speaking is **on by default** once installed. Control it with the `/yapper` command:

| Command | Effect |
|---|---|
| `/yapper status` | Show current settings and whether the API key is detected |
| `/yapper on` \| `off` \| `toggle` | Enable / disable speaking |
| `/yapper stop` | Silence what's playing right now (Yapper stays enabled) |
| `/yapper test [text]` | Speak a test phrase (verifies the API key + audio) |
| `/yapper voices` | List the voices on your ElevenLabs account |
| `/yapper voice <id\|name>` | Set the voice (by voice id or by name) |
| `/yapper model <id>` | Set the model (default `eleven_flash_v2_5`) |
| `/yapper maxchars <n>` | Cap characters spoken per message (default 1000) |
| `/yapper speed <0.5-2.0>` | Set speaking speed |
| `/yapper preview <transcript.jsonl>` | Print what *would* be spoken — no API call (debug) |

The same CLI is runnable directly:

```
node yapper/scripts/yapper.mjs status
node yapper/scripts/yapper.mjs test "Hello there."
```

## Interrupting playback

Audio plays in a **detached** process (so it outlives the hook and never blocks your next
prompt). A side effect: pressing **Ctrl-C in Claude Code won't stop it** — that keystroke goes to
Claude, not to the detached player. Claude Code keybindings also can't run shell commands, so a
key can't be bound directly to "stop yapper." Use one of these instead:

- **`/yapper stop`** — silences whatever is playing immediately (Yapper stays enabled).
- **Just start your next prompt** — the `UserPromptSubmit` hook stops playback the instant you
  submit, so the previous answer stops reading as soon as you move on. Disable with
  `"stopOnPrompt": false` in the config.
- **A global OS hotkey** (optional) — bind this dependency-free one-liner to any system-wide
  shortcut (Raycast, Karabiner, skhd, an Automator Quick Action, or a shell alias):

  ```sh
  kill "$(cat ~/.claude/yapper/current.pid 2>/dev/null)" 2>/dev/null
  ```

  It targets the stable pid file, so it keeps working across plugin updates.

## Configuration

Settings persist to `~/.claude/yapper/config.json` (outside the plugin dir, so they survive
plugin updates). Defaults:

```json
{
  "enabled": true,
  "voiceId": "nPczCjzI2devNBz1zQrb",
  "modelId": "eleven_flash_v2_5",
  "maxChars": 1000,
  "stability": 0.5,
  "similarityBoost": 0.75,
  "speed": 1.0,
  "interrupt": true,
  "stopOnPrompt": true,
  "readOptions": true,
  "readOptionDescriptions": true,
  "readPreamble": true,
  "skipCodeBlocks": true,
  "outputFormat": "mp3_44100_128",
  "chunkChars": 2000,
  "playerCmd": null,
  "playerArgs": null,
  "apiKey": ""
}
```

- **`voiceId`** — defaults to **Brian** (`nPczCjzI2devNBz1zQrb`), a free premade voice available
  on every account. Swap it for any voice id or name with `/yapper voice <id|name>`, or by editing
  this field directly. Library/cloned voices work too **if your ElevenLabs plan/key is allowed to
  use them** (library voices require a paid plan — a free account gets a `402` and stays silent).
  Set to `""` to auto-select the first voice on your account. Run `/yapper voices` to see options.
- **`interrupt`** — when `true`, a new response stops the previous message's audio so they
  don't overlap.
- **`stopOnPrompt`** — when `true`, submitting your next prompt immediately stops any playback
  (see [Interrupting playback](#interrupting-playback)).
- **`readOptions`** — when `true`, also reads **question prompts** aloud (Claude's
  `AskUserQuestion` — the "pick an option" prompts). The `Stop` hook can't cover these because the
  turn is still mid-tool, so a `PreToolUse` hook reads the question and its options as they appear.
  - **`readOptionDescriptions`** — include each option's description, not only its label.
  - **`readPreamble`** — also read the assistant text shown **just before** the prompt. That text
    isn't in the `PreToolUse` payload or the transcript at prompt time, so a `MessageDisplay` hook
    captures it live as it streams and the prompt read is prefixed with it — important for planning
    flows where the questions make no sense without the context. A long preamble is capped so it
    doesn't crowd out the options.
- **`skipCodeBlocks`** — drops fenced code blocks entirely (reading code aloud is useless).
- **`chunkChars`** — long reads are split into pieces of at most this many characters (default
  2000) at sentence boundaries and played in order, staying well under the ElevenLabs per-request
  limits (~40k chars / ~40 min). Also lets you raise `maxChars` for long planning-context reads.
- **`playerCmd` / `playerArgs`** — override the audio player, e.g. `"playerCmd": "mpg123"`,
  `"playerArgs": ["-q"]`.

## How it works

`hooks/hooks.json` registers four hooks, all pointing at `scripts/yapper.mjs`:

- **`Stop`** → `--hook` — the main path: reads the hook payload from stdin (uses
  `last_assistant_message` if present, otherwise the last assistant text block from the transcript
  JSONL), strips markdown, then spawns a **detached worker** and exits immediately (never blocks).
- **`PreToolUse`** (matcher `AskUserQuestion`) → `--tool` — `Stop` doesn't fire while a question
  prompt is on screen (the turn is mid-tool), so this reads the question and its options (plus the
  captured preamble, see below). Stays silent on stdout so it can't affect the prompt.
- **`MessageDisplay`** → `--capture` — fires per displayed text chunk with a `delta` field;
  accumulates the turn's assistant text into a buffer so the `PreToolUse` read can prefix it as the
  preamble. Writes only to the buffer file; never speaks.
- **`UserPromptSubmit`** → `--interrupt` — stops playback and resets the preamble buffer when you
  submit your next prompt.
- The worker (`--worker`) calls the ElevenLabs `text-to-speech` endpoint, writes an MP3 to a
  temp file, and plays it, recording the player PID so a new read can interrupt it.

**One read at a time, in order.** Every read stamps an *epoch*; a worker whose epoch is no longer
current stops before its next chunk, so `Stop` and `PreToolUse` reads never overlap or play out of
order — the latest read always wins. Long text is split at sentence boundaries into `chunkChars`
pieces and played sequentially, keeping each request under the ElevenLabs limits.
- All failures are **soft**: missing/invalid key, network errors, or no audio player are logged
  to `~/.claude/yapper/yapper.log` and the hook still exits 0. Yapper never breaks your session.

## Troubleshooting

- **No sound, `/yapper status` says API key MISSING** — set `apiKey` in
  `~/.claude/yapper/config.json`, or export `ELEVENLABS_API_KEY` in the shell you launch Claude
  Code from and restart it.
- **`/yapper test` says nothing / log shows `401`** — the key is invalid, expired, or revoked.
  Generate a fresh one at <https://elevenlabs.io/app/settings/api-keys>. Verify with:
  `curl -s -o /dev/null -w "%{http_code}\n" -H "xi-api-key: <your-key>" https://api.elevenlabs.io/v1/voices`
  (should print `200`).
- **Log shows `402` / a voice stays silent** — that voice needs a paid plan (library/cloned
  voices do). Pick a free premade voice with `/yapper voices` + `/yapper voice <id>`, or upgrade.
- **Check the log** — `~/.claude/yapper/yapper.log` records why a message wasn't spoken.
