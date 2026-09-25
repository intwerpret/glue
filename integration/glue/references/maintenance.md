# Recovery and maintenance

Use these procedures when saved history is damaged, a lock is left behind, or something was saved by accident. Everyday saving and resuming does not need them.

You need a terminal. The assistant can run these steps only if its host gives it shell access and you ask it to. Claude Desktop chat usually has no shell access, so run the steps yourself.

## Find the recovery tool

The recovery tool is `runtime/recovery.js` inside your Glue installation. Run it with Node.js:

```sh
node RECOVERY_TOOL PROJECT_FOLDER REQUEST_FILE
```

`REQUEST_FILE` is a small JSON file that says what to do. Use `-` to read the request from standard input instead.

Where the tool is, by host:

| Host | Recovery tool, relative to the project folder |
| --- | --- |
| Codex | `.agents/skills/glue/runtime/recovery.js` |
| Claude Code, one project | `.claude/skills/glue/runtime/recovery.js` |
| Claude Desktop, configuration-file setup | `.agents/skills/glue-desktop/runtime/recovery.js` |
| Claude Code plugin, Claude Desktop extension | `runtime/recovery.js` inside the plugin or extension folder |

For the plugin and extension, pass full absolute paths for all three arguments. Do not guess where Desktop keeps extensions; look it up in Desktop.

The tool prints JSON. On failure it prints `{"error": "…"}` to standard error and exits with code 1.

Keep the output private. It contains hashes, paths and saved labels.

## Inspect a context

Inspection only reads. It never changes anything.

1. Save this as `inspect-request.json`, outside the project or in a private folder. Use your handoff's path.

   ```json
   {"action": "inspect", "context": "notes/handoff.md"}
   ```

2. From the project folder, run:

   ```sh
   node .agents/skills/glue/runtime/recovery.js . inspect-request.json
   ```

3. Read the result:

   | Field | Meaning |
   | --- | --- |
   | `headHash` | Hash of the `HEAD.json` file, or `null` if it is missing. |
   | `workingCopyHash` | Hash of the handoff file, or `null` if it is missing. If the file cannot be read, `workingCopy.status` is `unavailable` instead. |
   | `revisions` | Every revision file, with `valid`, `at` (save time), `parent` and `reachableFromHead`. |
   | `ancestry.status` | `complete`, `incomplete` (a break in the chain), `unavailable` (head missing or unreadable) or `empty`. |
   | `ancestry.missingParents`, `reason`, `blockedAt` | Where the chain breaks. |

`reachableFromHead` is `true` for revisions in the current history, `false` for revisions outside it, and `null` when that cannot be known. A revision outside the history may be older work or an interrupted save. Do not delete it.

## Restore an earlier revision

Restore moves the head to a revision you choose and rewrites the handoff file to match. It does not change your evidence files.

1. Inspect the context, as above. Pick a revision where `valid` is `true`.
2. Save this as `restore-request.json`. Fill in the values from the inspection.

   ```json
   {
     "action": "restore",
     "context": "notes/handoff.md",
     "version": "REVISION_TO_RESTORE",
     "expectedHeadHash": "HEAD_HASH_FROM_INSPECTION",
     "workingCopyHash": "WORKING_COPY_HASH_FROM_INSPECTION"
   }
   ```

   Use JSON `null` only when the inspection returned `null`, meaning the file is missing.

3. Run:

   ```sh
   node .agents/skills/glue/runtime/recovery.js . restore-request.json
   ```

4. Check the result. `restored: true` means the head moved. If `workingCopyUpdated` is `false`, the handoff file changed during the restore and was left alone. Resume and reconcile it.

Restore first writes a `recovery-<hash>.json` file with the old head and the old handoff text. Nothing is lost.

If the restore fails with `Recovery inputs changed. Inspect again.`, something changed since you inspected. Start again from step 1.

**If the handoff file is unavailable.** The file may be over 128 KiB or not valid UTF-8. Restore cannot run until you deal with it. Copy the file somewhere safe, then remove or fix it, and inspect again.

**If saved bytes are damaged.** Restore from a backup of the whole `.glue` folder. Never edit hashes by hand to hide damage.

## Leftover locks

Glue creates a `.write-lock` folder inside a context's folder while it saves, and removes it afterwards. If Glue was interrupted, or cannot delete files, the lock stays behind. Later saves to that context then fail with `Glue store is busy`.

1. Make sure no Glue process is writing to this project. Check every host connected to it.
2. Look at `.write-lock/owner.json`. It names the process that created the lock.
3. If that process is gone, delete the `.write-lock` folder.

If a result or error included `lockNotReleased`, the process named in `owner.json` is the Glue server that is still running. It no longer holds the lock. You only need to confirm that no other Glue process is writing.

Other lock folders:

- `.glue/.write-lock` is left over from creating `.glue/PROJECT.json`. It blocks nothing. Delete it.
- `.glue-install-lock` in the project blocks installs. Delete it once no installer is running.
- `.glue-host-connection-lock` beside a host configuration file blocks connection changes. Delete it once no installer is running.

## Remove something saved by accident

Editing or deselecting content does not remove it from history. Earlier revisions, evidence copies, captures, recovery files and saved copies of your edits may all still hold it. To remove it, build a clean store in a new project and move only what you want to keep.

If the content includes a credential, revoke the credential first.

1. **Stop.** Close the Glue connections to the affected project. Don't share the project or its store.
2. **Keep the original.** Leave the affected project and its `.glue` folder where they are. Don't rename or move them into another project.
3. **Create a fresh, empty project folder.** Don't use it for anything else until you finish.
4. **Choose what to keep.** List the handoffs and captures you want to carry over. Leave out anything contaminated. If a handoff's text itself contains the content, prepare a cleaned-up version to send as `derivativeMarkdown`.
5. **Transfer each one.** Connect Glue to both projects. For each handoff, preview, read the exact content, export, then import into the fresh project. Transfer never copies history, recovery files or unselected evidence. It refuses sensitive captures and evidence.
6. **Verify the fresh project.** Resume and read every imported handoff. Search the whole fresh folder for the removed content, including `.glue`. If anything fails or is interrupted, stop. Don't switch to a partial result.
7. **Switch over.** Point your host at the fresh project.
8. **Retire the original.** Deleting the original project's store is a separate, deliberate step. Do it only when you are sure.

This procedure does not reach backups, exported bundles, other projects that imported a copy, or host transcripts. Deal with those separately.

## Backups

To back up saved work, copy the handoff files and the whole `.glue` folder together. Treat the backup as private: it holds every revision.

To share one handoff, use a transfer instead of a backup. A transfer sends only what you select.
