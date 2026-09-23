# Tests

Run `npm test`. It builds the source and runs every `tests/handoff*.test.mjs` file with Node's built-in test runner.

Each test creates a throwaway project folder and uses made-up data. The tests cover:

- revisions, version conflicts, retries and recovery;
- search and exact reads;
- path handling across operating systems;
- captures, sensitive content and transfer;
- the MCP protocol and server lifecycle;
- installation, packaging and host configuration.

Some tests start Glue as a subprocess and talk to it over MCP. No test starts a real host app, so they cannot show that a host loads Glue.

Test fixtures resolve temporary folder paths first. This keeps system aliases for the temporary folder from tripping Glue's link checks.

See [CONTRIBUTING.md](../CONTRIBUTING.md) for setup and conventions.
