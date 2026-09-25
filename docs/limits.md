# Limits

This is the one place where Glue's limits are listed. Other pages link here.

## Numeric limits

| What | Limit |
| --- | --- |
| Handoff text | 32 KiB (UTF-8) |
| Handoff file Glue will read from your project | 128 KiB |
| Context path | 500 characters, ending in `.md` |
| Evidence files per checkpoint | 64 |
| Size of one evidence file | 16 MiB |
| Captures per checkpoint | 16 |
| Size of one capture | 1 MiB |
| Evidence and captures together, per checkpoint | 64 MiB |
| One request to Glue, including base64 content | 2 MiB |
| Dependencies per checkpoint | 32 |
| Record title | 200 characters |
| Record or capture scope | 2000 characters |
| Capture label | 200 characters |
| Capture basis | 500 characters |
| `glue_find` query | 500 characters |
| `glue_find` results per page | 10 by default, 20 at most |
| Revisions searched per `glue_find` page | 64 |
| Gaps reported per `glue_find` page | 64 |
| Evidence text searched per `glue_find` page | 1 MiB |
| Evidence searched by name only | Files over 256 KiB, and files that are not UTF-8 text |
| `glue_read` page | 4096 bytes by default, 8192 at most |
| Revisions checked by one resume | 64 |
| Issues reported by one resume | 64 |
| Saved and live file bytes read by one resume | 64 MiB |
| Live evidence file checked by resume | 16 MiB |
| Captures per transfer | 16 saved captures plus 16 evidence copies |
| Transfer bundle | 1 MiB |
| Handoffs per transfer | 1 |
| Revisions per context for history lookups | 10,000 |
| Recovery request file | 100,000 bytes |

When a search or check reaches a limit, Glue says so. Search reports `next`, `gaps` or skipped counts. Resume sets `basis.complete` to `false`.

## What Glue does not do

- **It does not record conversations.** Glue saves only what the assistant passes it.
- **It does not scan your project.** Only files you select as evidence are copied and checked. Search covers saved material only.
- **It does not fetch anything.** Glue makes no network requests. Outside material arrives only as captures that the assistant retrieved with its own tools.
- **It does not judge content.** A hash shows that bytes are unchanged. It says nothing about whether a handoff is correct, complete or approved. Record labels such as `status` and `provenance` are what the assistant wrote, not verified facts.
- **It does not look backward through links.** Resume follows the links a handoff declares. Nothing finds which handoffs depend on a changed file. See [Checks run forward only](how-it-works.md#checks-run-forward-only).
- **It does not rank search results.** Search matches words. It does not understand meaning, and an empty result does not prove nothing relevant exists.
- **It does not sync transferred copies.** An imported handoff is independent. Changes on either side stay there.
- **It does not delete history.** Editing a handoff, clearing evidence or withdrawing a record leaves earlier revisions in place. See [Privacy](privacy.md#removing-something-you-saved-by-accident).
- **It does not encrypt.** The store is plaintext, protected by your file permissions.
- **It does not control what your host does with results.** Tool results go to the host, which may send them to a remote model and keep transcripts.
- **It does not update itself.** Updates are manual and never change saved history.

## Platform notes

- Glue refuses to choose between two paths that differ only by case or Unicode form, on any operating system.
- Saving needs a filesystem that supports hard links within a folder. On one that does not, the save fails and nothing partial is published.
- External editors do not respect Glue's lock. Avoid editing a handoff file at the same moment the assistant saves it.
- Glue checks paths and then opens files. Another program that swaps files in that gap can defeat the check. Do not let untrusted programs write to the project while Glue runs.
