// Native macOS permission dialog, shown by the server process (outside the
// sandbox). Commands can't answer it: they can't send Apple Events.

import { execFile } from "node:child_process";
import { appendFileSync } from "node:fs";

export const DIALOG_TIMEOUT_S = 120;

const SCRIPT = `
on run argv
  activate
  set r to display dialog (item 1 of argv) with title "host-shell-mcp" buttons {"Deny", "Allow this session", "Always allow"} default button "Deny" cancel button "Deny" with icon caution giving up after (item 2 of argv as integer)
  if gave up of r then return "timeout"
  return button returned of r
end run`;

const ANSWERS = { "Always allow": "always", "Allow this session": "session", timeout: "timeout" };

// Test hook: answer without showing anything. Only the server's own
// environment can set it, and commands can't change that.
function testAnswer(message) {
  if (process.env.HOST_SHELL_MCP_TEST_DIALOG_LOG) appendFileSync(process.env.HOST_SHELL_MCP_TEST_DIALOG_LOG, message + "\n---\n");
  return process.env.HOST_SHELL_MCP_TEST_DIALOG;
}

function show(message) {
  if (process.env.HOST_SHELL_MCP_TEST_DIALOG) return Promise.resolve(testAnswer(message));
  return new Promise((resolve) => {
    // Text goes in as an argument, never spliced into the script.
    execFile("/usr/bin/osascript", ["-e", SCRIPT, message, String(DIALOG_TIMEOUT_S)], { timeout: (DIALOG_TIMEOUT_S + 10) * 1000 }, (err, stdout, stderr) => {
      if (err) return resolve(/-128/.test(stderr) ? "deny" : "error"); // -128: Deny/Esc
      resolve(ANSWERS[stdout.trim()] ?? "deny");
    });
  });
}

// One dialog at a time; concurrent requests queue up.
let queue = Promise.resolve();

// Resolves to "always" | "session" | "deny" | "timeout" | "error".
export function askUser(message) {
  const result = queue.then(() => show(message));
  queue = result.catch(() => {});
  return result;
}
