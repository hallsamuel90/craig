// Run under each runtime with an external wall-clock timeout: a native call may block.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pty = require(process.argv[2]);
console.log("addon-loaded");
const terminal = pty.spawn("/bin/sh", ["-c", "printf 'pty-probe-ready\\n'; read line; printf 'pty-probe-input:%s\\n' \"$line\""], {
  cwd: process.cwd(), env: process.env, cols: 80, rows: 24,
});
console.log("spawn-returned");
let output = "";
terminal.onData((data) => {
  process.stdout.write(data);
  output += data;
  if (data.includes("pty-probe-ready")) terminal.write("hello\r");
});
terminal.onExit(({ exitCode }) => {
  console.log(JSON.stringify({ exitCode, receivedInput: output.includes("pty-probe-input:hello") }));
  process.exit(output.includes("pty-probe-input:hello") && exitCode === 0 ? 0 : 1);
});
setTimeout(() => { terminal.kill(); process.exit(2); }, 5000);
