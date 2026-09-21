# Behavior and limits

This document describes the current pre-release. Passing local tests, an available installer adapter and a host actually loading Glue are different things. See [host setup](../integration/glue/references/hosts.md) for what has been exercised on each host.

## Selected knowledge, not automatic memory

Projects are isolated by their selected connection. Glue retains chosen Markdown and sources; it does not crawl other projects, accounts or ordinary unsaved files. `glue_find` is lexical discovery over saved material, not a complete workspace index or a relevance guarantee. A no-match result does not prove that relevant knowledge is absent.

Records may carry title, kind, scope, provenance, status and a replacement reference. These are attributed claims, not authenticated owner approval. Historical labels remain historical. A superseded record requires an explicit replacement; copied statements must keep their applicability and restrictions.

`dependsOn` pins exact saved context versions, up to 32 per checkpoint. Supplied pins must name distinct other contexts at their current saved heads. Omission retains existing pins; an empty array clears them. Later changes do not silently advance old pins. Resume checks the declared closure and reports affected records and incomplete checks; it cannot discover unknown dependencies or certify sufficient knowledge.

## Local evidence and supplied captures

Local evidence selects ordinary project files: up to 64, at most 16 MiB each and 64 MiB total. Traversal, symbolic links and junctions, reserved names, unlisted filesystem aliases such as Windows short names, and `.git`, `.codex`, `.agents`, `.claude` and `.glue` directories at any depth are refused. Hard links are not detected. A context is a file Glue writes, so it must also stay outside dot-directories and cannot be a host instruction file such as `AGENTS.md`, `CLAUDE.md` or `SKILL.md`; those files can still be selected as evidence. Omission retains the selected evidence; an empty selection clears the current selection. Earlier copies remain in history.

A changed local source requires explicit review and reconciliation, then its observed current hash in `reviewedEvidence`. Another edit before capture rejects that acknowledgment. Acknowledgment records what the caller supplied; it does not prove comprehension, accuracy or authorization.

External material is supplied through authorized host retrieval, not by granting Glue access to an external directory or account. A capture identifies original bytes, extracted text, an excerpt or a derived representation; its basis explains what was retained. Capture IDs and opaque origin metadata are not credentials or private source locators. Keep private resolution details outside portable metadata.

Supplied captures use canonical base64: up to 16 per checkpoint, limited to 1 MiB each. MCP requests also have a 2 MiB line limit, including base64 and metadata, so the individual limits are not a promise that all maximum-size captures fit one call. A longer request is refused with a protocol error and nothing is saved; the connection stays open. A retained-byte hash identifies the supplied bytes only. Host-declared retrieval time and Glue receipt time are distinct. A new receipt time does not make an old capture a fresh original-source check. Missing originals and incomplete extractions must stay explicit.

`glue_read` retrieves exact saved content, including a selected capture. `glue_check_capture` compares a caller-supplied observation with the selected retained capture; it does not fetch or authenticate an original. Re-obtain the same representation through authorized host tools before claiming an original check. A changed extraction method or uncertain source identity is not automatically an original-content change. Checking never adopts new bytes.

## Reads, checks and bounded results

Exact reads use byte pages: 4096 bytes by default, at most 8192. Base64 preserves binary bytes and split UTF-8 characters; decoded text is available only for valid slices, and `textOmitted` distinguishes a page that splits a multi-byte character from content that is not UTF-8. Follow the returned continuation offset. Historical reads are limited to committed ancestry and explicitly refuse unsupported or damaged history; they do not certify current freshness.

Search examines at most 64 revisions per page and reports gaps. Gap reasons separate provably empty remnant directories and uninitialized directories (no saved bytes) from missing-head or unavailable committed histories, which keep their corruption warning; a context path appears only when a hash-verified revision supplies it. `view:"open"` or an explicit `status` filter narrows results by caller-declared record status without deleting anything; a rejected first save leaves no empty identity directory. Evidence-text search has a 1 MiB page budget; individual evidence above 256 KiB is searched by name only. Follow the returned cursor with the same query/history options. A changed head may require restarting. New records during traversal can require another search. Skipped or unavailable bodies are not silently treated as searched.

Declared-basis assessment is bounded to 64 record versions, 64 issues and 64 MiB of assessed snapshot/live evidence. Exhaustion or inaccessible material makes the result incomplete. Checks observe files at different moments, not one atomic project snapshot. An unchanged result means only that the declared checked basis has no observed issue.

## Deliberate transfer

`glue_transfer` is advertised as a single object with an `action` enum and documented fields (a discriminated union serializes without top-level properties, which some hosts render as an empty schema); validation stays action-specific and rejects irrelevant fields, and validation errors name the field and expected shape without echoing submitted values. It exports and imports an explicit selection, one record per bundle with at most 16 selected support captures and a 1 MiB serialized bundle limit. `transfer:"allowed"` on a capture only permits selection. Preview exposes the selection manifest without payload bytes; read the exact selected content separately before acknowledgment. Export/import require its exact reviewed hash. That hash records caller review, not authenticated approval. A destination receives an independent copy with separate local identity. History, prior manual text, recovery files, private locators and unselected dependency closure must not be silently copied. Missing or excluded support remains visible without exposing its private identity.

Review payload bytes as well as labels and manifests. A sensitive statement can occur inside an otherwise ordinary document. If excluded content is embedded in selected text, produce a reviewed derivative with a new identity rather than claiming the changed content is the original. Source restrictions are attributed information; applicable user restrictions still govern whether transfer is authorized.

No import establishes authenticated permission, globally applicable preferences or current upstream freshness. No automatic upstream access occurs during ordinary local resume. An explicit check cannot overwrite the destination; adoption is deliberate. Later upstream withdrawal or deletion does not revoke copies already transferred. The transfer `check` action compares a caller-supplied origin identity/version (or reports unavailable when null); it does not fetch or authenticate upstream state. `payloadHash` remains the original import receipt, not a checksum of subsequent local edits; `localModified` discloses those edits. Source provenance and earlier `originReceivedAt` stay attributed separately from the destination receipt time and local proposed record.

## Writes, history and recovery

The authoritative saved head points to a hash-verified revision; ordinary Markdown is a readable working copy. Saved content includes selected snapshots and, when reconciling external edits, prior manual text. A checkpoint commits history before projecting the working file. `workingCopyUpdated:false` does not undo that commit.

Use the version returned by resume for a new save. Identical retries locate their earlier committed result, including after intervening saves. A replay does not necessarily rewrite the current working copy. Conflicts require resume and reconciliation. Corrupt history is not silently reset.

Handoff text is limited to 32 KiB UTF-8; larger artifacts belong in selected sources. Working-copy reads are limited to 128 KiB. An unreadable, oversized or invalid-UTF-8 working copy is unavailable, not missing; verified saved content can remain readable while writes and restores are blocked.

A checkpoint or restore holds a `.write-lock` directory inside the context's saved history and removes it afterwards. The removal can fail, for example where the host allows creating files but not deleting them. Glue then reports what the write itself did and adds `lockNotReleased`: beside the result when the write committed, or after the error text when the write was rejected. It does not retry, adopt or delete that lock.

When HEAD is absent and a writer lock is present, resume reports retryable busy and find reports a `busy` coverage gap. The lock may belong to an active or interrupted first save; reads do not remove it or establish process liveness. If HEAD appears during the check, reads validate it normally. Existing committed history remains readable during later writes. Initialized history with no HEAD and no other writer lock still requires explicit recovery.

A leftover lock blocks later writes to that context, which report busy. If the context was never saved, its directory holds only the lock and Glue also refuses to create any new context, because it cannot rule out an unfinished first save there. `owner.json` inside the lock names the process that created it. After `lockNotReleased` that is the Glue server itself, still running but no longer holding the lock, so a live process ID there is not evidence of an active writer. Before removing the directory, confirm no other Glue process, including another host connected to the same project, is writing. The project namespace used by transfer takes its lock only once, to create `.glue/PROJECT.json`; a lock left over from that creation blocks nothing. The installer reports a leftover installation or host-connection lock on standard error.

Resume reports selected evidence as `unavailable` with `reason: "path_collision"` when two names at any level of its path differ only by case or Unicode form. The dependency check reports the same cause as `live_source_path_collision`, including for evidence of a dependency. Glue does not choose between the names.

External editors do not honor Glue locks. Rechecking before replacement protects detected edits but cannot promise atomic compare-and-swap against an uncooperative editor. Atomic replacement and file synchronization are not universal hardware/power-loss guarantees. Avoid simultaneous direct edits and checkpoints of one file.

Existing historical revision bytes must not be rewritten during portability or identity changes. Ambiguous case/Unicode/path mappings require explicit refusal or a separate conversion on a preserved copy. Source installation does not authorize migration of live saved work.

## Privacy and retention

History and snapshots are local plaintext. Host filesystem permissions protect them. Invoked tools return selected content to the host; Glue does not control its processing, transcripts or retention. There is no Glue account credential store, automatic network fetcher or telemetry client in the authored runtime.

Glue blocks common secret-bearing capture sources/content by default and permits only deliberately scoped exceptions. Retention and retrieval are separate: an acknowledged capture, or an evidence snapshot matching the heuristic, is never matched or excerpted by search and `glue_read` withholds its bytes unless `allowSensitive:true` is supplied; that flag records caller intent only. Transfer continues to refuse it. Detection is incomplete: passing it is not proof of safety, and an unflagged body may still be sensitive. A blocked capture must leave no sensitive marker in Glue-controlled persistent/temporary/recovery data or responses; it cannot undo a prior host retrieval. An exception is not authenticated permission and does not grant export authority.

Edits, deselection and withdrawn status do not delete history. Recovery also retains earlier pointer/text material. Follow [accidental-capture maintenance](../integration/glue/references/maintenance.md#accidental-capture-and-clean-store-rebuild) for a selected clean rebuild. Stop on interruption or failed verification; do not automatically select a partial replacement or reactivate a contaminated original. Destructive retirement remains a separate deliberate action.

A full backup is private history, not sanitized sharing. A selected export requires content review and does not erase other copies. Neither operation promises secure physical erasure or remote revocation.

Installed host-binding descriptors and check output can contain machine paths. Review them before sharing.


## Search detail and coverage

Find defaults to compact metadata for an empty query and concise matching evidence
for a nonempty lexical query. `detail:"full"` is available for both; it returns
longer excerpts, up to four selected source matches, and full record metadata.
`detail:"compact"` explicitly omits excerpts. Concise mode returns one matching
source/capture locator or a matching record/Markdown excerpt. `moreSourceMatches`
counts matching sources not shown. Excerpt and scope truncation flags mean that
qualifiers may be outside the preview; read exact selected bytes before reuse.

Short responses retain gaps, skipped-body counts, filters and continuation. Their
coverage object identifies saved-only lexical search, unchecked freshness, and
the 64-revision, 64-gap, 1 MiB evidence and 256 KiB individual-body bounds. Follow
the cursor with the same query, history and filters. Neither a preview nor an
exhausted cursor establishes semantic completeness. Sensitive bodies remain
excluded from matching/excerpts; their names can still match. Character offsets
in excerpts use JavaScript UTF-16 indexing; read byte offsets are separate.

An imported record can pass local checks while its origin has changed. Resume
therefore reports `upstreamStatus:"not-checked"` for imports. Use transfer check
with a freshly observed origin, or report origin freshness as unresolved. No
upstream access, synchronization, adoption or authorization is implied.
