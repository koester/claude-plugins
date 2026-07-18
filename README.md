# claude-plugins

A personal [Claude Code](https://code.claude.com) plugin marketplace.

This repo doubles as a **marketplace** (`.claude-plugin/marketplace.json`) — add it once, then
install any plugin below from inside Claude Code.

## Plugins

| Plugin | Description |
|---|---|
| [**yapper**](./yapper) | Reads Claude's completed responses aloud using ElevenLabs text-to-speech. |

## Install

Add this repo as a marketplace (GitHub shorthand), then install a plugin:

```
/plugin marketplace add koester/claude-plugins
/plugin install yapper@koester-plugins
```

Restart Claude Code (or reload plugins) afterwards so any hooks the plugin ships register.

<details>
<summary>Local checkout (development)</summary>

If you've cloned the repo and want to run it from disk instead of GitHub:

```
git clone https://github.com/koester/claude-plugins
/plugin marketplace add /path/to/claude-plugins
/plugin install yapper@koester-plugins
```

The marketplace name is **`koester-plugins`** (from `.claude-plugin/marketplace.json`), so plugins
install as `<plugin>@koester-plugins` regardless of how the marketplace was added.

</details>

## Managing plugins

```
/plugin                                 # open the plugin manager UI
/plugin marketplace update koester-plugins
/plugin uninstall yapper@koester-plugins
```

## Repo layout

```
claude-plugins/
├── .claude-plugin/
│   └── marketplace.json        # marketplace manifest (lists the plugins below)
└── yapper/                     # the yapper plugin (see yapper/README.md)
    ├── .claude-plugin/plugin.json
    ├── hooks/hooks.json
    ├── commands/
    ├── scripts/
    └── README.md
```

## Adding a plugin to this marketplace

1. Create a top-level folder `<plugin-name>/` with a `.claude-plugin/plugin.json`.
2. Add its `hooks/`, `commands/`, `agents/`, and/or `skills/` as needed.
3. Register it in `.claude-plugin/marketplace.json` under `plugins[]`:

   ```json
   { "name": "<plugin-name>", "source": "./<plugin-name>", "description": "…" }
   ```

See the [official plugin docs](https://code.claude.com/docs/en/plugins-reference) for the full schema.
