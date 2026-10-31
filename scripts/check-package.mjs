import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const npm = process.env.npm_execpath;
assert.ok(npm, "Run this check with npm run check:package");
const result = spawnSync(process.execPath, [npm, "pack", "--dry-run", "--json", "--ignore-scripts",
  "--cache", resolve(root, ".cache/npm")], { cwd: root, encoding: "utf8", timeout: 30_000 });
if (result.error) throw result.error;
assert.equal(result.status, 0, result.stderr || result.stdout);
const [pack] = JSON.parse(result.stdout);
const included = new Set(pack.files.map((file) => file.path));
const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
for (const path of [manifest.exports["."], manifest.exports["./client"], manifest.dsh.bundle.patch,
  "skill/SKILL.md", "LICENSE", "vendor/recorder-protocol.js", "vendor/LICENSE"]) {
  assert.ok(included.has(path.replace(/^\.\//, "")), `Missing package entry: ${path}`);
}
for (const path of included) {
  assert.ok(!/^(?:archive|tests|scripts|docs|\.cursor|\.git|\.cache)\//.test(path), `Unexpected package content: ${path}`);
  assert.ok(!/(?:^|\/)(?:\.env(?:\..*)?|\.qs668-device)$/.test(path), `Private data in package: ${path}`);
}

// Full MIT text and NextProto copyright checked against upstream main/LICENSE
// on 2026-10-31 (see docs/architecture.md). Ignore formatting-only whitespace.
// This digest pins the notice, not the provenance revision of the protocol code.
const notice = readFileSync(resolve(root, "vendor/LICENSE"), "utf8");
assert.equal(createHash("sha256").update(notice.replace(/\s+/g, " ").trim()).digest("hex"),
  "8bd8c6dd320416f73e99e332595fe8946cab34edd05e555e570e1b80baf23173",
  "Upstream license text changed or incomplete: verify the full copyright and permission notice");
for (const [path, licensePath] of [["vendor/recorder-protocol.js", "./LICENSE"], ["client.js", "vendor/LICENSE"]]) {
  const header = readFileSync(resolve(root, path), "utf8").split(/\r?\n/).slice(0, 15).join("\n");
  assert.ok(header.includes("Copyright (c) 2026 NextProto") &&
    header.includes(`Full upstream copyright and permission notice: ${licensePath}`),
    `Missing upstream attribution or license reference: ${path}`);
}

// Follow every local Markdown reference from the shipped Skill, including
// nested references. This catches links that work in a checkout but not npm.
const pending = ["skill/SKILL.md"];
const visited = new Set();
while (pending.length) {
  const path = pending.pop();
  if (visited.has(path)) continue;
  visited.add(path);
  const text = readFileSync(resolve(root, path), "utf8");
  for (const [, href] of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    if (/^https?:/.test(href)) continue;
    const target = resolve(root, dirname(path), href.split("#")[0]);
    const rel = relative(root, target);
    assert.ok(!isAbsolute(rel) && rel !== ".." && !rel.startsWith("..\\") && !rel.startsWith("../"),
      `Skill reference leaves the package: ${href}`);
    const normalized = rel.replaceAll("\\", "/");
    assert.ok(included.has(normalized), `Unshipped Skill reference: ${path} -> ${href}`);
    if (normalized.endsWith(".md")) pending.push(normalized);
  }
}
console.log(`Package check passed: ${included.size} files; upstream license/attribution and bundled Skill references verified.`);
console.log("Dry-run only: no publication or DSH installation performed.");
