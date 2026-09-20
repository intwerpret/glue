# Glue for Claude Desktop

Open the `.mcpb` file with Claude Desktop and inspect the installation dialog.
Choose one project folder. The folder setting is required, has no default, and
stays separate from the installed extension. Enable only the intended Glue
connector for the conversation. The extension does not edit your manual MCP
configuration.

Glue binds to the selected folder at startup. A conversation title, prompt,
current shell directory or Claude Code setting cannot change it. To select
another project, change the extension setting deliberately, restart the connection,
and start a new conversation. The extension does not provide simultaneous
multi-project connections or cloud synchronization.

To try it: ask Glue to save a small project, start a fresh conversation and ask
Glue to find and resume it, then change a detail, checkpoint, and ask for the
earlier version. Six tools should be available. A host without source-access
tools cannot retrieve an outside document just because Glue is installed.

Saved Markdown and `.glue` history stay in the selected folder when the extension
is updated or removed. Data is plaintext; selected tool output reaches Claude.
Editing or deselecting content is not deletion. See references/maintenance.md
for the recovery and clean-store procedure.

The extension is unsigned. The manifest targets Windows and macOS hosts with
Node 22+. It has been verified on Windows running in Claude Desktop's built-in
Node.js, so a separate Node.js installation is not required there. macOS has not
been tested. Linux extension loading is unverified and is not advertised by this
bundle.

Desktop receives MCP tools and core server instructions. This bundle does not
install a Claude Code slash-command skill into Desktop; guidance.md is reference
material, and Desktop does not load it automatically.

## Build from source

```text
node scripts/package-claude-desktop.mjs NEW_OUTPUT_DIRECTORY AUTHOR
npm exec --yes --package=@anthropic-ai/mcpb@2.1.2 -- mcpb validate NEW_OUTPUT_DIRECTORY/manifest.json
npm exec --yes --package=@anthropic-ai/mcpb@2.1.2 -- mcpb pack NEW_OUTPUT_DIRECTORY OUTPUT.mcpb
```

`AUTHOR` is the name written into the extension manifest. Pack only the output
directory, never the source checkout. `installation.json` lists the hash of every
packaged file.
