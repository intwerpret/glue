# Glue for Claude Code

This plugin contains the shared Glue runtime and the `/glue:glue` skill. Node.js 22
or later must be available as `node`. No dependency download happens at launch.
This is the Claude Code plugin, not the Claude Desktop extension.

Open a project folder, then launch:

```text
claude --plugin-dir ABSOLUTE_PLUGIN_DIRECTORY
```

Accept the project trust prompt. Use `/mcp` to inspect the plugin's Glue
connection and its six tools. Use `/glue:glue` or ask Claude to use Glue explicitly.
Do not enable a second Glue connection for the same project.

The host supplies `CLAUDE_PROJECT_DIR`; Glue binds to that folder once at startup.
A missing or invalid binding refuses startup. Shell directory changes and additional
folders do not expand this connection. Open a separate project/session to change
the binding. Keep the plugin outside the project; Glue refuses overlapping
plugin/project directories. Source text cannot select a different project.

Saved Markdown and `.glue` history live in the selected project, not the plugin
cache. Removing or replacing the plugin does not delete them. Restart the session
to load an updated plugin.

To try it: save a small project, open a fresh conversation, resume it, correct
one decision, then retrieve the earlier version as history. Local data is
plaintext; tool responses reach Claude. External capture and transfers require
deliberate selection.

## Build from source

Run `npm run build`, then
`node scripts/package-claude-code.mjs NEW_OUTPUT_DIRECTORY`. Packaging copies an
explicit runtime/skill inventory and the Zod runtime files and license, with hashes
in `installation.json`. It does not copy the source checkout or saved work.
