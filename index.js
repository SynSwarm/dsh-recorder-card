// Host half of the AI recorder card bundle.
//
// Confident pieces (mirror @deepseek-ai/dsh-skill-office):
//   1. Registers the bundled `recorder-card-bringup` skill as a skill provider, so the
//      SKILL.md ships with the bundle and reaches the agent catalog on demand.
//
// Skeleton pieces (exact registration APIs MUST be confirmed in the target
// profile with `cordis_inspect_query` before relying on them):
//   2. A `recorder` service that wraps the upstream Python CLI (tools/qs668-bringup.py,
//      tools/qs668-transcribe.py) via Node child_process.
//   3. Agent tools over that service, and the Host->Client Remote the card UI uses.
//
// The upstream CLI is the battle-tested path: it already handles the tricky BLE
// file-assembly rules (2-2 single 36-byte GATT write, AE22/AE23 separate framing,
// filename extension recovery, no on-card delete). Prefer it over a Node BLE port
// for the first integration.

import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const name = "recorder-card";
export const inject = ["skills"]; // plus shell/remote/tools once confirmed

const SKILL_PATH = fileURLToPath(new URL("./skill/SKILL.md", import.meta.url));
// Keep the skill description in sync with skill/SKILL.md frontmatter.
const SKILL_NAME = "recorder-card-bringup";
const SKILL_DESCRIPTION =
  "Guide AI recorder card (开源 AI 录音卡) connection, recording, import, and transcription in DSH, checking available tools and external CLI prerequisites first.";
// Mirrors BUNDLED_SKILL_RANK exported by @deepseek-ai/dsh-skill.
const BUNDLED_SKILL_RANK = 600;

// Strip the frontmatter; the catalog description is maintained above.
function parseSkill(raw) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw);
  if (!m) throw new Error(`recorder-card: ${SKILL_PATH} has no YAML frontmatter`);
  return { frontmatter: m[1], body: raw.slice(m[0].length).trim() };
}

// Thin wrapper over the upstream Python CLI. Each method maps 1:1 to a CLI verb.
// spawn is fine inside the Host (Electron main / Node); the workspace sandbox
// pipe restriction does not apply to plugin code running in the Host process.
function runCli(python, script, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, [script, ...args], { cwd, shell: false });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ code, out, err });
      else reject(new Error(`recorder CLI exited ${code}: ${err || out}`));
    });
  });
}

function recorderService(ctx, config) {
  const python = config.python ?? "python";
  const repoRoot = config.repoRoot ?? process.cwd();
  const bringup = `${repoRoot}/tools/qs668-bringup.py`;
  const transcribe = `${repoRoot}/tools/qs668-transcribe.py`;
  const address = config.deviceAddress;

  return {
    async scan() {
      return runCli(python, bringup, ["--scan"], repoRoot);
    },
    async status() {
      return runCli(python, bringup, ["--address", address, "--status"], repoRoot);
    },
    async list() {
      return runCli(python, bringup, ["--address", address, "--list"], repoRoot);
    },
    async importFirst(outDir = config.outDir ?? "archive/audio", transcribeFlag = false) {
      const args = ["--address", address, "--import-first", "--out", outDir];
      if (transcribeFlag) args.push("--transcribe");
      return runCli(python, bringup, args, repoRoot);
    },
    async record(action) {
      return runCli(python, bringup, ["--address", address, "--record", action], repoRoot);
    },
    async recordState() {
      return runCli(python, bringup, ["--address", address, "--record-state"], repoRoot);
    },
    // Transcription is provider-pluggable (see plan section 4):
    //   doubao/openai -> upstream qs668-transcribe.py (env QS668_ASR_PROVIDER)
    //   dsh/local     -> inject DSH speech-to-text / sensevoice (TODO)
    async transcribe(file, { force = false } = {}) {
      const args = [file];
      if (force) args.push("--force");
      return runCli(python, transcribe, args, repoRoot);
    },
  };
}

export function apply(ctx, config = {}) {
  // 1) Register the bundled skill provider (mirrors dsh-skill-office).
  const raw = readFileSync(SKILL_PATH, "utf8");
  parseSkill(raw);
  const candidate = {
    name: SKILL_NAME,
    description: SKILL_DESCRIPTION,
    invocation: { modelInvocable: true, userInvocable: true },
    provider: "recorder-card",
    source: "bundled",
    rank: BUNDLED_SKILL_RANK,
    resourceBase: { kind: "directory", path: fileURLToPath(new URL("./skill/", import.meta.url)) },
    locator: SKILL_PATH,
  };
  ctx.skills.registerProvider(() => ({
    name: "recorder-card",
    list: () => Promise.resolve([candidate]),
    async get(c, options = {}) {
      // This provider owns one bundled file, not arbitrary filesystem locators.
      if (c.name !== candidate.name || c.locator !== SKILL_PATH) return undefined;
      const raw = await readFile(SKILL_PATH, { encoding: "utf8", signal: options.signal });
      const { rank: _rank, locator: _locator, ...summary } = candidate;
      return { ...summary, content: parseSkill(raw).body };
    },
  }));

  // 2) Service + tools + Remote (skeleton).
  //
  // TODO (confirm exact APIs with cordis_inspect_query Service / Tool / Remote):
  //   - Expose recorderService to the agent as tools (scan/status/list/import/
  //     record/transcribe) and to the Client card via a session command or a
  //     Typert Remote (see @deepseek-ai/dsh-experimental-client-ui-voice-input
  //     for the ctx.remote.$mount pattern).
  //   - For `transcriptionProvider: "dsh"|"local"`, inject the DSH speech
  //     service here instead of shelling out.
  const service = recorderService(ctx, config);
  // dsh-skill 0.2.0-rc.2 registerProvider owns its Cordis effect and disposal.

  // Keep a handle for later wiring; the plugin stays active.
  return service;
}
