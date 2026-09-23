# Context identity

This page explains how Glue maps a handoff path to its folder in the store. It is for contributors. The code is in `src/identity.ts` and `Handoffs.location` in `src/handoff.ts`.

## Goal

A project can move between Windows, macOS and Linux. Those systems compare file names differently: some ignore case, and some treat composed and decomposed Unicode as the same name. Glue must find the same history for the same handoff on every system. It must never merge two different handoffs, or split one handoff into two histories.

## The comparison key

`pathKey` normalizes a project-relative path to Unicode NFC and lowercase. Two paths with the same key are the same context everywhere.

The handoff file on disk keeps whatever spelling it has. Only comparisons use the key.

## Path checks

`lexicalPath` rejects, before touching the filesystem:

- absolute paths, `..`, control characters and `: < > " | ? *`;
- paths that leave the project;
- any component named `.git`, `.codex`, `.agents`, `.claude` or `.glue`, in any case;
- components ending in a dot or space, and Windows device names such as `con` or `lpt1`.

`assertContextPath` adds rules for contexts only. A context cannot sit in a folder whose name starts with `.`. It cannot be a host instruction file: `agents`, `claude`, `codex`, `gemini`, `skill` or `copilot-instructions`, with an optional suffix such as `.local`, and the `.md` extension.

`portableFile` then walks the path one component at a time. At each level it lists the folder and compares entries by key:

- More than one match throws `PathCollision`. Glue does not pick one.
- A name that opens but is not listed is a filesystem alias, such as a Windows 8.3 short name. It is refused.
- Symbolic links and junctions anywhere on the path are refused (`assertUnlinked` in `src/storage.ts`).

## Folder names

Each context's folder under `.glue/contexts/` is the SHA-256 of its identity string. Each revision also stores that identity in its `context` field.

For a new context, the identity is the key: lowercase NFC.

A history whose stored identity is mixed-case keeps that identity. New revisions in that history reuse it. No revision or dependency hash is rewritten.

## Lookup

`contextIdentity` finds the folder for a requested path:

1. It lists the folder names in `.glue/contexts/`. More than 10,000 is refused.
2. It hashes the key, the file's on-disk spelling and the requested spelling. Folders with those names are matched without being opened.
3. For any other folder, it reads `HEAD.json` and the head revision, takes the stored identity, and checks that it hashes to the folder name. Verified results are cached in memory for the life of the `Handoffs` instance. Folder names are listed again on every lookup, so a new competing folder is noticed.
4. It collects every identity whose key equals the requested key.

The outcome:

- **One match:** use that identity.
- **Two or more:** refuse with a collision error. Both histories are preserved for the user to resolve.
- **None, and every folder was readable:** create a new context under the key.
- **None, but some folder could not be read:** refuse to create. The unreadable folder might be this context's history, and creating a second one would fork it.

An empty folder is skipped. A failed first save can leave one behind, and it holds no data. Any entry at all, including a `.write-lock`, means the folder is not skipped.

## Consequences

- Renaming a handoff by case only (`Notes.md` to `notes.md`) keeps its history.
- Evidence paths are compared by key as well. Resume reports an evidence file as `unavailable` with `reason: "path_collision"` when its path has a case or Unicode twin.
- Checks and opens are separate system calls. Another process that swaps a path in between can defeat the check. Glue does not defend against untrusted local writers.
- Before relocating a store, back up the whole `.glue` folder. If the target filesystem already holds colliding names, resolve them first.
