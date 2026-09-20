# Local host setup and project binding

Source installers configure a pinned local runtime for one explicit project. They cannot confirm that the host loads it; check that in the host. Linux desktop support depends on the host's own Linux release and the distribution in use.

Build the source first (`npm ci`, then `npm run build`). The `node scripts/...` commands below run from a source checkout; packaged plugins and extensions do not contain them. Node.js 22 or later is required for these command-based installations. Run setup from a terminal or a host with authorized command access. Claude Desktop chat needs no shell tools to use an already configured connection.

From a source checkout, `node install.mjs` run inside a project chooses the host, runs the matching command below, keeps Glue's files out of the project's Git history and runs the check. The commands below are the underlying steps.

## Codex

`node scripts/install-skill.mjs WORKSPACE --host codex`

Writes `.agents/skills/glue` and appends to project `.codex/config.toml`, preserving prior text. Trust the project and restart/refresh the connection. Existing Glue names or occupied destinations are refused.

## Claude Code

The Claude Code plugin is a separate package containing the shared skill and
runtime. Build it with `node scripts/package-claude-code.mjs NEW_OUTPUT_DIRECTORY`,
then launch `claude --plugin-dir ABSOLUTE_PLUGIN_DIRECTORY` from the intended
project. It uses the host's explicit project binding and leaves existing host
configuration untouched. See the package README for its requirements.
The direct project installer below is an alternative; do not enable both for
the same project.

`node scripts/install-skill.mjs WORKSPACE --host claude-code`

Writes `.claude/skills/glue` and project `.mcp.json`. JSON settings are reserialized: unrelated values survive, whitespace changes. Duplicate keys and numeric values that would lose precision are refused. Approve the server in Claude Code; configuration alone is not activation. Select another server name with `--name PROJECT_SERVER`.

## Claude Desktop chat

The `.mcpb` extension offers a required single-project folder picker.
Open the bundle in Desktop, select the project folder and enable the
intended connector. Changing this setting requires a deliberate connection restart
and a fresh conversation. The bundle targets Windows/macOS with Node 22+. Desktop can run an extension in
its own built-in Node.js or in the system Node.js; the extension has been verified
on Windows with Desktop's built-in runtime. macOS and Linux extension loading are
untested.
It supplies MCP tools, not the Claude Code slash-command skill. The manual setup
below is an alternative; do not enable duplicate Glue connections for one project.

`node scripts/install-skill.mjs WORKSPACE --host claude-desktop --config ABSOLUTE_CONFIG_FILE --name PROJECT_SERVER`

Select the exact `claude_desktop_config.json` file for the intended profile. Glue does not discover a global profile implicitly. Choose a unique descriptive project server name. This installs `.agents/skills/glue-desktop` and writes its absolute project binding into the explicitly selected configuration. Existing names are refused. This is command-based setup, not an MCPB extension or bundled-runtime promise.

Restart Desktop and select only the intended project connector for the conversation. Each connector stays bound to its project; chat text cannot change that boundary. Multiple enabled project connectors grant the assistant access to those projects separately. A conversation title does not isolate projects. Cross-project transfer requires explicit source and destination selection.

The local Code tab can inherit Desktop chat server definitions and gives them precedence over matching names in Code configuration. Avoid duplicate names across these surfaces. Standalone Claude Code does not automatically read Desktop chat configuration.

## Checks and lifecycle

Run the installed `scripts/check.mjs` with Node. It checks the package, recorded host binding, disabled/tool-filter settings and local MCP handshake/discovery. It cannot prove effective host policies, trust, connector selection or native conversation behavior. Confirm those in the host.

Preserve handoffs and `.glue` when removing runtime files/connections. Stop the Glue process, delete only its recorded installed directory, and remove only the recorded server entry: the marked Codex block or named JSON `mcpServers` member. Preserve unrelated configuration. Moving the project or changing Node location requires deliberate reconnection. Editing or rebuilding source never changes an installed copy or its saved data.
