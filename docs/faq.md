# FAQ

## Is Glue a memory for my assistant?

Not in the usual sense. Glue does not watch conversations or learn from them. It keeps what you ask it to save: handoffs, the files behind them, and every earlier version. You decide what goes in, and you can read all of it as ordinary Markdown.

## Does Glue send my data anywhere?

Glue itself makes no network requests. It reads and writes only inside the project folder it is connected to.

Your host is different. When the assistant uses a Glue tool, the result goes to the host app, which may send it to a remote model. See [Privacy](privacy.md#who-can-see-it).

## Should I commit .glue?

Usually not. The `.glue` folder holds every revision and every evidence copy, in plaintext. Committing it publishes all of that history, including anything later removed from the current handoff.

The project installer adds `.glue/` to `.gitignore`. With the Claude Code plugin or the Desktop extension, add it yourself.

The handoff Markdown files are ordinary project files. Commit them if you like.

To share one handoff with another project, use a [transfer](ways-to-use-glue.md#3-carry-a-lesson-into-another-project). It sends only what you select.

## How is Glue different from Git?

They do different jobs and work well together.

- Git versions your whole project when you commit. Glue versions one handoff each time the assistant saves it.
- Glue links a handoff to the exact files it relied on, and tells you when those files change. Git doesn't know which files a note relied on.
- Glue is built for your assistant to use through tools, in the middle of a conversation.
- Glue works the same in projects that don't use Git.

## Which assistants does Glue work with?

Codex, Claude Code and Claude Desktop. Glue is a standard MCP server, so other MCP hosts may work, but the installer and packages target those three.

## Can two projects share one Glue store?

No. Each connection is bound to one project folder and its own `.glue` store. To move work between projects, use a transfer.

## Can I edit a handoff by hand?

Yes. Glue notices the edit on the next resume. Before it saves over the file, the assistant reads your change and confirms it. Your edited text is kept in the next revision.

## What happens when I remove Glue?

Your handoffs and `.glue` folder stay. Reinstall later and your history is still there. See [Update and uninstall](quickstart.md#update-and-uninstall).

## Where are the limits?

All of them are in [Limits](limits.md).
