# Client→Host Remote：实现与验证

状态：0.3.0 已接线，并提供设备地址持久化入口及默认 DSH 转写。官方 Gateway 测试、真实 Web 实机导入与后续原生桌面检查通过本记录范围的自检；仍不代表 M2b/M3/M5 整体已验收。发布状态见 [RELEASE](../RELEASE.md)。

## 调用路径与配置

`client.js` → `ctx.remote.recorder` → `recorderController` → `recorder` Service → 随包 Python CLI → Host 蓝牙。

[index.js](../index.js) 在同一插件生命周期内创建一个 [RecorderService](../runtime/service.js)，工具直接使用该实例，Remote 通过 Cordis 注入同一服务。主 Loader 条目仍只有 `recorder-card`：无需重复 Service 配置，也不新增三个各自持有配置的条目。子控制器等待 `recorder` 和 `typert`；缺少 Gateway 的 headless 场景不会阻塞六个 Agent 工具。

Host CLI 原本已在模块内跨实例共享 BLE 队列。本次共享同一实例还统一了配置、取消与停用生命周期；没有新增跨进程锁。手机、外部 CLI 或其他 Host 仍需显式释放设备。

## 官方接口核对与必要修正

参考 DSH `0.2.0-rc.2` 的 `dsh-experimental-api-speech-to-text`、`dsh-experimental-client-ui-voice-input`、`dsh-typert-protocol`、`dsh-typert-loader`、`dsh-typert-registry` 和 `dsh-api-gateway`。Loader/Gateway 源码取自本机安装包；测试依赖固定为同版官方 npm 包。

- Host 的 `TypertRemoteService` 绑定服务名 `recorderController` 和命名空间 `recorder`。纯 JS 通过公开 `Remote(method, context)` 装饰器契约收集初始化器，在 `super()` 后运行；无需复制 TypeScript 编译器辅助代码或写私有元数据。
- Host 贡献为 `TYPERT = { package, face: "host", schemas, invocations, model }`，由包的 `./typert` 导出供 Loader 自动发现。手写贡献不再额外调用 `typert.register()`，避免重复注册。
- Client 贡献为 `TYPERT_REMOTE = { package, descriptors }`，不是带 `invocations` 的 Host 对象，也没有 `face: "client"` 要求。`./remote-client` 导出它；`./remote` 保留为控制器入口。
- 官方示例 codec 使用 Zod；Schemastery 用于插件 Config。协议公开的最小 wire schema 契约是 `parse(value)`，本项目用无依赖的严格解析器实现，拒绝额外字段和错误类型。结果通过 `encode` / `decode` 显式校验。
- Client 方法返回 `RemoteResult`：`{ ok: true, value }` 或 `{ ok: false, error }`。失败不一定抛异常；业务错误使用 `RemoteError` 保留代码和信息。
- 所有方法声明最终 `signal` 取消参数；它不进入 JSON `args`。可选业务参数仍占调用位置，例如 `transcribe(file, undefined, signal)`、`importFirst(undefined, signal)`。
- `status()` 是独立 CLI/BLE 操作，不作为扫描进度轮询。当前仅显示忙碌状态和最终文本，没有进度流。

## 八个方法（六个设备/转写，两个配置）

| 方法 | 业务参数 | 返回值 |
|---|---|---|
| `getDevice(signal?)` | 无 | `{ deviceAddress, source }`，source 为 `saved / config / none` |
| `saveDevice(address, signal?)` | 设备标识字符串；空字符串清除选择 | 同上，持久化成功后返回 |
| `scan(signal?)` | 无，不需要设备地址 | `{ code, out, err }` |
| `status(signal?)` | 无，使用 Host 配置的地址 | 同上 |
| `list(signal?)` | 无，使用 Host 配置的地址 | 同上 |
| `record(action, signal?)` | `state / start / pause / resume / save` | 同上；`state` 调用只读状态方法 |
| `importFirst(options, signal?)` | `options` 可为 undefined；字段 `outDir?`、`transcribe?` | `{ status, import, transcription, cleanup }` |
| `transcribe(file, force, signal?)` | 非空路径，`force` 为 boolean 或 undefined | `{ status, provider, recognizer, path, audioPath, audioSha256, reused, fallbackReason? }` |

普通进程结果不等于全工作流成功，扫描无结果不等于发现设备。导入 `partial` 会分别显示转写失败与清理未确认，并保留已保存音频路径；转写重试不再次导入，且不能清除之前的连接释放警告。未知错误由 Gateway 统一处理，已知 CLI/配置/取消/超时错误映射为稳定 Remote 错误码。

## Client 生命周期与界面边界

客户端 manifest 声明 Gateway 依赖，`apply()` 先 `$mount` 贡献，再等待 `remote.recorder` 和 `slots`，注册 `conversation.input.activity`。组件卸载取消自己的调用；插件卸载取消全部卡片调用、撤销 UI 与 Remote 贡献。Hook 内用同步引用阻止重新渲染前的连点；跨卡片与 Agent 的操作仍由 Host 队列串行化。

麦克风图标通过 Host 扫描，扫描不保持连接。用户点击“设置设备”，将扫描标识填入“设备地址”并保存后，立即使用状态/列表/首条导入按钮，无需手改 YAML 或重新加载。保存成功与扫描结果分别显示。录音控制明确提示固件支持未确认，不自动重试。转写是独立选择，会使用 Host 配置的 ASR 后端。

生产 Client 不再依赖 `navigator.bluetooth`。退役实现迁入 `tests/fixtures/legacy-web-bluetooth.js`，仅用于历史回归，不随包分发。图标沿用麦克风外观；样式使用宿主别名 token，不导入私有 UI 包。

## 契约维护

[runtime/remote-contract.js](../runtime/remote-contract.js) 是描述符与 wire 校验的唯一维护来源，Host 和 `typert.remote-client.js` 直接导入它。运行 `npm run sync:client` 将无依赖工厂复制到浏览器 ModuleLoader 入口；生成结果提交入库，用户无需构建。`npm test` 首先检查副本漂移。新增方法时同时更新控制器、契约、UI（如需）与验证。

## 2026-11-01 首轮接口自检（历史六方法构建）

本轮为开发者自检，不是独立 QA。

- `npm.cmd test`：74 项通过；包预检、相关 JavaScript 语法与本地文档链接检查通过。
- 官方 Client Gateway 与 Host Gateway，通过进程内 JSON carrier 验证六方法、严格输入/输出、错误码、可选参数、取消、Remote 卸载和控制器撤销。后端使用合成结果，没有 BLE 或 HTTP 认证验证。
- 当前 Client 的 Hook 测试实际挂载官方 Remote，验证图标调用、连点互斥、取消、组件/插件卸载、部分导入及仅重试已保存音频的转写；不会启动真实浏览器。
- 原有 Service/工具测试补充同一实例调用与卸载；历史浏览器回归继续保留。
- 实际 npm tarball 包含 26 个文件，包括 Service、控制器、两个 Typert 入口、共享契约及固定 CLI；不含测试夹具、私密数据或开发日志。
- 用 `D:\ProgramFiles\dsh` 的官方 CLI 将本地 tarball 安装到全新 `.cache/remote/final-profile`，未更改日常 profile 或 pnpm 年龄策略。真实 Host Node `v24.18.1` 的六项探针检查通过：两个 Service 可注入；Loader 自动注册六个严格描述符；缺地址经真实 Gateway 返回结构化错误；Remote/工具共用合成后端；非法录音动作被拒绝；Skill 可读取。
- 本地探针原始输出位于忽略目录 `.cache/remote/final-profile/probe-result.json`，最终候选包与安装/Host 日志位于 `.cache/remote/candidate/`。验证 tarball 的 SHA-256 为 `a8b6151cc520b785a03011262ec14b2c1a230a0ebea240dc65a6f8d2189e7cbf`。源码发生变化后应重新打包验证，不能将旧 tarball 视为任意后续构建的证据。

## 设备地址持久化（0.3.0）

新增 `runtime/device-settings.js`。地址写到 Host `dataDir/recorder-settings.json`，临时文件位于同目录，以写临时文件后原子 rename 的方式更新。保存成功才替换内存选择；写入失败保留原文件与地址，取消/停用会等待已开始的设置操作结束。已有队列项使用其发起时的设备地址。

保存值优先于旧 Config.deviceAddress，包含用于清除选择的空字符串。其他配置仍由原插件条目管理。配置损坏不会悄悄回退到另一台设备：设备调用返回 SettingsError，用户可重新保存修复；扫描仍不要求设备地址。跨 profile 需要独立选择时配置各自 dataDir。配置文件和临时文件已加入忽略与包排除检查，不包含真实标识到公开记录。

## 2026-11-01 真实 Web Client / cordis 模式与实机记录

- 本机安装的 DSH Desktop `0.2.0-rc.2` 官方 CLI 启动隔离 Web profile（`.cache/acceptance/dsh-home`），保留默认连接/认证策略，仅监听本机；数据目录在 `.cache/acceptance/data`。安装本地 0.3.0 tarball，未配置 repoRoot，使用包内固定 CLI。
- Playwright Core 驱动本机 Edge `156.0.4314.50` 无头浏览器，选择“创造模式”（官方 preset `cordis`）。实际页面加载模块、`$mount`、活动 Slot 和 `remote.recorder`，没有模拟 Gateway、React hooks 或设备响应。未配置模型密钥、未提交 Agent 消息，也未调用 `cordis_inspect_*`；本证据针对 UI→Remote→Host 链路。
- 先用合成标识验证输入框保存、刷新恢复和未重新加载时立即生效；最终候选包重启 Host 后，真实页面读取地址仍一致，非法输入返回错误且未覆盖原选择，页面错误数仍为 0。随后在用户确认设备就绪、第一条仍为测试录音后，从实际页面执行扫描，发现唯一录音卡，保存扫描标识，再点击“导入首条录音”。
- 首条导入成功：WAV 为 **169,004 B、单声道、16 kHz、84,480 帧、5.28 秒**；独立 Python wave 读取全部帧通过。文件 SHA-256 与此前用户确认内容正确的 M2a 测试音频一致。未修改或删除卡内原件；没有开始录音或调用云转写。
- UI 返回 `transcription: not-requested`、`cleanup: succeeded`；页面 JavaScript 错误数为 0。明亮主题截图与原始报告保留在忽略目录 `.cache/acceptance/`，包含真实设备标识的文件不得提交。普通沙箱读取音频受限，结构/哈希核对在获准的本地读取环境中完成，未修改音频内容或权限。
- 实机导入所用 tarball SHA-256：`0caa57bb06c957cb1c0a88bbae541c0e4fec1337196a1d10267edacfd646c0a2`。文档与工具说明同步后的最终候选包为 27 文件，SHA-256：`14c339e420676e920519205b6c3b13993a5a843531cdba4b09206aea1276e8e8`；该包已通过实际 Host 重启和 UI 配置恢复检查，没有重复操作硬件。
- 79 项 Node 回归通过，包含持久化/重启恢复、非法地址、取消、写入失败保护、损坏配置恢复、真实官方 Gateway 及 UI 配置按钮。

此前分发实验的导入超时保留为历史失败；本次完整导入通过不证明已找到或消除当时的连接问题。下节另记后续桌面/主题/认证证据；真实 BLE 取消/重试与 Agent 硬件工具仍待验证。没有将一次成功导入扩大为全部里程碑通过。

## 同日后续：原生桌面与 M4

- 实际 DSH Desktop 0.2.0-rc.2 / Electron 44.0.0，独立 DSH_HOME、desktop profile 和 Electron user-data-dir，安装本地 0.3.0 npm 包。仅测试 profile 的 webserver 使用随机本地端口，避免与日常实例默认端口 19387 冲突；首次端口冲突失败没有归因于插件。
- 在原生 `dsh-app:` 窗口选创造（cordis）模式，录音卡 Slot 可见，设备配置经正常桌面认证链路读取、保存并在页面重载后恢复。只保存合成标识 `test-native-device`，不访问 BLE；页面 JavaScript 错误为 0。
- 对同一 Host 的 getDevice RPC 直接发送无凭据 HTTP 请求，返回 401。未绕过或禁用认证，没有验证账号登录/会话过期等全部认证场景。
- 宿主保持“跟随系统”，通过 Electron 渲染器模拟 prefers-color-scheme 的 light/dark；卡片文字与边框颜色确实变化，深色截图已目视核对。此项不等同于操作系统设置切换或手动主题选项持久化验收。
- 私有报告 `.cache/m4/native-report.json` 和截图仅保存在忽略目录；本轮新增桌面实例与隔离 Web Host在检查结束后关闭，日常实例保持运行。
- 默认 DSH 转写另经真实 Host Gateway + 本机 SenseVoice 通过，Agent 工具复用成功，见 [M4 转写记录](transcription-validation.md)。转写 Remote 现在返回路径/provider/指纹/复用状态，不再返回进程日志；导入的转写阶段也保留这些字段。

## 后续验收步骤

1. 用正式发布版本复测安装及启用；新版本受 pnpm 最小发布年龄策略约束时等待，不修改安全策略。
2. 原生窗口/系统主题模拟已验证；补验操作系统主题切换、桌面重复装卸及认证过期。
3. 在明确授权的测试录音上验证 status/list、导入取消/重试及重名保护；不要盲目重复未确认的录音命令。
4. M4 默认 DSH 转写和指纹复用已通过真实 Host；继续完整硬件导入并转写及异常恢复。
