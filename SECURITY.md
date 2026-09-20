# Security

## Reporting

Report suspected vulnerabilities privately through GitHub: open this repository's **Security** tab and choose **Report a vulnerability**. Do not open a public issue for a vulnerability.

Reproduce with disposable, synthetic data where possible. Include the affected version, host and OS details, reproduction steps and the observed result. Do not include credentials, personal information, real handoffs or retained source bytes.

Only the latest pre-release is supported. There is no response-time commitment.

## Storage and trust boundaries

Glue stores handoffs, revisions and selected evidence as local plaintext protected by the host's filesystem permissions. Selected tool output reaches the connected assistant host; that host controls its own processing and transcript retention. Glue does not provide encryption, remote revocation or guaranteed physical erasure.

Each connection binds to an explicitly selected project. Source text and caller-declared status, provenance, review hashes or sensitive-content acknowledgments are not authenticated authority. Hashes verify bytes, not identity, truth or approval.

Common secret-bearing captures are blocked by heuristics, but detection is incomplete. A permitted capture is not necessarily safe to share. Sensitive retrieval is withheld by default and sensitive transfer is refused. Review actual payload content, not only metadata, before any transfer.

Editing or withdrawing a record does not erase its history. For accidental capture or damaged saved work, follow [recovery and maintenance](integration/glue/references/maintenance.md). Keep `.glue` stores and handoffs out of anything you publish. See [behavior and limits](docs/limits.md) for the full boundary.
