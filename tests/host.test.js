import test from "node:test";
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import { resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import * as host from "../index.js";

const root = fileURLToPath(new URL("../", import.meta.url));

// Capture the provider contract only. Cordis disposal requires a real Host;
// this fixture must not be reported as an unload/reload integration test.
function providerFixture() {
  const providers = [];
  host.apply({ tools: { register() {} }, effect(create) { create(); }, skills: { registerProvider(create) { providers.push(create()); } } });
  assert.equal(providers.length, 1);
  return providers[0];
}

test("Host advertises the bundled Skill with metadata matching its frontmatter", async () => {
  const provider = providerFixture();
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

test("Skill definition contains its body without discovery-only fields", async () => {
  const provider = providerFixture();
  const [candidate] = await provider.list();
  const definition = await provider.get(candidate);
  assert.equal(definition.name, candidate.name);
  assert.match(definition.content, /^# AI recorder card bring-up/);
  assert.equal("rank" in definition, false);
  assert.equal("locator" in definition, false);
  assert.equal(definition.content.startsWith("---"), false);
});

test("Skill loading honors cancellation", async () => {
  const provider = providerFixture();
  const [candidate] = await provider.list();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(provider.get(candidate, { signal: controller.signal }), { name: "AbortError" });
});

test("Skill provider rejects foreign names and filesystem locators", async () => {
  const provider = providerFixture();
  const [candidate] = await provider.list();
  assert.equal(await provider.get({ ...candidate, name: "another-skill" }), undefined);
  assert.equal(await provider.get({ ...candidate, locator: resolve(root, "package.json") }), undefined);
});

test("Skill local references resolve relative to the advertised resource base", async () => {
  const provider = providerFixture();
  const [candidate] = await provider.list();
  const definition = await provider.get(candidate);
  const links = [...definition.content.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)]
    .map((match) => match[1]).filter((target) => !/^https?:/.test(target));
  assert.ok(links.length > 0);
  for (const target of links) await access(resolve(candidate.resourceBase.path, target));
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
