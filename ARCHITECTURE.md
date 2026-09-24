# Architecture

Glue is a local MCP server. A host starts it over stdio, bound to one project
directory. It saves versioned Markdown handoffs, with selected evidence, in the
project's `.glue` store and reads them back. It makes no network requests.

This page maps the code for contributors. For user-facing behavior see
[behavior and limits](docs/limits.md) and [context identity](docs/identity.md).

## Modules

All runtime code is TypeScript in `src/`, compiled to `dist/`. Runtime
dependencies are `zod` (schemas) and, for the installer and installed check
only, `smol-toml`.

| Module                 | Responsibility                                                                   |
| ---------------------- | -------------------------------------------------------------------------------- |
| `mcp.ts`               | Stdio framing, JSON-RPC lifecycle, tool dispatch and error text. Entry point.    |
| `tools.ts`             | Tool names, tool descriptions and server instructions: all model-facing text.    |
| `handoff.ts`           | `Handoffs`: store layout, context lookup, save, resume, inspect and restore.     |
| `knowledge.ts`         | `Knowledge`: read-only tools (resume with basis check, find, read, check capture). |
| `knowledge-schema.ts`  | Input schemas for the read tools, record metadata and dependency references.     |
| `captures.ts`          | Capture schemas, capture preparation and the privacy heuristics.                 |
| `transfer.ts`          | `Transfers`: preview, export, import and check of records between projects.      |
| `identity.ts`          | Workspace path rules, portable path keys and context identity lookup.            |
| `storage.ts`           | Link checks, lock directories and atomic file replacement.                       |
| `schemas.ts`           | Shared schema pieces (digest, paths, capture id, record enums) and `sha256`.     |
| `limits.ts`            | Every size and count bound, as named constants.                                  |
| `recovery.ts`          | CLI for `inspect` and `restore`. Entry point.                                    |
| `input.ts`             | Bounded JSON request reading for the recovery CLI.                               |

Outside `src/`:

- `scripts/` builds, installs and packages Glue (see [Build and packaging](#build-and-packaging)).
- `integration/glue/` is the skill an installation copies: `SKILL.md`, references,
  the installed `check.mjs` and `configuration.mjs`, and `project-binding.mjs`.
- `integration/claude-code/` and `integration/claude-desktop/` hold the plugin and
  extension launchers. Each binds one project folder at startup and then calls
  `serveMcp` from the packaged runtime.
- `install.mjs` is the one-command installer. It wraps `scripts/install-skill.mjs`.

## Request flow

1. **Framing.** `mcp.ts` reads stdin in chunks. It accepts native streams and
   hosts whose stdin only emits `data` events (queue bounded to 4 MiB). It splits
   on newlines and bounds each line to 2 MiB. An oversized line is discarded up
   to its newline and answered with an error; the connection stays open.
2. **JSON-RPC.** Each line is decoded as strict UTF-8 and parsed as JSON, then
   checked as a JSON-RPC 2.0 request. Notifications never produce a response.
3. **Lifecycle.** `initialize`, then `notifications/initialized`. Tools are
   refused before that. `ping` is answered in any phase.
4. **Dispatch.** `tools/list` builds each tool from `tools.ts` text and the
   tool's zod schema (`z.toJSONSchema`, draft-7, input side). `tools/call` looks up
   the handler by name.
5. **Validation.** The handler parses its input with a strict zod schema.
   Unknown fields are rejected.
6. **Work.** Handlers are synchronous and run against `Handoffs`, `Knowledge`
   or `Transfers`. Writes take the context's write lock (see below).
7. **Result.** A successful result is JSON text in one content item. Any thrown
   error becomes a tool result with `isError: true`, not a protocol error.
   Validation errors name fields but never echo submitted values. Error text
   replaces the workspace path with `[project]`.
8. **Output.** Responses are written one per line and respect stream
   backpressure. If output closes, the server stops reading.

## Store layout

Everything Glue saves lives under `.glue/` in the bound project. The context's
Markdown file in the project is the **working copy**; Glue replaces it only when
its current text is already saved.

```text
.glue/
  PROJECT.json                   transfer namespace; created once, never rewritten
  contexts/
    <context id>/                sha256 of the context's identity path
      HEAD.json                  {"format":1,"version":"<revision hash>"}
      .initialized               marker: history exists, so HEAD must exist
      .write-lock/owner.json     present only while a writer holds the lock
      revisions/<hash>.json      one immutable revision per version
      evidence/<hash>[.ext]      immutable evidence and capture snapshots
      recovery-<hash>.json       record of each explicit restore
```

- The **identity path** of a new context is its workspace-relative path in
  Unicode NFC, lowercased. Older histories keep the exact spelling they were
  saved under; `identity.ts` finds them. See [context identity](docs/identity.md).
- A **version** is the sha256 of the revision's JSON bytes. A revision records
  its context, parent version, request hash, time, Markdown, evidence list and
  optional record metadata, dependency pins, captures and import origin.
- An **evidence snapshot** is named by the sha256 of its bytes plus the source's
  lowercased extension. A **capture** snapshot is named by its hash alone.
- `restoredFrom` in the revision schema and legacy-spelling identity lookup are
  kept so older stores stay readable.

## Save protocol

`Handoffs.save` (the `glue_checkpoint` tool; transfer imports use it too):

1. Parse the request. Check the Markdown size, resolve and sort evidence paths,
   and prepare captures (canonical base64, size, portable metadata, sensitivity).
2. Compute the **request hash**: sha256 of the normalized request.
3. Create the context directory and take `.write-lock` (an exclusive `mkdir`
   plus `owner.json`).
4. Read HEAD. If `expectedVersion` is not the current version, walk the
   committed ancestors of HEAD for a revision with the same request hash. If one
   exists, this is a retry: return it with `replayed: true`. Otherwise refuse
   with a version conflict. Nothing is written.
5. Refuse if the working copy diverged from the saved text and the caller did
   not supply its observed `workingCopyHash`.
6. Fill omitted fields from the previous revision. Check dependency pins against
   the current heads of those contexts. Read the selected evidence; changed
   files need `reviewedEvidence`, sensitive files need an exact-content exception.
7. Write every evidence and capture snapshot, then the revision file.
8. Write `.initialized`, then replace `HEAD.json`. This is the commit point.
9. Replace the working copy if its hash still matches what step 5 observed.
   A failure here leaves the commit intact and returns `workingCopyUpdated: false`.
10. Release the lock. A lock that cannot be removed is reported in
    `lockNotReleased`; the saved work stands.

If a first save fails, its empty context directory is removed. `rmdir` refuses
non-empty directories, so no history or lock is ever deleted.

### Invariants

- **Content-addressed.** Revisions and snapshots are named by the sha256 of
  their bytes. Reads verify size and hash before returning anything.
- **Write-once.** Immutable files are written to a private temporary file,
  fsynced, then published with a hard link. A hard link never replaces an
  existing file. If the name exists, its bytes must match exactly.
- **HEAD last.** HEAD is replaced by temporary file, fsync and rename, after all
  the bytes it points to are durable. A crash before that leaves unreachable
  files, never a HEAD that points at nothing.
- **Retries replay.** The same request against an older version returns the
  committed result instead of saving twice. Only committed ancestors count.
- **Conflicts save nothing.** A stale `expectedVersion` fails before any write.
- **No links.** Store files and their parent directories must not be symbolic links.
- **No silent reset.** Damaged or missing HEAD, revisions or snapshots raise an
  error that points to explicit recovery. History is never rewritten.

## Reads

- `glue_resume` returns the head revision and a **basis** check: a breadth-first
  walk of declared dependencies that compares snapshots and live sources.
  It is bounded to 64 records and 64 MiB and reports `incomplete` when cut short.
- `glue_find` scans `.glue/contexts` in sorted directory order. It pages with a cursor
  and bounds revisions, gaps and searched bytes per page. It never crawls the
  workspace.
- `glue_read` pages exact bytes of a revision's Markdown, evidence or capture.
  Sensitive content needs `allowSensitive: true`.
- `recovery.js` offers `inspect` (integrity and ancestry of every revision) and
  `restore` (point HEAD at a chosen verified version, keeping a recovery record).

## Build and packaging

- `npm run build` runs `scripts/build.mjs`. It fingerprints the inputs (`src/`,
  `tsconfig.json`, `package.json`, `package-lock.json`) as `sourceId`, removes
  stale `dist/` output, runs `tsc`, and writes `dist/build.json` with the
  `sourceId` and a hash of every compiled file. The build fails if the source
  changed while compiling.
- `scripts/install-skill.mjs` refuses to install unless `dist/build.json`
  matches the current source and compiled files. It stages the skill files,
  the runtime modules listed in `scripts/runtime-files.mjs`, the needed parts
  of `zod` and `smol-toml`, and an `installation.json` with a hash of every
  file. It moves the stage into place, then adds the host connection under a lock.
  If connecting fails, the new package is moved back out.
- The installed `scripts/check.mjs` verifies the package fingerprint and host
  configuration, starts the runtime and checks `initialize` and `tools/list`.
- `scripts/package-host.mjs` builds the Claude Code plugin and Claude Desktop
  extension directories. `scripts/package-marketplace.mjs` wraps the plugin in a
  marketplace folder. Both verify `dist/build.json` the same way.

A new runtime module must be added to `runtimeModules` in
`scripts/runtime-files.mjs`, or installed copies will not load it.

## Tests

- `npm test` builds, then runs `tests/handoff*.test.mjs` with `node:test`.
  Tests import from `dist/` or start `dist/mcp.js` as a subprocess.
- Every test uses a disposable temporary project. Filesystem failures are
  injected by patching `node:fs` and calling `syncBuiltinESMExports`.
- Each file covers one area, named in the file: saving, evidence, the working
  copy, recovery, paths, knowledge, privacy, transfer, locks, storage, the MCP
  protocol, installation, the one-command installer, plugin and desktop.
  [tests/README.md](tests/README.md) lists them.
- `npm run typecheck` and `npm run format:check` run in CI with the tests, on
  Windows, macOS and Linux with Node 22 and 24.
