# How Glue works

Glue is a small local server that your assistant's app starts. It is bound to one project folder. It reads and writes only inside that folder, and it makes no network requests of its own.

Your assistant does the thinking: it writes the handoff, decides what to save, and interprets what Glue reports. Glue stores what it is given, keeps every version, and checks saved files against the live ones.

## Terms

These words have one meaning throughout the Glue docs.

| Term | Meaning |
| --- | --- |
| Assistant | The AI model you are working with. |
| Host | The app that runs the assistant and starts Glue: Codex, Claude Code or Claude Desktop. |
| Handoff | A Markdown file in your project that describes a piece of work so it can be continued. |
| Context | The handoff's path, such as `notes/handoff.md`. Glue keeps one history per context. |
| Checkpoint | Saving a handoff. Each checkpoint creates a revision. |
| Revision | One saved, unchangeable copy of a handoff and its evidence. A revision is identified by its version hash. The latest revision is the head. |
| Evidence | Project files you choose to save with a handoff. Glue keeps exact copies and reports later if the live file changed. |
| Capture | Material from outside the project, such as a web page or a PDF excerpt, that the assistant retrieved and passed to Glue. |
| Record | Optional labels on a handoff: title, kind, scope, provenance and status. A record makes a handoff findable and reusable as a decision, finding, note or artifact. |
| Dependency | A link from one handoff to a specific revision of another (`dependsOn`). |
| Store | The `.glue/` folder in your project, where Glue keeps all revisions and copies. |
| Transfer | Copying one reviewed handoff into another project as an independent copy with its origin recorded. |

## Save, resume, check

Work with Glue follows a simple cycle.

**1. Save.** The assistant calls `glue_checkpoint` with the handoff text and the evidence you chose. Glue copies each evidence file into the store and writes a new revision. Then it updates the Markdown file in your project.

**2. Resume.** Later, the assistant calls `glue_resume`. Glue returns the saved handoff and checks it:

- Each evidence file is compared with its saved copy.
- If you edited the handoff file directly, Glue notices.
- Each dependency is followed. Glue checks whether the linked handoff has a newer revision, and checks that handoff's evidence too.

The check result is returned in the `basis` field. Its `status` is `unchanged`, `review_needed` or `incomplete`. See [glue_resume](tools.md#glue_resume).

**3. Review and save again.** If a file changed, the assistant reads it and reconciles the handoff. It then saves again, confirming that it reviewed the changed file. Glue refuses to save over a changed evidence file until the assistant confirms that review.

### Checks run forward only

Resume checks the links that the resumed handoff declares, and the links those handoffs declare in turn. Nothing looks up which other handoffs depend on a file or handoff that changed. To find affected work, resume the handoffs that depend on it.

### Saves do not recheck old links

When you add a dependency, it must point at the linked handoff's current revision. After that, the link is kept as is. A later save that keeps the link succeeds even if the linked handoff has moved on. Resume is what reports it.

### Finding saved work

`glue_find` searches saved handoffs, record titles and scopes, and the text of saved evidence. It splits your query into words. A result matches if any word appears anywhere in the text, ignoring case. For example, `price` matches "Pricing". Results are not ranked. Search covers only what was saved, never your live project files. See [glue_find](tools.md#glue_find).

## Where data lives

Everything Glue saves is in your project folder.

```text
your-project/
├── notes/handoff.md          the handoff you and the assistant read and edit
└── .glue/                    the store
    ├── PROJECT.json          project ID, created on first transfer
    └── contexts/
        └── <context-id>/     one folder per context
            ├── HEAD.json     points at the latest revision
            ├── revisions/    one file per revision, named by its hash
            ├── evidence/     exact copies of evidence files and captures
            └── recovery-<hash>.json   written when you restore an earlier revision
```

The context folder name is a hash of the handoff's path. Paths are compared ignoring case and Unicode form, so `Notes/Handoff.md` and `notes/handoff.md` are the same context. Glue refuses to guess when two files differ only that way.

The store is plaintext. Every read checks saved bytes against their hash, so damaged files are reported, not silently used. A `.write-lock` folder appears briefly inside a context folder while Glue saves.

For how the code is organized, see [ARCHITECTURE.md](../ARCHITECTURE.md). For how context paths map to folders, see [context identity](internals/identity.md).

## What the handoff file is

The Markdown file in your project is a working copy. The saved revision in the store is the authority.

Glue updates the working copy only when it still matches the last save, or when the assistant has confirmed your edits. If you edit the file between saves, Glue refuses to overwrite it. The assistant resumes, reads your edit, and saves with the file's current hash. Your edited text is kept inside the new revision.

If Glue saves a revision but cannot update the file, the result says `workingCopyUpdated: false`. The revision is still saved. Resume and reconcile.
