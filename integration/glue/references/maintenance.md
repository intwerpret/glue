# Recovery and maintenance

Normal continuation uses Glue's host tools. These instructions are for deliberate maintenance using a terminal. A host without terminal access needs an authorized local operator for this procedure; do not assume the assistant can run shell commands.

## Inspect and recover damaged history

For a default Codex installation, save this valid JSON as `inspect-request.json` in a private working directory:

```json
{"action":"inspect","context":"notes/handoff.md"}
```

From the project directory, run:

```sh
node .agents/skills/glue/runtime/recovery.js . inspect-request.json
```

Use the installed runtime path for your host from [host setup](hosts.md). The request-file path can be absolute if it is outside the current directory. Inspection is read-only. Preserve its output privately: hashes, paths and saved metadata may reveal project details.

For a Claude Code plugin or Desktop extension, `runtime/recovery.js` is inside
the package, while the project is a separate folder. An authorized local operator
can use `node "PACKAGE_DIRECTORY/runtime/recovery.js" "PROJECT_DIRECTORY" "REQUEST_FILE"`,
replacing all three placeholders with actual absolute paths. Use that same form
for either inspection or restoration. Desktop chat need not have terminal access;
do not guess its managed package location or switch to another runtime silently.

`valid` describes revision/snapshot integrity. `ancestry.status` separately reports `complete`, `incomplete`, `unavailable` or `empty`; `missingParents`, `reason` and `blockedAt` explain gaps. `reachableFromHead` is true for known reachable revisions, false only when exclusion is established, and null when it cannot be determined. An intact detached revision may be prior history or an interrupted save, not disposable data.

Read and deliberately select the intended revision before restoring. Save this JSON as `restore-request.json`, replacing each placeholder with the corresponding inspection value. Use JSON `null` for a genuinely missing head or working copy, never for an unavailable one:

```json
{
  "action": "restore",
  "context": "notes/handoff.md",
  "version": "SELECTED_REVISION_HASH",
  "expectedHeadHash": "HEAD_HASH_FROM_INSPECTION",
  "workingCopyHash": "WORKING_COPY_HASH_FROM_INSPECTION"
}
```

Then run:

```sh
node .agents/skills/glue/runtime/recovery.js . restore-request.json
```

Restore preserves the previous head bytes and validated working text in a recovery record. It checks saved snapshots and moves the handoff pointer; it does not restore original source files. If a concurrent edit is detected, `workingCopyUpdated:false` means the saved pointer changed but the live text was preserved. Resume and reconcile before continuing.

An unavailable working copy is not a missing file. Invalid UTF-8, a file above the 128 KiB working-copy read limit, or another read failure requires preserving and reconciling those bytes before saving/restoring. Do not replace an omitted hash with null. Do not rewrite stored hashes to conceal corruption. Use an intact backup for damaged saved bytes. Remove a stale lock only after confirming that its writer stopped. One exception: after a result or error that carries `lockNotReleased`, `owner.json` in that lock names the Glue server that is still running and no longer holds it. That live process is not an active writer; confirm only that no other Glue process is writing to the project.

## Accidental capture and clean-store rebuild

Deleting current text or deselecting evidence does not remove historical copies. A secret may remain in prior revisions, evidence/capture snapshots, reconciled manual text or recovery records. Credential revocation is separate from cleaning retained copies.

1. Stop affected Glue connections and further sharing. Record the affected store and other known copies privately. Do not rely on a current-head scan to establish absence from history.
2. Prepare a separate empty destination project. Keep it disconnected from ordinary work until verification succeeds. Preserve the original store privately; do not rename it into another discoverable project or silently switch the existing connection.
3. Review a manifest of permitted current records and supporting captures. Use `glue_transfer` to export only that explicit selection. Inspect both metadata and payload bytes. Do not copy `.glue`, whole history, recovery files or old manual text. If current selected content itself is contaminated, prepare a reviewed clean derivative with a new identity; do not relabel changed bytes as the original.
4. Import into the separate destination, preserving scope and reporting excluded dependencies/support. Verify the complete destination inventory, exact selected content, history and any generated temporary/recovery material. Use synthetic marker fixtures to rehearse these checks before applying the procedure to real data; pattern scanning alone cannot certify removal of all personal information.
5. Resume/read the rebuilt records and check that useful selected work survived. Record what was inspected, what was omitted and where other copies remain. If import or verification fails or is interrupted, stop; do not select the partial destination or automatically reactivate the contaminated original.
6. Only after successful verification, deliberately select the rebuilt project through the host's normal project/connection workflow. Retiring or deleting the contaminated original and associated artifacts is a separate destructive action requiring explicit authorization.

Glue's automated tests rehearse this rebuild with synthetic data only. They do not certify removal of arbitrary personal information or interruption safety on every filesystem; rehearse the relevant failure and verification steps for the actual environment before any destructive retirement.

This procedure does not erase backups, exported files, imported project copies, host transcripts or source systems. Account for those separately. It does not promise secure physical erasure or remote revocation. A retained private original remains contaminated until separately retired; preservation is not completion of cleanup.

## Backups and selected exports

A full backup must include handoffs and their complete `.glue` store. Treat it as private. A selected transfer omits history and private locators by default but still requires payload review; private information can occur in ordinary prose. Restrictions and provenance are attributed claims, not technical controls over a recipient's independent copy.

Filesystem permissions protect local plaintext. Hashes detect byte changes, not authorship or truth. External editors do not honor Glue locks; avoid simultaneous native editing and checkpointing of one file. Atomic replacement is not a universal hardware/power-loss guarantee.
