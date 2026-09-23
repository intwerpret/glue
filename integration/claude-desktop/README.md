# Glue for Claude Desktop

This extension adds Glue to Claude Desktop. Glue lets Claude save a piece of work as a Markdown handoff, with exact copies of the files it relied on, and resume it later.

The extension is built for Windows and macOS and has been tested on Windows. It is unsigned.

## Install

1. Open the `.mcpb` file with Claude Desktop and review the install dialog.
2. Choose one project folder. The folder is required and must be outside the extension.
3. Enable the Glue connector and start a new conversation.

The extension does not change your Desktop configuration file.

Glue binds to the chosen folder when it starts. A prompt or conversation cannot change it. To switch projects, change the folder in the extension settings, restart the connection, and start a new conversation. One extension serves one project at a time.

## Try it

1. Ask: "Use Glue to save where we are to `notes/handoff.md`."
2. Start a new conversation and ask: "Use Glue to find and resume my handoff."
3. Change a detail, save again, then ask for the earlier version.

You should see six Glue tools. Glue cannot fetch outside documents. Claude needs its own tools for that.

## Your data

Handoffs and the `.glue` folder stay in your project folder when you update or remove the extension. The `.glue` folder is plaintext. Tool results go to Claude. The extension does not add `.glue/` to `.gitignore`; add it yourself if the project uses Git.

Editing or deselecting content does not delete it from history. For recovery and removing something saved by accident, see `references/maintenance.md` in this extension.

Desktop gets Glue's tools and a short set of instructions. `guidance.md` in this extension is the longer assistant guide; Desktop does not load it automatically.

## Build from source

From the Glue source folder:

```sh
npm ci
npm run build
node scripts/package-claude-desktop.mjs NEW_OUTPUT_FOLDER AUTHOR
npm exec --yes --package=@anthropic-ai/mcpb@2.1.2 -- mcpb validate NEW_OUTPUT_FOLDER/manifest.json
npm exec --yes --package=@anthropic-ai/mcpb@2.1.2 -- mcpb pack NEW_OUTPUT_FOLDER glue.mcpb
```

`AUTHOR` is the name written into the extension manifest. Pack only the output folder, never the source folder. `installation.json` lists the hash of every packaged file.
