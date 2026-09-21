# Contributing

Glue is a pre-release. Issues and pull requests are welcome. Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md). Glue is licensed under [Apache-2.0](LICENSE), and contributions are accepted under the same license.

Sign off every commit (`git commit -s`). The `Signed-off-by` line certifies the [Developer Certificate of Origin](https://developercertificate.org/): that you wrote the change or otherwise have the right to submit it under the project's license.

Describe the problem, how to reproduce it and the intended behavior. Keep changes scoped to a requirement or a demonstrated defect. Do not include real handoffs, source snapshots, transcripts, credentials or machine-specific configuration.

Use Node.js 22 or later and npm:

```sh
npm ci
npm test
```

Use disposable projects for tests. Add focused regression coverage for changes to persistence, recovery, identity, configuration, capture or transfer. Preserve exact historical bytes, version-conflict handling, explicit project binding and unrelated configuration. Say which results come from automated checks and which from actual host use, and describe remaining limits.

Do not post sensitive reports or real project data publicly. See [Security](SECURITY.md), [Development](DEVELOPMENT.md) and [behavior and limits](docs/limits.md).
