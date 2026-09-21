# Tests

Run `npm test`. Tests use disposable projects to check immutable history,
conflicts and recovery, discovery and exact reads, portable identity, selected
captures, deliberate transfer, privacy boundaries, MCP lifecycle and host setup.

Host configuration and subprocess tests do not show that a real client loads
Glue, and they do not measure how well an assistant continues saved work. CI
runs on Windows, macOS and Linux. See [development](../DEVELOPMENT.md).

Temporary fixtures use resolved directory paths so system temporary-directory
aliases do not interfere with linked-path guards or injected filesystem failures.
