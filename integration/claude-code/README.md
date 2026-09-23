# Glue for Claude Code

This plugin adds Glue to Claude Code. Glue lets Claude save a piece of work as a Markdown handoff, with exact copies of the files it relied on, and resume it later.

You need Node.js 22 or later, available as `node`. The plugin downloads nothing when it starts.

## Start

Open your project folder and start Claude Code with the plugin:

```sh
claude --plugin-dir ABSOLUTE_PLUGIN_FOLDER
```

Accept the project trust prompt. Run `/mcp` to see the `glue` server and its six tools. Run `/glue:glue`, or ask Claude to use Glue.

Glue binds to the project Claude Code opened, once, at startup. Changing directory in the shell or adding folders does not change it. To work on another project, start a new session there. Keep the plugin folder outside your projects; Glue refuses to start if they overlap.

Don't also install Glue into the same project with the project installer.

## Try it

1. Ask: "Use Glue to save where we are to `notes/handoff.md`."
2. Start a new conversation and ask: "Use Glue to resume `notes/handoff.md`."
3. Change a decision, save again, then ask for the earlier version.

## Your data

Handoffs and the `.glue` folder live in your project, not in the plugin. Removing or replacing the plugin leaves them in place. Restart the session after replacing the plugin.

The `.glue` folder is plaintext. Tool results go to Claude. The plugin does not add `.glue/` to `.gitignore`; add it yourself if the project uses Git.

For recovery and removing something saved by accident, see `skills/glue/references/maintenance.md` in this plugin.

## Build from source

From the Glue source folder:

```sh
npm ci
npm run build
node scripts/package-claude-code.mjs NEW_PLUGIN_FOLDER
```

Packaging refuses to run without a fresh build. It copies a fixed list of files and records their hashes in `installation.json`. It never copies your projects or saved work.
