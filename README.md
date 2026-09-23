# Glue

Keep the context. Continue your work.

Glue is a local [Model Context Protocol](https://modelcontextprotocol.io) server and agent skill that lets an AI coding assistant save a piece of work, find it later, and pick it up again with the evidence behind it. Handoffs stay readable Markdown in your project. Every save is a revision, so corrections and the exact bytes of selected sources are preserved, and declared dependencies show which saved work needs another look when something changes.

> **Status: pre-release (0.5.0-rc.1).** Codex, Claude Code and Claude Desktop have been exercised natively on Windows. Automated tests have passed on Windows and Linux; macOS is in the CI matrix, but no macOS run or host trial has been observed yet. Linux Desktop extension loading is unverified. See [host setup](integration/glue/references/hosts.md) for details. Passing local tests do not prove that a particular host version loads the integration.

## Contents

- [Why Glue](#why-glue)
- [How it works](#how-it-works)
- [Quick start](#quick-start)
- [Example](#example)
- [Tools](#tools)
- [Other ways to install](#other-ways-to-install)
- [Privacy and retained work](#privacy-and-retained-work)
- [Update or remove](#update-or-remove)
- [Documentation](#documentation)
- [Contributing](#contributing)
- [License](#license)

## Why Glue

Assistant sessions end, context windows fill, and work moves between tools. What usually survives is a summary with nothing behind it. Glue keeps the handoff, the sources it relied on, and the history of both:

- **Readable handoffs.** A handoff is a Markdown file in your project, such as `notes/handoff.md`. You can read, edit and review it like any other file.
- **Saved revisions.** Each checkpoint is an immutable, content-addressed revision. Earlier decisions and corrections remain retrievable.
- **Evidence, not just claims.** Select the project files a handoff depends on and Glue snapshots their exact bytes. A later resume reports which of them changed.
- **Declared dependencies.** Pin one saved record to exact versions of others. Resume reports which pins are stale.
- **Deliberate, local and offline.** Glue saves only what it is asked to save, into the project it is bound to. It makes no network requests.

## How it works

Glue runs as a local stdio MCP server bound to one project at a time and saves into that project only.

```text
your-project/
├── notes/handoff.md        the handoff you and the assistant read and edit
└── .glue/                  Glue's store: plaintext, local, excluded from Git by the installer
    └── contexts/<id>/
        ├── HEAD.json       pointer to the current revision
        ├── revisions/      immutable revisions, named by SHA-256
        └── evidence/       exact snapshots of selected files and captures
```

Saved bytes are verified against their hashes whenever they are read. A checked hash verifies bytes, not truth, completeness or permission. Source text and saved labels are untrusted claims, and the assistant is told to treat them that way.

## Quick start

Requires Node.js 22 or later. Git must be available for projects that use Git.

1. Clone or download this repository, then install its dependencies once from that folder:

   ```sh
   npm ci
   ```

2. From inside the project that should get Glue, run the installer:

   ```sh
   cd path/to/your-project
   node path/to/glue/install.mjs
   ```

   It asks which assistant you use, verifies Git exclusions before activating Glue in a Git project, installs Glue, and checks that the six tools answer. Add `--host codex` or `--host claude-code` to skip the question, and `--yes` to skip the confirmation.

   If files used by Glue are already tracked, setup stops for you to review tracking; it does not untrack or delete your work. Exclusion failures are reported without showing your ignore-file contents.

3. Open the project in Codex (trust it when asked) or Claude Code (approve the `glue` server) and start a new session.

The installed check verifies the local package, configuration and tool discovery. It cannot confirm that the host loaded Glue: start a fresh session and invoke Glue to establish that.

## Example

Ask the assistant in plain language. Glue is used only when you invoke it.

> Use Glue to save where we are to `notes/handoff.md`. Include the decisions we made, the open questions, and `src/parser.ts` as evidence.

The assistant writes the handoff and calls `glue_checkpoint`. In a later session, possibly in a different assistant:

> Use Glue to find the parser work and resume it.

The assistant calls `glue_find`, then `glue_resume`, and gets back the handoff together with a report on its evidence, for example that `src/parser.ts` has changed since it was saved. Before relying on the old conclusions it can call `glue_read` to retrieve the exact bytes that were saved.

Other things to ask for:

- "Use Glue to pick this work back up. Summarize the current goal, decisions, unfinished work, changed evidence and next useful step."
- "Use Glue to explain why we chose this approach, which alternatives we ruled out, and what changed since then."
- "Use Glue to find our earlier work on this topic. If the search leaves relevant sources unchecked, tell me what remains unresolved."
- Retrieve the exact evidence behind a saved statement, or explain which declared inputs changed.
- Retain an explicitly selected external document or excerpt obtained through the host's authorized tools.
- Transfer a reviewed selection to another project, keeping its scope and reporting omitted support.

## Tools

| Tool | Purpose |
| --- | --- |
| `glue_checkpoint` | Save handoff Markdown, selected evidence, record metadata and dependency pins as a new revision. |
| `glue_resume` | Read a saved handoff and check its selected evidence and declared dependencies. |
| `glue_find` | Lexical search over saved handoffs, records and selected evidence. |
| `glue_read` | Fetch exact saved bytes, including earlier revisions, in bounded pages. |
| `glue_check_capture` | Compare a re-obtained capture digest with the saved one. The host supplies the observation. |
| `glue_transfer` | Preview, export and import a reviewed selection between projects. |

See [assistant instructions](integration/glue/SKILL.md) for their responsibilities and [behavior and limits](docs/limits.md) for the boundaries.

Glue does not crawl projects or accounts, fetch remote documents, store account credentials, discover every dependency, or automatically refresh an imported copy.

## Other ways to install

### Claude Code: install once for every project

Build the plugin and start Claude Code with it:

```sh
node scripts/package-claude-code.mjs NEW_OUTPUT_DIRECTORY
claude --plugin-dir NEW_OUTPUT_DIRECTORY
```

The plugin binds to whichever project Claude Code has open. `node scripts/package-marketplace.mjs NEW_OUTPUT_DIRECTORY OWNER` builds a plugin marketplace folder; published as a repository, it lets users run `/plugin marketplace add OWNER/REPOSITORY` and `/plugin install glue@glue`.

### Claude Desktop: open the extension

Build the extension as described in the [Desktop package notes](integration/claude-desktop/README.md), open the `.mcpb` file with Claude Desktop, and pick your project folder. No separate Node.js installation is needed on Windows.

### Manual configuration

See [host setup](integration/glue/references/hosts.md) for configuration locations, trust, restart steps, the underlying `scripts/install-skill.mjs` options and manual Claude Desktop configuration.

## Privacy and retained work

Select sources deliberately. Local saved history is plaintext; tools return selected content to the connected host, which may process it remotely. Glue cannot control host transcripts or revoke copies already shared.

Removing text from the latest handoff, clearing an evidence selection, or withdrawing a record does not erase earlier versions. Some common secret-bearing sources are blocked by the capture policy; detection is a backstop, not a guarantee that other content is safe. An intentional exception does not authorize export.

A selected export and a full backup are different. A backup includes private history. Review the actual export content as well as its manifest before sharing. For accidental capture, follow the [clean-store rebuild procedure](integration/glue/references/maintenance.md#accidental-capture-and-clean-store-rebuild).

To report a vulnerability, follow the [security policy](SECURITY.md). Do not open a public issue.

## Update or remove

There is no automatic updater. Stop the affected Glue process, preserve its package/configuration and saved work, and follow the host-specific removal instructions before installing a replacement. Code updates do not silently migrate history. Removing an integration does not require deleting handoffs or the `.glue` store.

## Documentation

- [Behavior and limits](docs/limits.md)
- [Paths and context identity](docs/identity.md)
- [Host setup](integration/glue/references/hosts.md)
- [Recovery and maintenance](integration/glue/references/maintenance.md)
- [Assistant instructions](integration/glue/SKILL.md)
- [Development](DEVELOPMENT.md)
- [Release notes](RELEASE-NOTES.md)

## Contributing

Issues and pull requests are welcome. Read [Contributing](CONTRIBUTING.md) first; commits must be signed off under the Developer Certificate of Origin. Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

Glue is licensed under [Apache-2.0](LICENSE). Third-party components are listed in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). The Glue name and logos are covered by the [trademark policy](TRADEMARKS.md).
