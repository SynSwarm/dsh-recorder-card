import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import * as cordis from "@deepseek-ai/cordis";
import Typert from "@deepseek-ai/dsh-typert-registry";
import Gateway from "@deepseek-ai/dsh-api-gateway";
import Controller from "../../runtime/remote.js";
import { TYPERT } from "../../typert.host.js";
import { TYPERT_REMOTE } from "../../typert.remote-client.js";

const require = createRequire(import.meta.url);
export function clientModule(path, modules = {}) {
  let result;
  vm.runInNewContext(readFileSync(path, "utf8"), {
    window: { __ModuleLoader__: { load(module) {
      result = module.factory(name => {
        if (name === "@deepseek-ai/cordis") return cordis;
        if (Object.hasOwn(modules, name)) return modules[name];
        throw new Error(`Unexpected browser dependency ${name}`);
      });
    } } },
    AbortController, AbortSignal, crypto: globalThis.crypto, URL, TextEncoder, TextDecoder,
    setTimeout, clearTimeout, setInterval, clearInterval, console,
  });
  return result;
}

export async function remoteRuntime(t, service, mountContract = true) {
  const host = new cordis.Context();
  const client = new cordis.Context();
  const mounts = [];
  t.after(async () => { for (const fiber of mounts.reverse()) await fiber.dispose(); });
  async function mount(ctx, plugin, config) {
    const fiber = ctx.plugin(plugin, config); mounts.push(fiber); await fiber; return fiber;
  }
  await mount(host, Typert);
  await mount(host, Gateway);
  await mount(host, { inject: ["typert"], apply(ctx) { ctx.provide("recorder", service); ctx.typert.register(TYPERT); } });
  const controller = await mount(host, Controller);
  await mount(client, Typert);
  const calls = [];
  // Real official Gateway on both sides, JSON carrier in process (no HTTP/BLE).
  await mount(client, { apply(ctx) { ctx.provide("connection", {
    registerGenerationSource: () => () => {}, start: () => ({ stop() {} }),
    generation: { getSnapshot: () => undefined, subscribe: () => () => {} },
    rpc: { open() { throw new Error("No streams in recorder contract"); },
      async call(path, endpoint, payload, signal) {
        assert.equal(path, "/api"); calls.push(endpoint);
        return host.typertGateway.dispatchRpc(endpoint, structuredClone(payload), signal);
      },
    },
  }); } });
  await mount(client, clientModule(require.resolve("@deepseek-ai/dsh-api-gateway/client")));
  let disposeRemote;
  const consumer = mountContract && await mount(client, { inject: ["remote"], async apply(ctx) { disposeRemote = await ctx.remote.$mount(TYPERT_REMOTE); } });
  return { host, client, calls, controller, consumer, mount, disposeRemote: () => disposeRemote() };
}
