// Host half of the AI recorder card bundle.
//
// Confident pieces (mirror @deepseek-ai/dsh-skill-office):
//   1. Registers the bundled `recorder-card-bringup` skill as a skill provider, so the
//      SKILL.md ships with the bundle and reaches the agent catalog on demand.
//
// Host CLI and tools (runtime acceptance remains separate from implementation):
//   2. A `recorder` service that wraps the upstream Python CLI (tools/qs668-bringup.py,
//      tools/qs668-transcribe.py, bundled under vendor/upstream) via Node child_process.
//   3. Six Agent tools and Client Remote methods over the same injectable service.
//
// The pinned upstream CLI handles the BLE
// file-assembly rules (2-2 single 36-byte GATT write, AE22/AE23 separate framing,
// filename extension recovery, no on-card delete). Prefer it over a Node BLE port
// for the first integration. The bundled adapter requires confirmed list/record
// responses and cleans up partially initialized sessions; see runtime/recorder_cli.py.

import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import RecorderService from "./runtime/service.js";
import RecorderController from "./runtime/remote.js";
import { fileURLToPath } from "node:url";
import { registerRecorderTools } from "./runtime/tools.js";
import z from "@deepseek-ai/schemastery";

export const name = "recorder-card";
export const inject = ["skills", "tools"];

// Configuration uses the same Schemastery contract as DSH 0.2.0-rc.2 plugins.
// Schemastery fields are optional unless .required() is used. The service supplies
// a bundled repoRoot fallback and validates deviceAddress only for device-specific calls.
export const Config = z.object({
  python: z.string().default("python").description("Python interpreter on the DSH Host."),
  repoRoot: z.string().description("Optional developer override for pinned CLI sources; omitted or empty uses bundled vendor/upstream."),
  deviceAddress: z.string().description("Initial device identifier. The card's saved selection overrides this fallback immediately; scan and transcribe need no address."),
  dataDir: z.string().description("Writable data directory; defaults to ~/.dsh-recorder-card on the Host. Contains audio, corpus, device cache and optional .env."),
  outDir: z.string().default("archive/audio").description("Import directory, relative to dataDir or absolute; never inside CLI sources."),
  cliTimeoutMs: z.number().min(1).max(2147483647).step(1).default(190000).description("CLI execution timeout in milliseconds, excluding queue time."),
  transcriptionProvider: z.union(["dsh", "doubao"]).default("dsh").description("Use DSH speechToText. Only absence of that service falls back to Doubao cloud ASR; readiness/inference failures never fall back."),
});

const SKILL_PATH = fileURLToPath(new URL("./skill/SKILL.md", import.meta.url));
// Keep the skill description in sync with skill/SKILL.md frontmatter.
const SKILL_NAME = "recorder-card-bringup";
const SKILL_DESCRIPTION =
  "Guide AI recorder card (开源 AI 录音卡) connection, recording, import, and transcription in DSH, checking available tools and Python prerequisites first.";
// Mirrors BUNDLED_SKILL_RANK exported by @deepseek-ai/dsh-skill.
const BUNDLED_SKILL_RANK = 600;

// Strip the frontmatter; the catalog description is maintained above.
function parseSkill(raw) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw);
  if (!m) throw new Error(`recorder-card: ${SKILL_PATH} has no YAML frontmatter`);
  return { frontmatter: m[1], body: raw.slice(m[0].length).trim() };
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

  // One configured instance owns both Agent and Remote operations. The Remote
  // child waits for Typert; headless tools remain usable without a Gateway.
  const service = new RecorderService(ctx, config);
  registerRecorderTools(ctx, service);
  ctx.plugin(RecorderController);
  return service;
}
