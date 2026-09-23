# Privacy

## What Glue stores

Glue stores only what the assistant passes to it:

- the handoff text of every revision;
- exact copies of evidence files you select;
- captures, which are outside material the assistant retrieved;
- record labels and dependency links;
- your own edits to a handoff file, when the assistant saves over them;
- recovery files, when you restore an earlier revision.

It does not store conversations, account credentials or files you did not select.

## Where it is stored

Everything lives in the `.glue/` folder inside your project. See [where data lives](how-it-works.md#where-data-lives). The files are plaintext and are not encrypted. Anyone who can read your project folder can read them.

Glue makes no network requests of its own.

## Who can see it

- **You and anyone with access to the project folder.** This includes backups and sync services that copy the folder.
- **Your host and its model.** When the assistant calls a Glue tool, the result goes to the host app. The host may send it to a remote model and keep it in transcripts. Glue does not control that.
- **Anyone you give the store to.** Committing `.glue/` to a shared repository publishes all of its history. See [Should I commit .glue?](faq.md#should-i-commit-glue)

The project installer adds `.glue/` to `.gitignore` in Git projects. The Claude Code plugin and the Claude Desktop extension do not. Add it yourself if you use those.

Installed configuration files and the output of `check.mjs` contain paths on your machine. Review them before sharing.

## Sensitive content

Glue refuses to save evidence files or captures that look like a secret, unless you approve them. It does not check the handoff text on save, so keep secrets out of what the assistant writes.

It treats a file or capture as sensitive when:

- the file name looks like a credential file, such as `.env`, `.npmrc`, `.pypirc`, `id_rsa`, `id_ed25519`, `credentials.json`, or a `.pem`, `.key`, `.p12` or `.pfx` file;
- or the content contains a private key block, a common API token pattern, or text like `password=…`, `api_key: …` or `secret=…` followed by a value.

This detection is a safety net. It catches common cases, not all of them. Content it misses may still be private.

**To save sensitive content anyway,** the assistant passes the exact hash of that content. For evidence, it uses `sensitiveEvidence: [{path, hash}]`. For a capture, it uses `sensitiveAcknowledgement`. The approval covers only those exact bytes. Only do this if you want that content kept.

After sensitive content is saved:

- Search never matches or shows its text. Its file name can still match.
- `glue_read` withholds its bytes unless the call sets `allowSensitive: true`.
- Transfer always refuses it.

Transfer is stricter again. It refuses handoff text, labels or captures that contain file paths, email addresses, URLs with query strings or credentials.

## Removing something you saved by accident

Editing the handoff, clearing its evidence or withdrawing its record does not remove anything. Every earlier revision still holds its copies. So do recovery files and saved copies of your own edits.

If the saved content includes a credential, revoke that credential first. Cleaning the store does not undo exposure.

To remove the content from Glue's history, rebuild a clean store. Follow the [clean rebuild procedure](recovery.md#remove-something-saved-by-accident). In short, you transfer only the handoffs you want to keep into a fresh project, check the result, and then retire the old store.

The rebuild does not reach copies outside the store: backups, exported bundles, other projects that imported a copy, or host transcripts. Deal with those separately.
