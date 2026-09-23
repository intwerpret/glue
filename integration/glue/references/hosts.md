# Host setup

This page is the reference for connecting Glue to a host by hand, checking the connection, and removing it. For a guided walkthrough, see `docs/quickstart.md` in the Glue repository.

Each Glue connection is bound to one project folder. It reads and writes only there. A prompt cannot change which folder that is.

## Before you start

The commands below run from the Glue source folder and need Node.js 22 or later. Build first:

```sh
npm ci
npm run build
```

`node PATH_TO_GLUE/install.mjs`, run from inside a project, does the Codex and Claude Code setups below for you. It also adds Glue's files to `.gitignore` in a Git project and runs the check.

## Codex

```sh
node scripts/install-skill.mjs PROJECT_FOLDER --host codex
```

This copies Glue into `.agents/skills/glue` and appends a marked `glue` block to `.codex/config.toml`. Existing text is kept. Trust the project in Codex, then start a new session.

## Claude Code

For one project:

```sh
node scripts/install-skill.mjs PROJECT_FOLDER --host claude-code
```

This copies Glue into `.claude/skills/glue` and adds a `glue` server to `.mcp.json`. Other entries are kept, but the file is rewritten, so whitespace may change. Setup refuses a file with duplicate keys or numbers it cannot store exactly. Use `--name SERVER_NAME` to choose another server name. Approve the server in Claude Code.

For every project, use the plugin instead:

```sh
node scripts/package-claude-code.mjs NEW_PLUGIN_FOLDER
claude --plugin-dir ABSOLUTE_PLUGIN_FOLDER
```

Run `claude` from the project folder. The plugin binds to the project Claude Code opens. Don't use the plugin and a project install for the same project.

## Claude Desktop

The recommended setup is the `.mcpb` extension. See the quickstart, or the extension's own README.

To set up Desktop through its configuration file instead:

```sh
node scripts/install-skill.mjs PROJECT_FOLDER --host claude-desktop --config ABSOLUTE_PATH_TO/claude_desktop_config.json --name SERVER_NAME
```

- `--config` must be the exact `claude_desktop_config.json` of the Desktop profile you use. Glue does not look for it.
- `--name` must be unique. Use one that names the project, such as `glue-website`.
- This copies Glue into `.agents/skills/glue-desktop` and adds the server to that configuration file.

Restart Desktop. In each conversation, enable only the Glue connector for the project you mean. Each connector stays bound to its own project. With two enabled, the assistant can reach both.

Desktop's Code tab can read server definitions from Desktop chat, and those take precedence over Code servers with the same name. Keep names distinct. Standalone Claude Code does not read Desktop's configuration.

## Check a connection

From anywhere, run the installed check:

```sh
node PROJECT_FOLDER/.agents/skills/glue/scripts/check.mjs
```

Use `.claude/skills/glue` or `.agents/skills/glue-desktop` for those setups. Run it with the same Node.js that ran the install, because the configuration records that exact program. The check verifies:

- the installed files match what was built;
- the host configuration points at this installation and is not disabled;
- no tool filter hides Glue's tools;
- the server starts and lists its six tools.

It prints `"ok":true` on success. It reports `"nativeLoadingVerified":false` because it cannot see inside the host. Start a session and use Glue to confirm the host loaded it.

## Remove a connection

Removing Glue never deletes handoffs or the `.glue` folder.

1. Stop the host or the Glue connection.
2. Delete the installed folder: `.agents/skills/glue`, `.claude/skills/glue` or `.agents/skills/glue-desktop`.
3. Remove the server entry:
   - Codex: the lines from `# BEGIN GLUE MANAGED CONNECTION` to `# END GLUE MANAGED CONNECTION` in `.codex/config.toml`.
   - Claude Code or Desktop: the Glue entry under `mcpServers` in the JSON file.
4. Leave other configuration alone.

To update, remove the old installation and install again. Installing over an existing copy is refused. Rebuilding the source never changes an installed copy.

If you move the project folder or change your Node.js installation, remove and reinstall the connection.
