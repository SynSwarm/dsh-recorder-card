import test from "node:test";
import assert from "node:assert/strict";
import { readFile, access, mkdtemp, rm } from "node:fs/promises";
import { resolve, isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { Context } from "@deepseek-ai/cordis";
import * as host from "../index.js";

const root = fileURLToPath(new URL("../", import.meta.url));

// Capture the provider contract only. Cordis disposal requires a real Host;
// this fixture must not be reported as an unload/reload integration test.
async function providerFixture(t) {
  const providers = [];
  const ctx = new Context();
  ctx.provide("tools", { register() {} });
  ctx.provide("skills", { registerProvider(create) { providers.push(create()); } });
  const dataDir = await mkdtemp(join(tmpdir(), "recorder-host-settings-"));
  const mounted = ctx.plugin(host, { dataDir });
  t.after(async () => { await mounted.dispose(); await rm(dataDir, { recursive: true, force: true }); });
  await mounted;
  assert.equal(providers.length, 1);
  return providers[0];
}

test("Host advertises the bundled Skill with metadata matching its frontmatter", async (t) => {
  const provider = await providerFixture(t);
  assert.deepEqual(host.inject, ["skills", "tools"]);
  assert.equal(provider.name, "recorder-card");
  const candidates = await provider.list();
  assert.equal(candidates.length, 1);
  const [candidate] = candidates;
  const raw = await readFile(candidate.locator, "utf8");
  assert.equal(candidate.name, /^name: (.+)$/m.exec(raw)[1].trim());
  assert.equal(candidate.description, /^description: (.+)$/m.exec(raw)[1].trim());
  assert.deepEqual(candidate.invocation, { modelInvocable: true, userInvocable: true });
  assert.equal(candidate.source, "bundled");
  assert.equal(candidate.rank, 600);
  assert.ok(isAbsolute(candidate.resourceBase.path));
  assert.equal(candidate.resourceBase.kind, "directory");
});

test("Skill definition contains its body without discovery-only fields", async (t) => {
  const provider = await providerFixture(t);
  const [candidate] = await provider.list();
  const definition = await provider.get(candidate);
  assert.equal(definition.name, candidate.name);
  assert.match(definition.content, /^# AI recorder card bring-up/);
  assert.equal("rank" in definition, false);
  assert.equal("locator" in definition, false);
  assert.equal(definition.content.startsWith("---"), false);
});

test("Skill loading honors cancellation", async (t) => {
  const provider = await providerFixture(t);
  const [candidate] = await provider.list();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(provider.get(candidate, { signal: controller.signal }), { name: "AbortError" });
});

test("Skill provider rejects foreign names and filesystem locators", async (t) => {
  const provider = await providerFixture(t);
  const [candidate] = await provider.list();
  assert.equal(await provider.get({ ...candidate, name: "another-skill" }), undefined);
  assert.equal(await provider.get({ ...candidate, locator: resolve(root, "package.json") }), undefined);
});

test("Skill local reference files resolve relative to the resource base, excluding fragments", async (t) => {
  const provider = await providerFixture(t);
  const [candidate] = await provider.list();
  const definition = await provider.get(candidate);
  const links = [...definition.content.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)]
    .map((match) => match[1]).filter((target) => !/^https?:/.test(target));
  assert.ok(links.length > 0);
  for (const target of links) {
    // A Markdown fragment identifies a section, not part of the filename.
    const path = target.split("#")[0];
    await access(path ? resolve(candidate.resourceBase.path, path) : candidate.locator);
  }
});

test("Host, Client module and manifest agree on loadable entry points", async () => {
  const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  for (const key of [".", "./client", "./package.json"]) await access(resolve(root, manifest.exports[key]));
  await access(resolve(root, manifest.dsh.bundle.patch));
  let module;
  vm.runInNewContext(await readFile(resolve(root, "client.js"), "utf8"), {
    window: { __ModuleLoader__: { load(value) { module = value; } } },
  });
  assert.equal(module.id, manifest.name);
  assert.equal(typeof module.factory, "function");
  assert.equal(typeof host.apply, "function");
});
