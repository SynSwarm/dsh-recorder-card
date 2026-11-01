// Host half of the AI recorder card bundle.
//
// Confident pieces (mirror @deepseek-ai/dsh-skill-office):
//   1. Registers the bundled `recorder-card-bringup` skill as a skill provider, so the
//      SKILL.md ships with the bundle and reaches the agent catalog on demand.
//
// Host CLI and tools (runtime acceptance remains separate from implementation):
//   2. A `recorder` service that wraps the upstream Python CLI (tools/qs668-bringup.py,
//      tools/qs668-transcribe.py) via Node child_process.
//   3. Six Agent tools over that service. Client Remote remains unimplemented.
//
// The pinned upstream CLI handles the BLE
// file-assembly rules (2-2 single 36-byte GATT write, AE22/AE23 separate framing,
// filename extension recovery, no on-card delete). Prefer it over a Node BLE port
// for the first integration. The bundled adapter requires confirmed list/record
// responses and cleans up partially initialized sessions; see runtime/recorder_cli.py.

import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRecorderService } from "./runtime/host-cli.js";
import { fileURLToPath } from "node:url";
import { registerRecorderTools } from "./runtime/tools.js";
import z from "@deepseek-ai/schemastery";

export const name = "recorder-card";
export const inject = ["skills", "tools"];

// Configuration uses the same Schemastery contract as DSH 0.2.0-rc.2 plugins.
export const Config = z.object({
  python: z.string().default("python").description("Python interpreter on the DSH Host."),
  repoRoot: z.string().description("Absolute external CLI checkout; defaults to Host working directory."),
  deviceAddress: z.string().description("Local device identifier; required except for scan/transcribe."),
  outDir: z.string().default("archive/audio").description("Import directory, relative to repoRoot or absolute."),
  cliTimeoutMs: z.number().min(1).max(2147483647).step(1).default(190000).description("CLI execution timeout in milliseconds, excluding queue time."),
});

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

  // 2) Service + tools.
  //
  // Tool registration mirrors @deepseek-ai/dsh-plugin-manager/tools. The
  // Client->Host Remote (see dsh-experimental-client-ui-voice-input) and the
  // DSH speech-to-text backend (transcriptionProvider "dsh"|"local") remain TODO.
  const service = createRecorderService(config);
  ctx.effect(() => () => service.dispose(), "recorder-card: CLI cancellation");
  registerRecorderTools(ctx, service);

  // Keep a handle for later wiring; the plugin stays active.
  return service;
}
