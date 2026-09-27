# host-shell-mcp

An MCP server that lets an AI agent working in a sandbox or VM, like Claude in Cowork, run shell commands on your real computer. You decide which folders it can change.

- **Commands run on your Mac, with your tools and credentials:** `git push`, `gh`, `brew`, your `.zshrc` PATH. That's the reason to use it.
- **Commands can change files only in the folders you allow.** They can read everywhere else, and macOS enforces the rules on everything a command starts, whether it's a shell, Python or Node script.
- **Access is granted when it's needed.** When Claude needs a new folder, a dialog on your Mac asks you: **Deny / Allow this session / Always allow**.
- **Claude can't change its own permissions.** Commands can't touch the settings file, the log, or the dialog.
- **Everything is logged** to a file you can read.

## Install in Cowork

Cowork's **Add connector** box only takes URLs, and Anthropic's cloud (not your computer) connects to those URLs, so a local server can't go there. Install it as a plugin instead. Claude Desktop starts a plugin's local MCP servers on your computer.

1. In Claude, open **Customize → Plugins → Add → Add marketplace** and enter `funkyfunc/host-shell-mcp`.
2. Install **host-shell-mcp** from it.
3. Turn on **Sync automatically** for the marketplace, so new releases arrive without you doing anything.

To check it's running on your Mac and not in the VM, ask Claude to run `uname -a` with it: `Darwin` means your Mac.

To install from a file instead, run `npm install && npm run cowork-plugin` and upload `dist/host-shell-mcp-cowork-plugin.zip` under **Customize → Plugins → Add → Upload plugin**.

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
timeout_seconds = 600       # commands running longer are stopped
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

| Tool | What it does |
|---|---|
| `run_command(command, cwd?, timeout_seconds?, wait_seconds?, stdin?)` | Runs a command. Returns the exit code, stdout and stderr, or a `job_id` if the command is still running after `wait_seconds` (default 30). A non-zero exit sets `isError`. |
| `read_output(job_id, wait_seconds?)` | Waits for a running command (up to `wait_seconds`, default 30) and returns the output it produced since the last look. Marked read-only. |
| `stop_command(job_id)` | Stops a running command and everything it started. |
| `request_write_access(paths, reason)` | Shows the permission dialog on your Mac. |

When the sandbox blocks something, the result says so and tells Claude about `request_write_access`.

## Behavior

- **Commands run as you.** The tool description tells the agent to treat this as the real machine: nothing is undoable. It should use its own sandboxed shell for ordinary file work, and this tool for what needs the host (credentials, git remotes, installed tools, host-only files). `run_command` is marked destructive (`destructiveHint`), so clients ask before running it.
- **Command log.** Each command gets a `start` line (time, mode, cwd, command) and an `end` line (exit code, signal, timeout or cancel, duration), matched by `id` and `pid`. Access requests are logged with the answer given. The file is readable only by you, since commands can contain secrets. Watch it with `tail -f ~/Library/Logs/host-shell-mcp/commands.jsonl`.
- **Fresh shell per call.** `cd` and `export` don't carry over. It's an interactive login shell (`$SHELL -ilc`), so your `.zprofile` and `.zshrc` load and `PATH` matches your terminal. That adds about 0.4 s per command with nvm.
- **Bash-style globbing under zsh.** A glob that matches nothing is passed through as-is instead of aborting with "no matches found".
- **No TTY, and stdin is closed.** Commands that prompt (sudo, ssh passwords) get EOF and fail instead of hanging. Use the `stdin` argument to feed input.
- **Long commands don't block.** `run_command` waits 30 seconds by default, under the roughly 60-second limit many MCP clients put on one call. A command still running after that becomes a job: Claude gets the output so far and a `job_id`, and follows up with `read_output` or `stop_command`. The command keeps running until it finishes or reaches `timeout_seconds`. While a call waits, the server sends progress notifications, so clients that support them can keep it alive.
- **Timeouts, `stop_command` and cancellation kill the whole process tree:** SIGTERM, then SIGKILL 2 seconds later. Cancelling a call that's waiting on a command (for example, pressing stop in the app) stops that command too.
- **Long output keeps its start and end.** Each stream shows its first 20 KB and last 20 KB, where errors usually are. Anything in between is saved to a file next to the log (`~/Library/Logs/host-shell-mcp/output/`), and the result gives its path. Output files are deleted after a day.
- **git and gh never prompt or page.** Commands get `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`, `GIT_PAGER=cat`, `PAGER=cat` and `GH_PROMPT_DISABLED=1`, so a missing credential fails right away instead of hanging.
- **VM paths are translated when it's safe.** Cowork shows your shared folders inside its VM as `/sessions/<id>/mnt/<folder>`, and Claude sometimes passes those as `cwd`. The server translates such a path when exactly one host folder with that name exists, looking in your allowed folders and the usual places like `~/Development` and `~/Desktop`, and says so in the result. If there's no match or more than one, Claude gets an error asking for the host path instead of a guess.
- **Background jobs don't block.** `cmd &` returns as soon as the shell exits, and the job keeps running. Redirect its output (`nohup cmd > /tmp/cmd.log 2>&1 &`).
- **Client disconnect.** When stdin closes, stdout breaks, or the server gets a signal, it stops running commands and exits.
- **stdout is protocol only.** All logging goes to stderr.

## Development

```bash
npm test                               # against server.js
npm run cowork-plugin && npm run test:plugin   # against the packaged plugin
```

The tests start the real server over stdio with throwaway settings. They cover the sandbox, including scripts in other languages and attempts to edit the settings. A test hook stands in for the dialog.

## Releasing

This repo is also the Cowork marketplace: `.claude-plugin/marketplace.json` points at `plugin/`, and Cowork installs straight from `main`. Cowork only picks up a new release when the plugin's version changes, so every release needs a version bump:

```bash
npm version patch --no-git-tag-version   # or minor / major
npm run cowork-plugin                    # rebuilds plugin/ (bundle + version) and the zip
npm test && npm run test:plugin
git commit -am "Release x.y.z" && git push
```

CI runs the tests on macOS and fails if the committed `plugin/` doesn't match what the source builds, so a stale bundle never reaches the marketplace.
