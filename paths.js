// Translates paths from an agent's VM into host paths.
//
// Cowork shows the folders a user shares with it at /sessions/<id>/mnt/<name>
// inside its VM, and doesn't record where each one lives on the host. So a VM
// path is translated only when exactly one host folder with that name can be
// found in the usual places; anything else is an error that asks the agent for
// the host path, rather than a guess that could run a command in the wrong place.

import { statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { expandPath } from "./config.js";
import { realPathLoose } from "./sandbox.js";

const VM_MOUNT = /^\/sessions\/[^/]+\/mnt\/([^/]+)(\/.*)?$/;
const COMMON_PARENTS = ["", "Development", "Developer", "Projects", "Code", "src", "Desktop", "Documents", "Downloads"];

const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };

// Returns { path, note? } or { error }.
export function toHostPath(p, config, sessionWrites) {
  const m = VM_MOUNT.exec(p);
  if (!m) return { path: expandPath(p) };
  const [, name, rest = ""] = m;
  if (isDir(p)) return { path: p }; // a real host path that happens to look like a VM one

  const granted = [...config.write.map(expandPath), ...sessionWrites];
  const candidates = [
    ...granted.filter((g) => basename(g) === name),
    ...granted.map((g) => join(g, name)),
    ...COMMON_PARENTS.map((d) => join(homedir(), d, name)),
  ].filter(isDir);
  const unique = [...new Set(candidates.map(realPathLoose))];

  if (unique.length === 1) {
    const path = resolve(unique[0] + rest);
    return { path, note: `VM path ${p} was translated to the host path ${path}.` };
  }
  if (unique.length === 0) {
    return { error: `${p} is a path inside your VM, and no host folder named "${name}" was found. Ask the user where that folder is on their computer and use the host path.` };
  }
  return { error: `${p} is a path inside your VM, and several host folders are named "${name}": ${unique.join(", ")}. Use the host path you mean.` };
}
