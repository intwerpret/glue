# Release notes

## 0.5.0-rc.1

Release candidate.

### Included

- Six MCP tools: `glue_find`, `glue_resume`, `glue_read`, `glue_checkpoint`, `glue_transfer` and `glue_check_capture`. See the [tools reference](docs/tools.md).
- Markdown handoffs with a revision for every save, readable at any point in history.
- Evidence: exact copies of selected project files, compared with the live files on resume.
- Captures: outside material the assistant retrieved, labeled as original bytes, extracted text, an excerpt or derived.
- Records that label a handoff as a decision, finding, note or artifact, with a status.
- Dependencies between handoffs, checked on resume.
- Word search over saved handoffs, labels and evidence text.
- Reviewed transfer of one handoff to another project, with its origin recorded.
- Detection of common secrets in evidence and captures.
- A recovery tool to inspect history and restore an earlier revision.
- A one-command installer for Codex and Claude Code, a Claude Code plugin, and a Claude Desktop extension.

### Supported hosts and platforms

| Host | Setup |
| --- | --- |
| Codex | Project installer |
| Claude Code | Project installer or plugin |
| Claude Desktop | Extension (built for Windows and macOS; tested on Windows), or configuration file |

Node.js 22 or later is required.

The automated tests run on Windows, macOS and Linux. Glue has been tried in all three host apps on Windows. Host app trials on macOS and Linux have not been done yet.

### Known limitations

- Resume follows dependencies forward only. Nothing lists which handoffs depend on a changed file.
- Search matches words and does not rank results.
- The store is plaintext and not encrypted.
- There is no automatic updater. To update, uninstall and install the new version. Saved history is never migrated.
- The Claude Desktop extension is unsigned.

See [Limits](docs/limits.md) for the full list.
