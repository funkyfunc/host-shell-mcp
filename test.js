// End-to-end tests: spawns the server over stdio and exercises it like an MCP client would.
// Usage: npm test
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { parse, stringify } from "smol-toml";

// HOST_SHELL_MCP_TEST_CMD (a JSON array) runs the suite against another launch command, e.g. the packaged plugin.
const [serverCmd, ...serverArgs] = process.env.HOST_SHELL_MCP_TEST_CMD
  ? JSON.parse(process.env.HOST_SHELL_MCP_TEST_CMD)
  : [process.execPath, fileURLToPath(new URL("./server.js", import.meta.url))];
const macOnly = { skip: process.platform !== "darwin" && "sandbox is macOS-only" };

const tmp = mkdtempSync(join(tmpdir(), "host-shell-mcp-test-"));
process.on("exit", () => rmSync(tmp, { recursive: true, force: true }));
const dir = (name) => { const p = join(tmp, name); mkdirSync(p, { recursive: true }); return p; };
const work = dir("work"); // writable
const outside = dir("outside"); // not writable
const secret = dir("secret"); // not readable
writeFileSync(join(secret, "key"), "hunter2");
const logFile = join(tmp, "logs", "commands.jsonl");

// Writes a settings file for one server. Temp folders are deliberately not
// writable, so "outside" (which lives in the temp dir) really is off-limits.
let configCount = 0;
function makeConfig(overrides = {}) {
  const path = join(dir(`cfg-${++configCount}`), "config.toml");
  const config = { mode: "sandboxed", write: [work], write_caches: [], deny_read: [secret], default_cwd: work, log_file: logFile, ...overrides };
  writeFileSync(path, "# my own comment\n" + stringify(config) + "\n");
  return path;
}
const mainConfig = makeConfig();

const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect({ config = mainConfig, dialog, dialogLog } = {}) {
  const env = { ...process.env, HOST_SHELL_MCP_CONFIG: config };
  if (dialog) Object.assign(env, { HOST_SHELL_MCP_TEST_DIALOG: dialog, HOST_SHELL_MCP_TEST_DIALOG_LOG: dialogLog });
  const client = new Client({ name: "test", version: "1" });
  await client.connect(new StdioClientTransport({ command: serverCmd, args: serverArgs, env, stderr: "ignore" }));
  return client;
}
const call = (client, name, args, opts) =>
  client.callTool({ name, arguments: args }, undefined, opts).then((r) => ({ text: r.content[0].text, isError: !!r.isError }));
const run = (client, args, opts) => call(client, "run_command", args, opts);

test("run_command", async (t) => {
  const client = await connect();
  t.after(() => client.close());

  await t.test("lists the tools with the right annotations", async () => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((x) => x.name), ["run_command", "request_write_access"]);
    assert.equal(tools[0].annotations.destructiveHint, true);
    assert.equal(tools[0].annotations.readOnlyHint, false);
    assert.match(tools[0].description, /Nothing is undoable/);
    assert.match(tools[0].description, /write only in: .*work/);
  });

  await t.test("unmatched glob is passed through, not fatal", async () => {
    const r = await run(client, { command: "echo nomatch-*.lock; echo after" });
    assert.match(r.text, /^Exit code: 0/);
    assert.match(r.text, /nomatch-\*\.lock\nafter/);
  });

  await t.test("every command is logged", async () => {
    await run(client, { command: "echo logged-marker; exit 4", cwd: tmp });
    const entries = readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const start = entries.findLast((e) => e.event === "start" && e.command.includes("logged-marker"));
    const end = entries.findLast((e) => e.event === "end" && e.id === start.id && e.pid === start.pid);
    assert.equal(start.cwd, tmp);
    assert.equal(start.mode, "sandboxed");
    assert.ok(start.ts);
    assert.equal(end.exit_code, 4);
    assert.equal(statSync(logFile).mode & 0o777, 0o600);
  });

  await t.test("stdout, stderr and exit code", async () => {
    const r = await run(client, { command: "echo out; echo err >&2; exit 3" });
    assert.match(r.text, /^Exit code: 3/);
    assert.match(r.text, /--- stdout ---\nout/);
    assert.match(r.text, /--- stderr ---\nerr/);
    assert.equal(r.isError, true);
  });

  await t.test("default cwd comes from settings; cwd and stdin", async () => {
    assert.match((await run(client, { command: "pwd" })).text, /\/work\n/);
    const r = await run(client, { command: "pwd; tr a-z A-Z", cwd: tmp, stdin: "hello" });
    assert.equal(r.isError, false);
    assert.match(r.text, new RegExp(`/${tmp.split("/").pop()}\nHELLO`));
  });

  await t.test("command that reads stdin gets EOF instead of hanging", async () => {
    const r = await run(client, { command: "cat; echo done" });
    assert.match(r.text, /done/);
  });

  await t.test("missing cwd is a clear error", async () => {
    const r = await run(client, { command: "true", cwd: "/does/not/exist" });
    assert.equal(r.isError, true);
    assert.match(r.text, /cwd does not exist/);
  });

  await t.test("timeout kills the whole process tree", async () => {
    const pidFile = join(work, "timeout.pid");
    const start = Date.now();
    const r = await run(client, { command: `sleep 300 & echo $! > ${pidFile}; wait`, timeout_seconds: 1 });
    assert.match(r.text, /Timed out after 1s/);
    assert.ok(Date.now() - start < 5000);
    await sleep(200);
    assert.equal(isAlive(Number(readFileSync(pidFile, "utf8"))), false, "background sleep should be killed");
  });

  await t.test("SIGTERM-ignoring command is SIGKILLed", async () => {
    const start = Date.now();
    const r = await run(client, { command: `perl -e '$SIG{TERM} = "IGNORE"; sleep 300'`, timeout_seconds: 1 });
    assert.match(r.text, /Timed out/);
    assert.ok(Date.now() - start >= 2900, "should only die after the SIGKILL grace period");
  });

  await t.test("backgrounded process doesn't block the call", async () => {
    const pidFile = join(work, "bg.pid");
    const start = Date.now();
    const r = await run(client, { command: `sleep 300 & echo $! > ${pidFile}; echo started` });
    assert.match(r.text, /^Exit code: 0/);
    assert.match(r.text, /started/);
    assert.ok(Date.now() - start < 3000);
    const pid = Number(readFileSync(pidFile, "utf8"));
    assert.equal(isAlive(pid), true, "background process should keep running");
    process.kill(pid);
  });

  await t.test("client cancellation kills the command", async () => {
    const pidFile = join(work, "cancel.pid");
    const ac = new AbortController();
    const pending = run(client, { command: `echo $$ > ${pidFile}; sleep 300` }, { signal: ac.signal });
    await sleep(700);
    ac.abort();
    await assert.rejects(pending);
    await sleep(500);
    assert.equal(isAlive(Number(readFileSync(pidFile, "utf8"))), false);
  });

  await t.test("large output is truncated", async () => {
    const r = await run(client, { command: "head -c 1000000 /dev/zero | tr '\\0' x" });
    assert.match(r.text, /output truncated at 200000 bytes/);
  });

  await t.test("concurrent calls", async () => {
    const start = Date.now();
    const rs = await Promise.all([1, 2, 3].map((n) => run(client, { command: `sleep 1; echo ${n}` })));
    rs.forEach((r, i) => assert.match(r.text, new RegExp(`stdout ---\n${i + 1}`)));
    assert.ok(Date.now() - start < 2500, "should run in parallel");
  });
});

test("sandbox", macOnly, async (t) => {
  const client = await connect();
  t.after(() => client.close());

  await t.test("writes inside allowed folders work", async () => {
    const r = await run(client, { command: `echo hi > ${work}/a && mkdir ${work}/d && mv ${work}/a ${work}/d/b && rm -r ${work}/d` });
    assert.match(r.text, /^Exit code: 0/, r.text);
  });

  await t.test("writes elsewhere are blocked, with a hint", async () => {
    const r = await run(client, { command: `echo hi > ${outside}/a` });
    assert.equal(r.isError, true);
    assert.match(r.text, /operation not permitted/i);
    assert.match(r.text, /blocked by the sandbox.*request_write_access/s);
    assert.equal(existsSync(join(outside, "a")), false);
  });

  await t.test("scripts in any language inherit the rules", async () => {
    for (const command of [
      `python3 -c 'open("${outside}/p", "w").write("x")'`,
      `node -e 'require("fs").writeFileSync("${outside}/n", "x")'`,
      `printf 'echo x > ${outside}/s\\n' > ${work}/s.sh && bash ${work}/s.sh`,
    ]) {
      const r = await run(client, { command });
      assert.equal(r.isError, true, command);
    }
    assert.deepEqual(readFileSync(mainConfig, "utf8").includes("my own comment"), true);
    assert.equal(existsSync(join(outside, "p")) || existsSync(join(outside, "n")) || existsSync(join(outside, "s")), false);
  });

  await t.test("deny_read blocks reads", async () => {
    const r = await run(client, { command: `cat ${secret}/key` });
    assert.equal(r.isError, true);
    assert.doesNotMatch(r.text, /hunter2/);
  });

  await t.test("launching apps is blocked", async () => {
    const r = await run(client, { command: "open -g -j -a Finder" });
    assert.equal(r.isError, true);
    assert.match(r.text, /Launching apps \(open\) and AppleScript are disabled/);
  });

  await t.test("settings and log are protected even inside a writable folder", async () => {
    const config = makeConfig({ write: [tmp] });
    const c = await connect({ config });
    try {
      for (const command of [`echo 'mode = "unrestricted"' > ${config}`, `rm ${config}`, `mv ${config} ${config}.bak`, `echo x >> ${logFile}`]) {
        const r = await run(c, { command });
        assert.equal(r.isError, true, command);
      }
      assert.match(readFileSync(config, "utf8"), /mode = "sandboxed"/);
      assert.match((await run(c, { command: `echo ok > ${outside}/allowed-here && rm ${outside}/allowed-here` })).text, /^Exit code: 0/);
    } finally { await c.close(); }
  });

  await t.test("unrestricted mode writes anywhere, but settings stay protected", async () => {
    const config = makeConfig({ mode: "unrestricted" });
    const c = await connect({ config });
    try {
      assert.match((await run(c, { command: `echo ok > ${outside}/u && rm ${outside}/u` })).text, /^Exit code: 0/);
      assert.equal((await run(c, { command: `echo x > ${config}` })).isError, true);
      assert.match((await call(c, "request_write_access", { paths: [outside], reason: "x" })).text, /aren't restricted/);
    } finally { await c.close(); }
  });

  await t.test("settings edits apply without a restart", async () => {
    const config = makeConfig();
    const c = await connect({ config });
    try {
      assert.equal((await run(c, { command: `touch ${outside}/live` })).isError, true);
      writeFileSync(config, stringify({ mode: "sandboxed", write: [work, outside], write_caches: [], log_file: logFile }));
      assert.match((await run(c, { command: `touch ${outside}/live && rm ${outside}/live` })).text, /^Exit code: 0/);
    } finally { await c.close(); }
  });

  await t.test("a broken settings file pauses commands (fails closed)", async () => {
    const config = makeConfig();
    const c = await connect({ config });
    try {
      writeFileSync(config, 'mode = "sandboxed"\nwrite = [ oops');
      const r = await run(c, { command: "echo hi" });
      assert.equal(r.isError, true);
      assert.match(r.text, /settings file has an error/);
      writeFileSync(config, 'mode = "sandboxed"\nwrite = []\ncolour = "blue"\n');
      assert.match((await run(c, { command: "echo hi" })).text, /unknown setting "colour"/);
    } finally { await c.close(); }
  });

  await t.test("first run creates locked-down settings", async () => {
    const config = join(tmp, "fresh", "sub", "config.toml");
    const c = await connect({ config });
    try {
      const text = readFileSync(config, "utf8");
      assert.match(text, /^# host-shell-mcp settings/);
      assert.deepEqual(parse(text).write, []);
      assert.equal(parse(text).mode, "sandboxed");
      assert.equal(statSync(config).mode & 0o777, 0o600);
    } finally { await c.close(); }
  });
});

test("request_write_access", macOnly, async (t) => {
  const dialogLog = join(tmp, "dialogs.txt");
  const lastDialog = () => readFileSync(dialogLog, "utf8").split("\n---\n").filter(Boolean).at(-1);

  await t.test("'Always allow' saves to settings and takes effect", async () => {
    const config = makeConfig();
    const target = dir("granted-always");
    const c = await connect({ config, dialog: "always", dialogLog });
    try {
      assert.equal((await run(c, { command: `touch ${target}/f` })).isError, true);
      const r = await call(c, "request_write_access", { paths: [target], reason: "Run npm install for the demo." });
      assert.match(r.text, /saved it to their settings/);
      assert.match(lastDialog(), /Run npm install for the demo/);
      assert.match(lastDialog(), /granted-always/);
      const saved = readFileSync(config, "utf8");
      assert.match(saved, /# my own comment/, "the user's comments survive");
      assert.ok(parse(saved).write.includes(realpathSync(target)));
      assert.match((await run(c, { command: `touch ${target}/f` })).text, /^Exit code: 0/);
    } finally { await c.close(); }
  });

  await t.test("'Allow this session' works but isn't saved", async () => {
    const config = makeConfig();
    const before = readFileSync(config, "utf8");
    const target = dir("granted-session");
    const c = await connect({ config, dialog: "session", dialogLog });
    try {
      assert.match((await call(c, "request_write_access", { paths: [target], reason: "x" })).text, /for this session/);
      assert.match((await run(c, { command: `touch ${target}/f` })).text, /^Exit code: 0/);
      assert.equal(readFileSync(config, "utf8"), before);
    } finally { await c.close(); }
  });

  await t.test("'Deny' and no answer leave it blocked", async () => {
    for (const dialog of ["deny", "timeout"]) {
      const target = dir(`denied-${dialog}`);
      const c = await connect({ config: makeConfig(), dialog, dialogLog });
      try {
        const r = await call(c, "request_write_access", { paths: [target], reason: "x" });
        assert.equal(r.isError, true);
        assert.match(r.text, dialog === "deny" ? /denied the request/ : /Nobody answered/);
        assert.equal((await run(c, { command: `touch ${target}/f` })).isError, true);
      } finally { await c.close(); }
    }
  });

  await t.test("already-allowed folders don't bother the user", async () => {
    const c = await connect({ config: makeConfig(), dialog: "deny", dialogLog });
    try {
      const before = existsSync(dialogLog) ? readFileSync(dialogLog, "utf8") : "";
      const r = await call(c, "request_write_access", { paths: [join(work, "sub")], reason: "x" });
      assert.match(r.text, /Already allowed/);
      assert.equal(existsSync(dialogLog) ? readFileSync(dialogLog, "utf8") : "", before);
    } finally { await c.close(); }
  });

  await t.test("broad folders get a warning", async () => {
    const c = await connect({ config: makeConfig(), dialog: "deny", dialogLog });
    try {
      await call(c, "request_write_access", { paths: ["~"], reason: "x" });
      assert.match(lastDialog(), /very broad location/);
    } finally { await c.close(); }
  });

  await t.test("requests are logged", async () => {
    const entries = readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const answers = entries.filter((e) => e.event === "access_request").map((e) => e.answer);
    for (const a of ["always", "session", "deny", "timeout"]) assert.ok(answers.includes(a), a);
  });
});

test("client disconnect stops running commands and exits the server", async () => {
  const pidFile = join(work, "disconnect.pid");
  const server = spawn(serverCmd, serverArgs, { stdio: ["pipe", "pipe", "ignore"], env: { ...process.env, HOST_SHELL_MCP_CONFIG: mainConfig } });
  const exited = new Promise((r) => server.on("exit", (code) => r(code)));
  const send = (msg) => server.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");

  let stdout = "";
  server.stdout.on("data", (d) => (stdout += d));

  send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "1" } } });
  send({ method: "notifications/initialized" });
  server.stdin.write("this is not json\n"); // must be ignored, not fatal
  send({ id: 2, method: "tools/call", params: { name: "run_command", arguments: { command: `echo $$ > ${pidFile}; sleep 300` } } });
  await sleep(1000);
  const pid = Number(readFileSync(pidFile, "utf8"));
  assert.equal(isAlive(pid), true);

  server.stdin.end(); // client goes away
  assert.equal(await exited, 0);
  assert.equal(isAlive(pid), false, "running command should be killed");

  // stdout must contain only JSON-RPC messages.
  for (const line of stdout.trim().split("\n")) assert.equal(JSON.parse(line).jsonrpc, "2.0");
});
