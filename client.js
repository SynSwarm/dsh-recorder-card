// DSH Client: BLE belongs to the Host. No Web Bluetooth or private UI imports.
window.__ModuleLoader__.load({
  id: "dsh-recorder-card",
  factory(require) {
    const React = require("react");
    const { createElement: h, useState, useRef, useEffect } = React;
    // BEGIN REMOTE CONTRACT
function createRecorderContract() {
  const fail = () => { throw new TypeError("Invalid recorder Remote value"); };
  const string = value => typeof value === "string" ? value : fail();
  const nonempty = value => string(value).trim() ? value : fail();
  const boolean = value => typeof value === "boolean" ? value : fail();
  const integer = value => Number.isSafeInteger(value) ? value : fail();
  const positive = value => integer(value) > 0 ? value : fail();
  const oneOf = (...values) => value => values.includes(value) ? value : fail();
  const optional = parse => value => value === undefined ? value : parse(value);
  const array = parse => value => Array.isArray(value) ? value.map(parse) : fail();
  const object = fields => value => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
    if (Object.keys(value).some(key => !Object.hasOwn(fields, key))) return fail();
    const result = {};
    for (const [key, parse] of Object.entries(fields)) {
      const parsed = parse(value[key]);
      if (parsed !== undefined) result[key] = parsed;
    }
    return result;
  };
  const error = object({ code: nonempty, message: string });
  const process = object({ code: integer, out: string, err: string });
  const device = object({ deviceAddress: string, source: oneOf("saved", "config", "none") });
  const transcriptFields = { provider: oneOf("dsh", "doubao"), recognizer: nonempty, path: nonempty,
    audioPath: nonempty, audioSha256: value => /^[a-f0-9]{64}$/.test(string(value)) ? value : fail(),
    reused: boolean, fallbackReason: optional(nonempty) };
  const transcript = object({ status: oneOf("succeeded"), ...transcriptFields });
  const imported = object({
    status: oneOf("succeeded", "partial"),
    import: object({ status: oneOf("succeeded"), path: nonempty, bytes: positive,
      sha256: value => /^[a-f0-9]{64}$/.test(string(value)) ? value : fail(),
      integrity: object({ status: oneOf("verified"), format: oneOf("wav-pcm"),
        channels: positive, sampleRate: positive, bitsPerSample: positive, frames: positive }),
    }),
    transcription: object({ status: oneOf("not-requested", "succeeded", "failed"),
      ...Object.fromEntries(Object.entries(transcriptFields).map(([key, parse]) => [key, optional(parse)])),
      exitCode: optional(value => value === null ? null : integer(value)), error: optional(error),
      retry: optional(object({ tool: oneOf("recorder_transcribe"), arguments: object({ file: nonempty }) })),
    }),
    cleanup: object({ status: oneOf("succeeded", "not-needed", "unconfirmed"), errors: array(error) }),
  });
  const codec = (name, parse) => ({ mode: "strict", typeSymbol: `dsh-recorder-card#${name}`,
    create: () => ({ parse }), encode: value => parse(value), decode: value => parse(value) });
  const parameter = (name, parse, acceptsUndefined = false) => ({ name, wire: name, source: "json",
    codec: codec(name, parse), ...(acceptsUndefined ? { acceptsUndefined: true } : {}) });
  const definitions = {
    scan: [], status: [], list: [],
    record: [parameter("action", oneOf("state", "start", "pause", "resume", "save"))],
    importFirst: [parameter("options", optional(object({ outDir: optional(nonempty), transcribe: optional(boolean) })), true)],
    transcribe: [parameter("file", nonempty), parameter("force", optional(boolean), true)],
    getDevice: [],
    saveDevice: [parameter("address", string)],
  };
  const descriptors = Object.entries(definitions).map(([method, parameters]) => ({
    id: `dsh-recorder-card#recorder/${method}`, service: "recorderController", namespace: "recorder", method,
    invocation: { kind: "direct" }, parameters, cancellation: { parameter: "signal" },
    result: method === "transcribe" ? codec("TranscriptResult", transcript)
      : method === "getDevice" || method === "saveDevice" ? codec("DeviceSettings", device)
      : codec(method === "importFirst" ? "ImportResult" : "ProcessResult", method === "importFirst" ? imported : process),
  }));
  return { package: "dsh-recorder-card", descriptors };
}
// END REMOTE CONTRACT
    const contribution = createRecorderContract();
    const css = `.recorder-card {color:var(--dsw-alias-label-primary);font-size:12px}
.recorder-card button {color:inherit;background:transparent;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:4px 8px;cursor:pointer}
.recorder-card button:disabled {opacity:.5;cursor:not-allowed}
.recorder-card button:hover:not(:disabled) {background:var(--dsw-alias-interactive-bg-hover-solid)}
.recorder-card .rec-icon-btn {width:32px;height:32px;border-radius:50%;padding:0;display:inline-flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-secondary);background:transparent}
.recorder-card .rec-actions {display:flex;flex-wrap:wrap;gap:6px;margin:6px 0}
.recorder-card pre {white-space:pre-wrap;overflow-wrap:anywhere;max-height:240px;overflow:auto}
.recorder-card details {margin:6px 0}`;
    function createCard(remote, lifetime) {
      return function Card() {
        const [open, setOpen] = useState(false);
        const [busy, setBusy] = useState("");
        const [output, setOutput] = useState("");
        const [failure, setFailure] = useState("");
        const [imported, setImported] = useState(null);
        const [address, setAddress] = useState("");
        const [selection, setSelection] = useState(null);
        const active = useRef(null);
        const mounted = useRef(true);
        useEffect(() => {
          mounted.current = true;
          return () => { mounted.current = false; active.current?.abort(); };
        }, []);
        async function run(label, method, ...args) {
          if (active.current || lifetime.disposed) return;
          const control = new AbortController();
          active.current = control;
          lifetime.calls.add(control);
          setBusy(label); setFailure(""); setOutput("");
          try {
            const result = await remote[method](...args, control.signal);
            if (!mounted.current || lifetime.disposed) return;
            if (!result.ok) throw result.error;
            if (control.signal.aborted) {
              setFailure("操作已取消，设备状态或连接释放未确认。请检查状态后再操作。");
              return;
            }
            if (method === "getDevice" || method === "saveDevice") {
              setSelection(result.value);
              setAddress(result.value.deviceAddress);
              setImported(null);
              setOutput(method === "saveDevice" ? "设备地址已保存并生效；无需重新加载。" : "已读取当前设备配置。");
            } else if (method === "importFirst") {
              const value = result.value;
              setImported(value);
              setOutput(`音频已保存：${value.import.path}\n完整性：已验证\n转写：${value.transcription.status}\n连接清理：${value.cleanup.status}`);
              const warnings = [value.transcription.error?.message, ...value.cleanup.errors.map(e => e.message)].filter(Boolean);
              if (value.status === "partial") setFailure(`导入部分完成：${warnings.join("；") || "请检查转写和连接清理状态。"}`);
            } else if (method === "transcribe") {
              const value = result.value;
              setOutput(`转写已${value.reused ? "复用" : "保存"}：${value.path}\n后端：${value.provider} / ${value.recognizer}`);
              if (value.fallbackReason) setFailure(`已回退豆包：${value.fallbackReason}`);
              if (imported) setImported({ ...imported, transcription: { ...value, exitCode: 0 } });
            } else {
              const value = result.value;
              setOutput(value.out || "命令已结束（没有文本输出）。");
              if (value.err) setFailure(value.err);
            }
          } catch (error) {
            if (mounted.current && !lifetime.disposed) setFailure(control.signal.aborted
              ? "操作已取消，设备状态或连接释放未确认。请检查状态后再操作。"
              : `${error.code ? `${error.code}: ` : ""}${error.message ?? error}`);
          } finally {
            lifetime.calls.delete(control);
            if (active.current === control) active.current = null;
            if (mounted.current && !lifetime.disposed) setBusy("");
          }
        }
        const button = (label, method, ...args) => h("button", { type: "button", disabled: !!busy,
          onClick: () => run(label, method, ...args) }, label);
        return h("div", { className: "recorder-card" }, h("style", null, css),
          h("button", { type: "button", className: "rec-icon-btn", title: "扫描录音卡（Host 蓝牙）", "aria-label": "扫描录音卡",
            disabled: !!busy, onClick: () => { setOpen(true); return run("正在扫描附近的录音卡…", "scan"); } },
            h("svg", { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, "aria-hidden": true },
              h("rect", { x: 9, y: 2, width: 6, height: 12, rx: 3 }), h("path", { d: "M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8" }))),
          h("button", { type: "button", disabled: !!busy,
            onClick: () => { setOpen(true); return run("读取设备配置…", "getDevice"); } }, "设置设备"),
          open && h("div", null,
            h("p", null, "使用 DSH Host 的蓝牙。扫描后，将设备标识粘贴到下方并保存；扫描不表示持续连接。"),
            h("label", null, "设备地址", h("input", { "aria-label": "设备地址", value: address, disabled: !!busy,
              maxLength: 256, placeholder: "扫描结果中的设备标识", onChange: event => setAddress(event.target.value) })),
            button("保存设备地址", "saveDevice", address),
            selection && h("p", null, selection.deviceAddress ? `当前设备：${selection.deviceAddress}` : "尚未配置设备；扫描无需地址。"),
            h("p", null, "保存空地址可清除设备选择；地址仅保存在 Host 用户数据目录。"),
            h("div", { className: "rec-actions" }, button("读取状态", "status"), button("读取文件列表", "list"),
              button("导入首条录音", "importFirst", { transcribe: false }),
              button("导入首条并转写", "importFirst", { transcribe: true })),
            h("p", null, "转写默认使用 DSH 已选择的识别器；speechToText 服务未挂载时回退豆包云端，需要相应凭据并上传音频。"),
            h("details", null, h("summary", null, "录音控制（固件支持未确认）"),
              h("p", null, "请先确认周围适合录制。操作失败时不要自动重试；取消不会替设备保存录音。"),
              h("div", { className: "rec-actions" }, button("录音状态", "record", "state"),
                button("开始录音", "record", "start"), button("暂停", "record", "pause"),
                button("继续录音", "record", "resume"), button("保存录音", "record", "save"))),
            imported && h("div", null,
              h("p", null, `已保存音频：${imported.import.path}；转写：${imported.transcription.status}；连接清理：${imported.cleanup.status}`),
              imported.transcription.path && h("p", null, `转写文件：${imported.transcription.path}；后端：${imported.transcription.provider}`),
              imported.transcription.fallbackReason && h("p", { role: "alert" }, `已回退豆包：${imported.transcription.fallbackReason}`),
              imported.cleanup.status === "unconfirmed" && h("p", { role: "alert" },
                `导入时连接释放未确认：${imported.cleanup.errors.map(e => e.message).join("；")}`)),
            imported?.transcription.status === "failed" && button("重试已保存音频的转写", "transcribe", imported.import.path, false),
            busy && h("div", { role: "status" }, busy, h("button", { type: "button", onClick: () => active.current?.abort() }, "取消")),
            failure && h("pre", { role: "alert" }, failure),
            output && h("pre", { role: "status" }, output)));
      };
    }
    return {
      inject: ["remote"],
      async apply(ctx) {
        const lifetime = { calls: new Set(), disposed: false };
        const disposeRemote = await ctx.remote.$mount(contribution);
        const ui = ctx.inject(["remote.recorder", "slots"], child => {
          child.slots.inject("conversation.input.activity", () => child.slots.register({
            name: "conversation.input.activity", id: "recorder-card", order: 5,
          }, createCard(child.remote.recorder, lifetime)));
        });
        const dispose = async () => {
          lifetime.disposed = true;
          for (const call of lifetime.calls) call.abort();
          try { await ui.dispose(); } finally { await disposeRemote(); }
        };
        try { await ui; } catch (error) { await dispose(); throw error; }
        return dispose;
      },
    };
  },
});
