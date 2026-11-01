// Client half of the AI recorder card bundle: a Web Bluetooth card.
//
// Protocol primitives inlined from the upstream sdk/javascript/qs668-protocol.js
// (MIT) so the card needs no extra module-format resolution. Canonical copy is
// vendor/recorder-protocol.js.
// Copyright (c) 2026 NextProto (upstream protocol portions).
// Full upstream copyright and permission notice: vendor/LICENSE
// https://github.com/nextproto1024/ai-recorder-card-open-protocol
//
// DSH constraints (from cordis-plugin-development references):
//   - register into a slot with ctx.slots.inject / ctx.slots.register
//   - React comes from require('react'), no CDN / duplicate React
//   - only --dsw-alias-* theme tokens; do NOT require dsh-client-ui-* packages
//   - register listeners/timers in apply via ctx.effect and return cleanup

window.__ModuleLoader__.load({
  id: "dsh-recorder-card",
  factory(require) {
    const React = require("react");
    const h = React.createElement;
    const { useState, useEffect, useRef, useCallback } = React;

    // ---- recorder card protocol (inlined from sdk/javascript/qs668-protocol.js) ----
    const UUIDS = Object.freeze({
      service: "0000ae20-0000-1000-8000-00805f9b34fb",
      write: "0000ae21-0000-1000-8000-00805f9b34fb",
      notify: "0000ae22-0000-1000-8000-00805f9b34fb",
      keyNotify: "0000ae23-0000-1000-8000-00805f9b34fb",
    });

    function crc16Xmodem(bytes) {
      let crc = 0x0000;
      for (const b of bytes) {
        crc ^= b << 8;
        for (let i = 0; i < 8; i += 1) {
          crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) : crc << 1;
          crc &= 0xffff;
        }
      }
      return crc & 0xffff;
    }

    function toBytes(value) {
      if (value instanceof Uint8Array) return value;
      if (ArrayBuffer.isView(value)) {
        return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      }
      return new Uint8Array(value);
    }
    function concatBytes(parts) {
      const arrays = parts.map(toBytes);
      const total = arrays.reduce((s, p) => s + p.length, 0);
      const out = new Uint8Array(total);
      let o = 0;
      for (const p of arrays) { out.set(p, o); o += p.length; }
      return out;
    }
    const bytes = (values) => new Uint8Array(values);
    const u16LE = (v) => bytes([v & 0xff, (v >> 8) & 0xff]);
    const u32LE = (v) => bytes([v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff]);
    const readU32BE = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
    function fixedTextBytes(text, length) {
      const out = new Uint8Array(length);
      out.set(new TextEncoder().encode(text).slice(0, length));
      return out;
    }
    function decodeText(b) {
      const end = b.indexOf(0);
      return new TextDecoder().decode(end >= 0 ? b.slice(0, end) : b).trim();
    }

    function buildFrame(payload, seq = 0) {
      const data = toBytes(payload);
      const len = u16LE(data.length);
      const crc = crc16Xmodem(concatBytes([len, data]));
      const frame = new Uint8Array(6 + data.length);
      frame[0] = 0x5a;
      frame[1] = seq & 0xff;
      frame[2] = crc & 0xff;
      frame[3] = (crc >> 8) & 0xff;
      frame.set(len, 4);
      frame.set(data, 6);
      return frame;
    }

    class FrameParser {
      constructor() { this.buffer = new Uint8Array(0); }
      push(chunk) {
        this.buffer = concatBytes([this.buffer, toBytes(chunk)]);
        const frames = [];
        while (this.buffer.length >= 6) {
          const i = this.buffer.indexOf(0x5a);
          if (i < 0) { this.buffer = new Uint8Array(0); break; }
          if (i > 0) this.buffer = this.buffer.slice(i);
          if (this.buffer.length < 6) break;
          const seq = this.buffer[1];
          const expectedCrc = this.buffer[2] | (this.buffer[3] << 8);
          const len = this.buffer[4] | (this.buffer[5] << 8);
          const total = 6 + len;
          if (this.buffer.length < total) break;
          const payload = this.buffer.slice(6, total);
          if (crc16Xmodem(this.buffer.slice(4, total)) === expectedCrc) {
            frames.push({ seq, payload, type: payload[0], cmd: payload[1], params: payload.slice(2) });
            this.buffer = this.buffer.slice(total);
          } else {
            this.buffer = this.buffer.slice(1);
          }
        }
        return frames;
      }
    }

    const commands = {
      syncTime(date = new Date()) {
        const y = date.getFullYear();
        return bytes([0, 0, y & 0xff, y >> 8, date.getMonth() + 1, date.getDate(),
          date.getHours(), date.getMinutes(), date.getSeconds()]);
      },
      getBattery: () => bytes([0, 3]),
      listFiles: () => bytes([2, 0]),
      importFile: (filename, offset = 0) =>
        concatBytes([bytes([2, 2]), u32LE(offset), fixedTextBytes(filename, 24)]),
      startRecording: () => bytes([3, 1]),
      saveRecording: () => bytes([3, 3]),
      pauseRecording: () => bytes([3, 5]),
      resumeRecording: () => bytes([3, 7]),
      getRecordState: () => bytes([3, 19]),
    };

    function parseFileList(payload) {
      const b = toBytes(payload);
      if (b.length < 4) return [];
      const count = readU32BE(b, 0);
      const files = [];
      let o = 4;
      for (let i = 0; i < count && o + 28 <= b.length; i += 1) {
        const e = b.slice(o, o + 28);
        files.push({
          durationOrTime: readU32BE(e, 0),
          size: readU32BE(e, 4),
          name: decodeText(e.slice(8, 28)),
          rawEntry: e,
        });
        o += 28;
      }
      return files;
    }

    // ---- Web Bluetooth session ----
    async function openSession(onFrame, onDisconnect, signal) {
      const device = await navigator.bluetooth.requestDevice({
        filters: [{ services: [UUIDS.service] }],
        optionalServices: [UUIDS.service],
      });
      if (signal.aborted) throw new Error("连接已取消");
      const server = device.gatt;
      let notifyChar;
      let closed = false;
      const parser = new FrameParser();
      const onValue = (ev) => {
        if (closed) return;
        for (const f of parser.push(ev.target.value)) {
          if (closed) break;
          onFrame(f);
        }
      };
      const close = (notifyDisconnect = false) => {
        if (closed) return;
        closed = true;
        notifyChar?.removeEventListener("characteristicvaluechanged", onValue);
        device.removeEventListener("gattserverdisconnected", onLost);
        signal.removeEventListener("abort", onAbort);
        if (server.connected) server.disconnect();
        if (notifyDisconnect) onDisconnect();
      };
      const onLost = () => close(true);
      const onAbort = () => close();
      const ensureOpen = () => {
        if (closed || !server.connected) throw new Error("录音卡已断开连接");
      };
      device.addEventListener("gattserverdisconnected", onLost);
      signal.addEventListener("abort", onAbort);
      try {
        await server.connect();
        ensureOpen();
        const service = await server.getPrimaryService(UUIDS.service);
        ensureOpen();
        const writeChar = await service.getCharacteristic(UUIDS.write);
        ensureOpen();
        notifyChar = await service.getCharacteristic(UUIDS.notify);
        ensureOpen();
        notifyChar.addEventListener("characteristicvaluechanged", onValue);
        await notifyChar.startNotifications();
        ensureOpen();
        let seq = 0;
        let writeTail = Promise.resolve();
        const send = (payload) => {
          // All callers, including initialization, share this session's queue.
          const data = toBytes(payload).slice();
          const result = writeTail.then(() => {
            // Recheck at execution time: disconnect invalidates queued writes.
            ensureOpen();
            const frame = buildFrame(data, seq++);
            if (writeChar.properties && writeChar.properties.writeWithoutResponse) {
              return writeChar.writeValueWithoutResponse(frame);
            }
            return writeChar.writeValue(frame);
          });
          // Report failure to this caller without poisoning the remaining queue.
          writeTail = result.catch(() => {});
          return result;
        };
        return { device, server, send, disconnect: () => close() };
      } catch (error) {
        close();
        // A pending connect may have resolved after a disconnect event.
        if (server.connected) server.disconnect();
        throw error;
      }
    }

    // ---- React card ----
    function Card() {
      const [session, setSession] = useState(null);
      const [battery, setBattery] = useState(null);
      const [recordState, setRecordState] = useState(null);
      const [files, setFiles] = useState([]);
      const [log, setLog] = useState("");
      const [connecting, setConnecting] = useState(false);
      const [listing, setListing] = useState(false);
      const [listMessage, setListMessage] = useState("");
      const [listBlocked, setListBlocked] = useState(false);
      const sessionRef = useRef(null);
      const connection = useRef(null); // identity survives awaits, invalidated on disconnect/unmount
      const listCollector = useRef(null); // { frames: [], timer } while listing
      const listNeedsReconnect = useRef(false); // synchronous guard for stale button handlers

      const onFrame = useCallback((f) => {
        if (f.type === 0 && f.cmd === 4) setBattery(f.params[0]); // 0-4 battery %
        if (f.type === 3 && f.cmd === 20) setRecordState(f.params[0]); // 3-20
        const collector = listCollector.current;
        if (collector) {
          if (f.type === 2 && f.cmd === 1) {
            collector.frames.push(f); // 2-1 list data
            armListTimeout(collector);
          }
          if (f.type === 2 && f.cmd === 18) {
            // The protocol defines body 0 as complete, but no request-ID echo.
            finishList(collector, f.params[0] === 0 ? "complete" : "unconfirmed");
          }
        }
      }, []);

      function blockListUntilReconnect() {
        // SEQ is not documented as a request/response correlation ID. Once a
        // response is uncertain, reusing this session could misattribute late frames.
        listNeedsReconnect.current = true;
        setListBlocked(true);
      }

      function finishList(collector, outcome = "complete") {
        if (!collector || listCollector.current !== collector) return;
        clearTimeout(collector.timer);
        listCollector.current = null;
        setListing(false);
        const all = collector.frames.flatMap((f) => parseFileList(f.params));
        setFiles(all);
        if (outcome !== "complete") blockListUntilReconnect();
        if (outcome === "timeout") {
          setListMessage(collector.frames.length
            ? `读取文件列表超时，已收到 ${all.length} 个文件，结果可能不完整，请先断开并重新连接后再读取。`
            : "读取文件列表超时，未收到列表数据，无法确认设备是否为空，请先断开并重新连接后再读取。");
        } else if (outcome === "unconfirmed") {
          setListMessage("列表结束响应未确认成功，结果可能不完整，请先断开并重新连接后再读取。");
        } else {
          setListMessage(`列表读取完成，共 ${all.length} 个文件。`);
        }
      }

      function armListTimeout(collector) {
        clearTimeout(collector.timer);
        // An idle timeout is not a device completion notification.
        collector.timer = setTimeout(() => finishList(collector, "timeout"), 1200);
      }

      function discardList() {
        const collector = listCollector.current;
        listCollector.current = null;
        if (collector) clearTimeout(collector.timer);
      }

      function resetConnection(message = "") {
        const attempt = connection.current;
        connection.current = null;
        attempt?.abort();
        sessionRef.current = null;
        discardList();
        listNeedsReconnect.current = false;
        setSession(null);
        setConnecting(false);
        setListing(false);
        setListMessage("");
        setListBlocked(false);
        setBattery(null);
        setRecordState(null);
        setFiles([]);
        setLog(message);
      }

      const connect = async () => {
        if (connection.current) return;
        const attempt = new AbortController();
        connection.current = attempt;
        setConnecting(true);
        setLog("");
        let s;
        try {
          s = await openSession(
            (frame) => { if (connection.current === attempt) onFrame(frame); },
            () => {
              if (connection.current === attempt) resetConnection("录音卡连接已断开，请重新连接");
            },
            attempt.signal,
          );
          if (connection.current !== attempt) { s.disconnect(); return; }
          sessionRef.current = s;
          setSession(s);
          await s.send(commands.syncTime());
          await s.send(commands.getBattery());
          await s.send(commands.getRecordState());
        } catch (error) {
          s?.disconnect();
          if (connection.current === attempt) resetConnection(`连接失败：${error.message}`);
        } finally {
          if (connection.current === attempt) setConnecting(false);
        }
      };

      const disconnect = () => {
        const s = sessionRef.current;
        resetConnection();
        s?.disconnect();
      };

      const sendCommands = async (payloads) => {
        const s = sessionRef.current;
        if (!s) return;
        try {
          for (const payload of payloads) {
            if (sessionRef.current !== s) return;
            await s.send(payload);
          }
        } catch (error) {
          if (sessionRef.current === s) setLog(`操作失败：${error.message}`);
        }
      };

      const refreshStatus = () => sendCommands([commands.getBattery(), commands.getRecordState()]);

      const record = async (action) => {
        const map = {
          start: commands.startRecording, pause: commands.pauseRecording,
          resume: commands.resumeRecording, save: commands.saveRecording,
        };
        await sendCommands([map[action](), commands.getRecordState()]);
      };

      const listFiles = async () => {
        const s = sessionRef.current;
        if (!s || listCollector.current || listNeedsReconnect.current) return;
        const collector = { frames: [], timer: null };
        listCollector.current = collector;
        setListing(true);
        setFiles([]);
        setListMessage("正在读取文件列表…");
        setLog("");
        try {
          await s.send(commands.listFiles());
          if (listCollector.current === collector) armListTimeout(collector);
        } catch (error) {
          if (listCollector.current !== collector) return;
          discardList();
          setListing(false);
          // A rejected write does not prove the device received no request.
          blockListUntilReconnect();
          setListMessage(`读取文件列表失败：${error.message}，请先断开并重新连接后再读取。`);
        }
      };

      const importFile = async (file) => {
        if (!session) return;
        // TODO(Phase 1): run the 2-2 -> 2-3 -> 2-4 -> 2-5 sequence per protocol,
        // assemble chunks, then hand bytes to the Host via Remote/session command
        // (Host writes archive/audio and optionally transcribes). Reference:
        // website/app.js. Remember 2-2 must be ONE 36-byte GATT write.
        setLog(`import "${file.name}" 待接入 Host 落盘（Phase 2）`);
      };

      useEffect(() => () => {
        const attempt = connection.current;
        connection.current = null;
        attempt?.abort();
        discardList();
        const s = sessionRef.current;
        sessionRef.current = null;
        s?.disconnect();
      }, []);

      if (!session) {
        return h("div", { style: cardStyle },
          styleEl,
          h("button", { className: "rec-btn rec-btn-primary", onClick: connect, disabled: connecting }, "连接录音卡"),
          connecting ? h("span", null, "正在连接…") : null,
          log ? h("div", null, log) : null);
      }

      return h("div", { style: cardStyle },
        styleEl,
        h("div", { style: row },
          h("span", null, battery == null ? "电量 —" : `电量 ${battery}%`),
          h("span", null, recordStateLabel(recordState)),
          h("button", { className: "rec-btn", onClick: refreshStatus }, "刷新"),
          h("button", { className: "rec-btn", onClick: disconnect }, "断开")),
        h("div", { style: row },
          h("button", { className: "rec-btn", onClick: () => record("start") }, "开始录音"),
          h("button", { className: "rec-btn", onClick: () => record("pause") }, "暂停"),
          h("button", { className: "rec-btn", onClick: () => record("resume") }, "继续"),
          h("button", { className: "rec-btn", onClick: () => record("save") }, "保存")),
        h("div", { style: row },
          h("button", { className: "rec-btn", onClick: listFiles, disabled: listing || listBlocked }, "读取文件列表"),
          h("span", null, files.length ? `${files.length} 个文件` : "")),
        listMessage ? h("div", { role: "status" }, listMessage) : null,
        files.length
          ? h("ul", null, files.map((f) =>
              h("li", { key: f.name }, f.name, " ",
                h("button", { className: "rec-btn", onClick: () => importFile(f) }, "导入"))))
          : null,
        log ? h("div", null, log) : null);
    }

    function recordStateLabel(s) {
      return s === 1 ? "录音中" : s === 2 ? "未录音" : s === 3 ? "已暂停" : "录音态 —";
    }

    const cardStyle = {
      display: "flex", flexDirection: "column",
      gap: "var(--dsw-alias-space-2, 8px)", padding: "var(--dsw-alias-space-2, 8px)",
      color: "var(--dsw-alias-label-primary, inherit)",
    };
    const row = { display: "flex", gap: "var(--dsw-alias-space-2, 8px)", alignItems: "center" };
    const recButtonCss = `
.rec-btn {
  padding: 4px 12px;
  font-size: 13px;
  line-height: 20px;
  border-radius: var(--dsw-radius-lg, 8px);
  border: 1px solid var(--dsw-alias-border-l1, transparent);
  background: transparent;
  color: var(--dsw-alias-label-primary, inherit);
  cursor: pointer;
  font-family: inherit;
}
.rec-btn:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover-solid);
}
.rec-btn:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}
.rec-btn-primary {
  background: var(--dsw-alias-state-business-primary, #247bbf);
  border-color: transparent;
  color: #fff;
}
.rec-btn-primary:hover:not(:disabled) {
  filter: brightness(0.94);
}
`;
    const styleEl = h("style", null, recButtonCss);

    return {
      inject: ["slots"],
      apply(ctx) {
        ctx.slots.inject("conversation.input.activity", () => ctx.slots.register({
          name: "conversation.input.activity",
          id: "recorder-card",
          order: 5,
        }, Card));
      },
    };
  },
});
