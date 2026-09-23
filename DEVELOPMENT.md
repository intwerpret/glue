# Development

Requires Node.js 22 or later and npm.

```sh
npm ci
npm test
```

The suite builds the source and runs disposable fixtures. Run focused checks for changed behavior, then the full suite. Subprocess tool discovery is not proof that a host loaded the integration; note host and platform trials separately from automated results.

## Development installation

```sh
npm run build
node scripts/install-skill.mjs . --development
```

`--development` permits installation into the source project. The installed runtime is an independent copy; rebuilding source does not update it. Stop the affected process and preserve the package, configuration and saved data before replacing it. Installation never migrates saved history.

## Changes and tests

Tie changes to a requirement or a demonstrated defect. Preserve exact saved bytes, version conflicts, retry semantics, explicit project binding and unrelated user configuration. Use synthetic data in every test and fixture: no real transcripts, credentials, machine paths or saved stores.

Review errors as well as successful results for disclosure. Derived text must not be presented as retained original bytes. Caller-declared provenance and sensitive-content acknowledgments are not authenticated permission. Host-specific instructions must not assume every host has shell or native file tools.

See [architecture](ARCHITECTURE.md), [behavior and limits](docs/limits.md), [host setup](integration/glue/references/hosts.md) and [maintenance](integration/glue/references/maintenance.md).
