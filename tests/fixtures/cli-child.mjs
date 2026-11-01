import { writeFileSync, openSync, closeSync, unlinkSync } from "node:fs";
import { spawn } from "node:child_process";

const [mode, target] = process.argv.slice(2);
if (mode === "success") {
  const bytes = Buffer.from("测试 recording");
  process.stdout.write(bytes.subarray(0, 2));
  setTimeout(() => process.stdout.write(bytes.subarray(2)), 5);
} else if (mode === "fail") {
  process.stderr.write("unconfirmed response");
  process.exitCode = 7;
} else if (mode === "flood") {
  setInterval(() => process.stdout.write(Buffer.alloc(4096, 120)), 1);
} else if (mode === "hold") {
  if (target) writeFileSync(target, String(process.pid));
  setInterval(() => {}, 1000);
} else if (mode === "tree") {
  const child = spawn(process.execPath, [process.argv[1], "hold", `${target}.child`], { windowsHide: true });
  writeFileSync(target, JSON.stringify({ parent: process.pid, child: child.pid }));
  setInterval(() => {}, 1000);
} else if (mode === "exclusive") {
  const handle = openSync(target, "wx"); // A concurrent invocation must fail.
  setTimeout(() => {
    closeSync(handle);
    unlinkSync(target);
    process.stdout.write("completed");
  }, 40);
} else {
  throw new Error("Unknown test mode");
}
