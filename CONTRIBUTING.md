# Contributing

Issues and pull requests are welcome. Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md). Glue is licensed under [Apache-2.0](LICENSE), and contributions are accepted under the same license.

Report security problems privately. See [SECURITY.md](SECURITY.md).

## Set up

You need Node.js 22 or later and npm.

```sh
git clone https://github.com/intwerpret/glue.git
cd glue
npm ci
npm test
```

`npm test` builds the TypeScript source into `dist/` and runs every test. CI runs the same command on Windows, macOS and Linux.

To run one test file:

```sh
npm run build
node --test tests/handoff-storage.test.mjs
```

To try your build in a real host, install it into the source folder itself:

```sh
npm run build
node scripts/install-skill.mjs . --development
```

The installed copy does not change when you rebuild. Remove it and install again to pick up changes. See [host setup](integration/glue/references/hosts.md#remove-a-connection).

## Where things are

For how the parts fit together, read [ARCHITECTURE.md](ARCHITECTURE.md).

| Path | Contents |
| --- | --- |
| `src/` | The server, in TypeScript. `mcp.ts` holds the protocol loop and the tool table. |
| `integration/glue/` | What gets installed: the assistant guide (`SKILL.md`), `references/`, and the check script. |
| `integration/claude-code/`, `integration/claude-desktop/` | Plugin and extension launchers, and the README each package ships. |
| `scripts/` | Build, install and packaging. |
| `tests/` | Tests. See [tests/README.md](tests/README.md). |
| `docs/` | User documentation. `docs/internals/` is for contributors. |

Some documentation ships inside installed packages, where users have no copy of this repository:

- `integration/glue/references/hosts.md` and `maintenance.md` are copied into every installation. Tests check that they are present.
- `integration/claude-code/README.md` and `integration/claude-desktop/README.md` become the package READMEs.

Keep those files self-contained. Link to repository docs by name, not by relative path.

## Making a change

- Open an issue first for anything larger than a small fix, so we can agree on the approach.
- Keep each pull request to one problem.
- Add a test for any change to saving, recovery, path handling, configuration, captures or transfer.
- Use made-up data in tests and examples. Never include real handoffs, transcripts, credentials or paths from your machine.
- Update the docs in the same pull request when behavior changes. Each limit is stated once, in [docs/limits.md](docs/limits.md).

Some rules protect users' saved work. A change must not:

- rewrite or delete existing revision bytes;
- let a stale `expectedVersion` save anything;
- change configuration that belongs to other tools;
- let a connection reach outside its bound project;
- include a submitted value or a machine path in an error message.

## Style

Code is formatted with Prettier. Before committing, run:

```sh
npm run format
npm run typecheck
npm test
```

CI runs `npm run format:check` and `npm run typecheck` on every push. Comments explain why code does something, not how it changed over time. Name new limits in `src/limits.ts` and shared schemas in `src/schemas.ts`.

Write documentation in plain words, second person and short sentences. Use the terms defined in [How Glue works](docs/how-it-works.md#terms).

## Commits

Sign off every commit:

```sh
git commit -s
```

The `Signed-off-by` line certifies the [Developer Certificate of Origin](https://developercertificate.org/): you wrote the change, or otherwise have the right to submit it under the project's license.

Write the subject line as a short imperative sentence, such as "Refuse duplicate capture IDs".

## Review

A maintainer reviews every pull request. Expect questions. Review looks at:

- whether the change solves the stated problem, and only that;
- tests, including failure cases;
- whether saved data, error messages or docs could expose private information;
- whether the docs still match the behavior.

In the pull request, say what you tested. Keep automated test results separate from what you tried in a real host, and name the host and operating system.
