# host-shell-mcp

An MCP server that lets an AI agent working in a sandbox or VM, like Claude in Cowork, run shell commands on your real computer. You decide which folders it can change.

- **Commands run on your Mac, with your tools and credentials:** `git push`, `gh`, `brew`, your `.zshrc` PATH. That's the reason to use it.
- **Commands can change files only in the folders you allow.** They can read everywhere else, and macOS enforces the rules on everything a command starts, whether it's a shell, Python or Node script.
- **Access is granted when it's needed.** When Claude needs a new folder, a dialog on your Mac asks you: **Deny / Allow this session / Always allow**.
- **Claude can't change its own permissions.** Commands can't touch the settings file, the log, or the dialog.
- **Everything is logged** to a file you can read.

## Install in Cowork

Cowork's **Add connector** box only takes URLs, and Anthropic's cloud (not your computer) connects to those URLs, so a local server can't go there. Install it as a plugin instead. Claude Desktop starts a plugin's local MCP servers on your computer.

```bash
npm install
npm run build
```

This writes `dist/host-shell-mcp-plugin-<version>.zip`. In Claude, open **Customize → Plugins**, choose the upload option, and select the zip. To check it's running on your Mac and not in the VM, ask Claude to run `uname -a` with it: `Darwin` means your Mac.

The plugin's launcher finds Node.js on its own (Homebrew, nvm, Volta, fnm, mise, asdf), because apps opened from the Dock don't see your shell's `PATH`. If it picks the wrong one, set `HOST_SHELL_MCP_NODE` to the path of the `node` you want.

Plugin MCP servers only run in local Cowork sessions, not cloud ones.

## Use with other MCP clients

Run `npm install`, then add it to the client's config:

```json
{ "mcpServers": { "host-shell": { "command": "node", "args": ["/absolute/path/to/host-shell-mcp/server.js"] } } }
```

## Settings

On first run, the server creates `~/.config/host-shell-mcp/config.toml`. It's commented, so you can read it and edit it by hand. Changes apply to the next command, with no restart needed.

```toml
mode = "sandboxed"          # or "unrestricted"
write = [                   # folders commands may create, edit, rename and delete in
  "~/Development",
]
write_caches = [            # temp and cache folders tools like npm, pip and git need
  "$TMPDIR", "/private/tmp", "~/Library/Caches", "~/.npm", "~/.cache",
]
deny_read = []              # folders commands may not read at all
shell = ""                  # empty = your login shell
default_cwd = "~"
timeout_seconds = 120
log_file = "~/Library/Logs/host-shell-mcp/commands.jsonl"
```

You don't need to set anything up first. The defaults let commands read everywhere and write only to temp and cache folders. The first time Claude needs to change files somewhere, it calls `request_write_access` with the folder and a reason, and this appears on your Mac:

> Claude wants to create, change and delete files in:
>
> &nbsp;&nbsp;&nbsp;&nbsp;~/Development/my-app
>
> Claude's reason: "Run npm install and commit the lockfile."
>
> **[Deny]  [Allow this session]  [Always allow]**

**Always allow** adds the folder to `write` and keeps your comments. Broad locations like `~` or `/` come with a warning. If nobody answers within two minutes, the request counts as denied.

A broken settings file stops all commands until you fix it. The server never falls back to looser rules.

## How the sandbox works

Commands run under macOS's Seatbelt sandbox (`sandbox-exec`), the same mechanism Chrome, Claude Code and Codex use. The rules:

| | sandboxed | unrestricted |
|---|---|---|
| Read files | everywhere except `deny_read` | everywhere except `deny_read` |
| Create, edit, rename, delete | `write` + `write_caches` | anywhere |
| Settings file and command log | never writable | never writable |
| Launch apps (`open`), AppleScript | blocked | allowed |

- **Nothing reads the command text.** macOS enforces the rules on every process a command starts, so tricks like `$(…)`, `sh -c` or writing a script and running it make no difference. Filters based on the command text are what most other shell MCP servers use, and nearly all of them have published ways around them.
- **Writing includes renaming and deleting.** macOS treats a rename as a delete, and git and most editors save by renaming, so "can write but not delete" would break them.
- **It's a guardrail, not a guarantee.** A command can still ask something outside the sandbox to act for it: `ssh` to your own Mac, Docker, or a launchd job. AppleScript and app launching are blocked because they're the easy routes to an unsandboxed Terminal.
- **It's macOS only.** On other systems, set `mode = "unrestricted"`. Commands then run without a sandbox.

## Tools

**`run_command(command, cwd?, timeout_seconds?, stdin?)`** returns the exit code, stdout and stderr, each capped at 200 KB. A non-zero exit sets `isError`. When the sandbox blocks something, the result says so and tells Claude about `request_write_access`.

**`request_write_access(paths, reason)`** shows the permission dialog on your Mac.

## Behavior

- **Commands run as you.** The tool description tells the agent to treat this as the real machine: nothing is undoable. It should use its own sandboxed shell for ordinary file work, and this tool for what needs the host (credentials, git remotes, installed tools, host-only files). `run_command` is marked destructive (`destructiveHint`), so clients ask before running it.
- **Command log.** Each command gets a `start` line (time, mode, cwd, command) and an `end` line (exit code, signal, timeout or cancel, duration), matched by `id` and `pid`. Access requests are logged with the answer given. The file is readable only by you, since commands can contain secrets. Watch it with `tail -f ~/Library/Logs/host-shell-mcp/commands.jsonl`.
- **Fresh shell per call.** `cd` and `export` don't carry over. It's an interactive login shell (`$SHELL -ilc`), so your `.zprofile` and `.zshrc` load and `PATH` matches your terminal. That adds about 0.4 s per command with nvm.
- **Bash-style globbing under zsh.** A glob that matches nothing is passed through as-is instead of aborting with "no matches found".
- **No TTY, and stdin is closed.** Commands that prompt (sudo, ssh passwords) get EOF and fail instead of hanging. Use the `stdin` argument to feed input.
- **Timeouts and cancellation kill the whole process tree:** SIGTERM, then SIGKILL 2 seconds later.
- **Background jobs don't block.** `cmd &` returns as soon as the shell exits, and the job keeps running. Redirect its output (`nohup cmd > /tmp/cmd.log 2>&1 &`).
- **Client disconnect.** When stdin closes, stdout breaks, or the server gets a signal, it stops running commands and exits.
- **stdout is protocol only.** All logging goes to stderr.

## Development

```bash
npm test                               # against server.js
npm run build && npm run test:plugin   # against the packaged plugin
```

The tests start the real server over stdio with throwaway settings. They cover the sandbox, including scripts in other languages and attempts to edit the settings. A test hook stands in for the dialog.
