# Glue

Keep the context. Continue the work.

Glue preserves deliberately selected work so an assistant can find it, continue it, and retrieve the evidence behind it. Handoffs remain readable Markdown. Saved revisions preserve corrections and exact selected bytes; declared dependencies help identify work that needs another review.

Glue is a pre-release (0.5.0-rc.1). It supports Codex, Claude Code and Claude Desktop on Windows, macOS and Linux; see [host setup](integration/glue/references/hosts.md) for what has been exercised on each. Passing local tests do not prove that a particular host version loads the integration.

## Install

Requires Node.js 22 or later. Clone or download this repository, then install its dependencies once from that folder:

```sh
npm ci
```

Glue always works in one project at a time and saves into that project only.

### Codex and Claude Code: one command per project

From inside the project that should get Glue:

```sh
cd path/to/your-project
node path/to/glue/install.mjs
```

It asks which assistant you use, verifies Git exclusions before activating Glue in a Git project, installs Glue, and checks that the six tools answer. Git must be available for Git projects. If files used by Glue are already tracked, setup stops for you to review tracking; it does not untrack or delete your work. Exclusion failures are reported without showing your ignore-file contents. Then open the project in Codex (trust it when asked) or Claude Code (approve the `glue` server), start a new session, and ask: "Use Glue to save where we are to `notes/handoff.md`."

Add `--host codex` or `--host claude-code` to skip the question, and `--yes` to skip the confirmation.

### Claude Code: install once for every project

Build the plugin and start Claude Code with it:

```sh
node scripts/package-claude-code.mjs NEW_OUTPUT_DIRECTORY
claude --plugin-dir NEW_OUTPUT_DIRECTORY
```

The plugin binds to whichever project Claude Code has open. `node scripts/package-marketplace.mjs NEW_OUTPUT_DIRECTORY OWNER` builds a plugin marketplace folder; published as a repository, it lets users run `/plugin marketplace add OWNER/REPOSITORY` and `/plugin install glue@glue`.

### Claude Desktop: open the extension

Build the extension as described in the [Desktop package notes](integration/claude-desktop/README.md), open the `.mcpb` file with Claude Desktop, and pick your project folder. No separate Node.js installation is needed on Windows.

### Details

The installed check verifies the local package, configuration and tool discovery. It cannot confirm that the host loaded Glue: start a fresh session and invoke Glue to establish that. See [host setup](integration/glue/references/hosts.md) for configuration locations, trust, restart steps, the underlying `scripts/install-skill.mjs` options and manual Claude Desktop configuration.

## Use Glue

Ask the connected assistant to:

- Save this work to `notes/handoff.md`, including decisions, unresolved questions, next steps and selected supporting sources.
- Find the saved work about a topic, then resume the relevant handoff.
- Retrieve the exact evidence behind a saved statement, or explain which declared inputs changed.
- Retain an explicitly selected external document or excerpt obtained through the host's authorized tools.
- Transfer a reviewed selection to another project, keeping its scope and reporting omitted support.

The tools are `glue_checkpoint`, `glue_resume`, `glue_find`, `glue_read`, `glue_check_capture` and `glue_transfer`. See [assistant instructions](integration/glue/SKILL.md) for their responsibilities and [behavior and limits](docs/limits.md) for the boundaries.

Glue does not crawl projects or accounts, fetch remote documents, store account credentials, discover every dependency, or automatically refresh an imported copy. A checked hash verifies bytes, not truth, completeness or permission. Source text and saved labels are untrusted claims.

## Privacy and retained work

Select sources deliberately. Local saved history is plaintext; tools return selected content to the connected host, which may process it remotely. Glue cannot control host transcripts or revoke copies already shared.

Removing text from the latest handoff, clearing an evidence selection, or withdrawing a record does not erase earlier versions. Some common secret-bearing sources are blocked by the capture policy; detection is a backstop, not a guarantee that other content is safe. An intentional exception does not authorize export.

A selected export and a full backup are different. A backup includes private history. Review the actual export content as well as its manifest before sharing. For accidental capture, follow the [clean-store rebuild procedure](integration/glue/references/maintenance.md#accidental-capture-and-clean-store-rebuild).

## Update or remove

There is no automatic updater. Stop the affected Glue process, preserve its package/configuration and saved work, and follow the host-specific removal instructions before installing a replacement. Code updates do not silently migrate history. Removing an integration does not require deleting handoffs or the `.glue` store.

Glue is licensed under [Apache-2.0](LICENSE). The Glue name and logos are covered by the [trademark policy](TRADEMARKS.md).

[Development](DEVELOPMENT.md) | [Contributing](CONTRIBUTING.md) | [Security](SECURITY.md) | [Behavior and limits](docs/limits.md) | [Recovery and maintenance](integration/glue/references/maintenance.md)
