# Tests

Run `npm test`. It builds the source and runs every `tests/handoff*.test.mjs` file with Node's built-in test runner.

Each test creates a throwaway project folder and uses made-up data. Each file covers one area:

| File | What it covers |
| --- | --- |
| `handoff-save` | Saving, version conflicts, retries and concurrent writers |
| `handoff-evidence` | Evidence snapshots, review of changed evidence, linked sources |
| `handoff-working-copy` | The handoff file on disk: edits, damage, failed writes |
| `handoff-recovery` | Inspecting history, restoring revisions, interrupted first saves |
| `handoff-paths` | Path rules, case and Unicode spellings, filesystem aliases |
| `handoff-knowledge` | Search, exact reads, dependencies and captures on resume |
| `handoff-privacy` | Sensitive content, private locators, clean copies |
| `handoff-transfer` | Moving a handoff to another project |
| `handoff-lock` | Write and installation locks |
| `handoff-storage` | Atomic file writes |
| `handoff-protocol` | The MCP server: lifecycle, tool schemas, errors and input framing |
| `handoff-installation` | The project installer and its checker |
| `handoff-easy-install` | The one-command installer and Git exclusions |
| `handoff-plugin` | The Claude Code plugin and marketplace packages |
| `handoff-desktop` | The Claude Desktop extension |

Each test name states the behavior it protects. When you add a test, name it the same way, and put it in the file for its area.

Some tests start Glue as a subprocess and talk to it over MCP. No test starts a real host app, so they cannot show that a host loads Glue.

Test fixtures resolve temporary folder paths first. This keeps system aliases for the temporary folder from tripping Glue's link checks.

See [CONTRIBUTING.md](../CONTRIBUTING.md) for setup and conventions.
