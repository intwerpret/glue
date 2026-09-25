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

A context's identity is its key: the project-relative path in lowercase NFC. Its folder under `.glue/contexts/` is the SHA-256 of that identity, and each revision stores the identity in its `context` field. `Handoffs.location` computes the folder directly, so every spelling of a path reaches the same folder without searching the others.

A damaged folder, or one holding a leftover `.write-lock`, affects only its own context. Other contexts can still be read and created.

## Consequences

- Renaming a handoff by case only (`Notes.md` to `notes.md`) keeps its history.
- Evidence paths are compared by key as well. Resume reports an evidence file as `unavailable` with `reason: "path_collision"` when its path has a case or Unicode twin.
- Checks and opens are separate system calls. Another process that swaps a path in between can defeat the check. Glue does not defend against untrusted local writers.
- Before relocating a store, back up the whole `.glue` folder. If the target filesystem already holds colliding names, resolve them first.
