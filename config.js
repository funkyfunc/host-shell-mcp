// Settings file: ~/.config/host-shell-mcp/config.toml
//
// Created with safe defaults on first run. Read on every command (cached by
// mtime), so edits apply without a restart. Commands can never write it (the
// sandbox protects it); the server writes it only after the user approves a
// change in a native dialog.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parse } from "smol-toml";

export const CONFIG_PATH = process.env.HOST_SHELL_MCP_CONFIG || join(homedir(), ".config/host-shell-mcp/config.toml");
export const SANDBOX_SUPPORTED = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec");

const DEFAULT_LOG = process.platform === "darwin"
  ? "~/Library/Logs/host-shell-mcp/commands.jsonl"
  : "~/.local/state/host-shell-mcp/commands.jsonl";

const DEFAULTS = {
  mode: SANDBOX_SUPPORTED ? "sandboxed" : "unrestricted",
  write: [],
  write_caches: ["$TMPDIR", "/private/tmp", "~/Library/Caches", "~/.npm", "~/.cache"],
  deny_read: [],
  shell: "",
  default_cwd: "~",
  timeout_seconds: 600,
  log_file: DEFAULT_LOG,
};

const tomlArray = (list) => (list.length ? `[\n${list.map((p) => `  ${JSON.stringify(p)},`).join("\n")}\n]` : "[\n]");

function template(c) {
  return `# host-shell-mcp settings
#
# Changes apply to the next command. No restart needed.
# Commands Claude runs can't edit this file. Claude can ask you for write access
# instead: a dialog appears on your Mac, and "Always allow" adds the folder to
# \`write\` below.

# "sandboxed":    commands can read everywhere, but only write in the folders below.
#                 Launching apps (\`open\`) and AppleScript are blocked.
# "unrestricted": no limits, except that this file and the command log stay protected.
mode = ${JSON.stringify(c.mode)}

# Folders where commands may create, edit, rename and delete files.
write = ${tomlArray(c.write)}

# Temp and cache folders that tools like npm, pip, git and Homebrew need to work.
write_caches = ${tomlArray(c.write_caches)}

# Folders commands may not read at all (applies in both modes).
# Careful: blocking ~/.ssh also blocks git over SSH.
deny_read = ${tomlArray(c.deny_read)}

# Shell used to run commands. Empty means your login shell.
shell = ${JSON.stringify(c.shell)}

# Where commands run when Claude doesn't say.
default_cwd = ${JSON.stringify(c.default_cwd)}

# Commands running longer than this many seconds are stopped. Long commands don't
# block Claude (it gets a job id and checks back), so this can be generous.
# Claude can ask for up to 3600 for a single command.
timeout_seconds = ${c.timeout_seconds}

# Every command is recorded here, one JSON object per line.
log_file = ${JSON.stringify(c.log_file)}
`;
}

// Atomic, owner-only write: never leaves a half-written settings file.
function writePrivate(path, text) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export function ensureConfig() {
  if (existsSync(CONFIG_PATH)) return false;
  writePrivate(CONFIG_PATH, template(DEFAULTS));
  return true;
}

export function expandPath(p) {
  const home = homedir();
  const tmp = process.env.TMPDIR || tmpdir();
  let out = p.replace(/^~(?=$|\/)/, home).replace(/\$\{?HOME\}?/g, home).replace(/\$\{?TMPDIR\}?/g, tmp);
  return isAbsolute(out) ? resolve(out) : out;
}

export const abbreviate = (p) => {
  const home = homedir();
  return p === home ? "~" : p.startsWith(home + "/") ? "~" + p.slice(home.length) : p;
};

function validate(raw) {
  const c = { ...DEFAULTS };
  const errors = [];
  for (const [key, value] of Object.entries(raw)) {
    if (!(key in DEFAULTS)) { errors.push(`unknown setting "${key}"`); continue; }
    const want = DEFAULTS[key];
    if (Array.isArray(want)) {
      if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) errors.push(`"${key}" must be a list of paths`);
      else c[key] = value;
    } else if (typeof value !== typeof want) {
      errors.push(`"${key}" must be a ${typeof want}`);
    } else {
      c[key] = value;
    }
  }
  if (!["sandboxed", "unrestricted"].includes(c.mode)) errors.push(`mode must be "sandboxed" or "unrestricted"`);
  if (!Number.isInteger(c.timeout_seconds) || c.timeout_seconds < 1 || c.timeout_seconds > 3600) {
    errors.push(`timeout_seconds must be a whole number from 1 to 3600`);
  }
  for (const key of ["write", "write_caches", "deny_read", "default_cwd", "log_file"]) {
    for (const p of [c[key]].flat()) {
      if (!isAbsolute(expandPath(p))) errors.push(`"${p}" in ${key} must be an absolute path (or start with ~)`);
    }
  }
  return { config: c, errors };
}

let cache = { key: null, result: null };

// Returns { config } or { error }. A broken file fails closed: commands refuse
// to run rather than fall back to looser defaults.
export function loadConfig() {
  let st;
  try {
    st = statSync(CONFIG_PATH);
  } catch {
    ensureConfig(); // deleted: recreate the safe defaults
    st = statSync(CONFIG_PATH);
  }
  const key = `${st.mtimeMs}:${st.size}`;
  if (cache.key === key) return cache.result;
  let result;
  try {
    const { config, errors } = validate(parse(readFileSync(CONFIG_PATH, "utf8")));
    result = errors.length ? { error: errors.join("; ") } : { config };
  } catch (e) {
    result = { error: e.message.split("\n")[0] };
  }
  cache = { key, result };
  return result;
}

// Replace the `write` list, keeping the rest of the file (including the user's
// own comments) as-is. If the file's layout defeats the in-place edit, rewrite
// it from the template with the current values.
export function saveWriteList(list) {
  const text = readFileSync(CONFIG_PATH, "utf8");
  const edited = text.replace(/^write\s*=\s*\[[^\]]*\]/m, `write = ${tomlArray(list)}`);
  let next = edited;
  try {
    const parsed = parse(edited);
    if (JSON.stringify(parsed.write) !== JSON.stringify(list)) throw new Error("in-place edit mismatch");
  } catch {
    const { config } = validate(parse(text));
    next = template({ ...config, write: list });
  }
  writePrivate(CONFIG_PATH, next);
}
