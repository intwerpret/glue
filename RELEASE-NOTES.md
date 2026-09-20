# Release notes: 0.5.0-rc.1

Pre-release.

## What Glue does

Glue retains deliberately selected project work so an assistant can find and resume it. It provides six MCP tools: `glue_checkpoint`, `glue_resume`, `glue_find`, `glue_read`, `glue_check_capture` and `glue_transfer`.

- Readable Markdown handoffs with saved revisions, decisions, corrections and selected supporting files.
- Lexical discovery over saved material and exact historical reads.
- Declared dependency/version checks and review of changed selected evidence.
- Host-supplied external captures labeled as original bytes, extracted text, excerpts or derived material.
- Reviewed cross-project export/import of selected work, retaining origin information and disclosing omitted support.
- Project-bound adapters for Codex, Claude Code and Claude Desktop, with plugin and extension packaging.

## Platform scope

The automated suite passes on Windows and Linux. Codex, Claude Code and Claude Desktop have been exercised natively on Windows, including the Desktop extension running in Desktop's built-in Node.js, and installation has been exercised on Linux under WSL2. macOS is part of the CI matrix, but no macOS run or host has been observed yet. These observations do not certify every host and version combination.

## Limits and updates

Glue does not automatically record conversations, crawl projects/accounts, fetch remote sources or synchronize imported copies. Local history is plaintext; selected tool output reaches the connected host. Editing, deselecting or withdrawing content does not erase earlier versions. Hashes and saved labels do not establish truth, completeness or permission.

There is no automatic updater or automatic history migration. Preserve the current package, connection and saved work before replacement. Follow [host setup](integration/glue/references/hosts.md) and [maintenance](integration/glue/references/maintenance.md). See [behavior and limits](docs/limits.md) before use.
