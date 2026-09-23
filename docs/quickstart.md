# Quickstart

This guide covers four ways to set up Glue:

- [Codex](#codex)
- [Claude Code, one project](#claude-code-one-project)
- [Claude Code plugin, every project](#claude-code-plugin-every-project)
- [Claude Desktop](#claude-desktop)

Then it walks through [your first save and resume](#first-save-and-resume) and [how to update or uninstall](#update-and-uninstall).

## Before you start

You need Node.js 22 or later. Check with `node --version`.

Download Glue once and install its dependencies. The rest of this guide calls this folder `path/to/glue`.

```sh
git clone https://github.com/intwerpret/glue.git
cd glue
npm ci
```

Use one Glue connection per project. Do not set up both the plugin and a project install for the same project.

## Codex

1. From inside your project, run the installer:

   ```sh
   cd path/to/your-project
   node path/to/glue/install.mjs --host codex
   ```

2. Open the project in Codex and trust it when asked.
3. Start a new session.

The installer does three things:

- It copies Glue into `.agents/skills/glue`.
- It adds a marked `glue` block to `.codex/config.toml`. Existing text in that file is kept.
- In a Git project, it adds `.glue/`, `.agents/skills/glue/` and `.codex/config.toml` to `.gitignore`.

If Git already tracks one of those paths, the installer stops and changes nothing. Review what is tracked, then run it again.

**Check it worked.** The installer runs a check at the end. To run it again:

```sh
node .agents/skills/glue/scripts/check.mjs
```

It prints `"ok":true` and the six tool names. The check confirms the files and configuration are correct. It cannot confirm that Codex loaded Glue. To confirm that, start a session and type `$glue`, or ask "Use Glue to list saved handoffs."

## Claude Code, one project

1. From inside your project, run the installer:

   ```sh
   cd path/to/your-project
   node path/to/glue/install.mjs --host claude-code
   ```

2. Open the project in Claude Code and approve the `glue` server when asked.
3. Start a new session.

The installer copies Glue into `.claude/skills/glue` and adds a `glue` server to `.mcp.json`. Other entries in `.mcp.json` are kept, but the file is rewritten, so its whitespace may change. In a Git project, the installer adds `.glue/`, `.claude/skills/glue/` and `.mcp.json` to `.gitignore`.

**Check it worked.** Run `node .claude/skills/glue/scripts/check.mjs`. In Claude Code, run `/mcp` and look for the `glue` server with six tools.

## Claude Code plugin, every project

The plugin works in whichever project Claude Code has open. You build it once from the Glue folder.

1. Build Glue, then package the plugin into a new folder outside any project:

   ```sh
   cd path/to/glue
   npm run build
   node scripts/package-claude-code.mjs /absolute/path/to/glue-plugin
   ```

   Packaging refuses to run if the build is missing or out of date. Run `npm run build` again after any change to the source.

2. Open your project folder and start Claude Code with the plugin:

   ```sh
   cd path/to/your-project
   claude --plugin-dir /absolute/path/to/glue-plugin
   ```

3. Accept the project trust prompt.

**Check it worked.** Run `/mcp` and look for the plugin's `glue` server with six tools. Run `/glue:glue` or ask Claude to use Glue.

The plugin does not add anything to `.gitignore`. Add `.glue/` yourself if the project uses Git. See [Should I commit .glue?](faq.md#should-i-commit-glue)

To share the plugin through a marketplace, run `node scripts/package-marketplace.mjs NEW_OUTPUT_DIRECTORY OWNER`. Publish the output folder as its own repository. Users then run `/plugin marketplace add OWNER/REPOSITORY` and `/plugin install glue@glue`.

## Claude Desktop

Claude Desktop uses a Glue extension (an `.mcpb` file). The extension supports Windows and macOS.

1. Build Glue and package the extension. `AUTHOR` is the name written into the extension's manifest.

   ```sh
   cd path/to/glue
   npm run build
   node scripts/package-claude-desktop.mjs /absolute/path/to/glue-desktop AUTHOR
   npm exec --yes --package=@anthropic-ai/mcpb@2.1.2 -- mcpb validate /absolute/path/to/glue-desktop/manifest.json
   npm exec --yes --package=@anthropic-ai/mcpb@2.1.2 -- mcpb pack /absolute/path/to/glue-desktop glue.mcpb
   ```

2. Open `glue.mcpb` with Claude Desktop and review the install dialog.
3. Choose one project folder. The folder must be outside the extension.
4. Enable the Glue connector and start a new conversation.

**Check it worked.** In the connector settings, Glue lists six tools. Ask "Use Glue to list saved handoffs."

To switch projects, change the folder in the extension settings, restart the connection and start a new conversation.

Desktop gets Glue's tools and a short set of server instructions. It does not load the longer assistant guide that Codex and Claude Code use.

The extension does not add anything to `.gitignore`. Add `.glue/` yourself if the project uses Git.

For setting up Desktop through its configuration file instead, see [host setup](../integration/glue/references/hosts.md#claude-desktop).

## First save and resume

1. Do some work with your assistant, then ask:

   > Use Glue to save where we are to `notes/handoff.md`. Include our decisions, open questions, the next step, and the files we relied on as evidence.

   The assistant writes `notes/handoff.md` and saves it. Glue creates a `.glue` folder in your project.

2. Start a new conversation and ask:

   > Use Glue to resume `notes/handoff.md`. Tell me what changed and what to do next.

   The assistant reads the handoff back. Glue reports whether any evidence file changed since the save.

3. Change a decision and save again. Then ask for the earlier version:

   > Use Glue to show what the handoff said before this change.

   Every save is kept, so the assistant can read any earlier revision.

See [Ways to use Glue](ways-to-use-glue.md) for more examples.

## Update and uninstall

There is no automatic updater. Removing Glue never deletes your handoffs or the `.glue` folder. Delete those yourself only if you no longer want the history.

To update, uninstall the old copy, download the new Glue version, run `npm ci`, and install again. The installer refuses to install over an existing copy.

Stop the host (or the Glue connection) before you remove files.

**Codex:**

1. Delete `.agents/skills/glue`.
2. In `.codex/config.toml`, delete the lines from `# BEGIN GLUE MANAGED CONNECTION` to `# END GLUE MANAGED CONNECTION`.
3. Optionally, remove the `# Glue:` block from `.gitignore`.

**Claude Code, one project:**

1. Delete `.claude/skills/glue`.
2. In `.mcp.json`, delete the `glue` entry under `mcpServers`.
3. Optionally, remove the `# Glue:` block from `.gitignore`.

**Claude Code plugin:** stop passing `--plugin-dir`, or run `/plugin uninstall glue@glue` if you installed from a marketplace. To update, package a new plugin folder and restart Claude Code with it.

**Claude Desktop:** remove the Glue extension in Desktop's extension settings. To update, open the new `.mcpb` file.

For the configuration-file setup and more detail, see [host setup](../integration/glue/references/hosts.md).
