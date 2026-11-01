# Architecture and open decisions

本文区分当前代码、开发方向和待决事项。当前能力以[状态表](../README.zh.md#当前状态)为准，验收顺序见[路线图](../ROADMAP.md)。

## 当前运行边界

| 部分 | 执行位置 | 已有代码 | 尚缺部分 |
|---|---|---|---|
| Client | 打开 DSH 页面的浏览器 | 宿主 React、会话活动 Slot、Typert Remote 调用；不持有 BLE | Web 创造模式已验证配置/扫描/首条导入；Electron、暗色主题与异常场景待验收 |
| Host | DSH 的 Node 运行时所在机器 | Skill、八个工具及 Remote，共用 recorder Service、CLI 队列与子进程管理 | 完整实机工具/卡片验收 |
| Python CLI | Host 的 Python 3.11+ | 固定源码包含在 vendor/upstream；适配器校验哈希并分离数据目录 | Python/Bleak/requests 安装、平台与设备验收 |
| Skill | DSH 提供给 Agent 的内容 | 能力检查、资源定位及操作约束；M1 发现/访问通过 | 后续硬件工作流验证 |

浏览器与 Host 可能在不同机器上。当前浏览器卡片通过 Remote 访问 Host；Python 访问的是 Host 机器的蓝牙设备。远程 Host 不会自动获得浏览器本地的蓝牙访问能力。

2026-10-31 确定主路线为 Host Python CLI 直连，见[路线图](../ROADMAP.md)。Host 所在机器必须有可用蓝牙、相应权限并能连接卡片；先在该机器上完成 M2a 独立 CLI 验证，M1 与 M2a 通过后再做 M2b 工具接入。

当前 Client 路径：浏览器卡片 → Typert Remote → `recorderController` → `recorder` Service → Host Python CLI → 设备。Agent 工具和卡片使用主插件同一份配置与服务实例。`./typert` 暴露 Host 描述符，由官方 Loader 自动注册；客户端挂载含 `descriptors` 的贡献，处理 `{ ok, value/error }` 返回值。详见[Remote 设计与验证](client-host-remote.md)。

0.4.0 实现单图标交互。点击通过 Host 连接已保存设备；首次使用扫描唯一设备并自动保存，多设备在对话中选择。Host 用独立 `recorder_worker.py` 保持上游 Session；确认连接才变绿，断线由 Bleak 回调更新。Client 每 1.5 秒读取内存 `connectionState()`，不轮询 BLE `status()`。后续列表、录音、首条导入、转写通过 Agent 工具执行；右键可断开或切换。引导使用官方 `sessions.scope(sessionId).get("conversation").send(text)`，不改草稿、不伪造回复。图标挂在列表 Slot `conversation.input.left`，不占用语音输入 activity。组件卸载取消未完成请求；共享已连接会话持续到主动断开、故障或 Host 插件卸载。

持续会话期间操作串行，整个会话持有同模块 BLE 队列；其他 Service 实例不能绕过它启动 CLI。失败、超时或取消后的会话被关闭，不复用有歧义的通知流。安全导入继续校验内容、原子发布；`cleanup: retained` 明确表示 Host 有意持有连接，和释放成功/释放未确认分开。没有显式连接时，既有一次性 CLI 工具路径保留。连接选择写到 dataDir/recorder-settings.json，保存值优先于旧 Config.deviceAddress；切换设备先释放原连接。

旧浏览器直连实现迁入 `tests/fixtures/legacy-web-bluetooth.js`，不随 npm 包分发。保留的测试覆盖 DataView、列表超时/迟到帧、GATT 写入队列和会话清理，仅作历史回归，不证明新 Remote UI 的硬件行为。其 1.2 秒列表策略与浏览器连接交接不再适用于当前 Client 入口。

当前 Host 设备路径：内部服务方法 → 随包 `runtime/recorder_cli.py` → 经源码哈希校验的随包 CLI。DSH 转写直接使用 Host speechToText；豆包回退通过适配器校验脚本并定位数据目录。`apply()` 使用 [工具适配层](../runtime/tools.js) 注册八个 `recorder_*` 工具；已在真实 DSH 注册表验证发现、错误和启停。Client 通信已接入相同服务；扫描/状态/列表/录音 Remote 的进程结果为 `{ code, out, err }`，业务失败保留 `RemoteError` 错误码。以下为 Agent 工具结果：除连接管理、导入及转写工作流外，成功值包含 `operation`、`completion: operation-completed`、`exitCode`、`stdout`、`stderr`，失败走 DSH 的 `isError` 通道并保留稳定错误码（如 `RECORDER_CONFIG_OR_ARGUMENT`、`RECORDER_CLI_FAILED`、`RECORDER_TIMEOUT`、`RECORDER_CLEANUP_FAILED`），不把非零退出或不完整列表包装为成功。进程退出不等于状态字段、音频完整性或端到端验收通过。

导入单独返回 `{ status, import, transcription, cleanup }`：`import` 包含成功状态、实际路径、字节数、SHA-256 与 PCM 结构验证信息；转写失败时整体为 `partial`，转写项包含错误码、信息及仅重试转写的工具参数。该已报告的部分结果可以是 DSH `isError: false`，调用方必须检查工作流与阶段状态，不能当作全流程成功。导入失败或结果文件不可信仍走错误通道。导入与清理状态来自适配器独立 version-2 JSON 文件；转写状态来自归档管线，不解析日志中的 WARN/DONE。`cleanup` 独立记录连接释放状态与错误；转写失败和清理失败同时发生时均保留，清理未确认也使整体为 `partial`，不能视为设备已释放。

适配器先把上游导入限定在目标目录下的独立暂存目录，完成后校验支持的 PCM 文件结构并计算哈希，以原子硬链接发布。冲突时添加随机后缀，现有文件不会被替换；不支持硬链接则报错，不采用覆盖式回退。普通失败/取消清理暂存；强制杀进程可能留下暂存目录，但不会把半文件写入已有音频。后续转写失败保留已发布音频。发布前现已核对 RIFF/WAVE PCM 的总长度、块边界与填充、格式字段和完整采样帧；未知编码或截断报完整性未确认，不发布也不继续转写。这不替代源端校验和、人工试听、归档 Markdown 和实机中断恢复验收。

## BLE 连接归属

工作区新增 `recorder_import.filename` 与 `RecorderService.importFile` / Remote `importFile`。同一持久 worker 内先确认列表、精确选择文件再导入，省略文件名保持首条行为；转写后仍保留 Host 连接。未连接时使用独立 `--filename=<name>` 参数调用一次性适配器，不能与 `--import-all` 混用。没有为工具导入增加断开交接事务，也未实现字节续传或自动重连。错误分类、用户实机反馈和 profile 升级核对见[导入与恢复](import-recovery.md)。

当前卡片与 Agent 工具均通过 Host 队列，不会创建额外浏览器 BLE 连接。手机、其他浏览器直连页面和外部 CLI 仍需先断开，避免抢占设备。

Host 的 [CLI 管理层](../runtime/host-cli.js)在同一个加载模块内共享单一设备队列。显式连接时复用持续 worker；未显式连接时保留每次调用独立 Python 子进程的路径。只有进程及输出管道关闭、终止尝试结束后才释放全局队列。排队中取消不会启动进程；失败不会自动重试录音命令。独立转写不占用 BLE 队列，但纳入同一实例的停用清理。

方法接受 `AbortSignal`；`ctx.effect` 注册的异步清理会取消该实例的排队请求、终止运行中的进程，并等待退出。Host 默认运行时限为 190 秒（从启动算起，不含排队），输出捕获上限为 stdout/stderr 合计 8 MiB。Windows 使用 `taskkill /T /F`，POSIX 使用独立进程组的 SIGTERM，1 秒后再发 SIGKILL。若系统拒绝终止且进程仍未关闭，返回 `CleanupError`，队列继续阻塞直到实际退出，停用也不能报告清理成功。正常路径由 Python 适配器尝试断开连接；Host 强制终止不保证执行 Python 的 finally，更不等于设备停止/保存录音或回滚导入。取消或超时后须检查设备状态及部分输出，不能盲目重试。

Windows 本地进程测试及真实 DSH 隔离 profile 的活动测试子进程停用已通过；BLE 取消、POSIX 分支和桌面 UI 仍待验证。队列不能协调其他 Node Host、模块副本、外部手动 CLI 或浏览器；这些仍需显式交接，没有跨进程连接锁。文件导入与实时音频也不能同时运行。

可选界面已展示 Host 返回值并通过 Host 发命令，扫描、状态和列表目前仍是命令文本。前端本地忙碌状态不代表精确设备进度，界面不会在 BLE 调用期间并发轮询状态。

首条完整导入流程确定为 Host + 随包 CLI，复用已有封装。M2a 的独立单文件导入用于可行性验证，M3 必须从 DSH 工具完成导入。卡片导入调用相同 Host 服务，不传输浏览器音频；卡片可点击不等于 M3 实机验收通过。

## 协议来源与维护

[上游仓库](https://github.com/nextproto1024/ai-recorder-card-open-protocol)是协议及 Python CLI 的外部来源。本仓库的 [vendor/recorder-protocol.js](../vendor/recorder-protocol.js)包含协议原语，旧浏览器内联副本仅保留在测试夹具中，当前 [client.js](../client.js) 不含 BLE 协议。

当前仓库未记录协议副本对应的上游 commit。协议变更时先确认上游版本及规范，更新实际使用路径的代码和回归；UUID、CRC、字节序和命令不得凭经验补齐。退役浏览器夹具用于历史回归，不继续作为生产协议来源。

2026-10-31 核对[上游 LICENSE](https://github.com/nextproto1024/ai-recorder-card-open-protocol/blob/main/LICENSE)，将完整 MIT 许可文本及 `Copyright (c) 2026 NextProto` 保存在 [vendor/LICENSE](../vendor/LICENSE)，适用于协议副本及历史浏览器夹具中的上游代码部分。源码头保留许可引用；npm 包预检要求协议副本与完整许可随包分发。此次许可证核对不代表已确定协议代码的来源 commit。

M2a 后续固定了 CLI/规范参考 commit `de42d1fbf19fc92064ac4688f71f42730c82267f` 并进行了部分实机验证，详见 [CLI 验证记录](cli-validation.md)。该固定参考补充了前述 main 分支核查，不代表已确认 vendored JavaScript 的来源。原始 CLI 的列表/录音确认和异常释放存在缺口；随包适配器针对这些已验证源码增加校验，并拒绝未知源码版本。不能把所有退出码 0 当作设备操作成功，扫描空结果、完整音频校验及其他边界仍需分别判断。适配器参数、超时策略与限制见[随包运行说明](../skill/references/runtime.md#bundled-cli-adapter)。

## Current Host configuration

以下字段由 `index.js` 导出的 Schemastery `Config` 校验，并已通过真实 Host 加载；尚未验证桌面设置界面的呈现。

| 字段 | 当前默认值 | 行为与限制 |
|---|---|---|
| `python` | `python` | 传给 `spawn` 的解释器路径/命令，需要在 Host 环境可用 |
| `repoRoot` | 包内 `vendor/upstream/` | 可选开发者覆盖；缺省或空字符串使用随包固定源码，不作为数据目录 |
| `dataDir` | Host 用户目录 `~/.dsh-recorder-card` | 用户数据、设备缓存与可选 ASR `.env`；不能位于 CLI 源码目录内 |
| `deviceAddress` | 无 | 高级回退地址；图标或 recorder_connect 自动发现并保存设备后无需手工配置。一次性设备调用仍需要已保存/配置的地址 |
| `outDir` | `archive/audio` | `importFirst()` 的默认输出参数；相对路径以 `dataDir` 为基准，调用前转为绝对路径 |
| `cliTimeoutMs` | `190000` | Host 子进程运行时限，正整数毫秒；不改变适配器自身的 180 秒异步设备时限 |
| `transcriptionProvider` | `dsh` | 使用 Host 的 speechToText；仅服务缺席回退 doubao，也可显式选 doubao |

当前 `transcribe()` 由 [归档管线](../runtime/transcription.js) 处理：校验完整的标准头 16 kHz 单声道 PCM16 WAV（最大 64 MiB，识别器可有更小限制），计算指纹，调用 `speechToText.resolve({ audio })` 后 `transcribe(spec, signal)`。服务通过可选注入获取，不阻止设备工具加载；仅服务不存在时回退豆包。服务存在但未准备、选择错误、识别失败或取消均不回退。DSH 可使用本机 SenseVoice，并不等于 DeepSeek 云 API。

已实现默认 `dsh` 和显式 `doubao`；`openai`/独立 `local` 配置仍属后续规划。豆包经固定 CLI 写入独立暂存目录；管线核对产物指纹/provider/正文后统一归档，不凭进程日志判断成功。

转写成功结果为 `{ status, provider, recognizer, path, audioPath, audioSha256, reused, fallbackReason? }`。缓存按音频指纹、provider、识别器 ID、语言及格式版本隔离，复用时核对正文哈希；同 ID 的模型替换需显式 `force`。并发同键串行，强制重转写不覆盖旧文件，使用暂存文件与原子硬链接发布。空正文、截断音频、识别期间输入变化均失败；取消或停用传播至识别器。导入先完成音频发布，再调用此管线；持续会话仍由 Host 持有，转写失败不丢失独立 cleanup 警告。

0.3.1 缓存关联修复：返回同路径缓存前重新读取当前音频并核对指纹；所有新归档（包括跨路径复用）在暂存完成后、发布前也做同样核对。优先命中当前绝对路径的归档；只有其他路径的有效缓存时，另存一份 `audio` 与标题指向当前文件的归档，并重新计算正文哈希，`reused: true` 表示正文没有再次识别。原归档不覆盖。`transcription_source_audio` 保留最初识别来源，`recorded_at_source_audio` 解释沿用的文件名时间；改名不会平移既有时间线。这些历史来源可以已不存在，当前有效音频引用是 `audio`。这是返回/发布时的校验，不保证外部进程之后不能修改音频。

DSH 返回纯文本及音频/推理时长，无分段或说话人。归档声明 `timeline: none`、`speaker_source: fallback`，起始时间仅由文件名推算且时区未知。实际 Host/SenseVoice 验证见 [M4 记录](transcription-validation.md)。

`spawn` 继承 Host 环境并显式启用 Python UTF-8 I/O；转写读取 Host 环境或 `dataDir/.env`；扫描/导入不需要转写密钥。相对音频路径基于 `dataDir`。启动 Python 时禁写字节码，避免包目录产生缓存。

## CLI 获取与分发

方案已确定：将 commit `de42d1fbf19fc92064ac4688f71f42730c82267f` 的三个 Python 脚本和 requirements 原样放入 `vendor/upstream/tools/`，保留 NextProto 完整 MIT 许可证。`SOURCE.json` 记录逐文件哈希；原有设备脚本 SOURCE_HASHES 不变，转写脚本另加校验。

用户无需 clone、填写 repoRoot 或修改 pnpm 安全年龄门槛。需在 Host Python 3.11+ 安装 Bleak/requests；缺依赖返回安装命令，不自动下载。扫描无需地址，Skill 引导使用卡片设备地址输入框。DSH 转写需准备所选识别器；豆包云端另需 ASR 凭据。

`dataDir` 与源码分离，默认包含 `archive/audio/`、`archive/corpus/`、设备缓存和可选 `.env`。旧用户相对路径基准从 repoRoot 改为 dataDir；原文件不迁移或删除，可用绝对音频路径或自行复制到新数据目录。数据目录不能指向源码目录。包预检要求完整 CLI、哈希和许可，并排除缓存、音频和秘密。验证证据见[分发记录](distribution-validation.md)。

## 规划中的数据流与存储约定

首条目标流程为：Agent 工具 → Host → Python BLE 导入 → 完整音频 → 一种转写后端 → 关联的 Markdown。当前卡片经 Remote 走相同的 Host 导入路径；浏览器直接 BLE 传输不在本次范围。

当前实现与剩余约定：

- 已实现独立 dataDir，包含 `archive/audio/` 与 `archive/corpus/`；源码目录不作为默认输出。
- 导入完成并通过完整性检查后，才把文件视为可用音频；中断留下的部分文件不可视为成功。
- 以 `audio_sha256` 关联转写和音频，文件名相同不代表内容相同。
- 复用转写时同时检查指纹和有效正文；冲突时保留已有有效数据。
- 转写失败保留音频，分别报告导入结果和转写结果。
- 不删除卡内原件，不提交音频、语料、密钥或设备地址。

导入的原子发布、冲突后缀、音频哈希、阶段结果及 Markdown 元数据/复用已实现并有回归；完整硬件异常恢复验收仍属于 M3/M4。

## 待决事项

| 决策 | 解决阶段 | 需要的证据 |
|---|---|---|
| DSH Host/Skill 支持版本及加载接口 | M1 | 实际运行时检查和加载记录 |
| CLI 固定版本、Python/Bleak、系统/蓝牙及卡片兼容范围 | M2a | 独立 CLI 实机与单文件导入记录 |
| DSH 设备工具接口、互斥及子进程生命周期 | M2b | 工具调用、并发、取消及失败恢复记录 |
| DSH 导入目标、数据根目录及完整性 | M3 | 经工具执行的单文件导入和失败恢复记录 |
| Slot、Client–Host 通信 | 可选增强 | Web 创造模式已有配置/扫描/首条导入证据；Electron 与异常恢复待验收 |
| 转写后端实现与验证（默认 `dsh`，doubao/openai/local 可选）及归档格式 | M4 | 成功、复用、冲突与失败场景 |
| CLI 随包分发与发布渠道 | M5 | 固定源码已随包分发；仍需干净环境与发布包验收 |
