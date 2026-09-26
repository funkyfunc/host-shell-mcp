#!/usr/bin/env node
// host-shell-mcp: a stdio MCP server that runs shell commands on the machine it
// runs on, confined (on macOS) to the folders the user allows.
//
// stdout carries the MCP protocol and nothing else; all logging goes to stderr.
// Settings live in ~/.config/host-shell-mcp/config.toml (see config.js).

import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, statSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, dirname, isAbsolute } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { abbreviate, CONFIG_PATH, ensureConfig, expandPath, loadConfig, SANDBOX_SUPPORTED, saveWriteList } from "./config.js";
import { askUser, DIALOG_TIMEOUT_S } from "./dialog.js";
import { isWithin, realPathLoose, sandboxArgs, writableRoots } from "./sandbox.js";

const MAX_OUTPUT_BYTES = 200_000; // per stream
const MAX_TIMEOUT_S = 3600;
const KILL_GRACE_MS = 2000; // SIGTERM -> SIGKILL
const DRAIN_MS = 250; // how long to wait for output after the shell exits

// Anything written to stdout that isn't a protocol message corrupts the connection.
console.log = console.info = console.debug = console.error;
const log = (...args) => console.error(`[host-shell-mcp ${new Date().toISOString()}]`, ...args);

// Apps launched from the Dock may not have $SHELL set, so fall back to the login shell from the user database.
const shellFor = (config) => config.shell || process.env.SHELL || userInfo().shell || "/bin/sh";

// zsh aborts a command when a glob matches nothing ("no matches found"). Callers
// expect bash behaviour (the pattern is passed through as-is), so turn that off.
// It goes after the rc files have run, on the same line so error line numbers don't shift.
const scriptPrefix = (shell) => (basename(shell) === "zsh" ? "setopt no_nomatch; " : "");

// Folders granted with "Allow this session" (real paths). Gone when the server exits.
const sessionWrites = [];

// Append-only record of every command run, so the user can audit what an agent did.
// One JSON object per line: a "start" entry, then an "end" entry with the same id.
let nextId = 1;
let brokenLog = null;
function audit(config, entry) {
  const file = expandPath(config?.log_file ?? "~/Library/Logs/host-shell-mcp/commands.jsonl");
  if (brokenLog === file) return;
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, ...entry }) + "\n", { mode: 0o600 });
  } catch (e) {
    brokenLog = file; // don't fail commands over it; say so once
    log(`cannot write command log ${file}: ${e.message}`);
  }
}

// Running shells, so they can be stopped if the client goes away.
const active = new Set();

// Each command runs in its own process group (detached), so signalling -pid
// reaches the shell and everything it started.
function signalGroup(child, sig) {
  try { process.kill(-child.pid, sig); } catch {} // ESRCH: already gone
}

function stopGroup(child) {
  signalGroup(child, "SIGTERM");
  setTimeout(() => signalGroup(child, "SIGKILL"), KILL_GRACE_MS).unref();
}

function capture(stream) {
  const chunks = [];
  let bytes = 0;
  let truncated = false;
  stream.on("data", (chunk) => {
    const room = MAX_OUTPUT_BYTES - bytes;
    if (chunk.length > room) { truncated = true; chunk = chunk.subarray(0, room); }
    if (chunk.length) { chunks.push(chunk); bytes += chunk.length; }
  });
  stream.on("error", () => {});
  return () => {
    const text = Buffer.concat(chunks).toString("utf8");
    return truncated ? `${text}\n[output truncated at ${MAX_OUTPUT_BYTES} bytes]` : text;
  };
}

function runCommand({ command, cwd, timeout_seconds, stdin = "" }, config, abortSignal) {
  return new Promise((resolve) => {
    try {
      if (!statSync(cwd).isDirectory()) return resolve({ error: `cwd is not a directory: ${cwd}` });
    } catch {
      return resolve({ error: `cwd does not exist: ${cwd}` });
    }

    const shell = shellFor(config);
    // -il: interactive login shell, so the environment matches a normal terminal
    // (PATH from .zprofile *and* .zshrc, where nvm and friends usually live) even
    // when the MCP client launched us with a minimal environment.
    const argv = [shell, "-ilc", scriptPrefix(shell) + command];
    // sandbox-exec execs the shell in place, so the pid and process group are the shell's.
    if (SANDBOX_SUPPORTED) argv.unshift(...sandboxArgs(config, sessionWrites));

    const started = Date.now();
    // detached: own process group and session, so no controlling TTY (a password
    // prompt fails fast instead of hanging) and the whole tree can be killed at once.
    const child = spawn(argv[0], argv.slice(1), { cwd, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    active.add(child);

    const stdout = capture(child.stdout);
    const stderr = capture(child.stderr);
    let stopReason = null;
    let drainTimer;
    let done = false;

    const stop = (reason) => {
      if (stopReason || done) return;
      stopReason = reason;
      stopGroup(child);
    };
    const timer = setTimeout(() => stop("timeout"), timeout_seconds * 1000);
    const onAbort = () => stop("cancelled");
    abortSignal?.addEventListener("abort", onAbort, { once: true });
    if (abortSignal?.aborted) onAbort();

    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(drainTimer);
      abortSignal?.removeEventListener("abort", onAbort);
      active.delete(child);
      resolve({ ...result, duration_ms: Date.now() - started, stop_reason: stopReason, stdout: stdout(), stderr: stderr() });
    };

    // Failed to start (e.g. the shell doesn't exist).
    child.on("error", (e) => finish({ error: `failed to start ${argv[0]}: ${e.message}` }));

    // 'close' fires once the shell has exited and its output pipes are closed.
    child.on("close", (code, signal) => finish({ exit_code: code, signal }));

    // A backgrounded process (`cmd &`) inherits the pipes and would keep 'close'
    // from ever firing. Once the shell itself exits, give output a moment to drain,
    // then stop reading and return; the background process keeps running.
    child.on("exit", (code, signal) => {
      active.delete(child);
      drainTimer = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish({ exit_code: code, signal, detached_output: true });
      }, DRAIN_MS);
    });

    child.stdin.on("error", () => {}); // EPIPE if the command exits without reading stdin
    child.stdin.end(stdin);
  });
}

const listPaths = (paths) => (paths.length ? paths.map(abbreviate).join(", ") : "(none yet)");

// When a sandboxed command fails with a permission error, tell the agent why
// and how to ask for access, instead of leaving it to guess.
function sandboxHint(r, config) {
  if (config.mode !== "sandboxed" || r.exit_code === 0) return null;
  if (!/operation not permitted|EPERM|PermissionError|Unable to find application|privilege violation/i.test(r.stdout + r.stderr)) return null;
  const granted = [...config.write.map(expandPath), ...sessionWrites];
  return [
    `[host-shell-mcp] This was probably blocked by the sandbox. Commands can write only in: ${listPaths(granted)}, plus temp and cache folders.`,
    config.deny_read.length ? `Reading is blocked in: ${listPaths(config.deny_read.map(expandPath))}.` : null,
    `Launching apps (open) and AppleScript are disabled.`,
    `To write somewhere else, call request_write_access with the folder and your reason; the user is asked on their Mac.`,
  ].filter(Boolean).join(" ");
}

function formatResult(r, timeoutSeconds, config) {
  if (r.error && r.exit_code === undefined) return { text: `Error: ${r.error}`, isError: true };
  let status;
  if (r.stop_reason === "timeout") status = `Timed out after ${timeoutSeconds}s; process group killed`;
  else if (r.stop_reason === "cancelled") status = "Cancelled; process group killed";
  else if (r.signal) status = `Killed by signal ${r.signal}`;
  else status = `Exit code: ${r.exit_code}`;
  const parts = [`${status} (${r.duration_ms} ms)`];
  if (r.stdout) parts.push(`--- stdout ---\n${r.stdout}`);
  if (r.stderr) parts.push(`--- stderr ---\n${r.stderr}`);
  if (r.detached_output) parts.push("[note: a background process still holds the output pipes; its later output is not captured]");
  const hint = sandboxHint(r, config);
  if (hint) parts.push(hint);
  return { text: parts.join("\n"), isError: r.exit_code !== 0 };
}

// Loads settings for a tool call, or explains why it can't run.
function currentConfig() {
  const { config, error } = loadConfig();
  if (error) return { error: `The host-shell-mcp settings file has an error, so commands are paused: ${error}. The user needs to fix ${abbreviate(CONFIG_PATH)}.` };
  if (config.mode === "sandboxed" && !SANDBOX_SUPPORTED) {
    return { error: `Sandboxing needs macOS. To run commands without it, the user can set mode = "unrestricted" in ${abbreviate(CONFIG_PATH)}.` };
  }
  return { config };
}

const errorResult = (text) => ({ content: [{ type: "text", text }], isError: true });

if (ensureConfig()) log(`created default settings at ${CONFIG_PATH}`);
const startup = loadConfig().config;

function describeAccess(config) {
  if (!config) return `Access rules are in ${abbreviate(CONFIG_PATH)} (currently unreadable).`;
  if (config.mode === "unrestricted") {
    return `Access: unrestricted. Commands run as the user with their full permissions, files, installed tools and credentials.`;
  }
  return `Access: commands can read everywhere but write only in: ${listPaths(config.write.map(expandPath))} ` +
    `(plus temp and cache folders)${config.deny_read.length ? `; reading is blocked in ${listPaths(config.deny_read.map(expandPath))}` : ""}. ` +
    `The OS enforces this on everything a command starts. Launching apps (open) and AppleScript are disabled. ` +
    `To write elsewhere, call request_write_access; the user approves on their Mac.`;
}

const server = new McpServer({ name: "host-shell-mcp", version: "1.2.0" });

server.registerTool(
  "run_command",
  {
    title: "Run shell command on the user's computer",
    description: [
      `Run a shell command on the user's real computer, outside your sandbox or VM. ` +
        `Commands run as the user, with their installed tools and credentials (SSH keys, keychain, gh/git auth, cloud CLIs). ` +
        `Nothing is undoable: a delete is permanent and a push is public. Be as careful as you would be at their keyboard. ` +
        `Every command is recorded in a log the user can review.`,
      describeAccess(startup),
      `When to use it: if you also have a sandboxed shell, use that for reading and editing files you already have. ` +
        `Use this one only for what needs the real machine: credentials, git remotes (push/pull/fetch), ` +
        `tools installed on the host, and files that exist only on the host.`,
      `Details: runs \`<shell> -ilc <command>\`, so the user's shell startup files are loaded and PATH matches their terminal; ` +
        `with zsh, unmatched globs are passed through literally, as in bash. ` +
        `Each call is a fresh shell with no TTY: cd/export don't carry over (chain with && or pass cwd), ` +
        `and anything that prompts gets EOF (feed it with stdin). ` +
        `stdout and stderr are each capped at ${MAX_OUTPUT_BYTES} bytes. To leave something running, ` +
        `background it with output redirected: \`nohup cmd > /tmp/cmd.log 2>&1 &\`.`,
    ].join("\n\n"),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    inputSchema: {
      command: z.string().min(1).describe("Shell command to run"),
      cwd: z.string().optional().describe("Working directory (absolute path; ~ is allowed)"),
      timeout_seconds: z.number().int().positive().max(MAX_TIMEOUT_S).optional()
        .describe("Kill the command after this many seconds (default from the user's settings, usually 120)"),
      stdin: z.string().optional().describe("Text written to the command's stdin"),
    },
  },
  async (args, extra) => {
    const { config, error } = currentConfig();
    if (error) return errorResult(error);
    const id = nextId++;
    const cwd = expandPath(args.cwd ?? config.default_cwd);
    const timeout = args.timeout_seconds ?? config.timeout_seconds;
    log(`run #${id} cwd=${cwd} cmd=${JSON.stringify(args.command)}`);
    audit(config, { event: "start", id, mode: config.mode, cwd, command: args.command });
    const r = await runCommand({ ...args, cwd, timeout_seconds: timeout }, config, extra.signal);
    log(`done #${id} exit=${r.exit_code} signal=${r.signal} stop=${r.stop_reason} ${r.duration_ms}ms${r.error ? ` error=${r.error}` : ""}`);
    audit(config, { event: "end", id, exit_code: r.exit_code ?? null, signal: r.signal ?? null,
      stop_reason: r.stop_reason ?? null, error: r.error ?? null, duration_ms: r.duration_ms });
    const { text, isError } = formatResult(r, timeout, config);
    return { content: [{ type: "text", text }], isError };
  },
);

const HOME = homedir();
const BROAD = ["/", "/Users", "/System", "/Library", "/Applications", "/usr", "/bin", "/sbin", "/private", "/opt"];

server.registerTool(
  "request_write_access",
  {
    title: "Ask the user for write access to a folder",
    description:
      `Ask the user to let run_command create, edit and delete files in a folder on their computer. ` +
      `A dialog appears on their Mac showing the folder and your reason; they can deny, allow for this session, ` +
      `or always allow (saved to their settings). Ask for the narrowest folder that does the job, usually the project folder. ` +
      `If nobody answers within ${DIALOG_TIMEOUT_S} seconds, it counts as denied.`,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      paths: z.array(z.string().min(1)).min(1).max(10).describe("Absolute folder paths (~ is allowed)"),
      reason: z.string().min(1).max(500).describe("Why you need to write there, in one or two plain sentences for the user"),
    },
  },
  async ({ paths, reason }) => {
    const { config, error } = currentConfig();
    if (error) return errorResult(error);
    if (config.mode === "unrestricted") return { content: [{ type: "text", text: "Writes aren't restricted (mode = unrestricted), so no access is needed." }] };

    const requested = [];
    for (const p of paths) {
      const expanded = expandPath(p.trim());
      if (!isAbsolute(expanded)) return errorResult(`"${p}" isn't an absolute path.`);
      const real = realPathLoose(expanded);
      if (!requested.includes(real)) requested.push(real);
    }
    const roots = writableRoots(config, sessionWrites);
    const needed = requested.filter((p) => !roots.some((root) => isWithin(p, root)));
    if (needed.length === 0) return { content: [{ type: "text", text: `Already allowed: ${listPaths(requested)}.` }] };

    const broad = needed.filter((p) => BROAD.includes(p) || isWithin(HOME, p));
    const message = [
      `Claude wants to create, change and delete files in:`,
      needed.map((p) => `    ${abbreviate(p)}`).join("\n"),
      broad.length ? `⚠️ ${listPaths(broad)} is a very broad location. Allowing it lets commands change almost anything there.` : null,
      `Claude's reason: “${reason.trim()}”`,
      `“Always allow” saves this to ${abbreviate(CONFIG_PATH)}.`,
    ].filter(Boolean).join("\n\n");

    const answer = await askUser(message);
    audit(config, { event: "access_request", paths: needed, reason, answer });
    log(`access request ${JSON.stringify(needed.map(abbreviate))}: ${answer}`);

    if (answer === "always") {
      try {
        saveWriteList([...config.write, ...needed.map(abbreviate)]);
      } catch (e) {
        sessionWrites.push(...needed);
        return errorResult(`The user allowed it, but saving the settings failed (${e.message}), so it applies only to this session.`);
      }
      return { content: [{ type: "text", text: `The user allowed writing in ${listPaths(needed)} and saved it to their settings.` }] };
    }
    if (answer === "session") {
      sessionWrites.push(...needed);
      return { content: [{ type: "text", text: `The user allowed writing in ${listPaths(needed)} for this session.` }] };
    }
    const why = {
      deny: "The user denied the request.",
      timeout: `Nobody answered within ${DIALOG_TIMEOUT_S} seconds, so the request was denied. The user may be away from their computer.`,
    }[answer] ?? "The permission dialog couldn't be shown, so the request was denied.";
    return errorResult(`${why} Don't retry the same request; ask the user in chat if you still need it.`);
  },
);

server.server.onerror = (e) => log("protocol error:", e.message ?? e);

// Shutdown: stop running commands, then exit. Triggered when the client goes away
// (stdin ends, stdout breaks) or we're signalled.
let shuttingDown = false;
function shutdown(reason, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`shutting down: ${reason}${active.size ? `; stopping ${active.size} running command(s)` : ""}`);
  if (active.size === 0) process.exit(exitCode);
  for (const child of active) {
    signalGroup(child, "SIGTERM");
    child.once("exit", () => { active.delete(child); if (active.size === 0) process.exit(exitCode); });
  }
  setTimeout(() => {
    for (const child of active) signalGroup(child, "SIGKILL");
    process.exit(exitCode);
  }, KILL_GRACE_MS);
}

process.stdin.on("end", () => shutdown("client closed stdin"));
process.stdin.on("close", () => shutdown("stdin closed"));
process.stdout.on("error", (e) => shutdown(`stdout error: ${e.code ?? e.message}`));
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => shutdown(sig));
process.on("uncaughtException", (e) => { log("uncaught exception:", e); shutdown("uncaught exception", 1); });
process.on("unhandledRejection", (e) => { log("unhandled rejection:", e); shutdown("unhandled rejection", 1); });

await server.connect(new StdioServerTransport());
log(`ready (config=${CONFIG_PATH}, sandbox=${SANDBOX_SUPPORTED ? startup?.mode ?? "config error" : "unsupported"})`);
