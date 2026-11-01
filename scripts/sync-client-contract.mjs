// Copy the dependency-free shared factory; no compiler or runtime bundler needed.
import { readFile, writeFile } from "node:fs/promises";
import { createRecorderContract } from "../runtime/remote-contract.js";
const url = new URL("../client.js", import.meta.url);
const source = (await readFile(url, "utf8")).replaceAll("\r\n", "\n");
for (const marker of ["// BEGIN REMOTE CONTRACT", "// END REMOTE CONTRACT"]) {
  if (source.split(marker).length !== 2) throw new Error(`Expected exactly one ${marker}`);
}
const updated = source.replace(/\/\/ BEGIN REMOTE CONTRACT[\s\S]*?\/\/ END REMOTE CONTRACT/,
  `// BEGIN REMOTE CONTRACT\n${createRecorderContract.toString().replaceAll("\r\n", "\n")}\n// END REMOTE CONTRACT`);
if (process.argv.includes("--check")) {
  if (source !== updated) throw new Error("Client contract drift: run npm run sync:client");
} else await writeFile(url, updated);
