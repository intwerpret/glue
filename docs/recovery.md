# Recovery

The full recovery procedures ship with every Glue installation, so they are available without this repository. The canonical copy is [references/maintenance.md](../integration/glue/references/maintenance.md).

Use it when:

| Situation | Section |
| --- | --- |
| Glue says `Saved Glue data is damaged`, `Saved HEAD is missing` or `Revision integrity failure`. | [Inspect a context](../integration/glue/references/maintenance.md#inspect-a-context) |
| You want to roll a handoff back to an earlier revision. | [Restore an earlier revision](../integration/glue/references/maintenance.md#restore-an-earlier-revision) |
| Saves keep failing with `Glue store is busy`, or a result included `lockNotReleased`. | [Leftover locks](#leftover-locks) |
| You saved a secret or private file by accident. | [Remove something saved by accident](#remove-something-saved-by-accident) |

## Leftover locks

A `.write-lock` folder left inside a context blocks later saves. Confirm that no Glue process is writing to the project, then delete the folder. See [Leftover locks](../integration/glue/references/maintenance.md#leftover-locks) for the details, including other lock folders.

## Remove something saved by accident

Earlier revisions keep their copies, so editing or deselecting does not remove anything. Revoke any exposed credential first. Then build a clean store in a fresh project by transferring only what you want to keep. Follow [the step-by-step procedure](../integration/glue/references/maintenance.md#remove-something-saved-by-accident).
