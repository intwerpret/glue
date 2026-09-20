# Portable context identity

New contexts use the workspace-relative Markdown path normalized to Unicode NFC
and lowercase as their comparison identity on every supported operating system.
The readable file keeps its existing spelling. Glue resolves each path component
against directory entries and refuses multiple case/normalization aliases rather
than selecting one arbitrarily. Filesystem-specific behavior still has to be tested on each platform; this rule
is not a promise to emulate every filesystem's name comparison.

Existing revisions keep their exact original context strings and hashes. A
relocated mixed-case context continues in its original history directory;
new revisions retain that identity. No prior revision or dependency hash is
rewritten by lookup. Case-only file renames do not create another history.

Lookup enumerates saved-context directory names, recognizes known path spellings
without reading their HEAD, and resolves identities saved under another spelling from a verified
HEAD revision. Verified directory-hash-to-context associations are cached only
in memory. Directory names are re-enumerated, so adding a competing
identity is detected on the next lookup. Two valid histories with equivalent
portable identities cause an explicit collision error, including when one already
uses the canonical spelling.

A verified empty, unlinked directory left by a failed first save has no retained
historical bytes and does not prevent unrelated new work. Any entry, including
a writer lock, prevents that exception.

An unreadable unrelated directory does not hide a known exact history. If no
known identity exists, an unreadable saved identity blocks creating another context:
it might be the missing history. This is a conservative refusal, not evidence
that the damaged directory is related. Inspect and preserve ambiguous histories
before resolving them. Lookup refuses an inventory above 10,000 contexts.

Back up the whole private store before relocation. On a filesystem that already
contains colliding filenames, repair that ambiguity explicitly before using
Glue. Independent-process filesystem replacement can still race a read; this
lookup does not authenticate an uncooperative writer or provide a cross-process
migration transaction.
