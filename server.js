#!/usr/bin/env node
// host-shell-mcp: a stdio MCP server that runs shell commands on the machine it
// runs on, confined (on macOS) to the folders the user allows.
//
// stdout carries the MCP protocol and nothing else; all logging goes to stderr.
// Settings live in ~/.config/host-shell-mcp/config.toml (see config.js).

import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, statSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { abbreviate, CONFIG_PATH, ensureConfig, expandPath, loadConfig, SANDBOX_SUPPORTED, saveWriteList } from "./config.js";
import { askUser, DIALOG_TIMEOUT_S } from "./dialog.js";
import { HEAD_BYTES, Output, pruneOutputFiles, TAIL_BYTES } from "./output.js";
import { toHostPath } from "./paths.js";
import { isWithin, realPathLoose, sandboxArgs, writableRoots } from "./sandbox.js";

const MAX_TIMEOUT_S = 3600;
const DEFAULT_WAIT_S = 30; // under the ~60 s many MCP clients allow a single call
const MAX_WAIT_S = 300;
const KILL_GRACE_MS = 2000; // SIGTERM -> SIGKILL
const DRAIN_MS = 250; // how long to wait for output after the shell exits
const PROGRESS_EVERY_MS = 10_000;
const MAX_FINISHED_JOBS = 50; // finished jobs kept until the agent reads them

// Commands have no TTY, so anything that would prompt or page must be told not to.
const NON_INTERACTIVE_ENV = {
  GIT_TERMINAL_PROMPT: "0",
  GCM_INTERACTIVE: "never",
  GIT_PAGER: "cat",
  PAGER: "cat",
  GH_PROMPT_DISABLED: "1",
};

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

const outputDir = (config) => join(dirname(expandPath(config.log_file)), "output");

// Append-only record of every command run, so the user can audit what an agent did.
// One JSON object per line: a "start" entry, then an "end" entry with the same id.
let brokenLog = null;
function audit(config, entry) {
  const file = expandPath(config.log_file);
  if (brokenLog === file) return;
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, ...entry }) + "\n", { mode: 0o600 });
  } catch (e) {
    brokenLog = file; // don't fail commands over it; say so once
    log(`cannot write command log ${file}: ${e.message}`);
  }
}

// Each command runs in its own process group (detached), so signalling -pid
// reaches the shell and everything it started.
function signalGroup(child, sig) {
  try { process.kill(-child.pid, sig); } catch {} // ESRCH: already gone
}

// ---- Jobs ----
//
// Every command is a job. run_command waits for it for a while; if it's still
// running after that, the agent gets a job id and the output so far, and the
// command carries on until it finishes or hits its time limit.

let nextId = 1;
const jobs = new Map(); // running jobs, and finished ones the agent hasn't been told about yet

function startJob({ command, cwd, timeout_seconds, stdin = "" }, config) {
  try {
    if (!statSync(cwd).isDirectory()) return { error: `cwd is not a directory: ${cwd}` };
  } catch {
    return { error: `cwd does not exist: ${cwd}` };
  }

  const shell = shellFor(config);
  // -il: interactive login shell, so the environment matches a normal terminal
  // (PATH from .zprofile *and* .zshrc, where nvm and friends usually live) even
  // when the MCP client launched us with a minimal environment.
  const argv = [shell, "-ilc", scriptPrefix(shell) + command];
  // sandbox-exec execs the shell in place, so the pid and process group are the shell's.
  if (SANDBOX_SUPPORTED) argv.unshift(...sandboxArgs(config, sessionWrites));

  const id = nextId++;
  const spool = join(outputDir(config), `${Date.now()}-${process.pid}-${id}`);
  const job = {
    id, command, cwd, timeout_seconds, config,
    started: Date.now(),
    stdout: new Output(`${spool}.stdout.txt`),
    stderr: new Output(`${spool}.stderr.txt`),
    stopReason: null,
    result: null, // set when finished
  };

  // detached: own process group and session, so no controlling TTY (a password
  // prompt fails fast instead of hanging) and the whole tree can be killed at once.
  const child = spawn(argv[0], argv.slice(1), {
    cwd, detached: true, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...NON_INTERACTIVE_ENV },
  });
  job.child = child;
  log(`run #${id} cwd=${cwd} cmd=${JSON.stringify(command)}`);
  audit(config, { event: "start", id, mode: config.mode, cwd, command });

  child.stdout.on("data", (c) => job.stdout.write(c));
  child.stderr.on("data", (c) => job.stderr.write(c));
  child.stdout.on("error", () => {});
  child.stderr.on("error", () => {});

  let drainTimer;
  const timer = setTimeout(() => stopJob(job, "timeout"), timeout_seconds * 1000);
  job.done = new Promise((resolve) => {
    job.finish = (result) => {
      if (job.result) return;
      clearTimeout(timer);
      clearTimeout(drainTimer);
      job.result = { ...result, duration_ms: Date.now() - job.started };
      job.stdout.close();
      job.stderr.close();
      const r = job.result;
      log(`done #${id} exit=${r.exit_code} signal=${r.signal} stop=${job.stopReason} ${r.duration_ms}ms${r.error ? ` error=${r.error}` : ""}`);
      audit(config, { event: "end", id, exit_code: r.exit_code ?? null, signal: r.signal ?? null,
        stop_reason: job.stopReason, error: r.error ?? null, duration_ms: r.duration_ms,
        stdout_bytes: job.stdout.total, stderr_bytes: job.stderr.total });
      pruneFinishedJobs();
      resolve();
    };
  });

  // Failed to start (e.g. the shell doesn't exist).
  child.on("error", (e) => job.finish({ error: `failed to start ${argv[0]}: ${e.message}` }));

  // 'close' fires once the shell has exited and its output pipes are closed.
  child.on("close", (code, signal) => job.finish({ exit_code: code, signal }));

  // A backgrounded process (`cmd &`) inherits the pipes and would keep 'close'
  // from ever firing. Once the shell itself exits, give output a moment to drain,
  // then stop reading and return; the background process keeps running.
  child.on("exit", (code, signal) => {
    job.exited = true;
    drainTimer = setTimeout(() => {
      child.stdout.destroy();
      child.stderr.destroy();
      job.finish({ exit_code: code, signal, detached_output: true });
    }, DRAIN_MS);
  });

  child.stdin.on("error", () => {}); // EPIPE if the command exits without reading stdin
  child.stdin.end(stdin);

  jobs.set(id, job);
  return job;
}

// SIGTERM the job's process group, then SIGKILL if it's still there.
function stopJob(job, reason) {
  if (job.result || job.stopReason) return;
  job.stopReason = reason;
  signalGroup(job.child, "SIGTERM");
  // Always, not just if the shell is still there: a child that ignored SIGTERM may have outlived it.
  setTimeout(() => signalGroup(job.child, "SIGKILL"), KILL_GRACE_MS).unref();
}

function pruneFinishedJobs() {
  const finished = [...jobs.values()].filter((j) => j.result);
  for (const j of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED_JOBS))) jobs.delete(j.id);
}

// Wait until the job finishes or `seconds` pass. If the call is cancelled
// (the user pressed stop), the command is stopped too. Sends progress
// notifications while waiting, when the client asked for them.
async function waitForJob(job, seconds, extra) {
  if (job.result) return;
  const token = extra._meta?.progressToken;
  let progress;
  if (token !== undefined) {
    progress = setInterval(() => {
      const elapsed = Math.round((Date.now() - job.started) / 1000);
      extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: elapsed, message: `running for ${elapsed}s` } }).catch(() => {});
    }, PROGRESS_EVERY_MS);
  }
  const onAbort = () => stopJob(job, "cancelled");
  extra.signal?.addEventListener("abort", onAbort, { once: true });
  if (extra.signal?.aborted) onAbort();
  let timer;
  await Promise.race([job.done, new Promise((r) => { timer = setTimeout(r, seconds * 1000); })]);
  clearTimeout(timer);
  clearInterval(progress);
  extra.signal?.removeEventListener("abort", onAbort);
}

const listPaths = (paths) => (paths.length ? paths.map(abbreviate).join(", ") : "(none yet)");

// When a sandboxed command fails with a permission error, tell the agent why
// and how to ask for access, instead of leaving it to guess.
function sandboxHint(job, text) {
  const { config } = job;
  if (config.mode !== "sandboxed" || !job.result || job.result.exit_code === 0) return null;
  if (!/operation not permitted|EPERM|PermissionError|Unable to find application|privilege violation/i.test(text)) return null;
  const granted = [...config.write.map(expandPath), ...sessionWrites];
  return [
    `[host-shell-mcp] This was probably blocked by the sandbox. Commands can write only in: ${listPaths(granted)}, plus temp and cache folders.`,
    config.deny_read.length ? `Reading is blocked in: ${listPaths(config.deny_read.map(expandPath))}.` : null,
    `Launching apps (open) and AppleScript are disabled.`,
    `To write somewhere else, call request_write_access with the folder and your reason; the user is asked on their Mac.`,
  ].filter(Boolean).join(" ");
}

// Describes the job's state plus the output since the last report. A finished
// job is forgotten once reported.
function reportJob(job, notes = []) {
  const r = job.result;
  if (r?.error && r.exit_code === undefined) {
    jobs.delete(job.id);
    return { content: [{ type: "text", text: `Error: ${r.error}` }], isError: true };
  }
  const stdout = job.stdout.take();
  const stderr = job.stderr.take();
  const elapsed = Math.round((Date.now() - job.started) / 1000);

  let status;
  if (!r) {
    status = `Still running after ${elapsed}s (job_id ${job.id}). It keeps running until it finishes or reaches its ${job.timeout_seconds}s limit. ` +
      `Call read_output with job_id ${job.id} to wait for it and get new output, or stop_command to stop it.`;
  } else if (job.stopReason === "timeout") status = `Timed out after ${job.timeout_seconds}s; process group killed`;
  else if (job.stopReason === "cancelled") status = "Cancelled; process group killed";
  else if (job.stopReason === "stopped") status = "Stopped with stop_command; process group killed";
  else if (r.signal) status = `Killed by signal ${r.signal}`;
  else status = `Exit code: ${r.exit_code}`;

  const suffix = r ? "" : " so far";
  const parts = [r ? `${status} (${r.duration_ms} ms)` : status, ...notes];
  if (stdout) parts.push(`--- stdout${suffix} ---\n${stdout}`);
  if (stderr) parts.push(`--- stderr${suffix} ---\n${stderr}`);
  if (r?.detached_output) parts.push("[note: a background process still holds the output pipes; its later output is not captured]");
  const hint = sandboxHint(job, stdout + stderr);
  if (hint) parts.push(hint);
  if (r) jobs.delete(job.id);
  return { content: [{ type: "text", text: parts.join("\n") }], isError: !!r && r.exit_code !== 0 };
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
const textResult = (text) => ({ content: [{ type: "text", text }] });

if (ensureConfig()) log(`created default settings at ${CONFIG_PATH}`);
const startup = loadConfig().config;
if (startup) pruneOutputFiles(outputDir(startup));

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

const server = new McpServer({ name: "host-shell-mcp", version: "1.3.0" });

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
      `Paths: pass host paths. A cwd inside your VM's shared folders (/sessions/…/mnt/<folder>/…) is translated to the ` +
        `host folder of the same name when there's exactly one; otherwise you get an error asking for the host path.`,
      `Long commands: the call waits up to wait_seconds (default ${DEFAULT_WAIT_S}). If the command is still running, ` +
        `you get a job_id and the output so far; call read_output to wait for more, or stop_command to stop it. ` +
        `It's killed if it runs longer than timeout_seconds.`,
      `Output: each stream shows its first ${HEAD_BYTES / 1000} KB and last ${TAIL_BYTES / 1000} KB; anything longer is saved ` +
        `to a file on the host whose path is in the result (read it with run_command, e.g. sed -n or grep).`,
      `Details: runs \`<shell> -ilc <command>\`, so the user's shell startup files are loaded and PATH matches their terminal; ` +
        `with zsh, unmatched globs are passed through literally, as in bash. ` +
        `Each call is a fresh shell with no TTY: cd/export don't carry over (chain with && or pass cwd), ` +
        `anything that prompts gets EOF (feed it with stdin), and git/gh prompts and pagers are turned off.`,
    ].join("\n\n"),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    inputSchema: {
      command: z.string().min(1).describe("Shell command to run"),
      cwd: z.string().optional().describe("Working directory: a host path (~ is allowed) or a path in your VM's shared folders"),
      timeout_seconds: z.number().int().positive().max(MAX_TIMEOUT_S).optional()
        .describe("Kill the command if it runs longer than this (default from the user's settings)"),
      wait_seconds: z.number().int().min(0).max(MAX_WAIT_S).optional()
        .describe(`How long this call waits before returning a job_id for a command that's still running (default ${DEFAULT_WAIT_S})`),
      stdin: z.string().optional().describe("Text written to the command's stdin"),
    },
  },
  async (args, extra) => {
    const { config, error } = currentConfig();
    if (error) return errorResult(error);
    const where = toHostPath(args.cwd ?? config.default_cwd, config, sessionWrites);
    if (where.error) return errorResult(where.error);
    const timeout = args.timeout_seconds ?? config.timeout_seconds;
    const job = startJob({ ...args, cwd: where.path, timeout_seconds: timeout }, config);
    if (job.error) return errorResult(`Error: ${job.error}`);
    await waitForJob(job, args.wait_seconds ?? DEFAULT_WAIT_S, extra);
    return reportJob(job, where.note ? [where.note] : []);
  },
);

const unknownJob = (id) => errorResult(
  `There's no job ${id}. It has already been reported as finished, or the server restarted.` +
  (jobs.size ? ` Current jobs: ${[...jobs.keys()].join(", ")}.` : ""));

server.registerTool(
  "read_output",
  {
    title: "Wait for a running command and read its new output",
    description: `Wait for a command that run_command left running (by job_id), and get the output it produced since you last looked. ` +
      `Returns as soon as the command finishes, or after wait_seconds (default ${DEFAULT_WAIT_S}) if it's still running.`,
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: {
      job_id: z.number().int().positive(),
      wait_seconds: z.number().int().min(0).max(MAX_WAIT_S).optional().describe(`Default ${DEFAULT_WAIT_S}`),
    },
  },
  async ({ job_id, wait_seconds }, extra) => {
    const job = jobs.get(job_id);
    if (!job) return unknownJob(job_id);
    await waitForJob(job, wait_seconds ?? DEFAULT_WAIT_S, extra);
    return reportJob(job);
  },
);

server.registerTool(
  "stop_command",
  {
    title: "Stop a running command",
    description: "Stop a command that run_command left running (by job_id): SIGTERM to everything it started, then SIGKILL after 2 seconds. Returns its final output.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { job_id: z.number().int().positive() },
  },
  async ({ job_id }) => {
    const job = jobs.get(job_id);
    if (!job) return unknownJob(job_id);
    stopJob(job, "stopped");
    await Promise.race([job.done, new Promise((r) => setTimeout(r, KILL_GRACE_MS + 3000))]);
    return reportJob(job);
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
      paths: z.array(z.string().min(1)).min(1).max(10).describe("Folder paths: host paths (~ is allowed) or paths in your VM's shared folders"),
      reason: z.string().min(1).max(500).describe("Why you need to write there, in one or two plain sentences for the user"),
    },
  },
  async ({ paths, reason }) => {
    const { config, error } = currentConfig();
    if (error) return errorResult(error);
    if (config.mode === "unrestricted") return textResult("Writes aren't restricted (mode = unrestricted), so no access is needed.");

    const requested = [];
    const notes = [];
    for (const p of paths) {
      const where = toHostPath(p.trim(), config, sessionWrites);
      if (where.error) return errorResult(where.error);
      if (!isAbsolute(where.path)) return errorResult(`"${p}" isn't an absolute path.`);
      if (where.note) notes.push(where.note);
      const real = realPathLoose(where.path);
      if (!requested.includes(real)) requested.push(real);
    }
    const roots = writableRoots(config, sessionWrites);
    const needed = requested.filter((p) => !roots.some((root) => isWithin(p, root)));
    const withNotes = (text) => [...notes, text].join("\n");
    if (needed.length === 0) return textResult(withNotes(`Already allowed: ${listPaths(requested)}.`));

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
        return errorResult(withNotes(`The user allowed it, but saving the settings failed (${e.message}), so it applies only to this session.`));
      }
      return textResult(withNotes(`The user allowed writing in ${listPaths(needed)} and saved it to their settings.`));
    }
    if (answer === "session") {
      sessionWrites.push(...needed);
      return textResult(withNotes(`The user allowed writing in ${listPaths(needed)} for this session.`));
    }
    const why = {
      deny: "The user denied the request.",
      timeout: `Nobody answered within ${DIALOG_TIMEOUT_S} seconds, so the request was denied. The user may be away from their computer.`,
    }[answer] ?? "The permission dialog couldn't be shown, so the request was denied.";
    return errorResult(`${why} Don't retry the same request; ask the user in chat if you still need it.`);
  },
);

server.server.onerror = (e) => log("protocol error:", e.message ?? e);

// Shutdown: stop running commands (including ones left running as jobs), then
// exit. Triggered when the client goes away (stdin ends, stdout breaks) or
// we're signalled.
let shuttingDown = false;
function shutdown(reason, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  const running = [...jobs.values()].filter((j) => !j.exited);
  log(`shutting down: ${reason}${running.length ? `; stopping ${running.length} running command(s)` : ""}`);
  if (running.length === 0) process.exit(exitCode);
  let left = running.length;
  for (const job of running) {
    signalGroup(job.child, "SIGTERM");
    job.child.once("exit", () => { if (--left === 0) process.exit(exitCode); });
  }
  setTimeout(() => {
    for (const job of running) signalGroup(job.child, "SIGKILL");
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
