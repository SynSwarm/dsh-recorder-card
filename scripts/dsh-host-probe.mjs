import assert from "node:assert/strict";
import { writeFile, access, readFile, unlink } from "node:fs/promises";
import { resolve, join } from "node:path";
export const inject = ["tools", "skills", "pluginManager"];
let started = false;
export function apply(ctx, config) {
  if (started) return;
  started = true;
  setImmediate(() => void validate(ctx, config).catch(error => { console.error(error); process.exit(1); }));
}
async function validate(ctx, config) {
  // This probe intentionally toggles one bundle and starts a synthetic process.
  // Refuse a normal user profile: both configuration and environment must point
  // to the dedicated test home, with the caller-created marker present.
  const home = resolve(config.profileHome);
  if (resolve(process.env.DSH_HOME || ".") !== home) throw new Error("DSH_HOME must match the isolated test home");
  await access(join(home, ".recorder-test-profile"));
  const report = { runtime: config.runtimeVersion, node: process.versions.node, checks: [] };
  let managedRow;
  try {
    const initialRows = await ctx.pluginManager.listPlugins();
    const initialRow = initialRows.find(row => row.moduleName === "dsh-recorder-card");
    if (initialRow) report.initialEnable = await ctx.pluginManager.setPluginEnabled(initialRow.entryId, true);
    const names = () => ctx.tools.schemas().filter(t => t.name.startsWith("recorder_")).map(t => t.name);
    for (let attempt = 0; names().length !== 6 && attempt < 50; attempt++) await new Promise(r => setTimeout(r, 100));
    assert.equal(names().length, 6);
    report.checks.push("six tools registered");
    const skill = await ctx.skills.get("recorder-card-bringup");
    assert.ok(skill.content.includes("AI recorder card"));
    await access(`${skill.resourceBase.path}/references/runtime.md`);
    report.checks.push("skill body and runtime reference readable");
    const result = await ctx.tools.execute({ callId: "recorder-probe", name: "recorder_status", arguments: {}, signal: new AbortController().signal });
    assert.equal(result.isError, true);
    report.errorCode = result.error.info?.code;
    assert.equal(report.errorCode, "RECORDER_CONFIG_OR_ARGUMENT");
    report.checks.push("missing configuration fails before device access");
    const rows = await ctx.pluginManager.listPlugins();
    const row = rows.find(row => row.moduleName === "dsh-recorder-card");
    assert.ok(row);
    report.row = row;
    managedRow = row;
    const marker = join(home, "fixture-cli", "started.txt");
    await unlink(marker).catch(error => { if (error.code !== "ENOENT") throw error; });
    const active = ctx.tools.execute({ callId: "recorder-probe-active", name: "recorder_transcribe", arguments: { file: "synthetic-unused.wav" }, signal: new AbortController().signal });
    let childPid;
    for (let attempt = 0; attempt < 50; attempt++) {
      try { childPid = Number(await readFile(marker, "utf8")); break; }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(Number.isInteger(childPid) && childPid > 0);
    report.disable = await ctx.pluginManager.setPluginEnabled(row.entryId, false);
    assert.equal(report.disable.application, "applied");
    const cancelled = await active;
    assert.equal(cancelled.isError, true);
    assert.equal(cancelled.error.info?.code, "RECORDER_ABORTED");
    assert.throws(() => process.kill(childPid, 0), { code: "ESRCH" });
    report.checks.push("plugin disable terminated synthetic CLI child");
    assert.equal(names().length, 0);
    assert.equal(await ctx.skills.get("recorder-card-bringup"), undefined);
    report.checks.push("unload removes tools and skill");
    report.enable = await ctx.pluginManager.setPluginEnabled(row.entryId, true);
    assert.equal(report.enable.application, "applied");
    assert.equal(names().length, 6);
    report.checks.push("reload has no duplicate tools");
    report.passed = true;
  } catch (error) {
    report.passed = false;
    report.error = String(error);
  } finally {
    if (!report.passed && managedRow) {
      try { report.failureCleanup = await ctx.pluginManager.setPluginEnabled(managedRow.entryId, false); }
      catch (error) { report.cleanupError = String(error); }
    }
    await writeFile(join(home, "probe-result.json"), JSON.stringify(report, null, 2));
    setImmediate(() => process.exit(report.passed ? 0 : 1));
  }
}
