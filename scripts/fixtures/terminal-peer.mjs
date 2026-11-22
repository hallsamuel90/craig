// Deterministic real-PTY peer. No agents, credentials, model calls or network.
import { createHash } from "node:crypto";
import { once } from "node:events";
import { setImmediate as nextTurn } from "node:timers/promises";

process.stdin.setRawMode(true);
let input = Buffer.alloc(0);
let capture;
let commands = Promise.resolve();
let releaseBurst;
const write = async (data) => { if (!process.stdout.write(data)) await once(process.stdout, "drain"); };
const line = (text) => write(`\r\n${text}\r\n`);

process.stdin.on("data", (data) => {
  input = Buffer.concat([input, data]);
  for (;;) {
    if (capture) {
      if (input.length < capture.length) return;
      const received = input.subarray(0, capture.length);
      input = input.subarray(capture.length);
      void line(`${capture.id}:CAPTURE:${received.toString("hex")}`);
      capture = undefined;
      continue;
    }
    if (input[0] === 27) {
      const match = new RegExp(`^${String.fromCharCode(27)}\\[\\d+;\\d+R`).exec(input.toString("utf8"));
      if (!match) return;
      input = input.subarray(Buffer.byteLength(match[0]));
      void line(`QUERY:${Buffer.from(match[0]).toString("hex")}`);
      continue;
    }
    const end = input.indexOf(10);
    if (end < 0) return;
    const command = JSON.parse(input.subarray(0, end).toString("utf8"));
    input = input.subarray(end + 1);
    if (command.type === "go") { releaseBurst?.(); continue; }
    commands = commands.then(() => run(command)).catch((error) => { process.stderr.write(String(error)); process.exit(3); });
  }
});

async function run(command) {
  if (command.type === "query") {
    if (command.fragmented) {
      await write("\x1b[3;7H\x1b[");
      await nextTurn();
      await write("6n");
    } else await write("\x1b[3;7H\x1b[6n");
  } else if (command.type === "capture") {
    capture = { id: command.id, length: command.length };
    await write(command.modes ?? "");
    await line(`${command.id}:READY`);
  } else if (command.type === "unicode") {
    for (const byte of Buffer.from("fragmented 界 e\u0301 👩‍💻 done")) { await write(Buffer.of(byte)); await nextTurn(); }
    await line(`${command.id}:UNICODE_DONE`);
  } else if (command.type === "burst") {
    const gate = new Promise((resolveGate) => { releaseBurst = resolveGate; });
    await line(`${command.id}:BEGIN`);
    await gate;
    releaseBurst = undefined;
    const rows = Array.from({ length: 128 }, (_, i) => `\x1b[32m${command.id}:line-${i}\x1b[0m\r\n`).join("");
    for (let i = 0; i < command.batches; i++) { await write(rows); await nextTurn(); }
    await write("\x1b[r\x1b[H\x1b[2J");
    await write(`\x1b[32m${command.id}:BURST_DONE\x1b[0m\r\n`);
    await write("\x1b]8;;https://example.com/preview\x1b\\preview\x1b]8;;\x07\r\n");
    await line(`SIZE:${process.stdout.columns}x${process.stdout.rows}`);
  } else if (command.type === "identity") {
    await line(`${command.id}:PID:${process.pid}`);
    await line(`${command.id}:CWD_HASH:${createHash("sha256").update(process.cwd()).digest("hex")}`);
  } else throw new Error(`Unknown peer command ${command.type}`);
}

process.on("SIGWINCH", () => { void line(`SIZE:${process.stdout.columns}x${process.stdout.rows}`); });
await line(`PEER_READY:${process.pid}`);
