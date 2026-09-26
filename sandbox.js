// Builds the macOS Seatbelt (sandbox-exec) wrapper for a command.
//
// The kernel enforces the profile on the command and everything it starts
// (scripts in any language included), so nothing here parses command text.
//
// It's a guardrail, not a guarantee against a determined attacker: a command
// can still ask something outside the sandbox to act for it (ssh to this Mac,
// Docker, launchd jobs). AppleScript and launching apps are blocked because
// they're the easy routes to an unsandboxed Terminal.

import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { CONFIG_PATH, expandPath } from "./config.js";

// Seatbelt matches real paths (/var is really /private/var), and paths that
// don't exist yet still need a sensible real form, so resolve the longest
// existing prefix.
export function realPathLoose(p) {
  let cur = resolve(p);
  const rest = [];
  for (;;) {
    try {
      return join(realpathSync(cur), ...rest.reverse());
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return resolve(p);
      rest.push(basename(cur));
      cur = parent;
    }
  }
}

export const isWithin = (child, parent) => child === parent || child.startsWith(parent.endsWith("/") ? parent : parent + "/");

// Real paths the command may write to right now.
export function writableRoots(config, sessionWrites) {
  return [...config.write, ...config.write_caches].map((p) => realPathLoose(expandPath(p))).concat(sessionWrites);
}

// Returns the argv prefix that runs a command inside the sandbox.
export function sandboxArgs(config, sessionWrites) {
  const params = [];
  const param = (prefix, list) =>
    list.map((path, i) => {
      params.push("-D", `${prefix}${i}=${path}`);
      return `(subpath (param "${prefix}${i}"))`;
    }).join(" ");

  const rules = ["(version 1)", "(allow default)"];

  if (config.mode === "sandboxed") {
    rules.push(
      "(deny file-write*)",
      `(allow file-write* (regex #"^/dev/") ${param("W", writableRoots(config, sessionWrites))})`,
      "(deny appleevent-send)",
      // LaunchServices: without it `open` can't find or launch apps.
      '(deny mach-lookup (global-name-regex #"^com\\.apple\\.(lsd\\.|coreservices\\.launchservicesd)"))',
    );
  }

  if (config.deny_read.length) {
    rules.push(`(deny file-read* ${param("R", config.deny_read.map((p) => realPathLoose(expandPath(p))))})`);
  }

  // Always last, so it wins over any write rule above, in both modes.
  const logFile = realPathLoose(expandPath(config.log_file));
  rules.push(`(deny file-write* ${param("P", [realPathLoose(dirname(CONFIG_PATH))])} (literal (param "LOG")))`);
  params.push("-D", `LOG=${logFile}`);

  return ["/usr/bin/sandbox-exec", ...params, "-p", rules.join("\n")];
}
