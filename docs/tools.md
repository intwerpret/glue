# Tools reference

Glue gives your assistant six tools. You don't call them yourself: you ask in plain language and the assistant picks the tool. This page is for when you want to know exactly what a tool does, or why a call failed.

| Tool | What it does | Changes files? |
| --- | --- | --- |
| [`glue_find`](#glue_find) | Search or list saved handoffs. | No |
| [`glue_resume`](#glue_resume) | Load a handoff and check its evidence and dependencies. | No |
| [`glue_read`](#glue_read) | Read exact saved bytes, including earlier revisions. | No |
| [`glue_checkpoint`](#glue_checkpoint) | Save a handoff as a new revision. | Yes |
| [`glue_transfer`](#glue_transfer) | Copy one reviewed handoff to another project. | Import saves a revision. The first preview creates `.glue/PROJECT.json`. |
| [`glue_check_capture`](#glue_check_capture) | Compare a re-fetched outside source with its saved copy. | No |

Hashes are SHA-256, written as 64 lowercase hex characters. Paths are relative to the project folder and use `/`. For size limits, see [Limits](limits.md).

## Errors common to all tools

| Message starts with | Meaning | What to do |
| --- | --- | --- |
| `Invalid Glue arguments.` | A parameter is missing, has the wrong type, or is not allowed. The message names the field. | Fix the named field. Nothing was saved. Use JSON `null`, not the string `"null"`. |
| `Glue store is busy.` | Another save to this context is in progress, or a lock was left behind. | Retry the same request. If it keeps failing, see [locks](recovery.md#leftover-locks). |
| `Filesystem operation failed` | The operating system refused a read or write. The code, such as `EACCES`, is included. | Check that the project folder exists and is writable. |
| `Request exceeds the 2 MiB line limit.` | The whole request, including base64 content, is too large. | Send fewer or smaller captures per save. |
| `Saved Glue data is damaged` or `Revision integrity failure` | A file in the store does not match its hash. | See [Recovery](recovery.md). Glue never resets history on its own. |

## glue_find

Search saved work, or list it with an empty query.

The query is split into words (letters, digits and `_`). A revision matches if any word appears as a substring, ignoring case, in its context path, record title or scope, handoff text, evidence file names or evidence text, or capture labels or text. For example, `price` matches "Pricing" and `2026-q3` searches for `2026` or `q3`. Results are not ranked.

Search covers the latest revision of each context unless you ask for history. It never looks at live project files.

### Parameters

| Name | Type | Default | Meaning |
| --- | --- | --- | --- |
| `query` | string | `""` | Words to look for. Empty lists saved handoffs. |
| `limit` | integer, 1–20 | 10 | Results per page. |
| `detail` | `compact`, `concise` or `full` | `compact` when listing, `concise` when searching | `compact` omits excerpts. `concise` shows one matching excerpt. `full` shows longer excerpts, up to four matching sources and the full record. |
| `includeHistory` | boolean | `false` | Also search earlier revisions. |
| `view` | `all` or `open` | `all` | `open` shows records that are active, proposed or unlabeled. It hides superseded and withdrawn records. |
| `status` | array of `active`, `proposed`, `superseded`, `withdrawn`, `none` | none | Show only these statuses. `none` means no record. Overrides `view`. |
| `cursor` | object | none | The `next` value from the previous page. |

### Result

| Field | Meaning |
| --- | --- |
| `results` | Matching revisions: `context`, `version`, `isHead`, `at` (save time), a record summary, and what `matched`. |
| `next` | Pass this as `cursor` to get the next page, with the same query and options. `null` when there are no more pages. |
| `gaps` | Contexts that could not be searched, with a `reason`. |
| `skippedEvidenceBodies` | Evidence or captures whose text was not searched because of the size budget. Their names were still searched. |
| `skippedSensitiveBodies` | Evidence or captures withheld because they look sensitive. Their names were still searched. |
| `coverage` | The limits that applied to this page. |

A result's `freshness` is always `not_checked`. Use `glue_resume` to compare with live files.

Gap reasons:

| Reason | Meaning |
| --- | --- |
| `busy` | A save is in progress for a context that has no revision yet. Retry. |
| `empty_directory`, `uninitialized` | Leftovers from a failed first save. They hold no saved data. |
| `missing_head`, `context_unavailable`, `revision_unavailable`, `history_cycle` | Saved history is damaged. See [Recovery](recovery.md). |

An empty result does not mean nothing relevant exists. It can mean different wording was used, or that text was skipped. Check `gaps` and the skipped counts. Try other words, `includeHistory: true`, or an empty query to list everything.

### Errors

| Message | What to do |
| --- | --- |
| `Search cursor head changed. Restart the search.` | A context was saved during paging. Start again without a cursor. |
| `Search cursor context disappeared. Restart the search.` | Start again without a cursor. |
| `Historical cursor requires includeHistory.` | Keep `includeHistory: true` on every page. |

## glue_resume

Load a saved handoff and check it against the live project.

### Parameters

| Name | Type | Default | Meaning |
| --- | --- | --- | --- |
| `context` | string | required | The handoff's path, such as `notes/handoff.md`. |
| `knownVersion` | hash | none | If this matches the head, the Markdown is left out of the result. Checks still run. Use it only when the assistant still has that exact text. |

### Result

| Field | Meaning |
| --- | --- |
| `version` | The head revision. `null` if the context was never saved. Pass it as `expectedVersion` on the next save. |
| `markdown` | The saved handoff text. |
| `workingCopy` | The live Markdown file: `status` is `matches`, `edited`, `missing` or `unavailable`, with its `hash`. |
| `evidence` | Each evidence file with `status` `unchanged`, `changed`, `missing` or `unavailable`, plus `savedHash` and `currentHash`. |
| `captures` | Saved captures and their labels. |
| `record` | The record labels, or `null`. |
| `dependsOn` | The dependencies this revision declares. |
| `imported` | Origin details if the handoff came from a transfer, otherwise `null`. |
| `upstreamStatus` | `not-checked` for imported handoffs. Resume never contacts the origin project. |
| `basis` | The check result, described below. |

The `basis` field holds the check result. It covers this handoff and every handoff it depends on, directly or through other dependencies.

| Field | Meaning |
| --- | --- |
| `status` | `unchanged`: nothing needs attention. `review_needed`: see `issues`. `incomplete`: some checks could not run. |
| `complete` | `false` if a check was skipped or failed. |
| `checkedRecords` | How many revisions were checked. |
| `issues` | One entry per finding: `context`, `version`, `reason`, the `source` file when relevant, and `via`, the chain of handoffs that led here. |

Issue reasons:

| Reason | Meaning |
| --- | --- |
| `source_changed` | An evidence file differs from its saved copy. |
| `saved_revision_changed` | A dependency has a newer revision than the one linked. |
| `working_copy_changed_or_missing` | A handoff file was edited or deleted outside Glue. |
| `record_proposed`, `record_superseded`, `record_withdrawn` | The handoff's record is not `active`. |
| `imported_support_omitted` | An imported handoff arrived without some of its original support. |
| `live_source_unavailable`, `live_source_path_collision`, `live_source_not_checked` | An evidence file could not be read, has a case or Unicode twin, or was too large to check. |
| `snapshot_unavailable`, `capture_snapshot_unavailable`, `saved_dependency_unavailable`, `working_copy_unavailable` | Saved data could not be read. See [Recovery](recovery.md). |
| `evidence_check_budget`, `capture_check_budget` | The check reached its size budget. See [Limits](limits.md). |

## glue_read

Read exact saved bytes: a handoff, an evidence copy or a capture, from any revision.

Omit `source` and `capture` to read the handoff text. Every result also lists the revision's evidence and captures, so this is also how the assistant sees what a revision saved.

### Parameters

| Name | Type | Default | Meaning |
| --- | --- | --- | --- |
| `context` | string | required | The handoff's path. |
| `version` | hash | head | Any earlier revision of this context. |
| `source` | string | none | An evidence file path to read. |
| `capture` | string | none | A capture ID to read. Use `source` or `capture`, not both. |
| `offset` | integer | 0 | Byte offset to start from. |
| `limit` | integer, 1–8192 | 4096 | Bytes to return. |
| `representation` | `text`, `base64` or `both` | `text` | `text` also includes base64 when the bytes are not valid UTF-8. |
| `allowSensitive` | boolean | `false` | Set `true` to read content Glue marks sensitive. See [Privacy](privacy.md#sensitive-content). |

### Result

| Field | Meaning |
| --- | --- |
| `text` or `base64` | The requested bytes. |
| `textOmitted` | Why `text` is missing: the page splits a character, or the content is binary. |
| `hash`, `bytes` | Hash and total size of the whole item. |
| `nextOffset` | Pass as `offset` for the next page. `null` at the end. |
| `parent` | The previous revision. Follow it to walk back through history. |
| `currentVersion` | The head, for comparison with `version`. |
| `evidence`, `captures`, `record`, `dependsOn` | What this revision saved. |
| `sensitive` | Whether this content is marked sensitive. |

### Errors

| Message | What to do |
| --- | --- |
| `Selected content is marked sensitive.` | Retry with `allowSensitive: true` only if the user wants that content read. |
| `Source was not selected in this saved revision.` / `Capture was not selected in this saved revision.` | Check the `evidence` or `captures` list for this version. |
| `Version is not in this context's committed history.` | Use a version from this context's history. |
| `No saved context: …` | The context was never saved. Check the path, or use `glue_find`. |
| `Offset exceeds saved content length.` | Use an offset below `bytes`. |

## glue_checkpoint

Save a handoff as a new revision.

For the optional lists and the record, leaving the field out keeps the previous value. An empty list (or `null` for `record`) clears it.

### Parameters

| Name | Type | Default | Meaning |
| --- | --- | --- | --- |
| `context` | string | required | The handoff's path. Must end in `.md`. |
| `expectedVersion` | hash or `null` | required | The `version` from resume. `null` creates a new context. |
| `markdown` | string | required | The full handoff text. It replaces the previous text. |
| `evidence` | array of paths | keep | Project files to copy into the store. |
| `reviewedEvidence` | array of `{path, hash}` | none | Confirms review of evidence files that changed. Use `currentHash` from resume. |
| `sensitiveEvidence` | array of `{path, hash}` | none | Allows evidence files that look sensitive. See [Privacy](privacy.md#sensitive-content). |
| `captures` | array of capture objects | keep | Outside material, described below. |
| `record` | object or `null` | keep | Record labels, described below. |
| `dependsOn` | array of `{context, version}` | keep | Links to other handoffs. Each must name a different context at its current head. |
| `workingCopyHash` | hash or `null` | none | The handoff file's hash from resume, when it was edited outside Glue. `null` means the file is missing. |

A context can be any Markdown file in the project except:

- files inside a folder whose name starts with `.`;
- host instruction files: `AGENTS.md`, `CLAUDE.md`, `CODEX.md`, `GEMINI.md`, `SKILL.md` and `copilot-instructions.md`, including variants such as `CLAUDE.local.md`.

Evidence can be any ordinary project file, including those instruction files. Evidence cannot be inside `.git`, `.codex`, `.agents`, `.claude` or `.glue`, and cannot be a link.

**Record fields:**

| Field | Values |
| --- | --- |
| `title` | Text, up to 200 characters. |
| `kind` | `decision`, `finding`, `note` or `artifact`. |
| `scope` | Where this applies, up to 2000 characters. |
| `provenance` | Who it came from: `user`, `assistant`, `source` or `unknown`. |
| `status` | `active`, `proposed`, `superseded` or `withdrawn`. |
| `supersededBy` | `{context, version}` of the replacement. Required when `status` is `superseded`, and not allowed otherwise. |

**Capture fields:**

| Field | Meaning |
| --- | --- |
| `id` | Lowercase ID, such as `vendor-quote`. Starts with a letter; up to 64 characters of `a–z`, `0–9`, `-`, `_`. |
| `label` | A short, safe name, up to 200 characters. |
| `representation` | `original-bytes`, `extracted-text`, `excerpt` or `derived`. |
| `basis` | How the content was obtained or extracted, up to 500 characters. |
| `scope` | Where it applies, up to 2000 characters. |
| `base64` | The content, as standard base64. |
| `origin` | Optional `{namespace, id, version}` of short opaque tokens identifying the source. |
| `retrievedAt` | Optional ISO date-time when the assistant fetched it. |
| `transfer` | `project-only` (default) or `allowed`. `allowed` makes the capture eligible for transfer. |
| `sensitiveAcknowledgement` | The capture's hash, to save content that looks sensitive. |

Labels, bases, scopes and origins must not contain file paths, email addresses, URLs with query strings or credentials.

### Result

| Field | Meaning |
| --- | --- |
| `committed` | `true` when the revision is saved. |
| `version` | The new revision's hash. |
| `replayed` | `true` if this exact request was already saved. `version` is then the earlier revision. |
| `workingCopyUpdated` | `false` if the Markdown file was not updated. The revision is still saved. Resume and reconcile. |
| `lockNotReleased` | Present if Glue could not remove its lock afterwards. See [locks](recovery.md#leftover-locks). |

If a save times out or you are unsure it worked, send exactly the same request again. Glue recognizes it and returns `replayed: true` instead of saving twice.

### Errors

| Message starts with | Meaning | What to do |
| --- | --- | --- |
| `Version conflict.` | `expectedVersion` is not the head. Another save happened. | Resume, reconcile, and save with the new version. |
| `Working copy changed.` | The Markdown file was edited outside Glue, or exists before the first save. | Resume, read the file, and pass its `workingCopy.hash` as `workingCopyHash`. |
| `Evidence changed: …` | An evidence file changed since the last save. | Resume, read the file, then pass its `currentHash` in `reviewedEvidence`. |
| `Evidence changed since review` | The file changed again after review. | Resume and review again. |
| `Dependency changed or missing` | A `dependsOn` version is not that context's head. | Resume the dependency and use its current version. |
| `Selected evidence may contain sensitive material.` | An evidence file looks like a secret. | Deselect it, or add it to `sensitiveEvidence` if the user approves. |
| `Capture may contain sensitive material.` | A capture looks like a secret. | Leave it out, or set `sensitiveAcknowledgement` if the user approves. |
| `Portable metadata may contain a private locator or credential.` | A capture's label, basis, scope or origin contains a path, email, URL query or credential. | Use a plain label and opaque origin. |
| `Context must …` | The path is not an allowed Markdown file. | Choose an ordinary `.md` path outside dot-folders. |
| `The handoff is already versioned` | The handoff itself was listed as evidence. | Remove it from `evidence`. |
| `Keep the handoff within 32 KiB` | The text is too long. | Shorten it and save large material as evidence. |
| `Selected evidence and captures exceed 64 MiB.` | The total is too large. | Select fewer files. |
| `Portable path collision.` | Two files differ only by case or Unicode form. | Rename one of them. |

## glue_transfer

Copy one reviewed handoff from one project to another. The destination gets an independent copy with its origin recorded. It does not stay in sync.

The assistant needs a Glue connection to each project. A transfer takes two steps on each side, so you can review before anything moves:

1. **Source project:** `preview` shows what would be sent and returns a `payloadHash`.
2. **Source project:** `export` with the same selection and `reviewedHash` set to that hash returns the `bundle`.
3. **Destination project:** `preview-import` with the bundle shows what would arrive and returns a `payloadHash`.
4. **Destination project:** `import` with the bundle, `reviewedHash` and a destination `context` saves it.

`check` compares an imported handoff's recorded origin with an origin version you supply.

### Parameters by action

| Action | Required | Optional |
| --- | --- | --- |
| `preview` | `context`, `version` | `captures`, `evidence`, `derivativeMarkdown` |
| `export` | `context`, `version`, `reviewedHash` | `captures`, `evidence`, `derivativeMarkdown` |
| `preview-import` | `bundle` | none |
| `import` | `bundle`, `reviewedHash`, `context`, `expectedVersion` | `workingCopyHash` |
| `check` | `context`, `upstream` | `version` |

| Name | Meaning |
| --- | --- |
| `context` | Preview and export: the source handoff. Import: the destination path. Check: the imported handoff. |
| `version` | Preview and export: the source head. Export refuses an older version. |
| `captures` | IDs of saved captures to include. Only captures saved with `transfer: "allowed"` and not sensitive qualify. Nothing is included unless listed. |
| `evidence` | Evidence copies to include, each as `{path, id, label, scope}`. They arrive as captures. The file path is not sent. |
| `derivativeMarkdown` | Replacement handoff text, for when the original contains something that must not leave. The bundle is marked derived. |
| `reviewedHash` | The `payloadHash` from the matching preview. |
| `bundle` | The bundle object exactly as export returned it. |
| `expectedVersion` | `null` to create the destination context, or its current version. |
| `upstream` | For check: the origin's current `{namespace, id, version}`, or `null` if unavailable. |

### Result

- `preview` and `preview-import` return `payloadHash` and a `manifest`: origin, title and labels, capture list, and `omittedSupport`. `omittedSupport` counts evidence, captures, dependencies and replacement links that were left out.
- `export` returns `bundle` and `payloadHash`.
- `import` returns the same fields as a checkpoint, plus `origin` and `upstreamStatus: "not-checked"`. The imported record has status `proposed` and provenance `source`.
- `check` returns `status`: `unchanged`, `changed`, `different_source` or `unavailable`.

What is never sent: history, earlier revisions, evidence you did not select, dependencies, recovery files and file paths.

### Errors

| Message starts with | What to do |
| --- | --- |
| `Transfer requires the current saved source version.` | Resume the source and use its current version. |
| `Transfer payload changed or was not reviewed.` / `Import payload was not reviewed at its exact hash.` | Preview again and use the new `payloadHash`. |
| `Portable metadata may contain a private locator or credential.` | The handoff text, a label or a capture contains a file path, email address, URL with a query string or credential. Remove it, or supply `derivativeMarkdown`. |
| `Selected transfer text may contain sensitive material.` | Supply a reviewed `derivativeMarkdown`. |
| `Source scope restricts transfer.` | The record's scope says "project only" or "do not share". Change the scope only if the user agrees. |
| `A selected capture is private or sensitive` | Deselect it, or save it again with `transfer: "allowed"` if the user agrees. |
| `Transfer bundle exceeds 1 MiB.` | Select less. |
| `The selected record has no imported origin to compare.` | `check` only works on imported handoffs. |

## glue_check_capture

Compare a capture with a fresh copy of the same outside source. The assistant fetches the source again with its own tools, hashes it, and passes the result. Glue does not fetch anything and does not change the saved capture.

### Parameters

| Name | Type | Default | Meaning |
| --- | --- | --- | --- |
| `context` | string | required | The handoff that holds the capture. |
| `version` | hash | head | The revision that holds the capture. |
| `capture` | string | required | The capture ID. |
| `hash` | hash | required | SHA-256 of the freshly obtained content. |
| `representation` | as for captures | required | Must match the saved capture to be comparable. |
| `basis` | string | required | Must match the saved capture to be comparable. |
| `origin` | `{namespace, id, version}` | none | The source's current identity and version. |
| `retrievedAt` | ISO date-time | required | When the assistant fetched it. |

### Result

| Field | Meaning |
| --- | --- |
| `comparison` | `same_supplied_bytes`, `supplied_bytes_changed`, or `basis_changed` when representation, basis or origin differ. |
| `originVersionChanged` | `true` or `false` when both sides give an origin version, otherwise `null`. |
| `declaredSourceIdentity` | `same`, `different` or `not_established`. |
| `changedStoredContent` | Always `false`. To keep the new content, save it in a new checkpoint. |
