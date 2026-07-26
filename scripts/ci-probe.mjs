// CI probe: boot the built server over stdio with NO wallet configured and
// assert it completes the MCP handshake and lists every tool.
//
// This is the property directory listings and MCP clients depend on: the
// process must start and answer introspection without credentials. A regression
// here (e.g. loading the wallet eagerly again) makes the server look crashed to
// every client that browses it.

import { spawn } from "node:child_process";

const EXPECTED_TOOLS = 15;
const TIMEOUT_MS = 30_000;

const child = spawn("node", ["dist/cli.js"], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, SOLINKIFY_WALLET_PATH: "", SOLINKIFY_WALLET_BS58: "" },
});

let stdout = "";
let stderr = "";
child.stdout.on("data", (d) => (stdout += d.toString()));
child.stderr.on("data", (d) => (stderr += d.toString()));

const send = (msg) => child.stdin.write(JSON.stringify(msg) + "\n");

send({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "ci-probe", version: "1.0.0" },
  },
});

const deadline = Date.now() + TIMEOUT_MS;
let toolsRequested = false;
let result = null;

while (Date.now() < deadline && result === null) {
  await new Promise((r) => setTimeout(r, 250));
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue; // partial line
    }
    if (msg.id === 1 && !toolsRequested) {
      toolsRequested = true;
      send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
      send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    }
    if (msg.id === 2) result = msg;
  }
}

child.kill();

if (!result) {
  console.error("FAIL: no tools/list response within timeout");
  console.error("stdout:", stdout.slice(0, 500));
  console.error("stderr:", stderr.slice(0, 500));
  process.exit(1);
}

const tools = result.result?.tools ?? [];
console.log(`tools listed: ${tools.length}`);
for (const t of tools) console.log(` - ${t.name}`);

if (tools.length !== EXPECTED_TOOLS) {
  console.error(`FAIL: expected ${EXPECTED_TOOLS} tools, got ${tools.length}`);
  process.exit(1);
}
const undescribed = tools.filter((t) => !t.description || !t.inputSchema);
if (undescribed.length > 0) {
  console.error(`FAIL: tools missing description/inputSchema: ${undescribed.map((t) => t.name).join(", ")}`);
  process.exit(1);
}
console.log("OK: server boots with no wallet and lists all tools.");
