# Security

## Reporting a vulnerability

Report vulnerabilities privately through GitHub. Open this repository's **Security** tab and choose **Report a vulnerability**. Do not open a public issue.

Include:

- the Glue version, host and operating system;
- steps to reproduce, using made-up data where possible;
- what happened and what you expected.

Do not include credentials, personal information, real handoffs or saved files.

Only the latest release is supported. There is no fixed response time.

## Trust boundary

- Each Glue connection is bound to one project folder. It reads and writes only inside it and makes no network requests.
- The store is plaintext. Your operating system's file permissions protect it.
- Tool results go to the host, which controls what happens to them next.
- Handoff text, record labels and review hashes are written by the assistant. Glue treats them as claims, not as proof of identity or approval.
- Hashes detect changed bytes. They do not show who wrote something or whether it is true.
- Sensitive-content detection catches common secrets, not all of them.

For what Glue stores and how to clean up an accidental save, see [Privacy](docs/privacy.md).
