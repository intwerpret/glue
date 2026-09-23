# Troubleshooting

For errors returned by a specific tool, see the error tables in the [tools reference](tools.md).

## Installing

**"Glue needs Node.js 22 or later."** Install a current Node.js and run the installer again.

**"Glue's dependencies are not installed yet."** Run `npm ci` in the Glue source folder.

**"Run this from inside the project that should get Glue."** The installer runs against the current folder. Change to your project folder first, then run `node path/to/glue/install.mjs`.

**"Git already tracks files used by Glue."** Your project's Git already tracks `.glue/`, the install folder, or the host configuration file. The installer will not untrack them for you. Decide whether to keep them tracked, then run the installer again.

**"Glue could not verify project Git exclusions."** Check that `git` works in the project and that `.gitignore` is writable.

**"Installation destination is occupied" or "Existing Glue connection".** Glue is already installed in this project. To reinstall, [uninstall](quickstart.md#update-and-uninstall) first.

**"Source changed. Build before packaging." or "Run npm run build."** Run `npm run build` in the Glue source folder, then try again.

**"Another installation operation is active".** Another installer is running, or one was interrupted. Once none is running, delete `.glue-install-lock` from the project.

## Glue does not appear in the host

- Start a new session after installing. Restart the app if that is not enough.
- **Codex:** make sure you trusted the project.
- **Claude Code:** run `/mcp`. Approve the `glue` server if it is waiting.
- **Claude Desktop:** make sure the Glue connector is enabled for this conversation.
- Run the installed check. See [host setup](../integration/glue/references/hosts.md#check-a-connection).
- If the check says the connection "does not match this local installation", you may be running a different Node.js than the one that installed Glue. Reinstall with the Node.js the host will use.

**"Glue plugin could not start or serve."** Check that `node --version` is 22 or later, that the plugin folder is complete, and that the plugin folder is not inside your project.

**"Glue could not start or serve (project-folder, …)" in Desktop.** Choose a project folder that exists and is not inside the extension.

## Saving and resuming

**The assistant says Glue found nothing.** Search matches words, not meaning. Try other words from the handoff's title or text. Ask for an empty search to list everything. Ask it to include history. Check whether the result reported gaps or skipped content.

**"Version conflict."** Someone saved in between, possibly another conversation. Ask the assistant to resume, reconcile, and save again.

**"Working copy changed."** The handoff file was edited outside Glue, or existed before the first save. Ask the assistant to resume, read the file, and save with its current hash. Your edit is kept.

**"Evidence changed."** An evidence file changed since the last save. Glue will not save until the assistant has read the new version and confirmed it with `reviewedEvidence`.

**"Glue store is busy."** Retry. If it keeps happening, see [leftover locks](recovery.md#leftover-locks).

**`workingCopyUpdated: false`.** The revision was saved, but the handoff file was not updated, usually because it changed at the same moment. Resume and reconcile.

**Resume says `incomplete`.** Some checks could not run, for example because a file was too large or unreadable. The `issues` list says which. Treat those parts as unchecked.

**"Context must be an ordinary Markdown note…"** Handoffs must be `.md` files outside folders whose names start with `.`, and not host instruction files such as `AGENTS.md` or `CLAUDE.md`. Choose another path.

**"Portable path collision."** Two files or folders in the path differ only by upper and lower case, or by Unicode form. Rename one.

**"Saved Glue data is damaged" or "Saved HEAD is missing".** See [Recovery](recovery.md).

## Transfers

**"Portable metadata may contain a private locator or credential."** The text being transferred contains a file path, an email address, a URL with a query string, or something like a credential. Remove it, or ask the assistant to prepare a cleaned-up version.

**"Source scope restricts transfer."** The record's scope says "project only" or "do not share". Change it only if you mean to share.

**"Transfer payload changed or was not reviewed."** The source changed after preview. Preview again.
