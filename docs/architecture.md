# Architecture and open decisions

本文区分当前代码、开发方向和待决事项。当前能力以[状态表](../README.zh.md#当前状态)为准，验收顺序见[路线图](../ROADMAP.md)。

## 当前运行边界

| 部分 | 执行位置 | 已有代码 | 尚缺部分 |
|---|---|---|---|
| Client | 打开 DSH 页面的浏览器 | 从宿主加载 React；向 `conversation.input.activity` 注入卡片；通过 Web Bluetooth 控制设备 | 完整导入、Host 通信、错误和资源清理的验证 |
| Host | DSH 的 Node 运行时所在机器 | 注册 Skill 与六个工具；配置 schema、CLI 队列与子进程管理 | 真实硬件工具验收、Client 通信和 DSH 转写后端 |
| Python CLI | Host 机器上的外部 checkout | 本仓库仅引用其路径，没有包含脚本 | 获取与版本固定、依赖安装及发布分发方案 |
| Skill | DSH 提供给 Agent 的内容 | 能力检查、资源定位及操作约束；M1 发现/访问通过 | 后续硬件工作流验证 |

浏览器与 Host 可能在不同机器上。浏览器访问的是浏览器所在机器的蓝牙设备；Python 访问的是 Host 机器的蓝牙设备。远程 Host 不会自动获得浏览器本地的蓝牙访问能力。

2026-10-31 确定主路线为 Host Python CLI 直连，见[路线图](../ROADMAP.md)。Host 所在机器必须有可用蓝牙、相应权限并能连接卡片；先在该机器上完成 M2a 独立 CLI 验证，M1 与 M2a 通过后再做 M2b 工具接入。

当前 Client 路径：浏览器卡片 → Web Bluetooth → 设备，为可选独立模式。文件导入按钮仅显示提示，没有音频传输或归档。此文档调整未改变当前 manifest 的 Client 注入声明；若其依赖阻碍 Host 加载，应在 M1 解决。页面认证和蓝牙权限分别验证，不把带 token 的 URL 视为 Web Bluetooth 可用的保证。

Client 的同一会话通过统一队列串行执行 GATT 写入，初始化与各操作按钮共用队列；执行待发项前重新检查连接状态。单次写入失败返回给调用方，队列仍可处理后续请求。该机制只保证写入 Promise 不重叠，不代表整个设备命令/响应事务互斥，也不协调 Python 进程。

文件列表只有收到正文为 `0` 的 `2-18` 才标记完成。1.2 秒未收到后续列表帧会显示超时：无数据时提示无法确认空列表，收到部分数据时显示结果可能不完整。超时、列表写入失败或结束响应缺失成功状态后，禁止在该连接中再次读取列表，并忽略随后到达的列表响应；用户须先断开并重新连接。状态刷新和录音控制仍可使用。断开会清理列表及接收会话，重新连接后才能开始新请求。

2026-10-31 核查[上游协议 main 分支](https://github.com/nextproto1024/ai-recorder-card-open-protocol/blob/main/docs/protocol.md)：`SEQ` 仅定义为回绕序号，文档未规定请求序号回显或列表请求 ID；`2-18` 正文 `0` 表示完成，`2-7` 用于终止导入。因而本地不假设 `SEQ` 可关联列表响应，也不使用导入终止命令取消列表。本次核查未取得不可变 commit，不代表已确认 vendored SDK 的来源版本。

要求重新连接是本插件在缺少可靠响应关联时采用的保守策略。模拟测试覆盖旧会话监听与回调隔离；1.2 秒阈值和设备是否跨连接重发旧数据仍需实机验证，不能将重连描述为协议保证的设备缓存清空。

当前 Host 设备路径：内部服务方法 → 随包 `runtime/recorder_cli.py` → 经源码哈希校验的外部 CLI。独立转写方法仍直接调用外部转写脚本。`apply()` 使用 [工具适配层](../runtime/tools.js) 注册六个 `recorder_*` 工具；已在真实 DSH 注册表验证发现、错误和启停。Client 通信仍未实现。除导入工作流外，成功值包含 `operation`、`completion: process-exited`、`exitCode`、`stdout`、`stderr`，失败走 DSH 的 `isError` 通道并保留稳定错误码（如 `RECORDER_CONFIG_OR_ARGUMENT`、`RECORDER_CLI_FAILED`、`RECORDER_TIMEOUT`、`RECORDER_CLEANUP_FAILED`），不把非零退出或不完整列表包装为成功。进程退出不等于状态字段、音频完整性或端到端验收通过。

导入单独返回 `{ status, import, transcription, cleanup }`：`import` 包含成功状态、实际路径、字节数、SHA-256 与 PCM 结构验证信息；转写失败时整体为 `partial`，转写项包含错误码、信息及仅重试转写的工具参数。该已报告的部分结果可以是 DSH `isError: false`，调用方必须检查工作流与阶段状态，不能当作全流程成功。导入失败或结果文件不可信仍走错误通道。状态来自适配器的独立 version-2 JSON 文件，不解析日志中的 WARN/DONE。`cleanup` 独立记录连接释放状态与错误；转写失败和清理失败同时发生时均保留，清理未确认也使整体为 `partial`，不能视为设备已释放。

适配器先把上游导入限定在目标目录下的独立暂存目录，完成后校验支持的 PCM 文件结构并计算哈希，以原子硬链接发布。冲突时添加随机后缀，现有文件不会被替换；不支持硬链接则报错，不采用覆盖式回退。普通失败/取消清理暂存；强制杀进程可能留下暂存目录，但不会把半文件写入已有音频。后续转写失败保留已发布音频。发布前现已核对 RIFF/WAVE PCM 的总长度、块边界与填充、格式字段和完整采样帧；未知编码或截断报完整性未确认，不发布也不继续转写。这不替代源端校验和、人工试听、归档 Markdown 和实机中断恢复验收。

## BLE 连接归属

浏览器 BLE 与 Python BLE 是两条独立路径，不应同时操作同一卡片。开发验证采用显式交接：先断开浏览器连接，再启动 Python；Python 会话结束后才能重新连接浏览器。

Host 的 [CLI 管理层](../runtime/host-cli.js)在同一个加载模块内共享单一设备队列，保守地串行执行所有设备调用（包括扫描、导入和不同服务实例的请求）。每次调用仍启动独立 Python 子进程；只有进程及其输出管道关闭、终止尝试结束后才释放队列。排队中取消不会启动进程；失败不会自动重试录音命令。独立转写不占用 BLE 队列，但纳入同一实例的停用清理。

方法接受 `AbortSignal`；`ctx.effect` 注册的异步清理会取消该实例的排队请求、终止运行中的进程，并等待退出。Host 默认运行时限为 190 秒（从启动算起，不含排队），输出捕获上限为 stdout/stderr 合计 8 MiB。Windows 使用 `taskkill /T /F`，POSIX 使用独立进程组的 SIGTERM，1 秒后再发 SIGKILL。若系统拒绝终止且进程仍未关闭，返回 `CleanupError`，队列继续阻塞直到实际退出，停用也不能报告清理成功。正常路径由 Python 适配器尝试断开连接；Host 强制终止不保证执行 Python 的 finally，更不等于设备停止/保存录音或回滚导入。取消或超时后须检查设备状态及部分输出，不能盲目重试。

Windows 本地进程测试及真实 DSH 隔离 profile 的活动测试子进程停用已通过；BLE 取消、POSIX 分支和桌面 UI 仍待验证。队列不能协调其他 Node Host、模块副本、外部手动 CLI 或浏览器；这些仍需显式交接，没有跨进程连接锁。文件导入与实时音频也不能同时运行。

后续可选界面优先展示 Host 提供的状态并通过 Host 发命令；该通信尚未实现。现有浏览器直连模式必须在 CLI 释放设备后才能使用，不作为 CLI 占用期间的实时监控面板。

首条完整导入流程确定为 Host + 外部 CLI，复用已有封装。M2a 的独立单文件导入用于可行性验证，M3 必须从 DSH 工具完成导入。浏览器直接传输是另一项集成工作，需完成协议收包和 Host 上传/落盘接口后才能声明可用。

## 协议来源与维护

[上游仓库](https://github.com/nextproto1024/ai-recorder-card-open-protocol)是协议及 Python CLI 的外部来源。本仓库的 [vendor/recorder-protocol.js](../vendor/recorder-protocol.js)包含协议原语，[client.js](../client.js)另有内联副本。

当前仓库未记录协议副本对应的上游 commit。协议变更时先确认上游版本及规范，再检查两份实现的一致性；UUID、CRC、字节序和命令不得凭经验补齐。后续应评估统一来源，避免两份实现逐渐分叉。

2026-10-31 核对[上游 LICENSE](https://github.com/nextproto1024/ai-recorder-card-open-protocol/blob/main/LICENSE)，将完整 MIT 许可文本及 `Copyright (c) 2026 NextProto` 保存在 [vendor/LICENSE](../vendor/LICENSE)，适用于协议副本及 Client 内联的上游代码部分。两处源码头均引用该文件；npm 包预检要求其随包分发并检查完整文本。此次许可证核对不代表已确定协议代码的来源 commit。

M2a 后续固定了 CLI/规范参考 commit `de42d1fbf19fc92064ac4688f71f42730c82267f` 并进行了部分实机验证，详见 [CLI 验证记录](cli-validation.md)。该固定参考补充了前述 main 分支核查，不代表已确认 vendored JavaScript 的来源。原始 CLI 的列表/录音确认和异常释放存在缺口；随包适配器针对这些已验证源码增加校验，并拒绝未知源码版本。不能把所有退出码 0 当作设备操作成功，扫描空结果、完整音频校验及其他边界仍需分别判断。适配器参数、超时策略与限制见[随包运行说明](../skill/references/runtime.md#bundled-cli-adapter)。

## Current Host configuration

以下字段由 `index.js` 导出的 Schemastery `Config` 校验，并已通过真实 Host 加载；尚未验证桌面设置界面的呈现。

| 字段 | 当前默认值 | 行为与限制 |
|---|---|---|
| `python` | `python` | 传给 `spawn` 的解释器路径/命令，需要在 Host 环境可用 |
| `repoRoot` | `process.cwd()` | 查找 `tools/qs668-bringup.py` 和 `tools/qs668-transcribe.py`，也是子进程工作目录；不保证等于插件目录 |
| `deviceAddress` | 无 | 除扫描和转写外必须配置非空值；缺少时在启动进程前报错，不使用上游缓存 |
| `outDir` | `archive/audio` | `importFirst()` 的默认输出参数；相对路径以 `repoRoot` 为基准，调用前转为绝对路径 |
| `cliTimeoutMs` | `190000` | Host 子进程运行时限，正整数毫秒；不改变适配器自身的 180 秒异步设备时限 |

当前 `transcribe()` 仅传递文件路径及可选 `--force`。没有实现 `transcriptionProvider` 配置，也没有集成 DSH 或本地转写服务。外部脚本是否支持某个后端，取决于实际使用的上游版本及配置。

后端选型已定：默认 `dsh`（复用 DSH 内置 speech-to-text），`doubao`/`openai`/`local` 为可选；M4 只做实现与验证，不重开选型。

`spawn` 继承 Host 环境并显式启用 Python UTF-8 I/O；不要假设插件会自动读取 `.env` 或注入转写密钥。文件输入路径同样受子进程工作目录影响，开发验证优先使用明确的绝对路径。

## CLI 获取与分发

当前开发约定是**使用单独获取的上游 checkout**，记录其 commit，并按该版本文档安装依赖。需要先确认脚本与参数存在，再将 `repoRoot` 指向它。本插件仓库不提供 `tools/`、上游协议文档或 `sdk/`。

外部 CLI 独立运行成功只能证明该 CLI 路径可用，不能证明 DSH 工具注册或浏览器导入已完成。

发布前需决定继续要求外部依赖还是随插件分发固定版本；两者均需说明版本、许可、安装方法与升级策略。本次文档不承诺自动下载或自动安装。

## 规划中的数据流与存储约定

首条目标流程为：Agent 工具 → Host → Python BLE 导入 → 完整音频 → 一种转写后端 → 关联的 Markdown。浏览器直接导入若后续接入，则由浏览器传输音频，再通过经过验证的接口交给 Host 落盘。

以下约定尚待实现和测试：

- 明确的数据根目录包含 `archive/audio/` 与 `archive/corpus/`，避免输出意外落到运行时目录。
- 导入完成并通过完整性检查后，才把文件视为可用音频；中断留下的部分文件不可视为成功。
- 以 `audio_sha256` 关联转写和音频，文件名相同不代表内容相同。
- 复用转写时同时检查指纹和有效正文；冲突时保留已有有效数据。
- 转写失败保留音频，分别报告导入结果和转写结果。
- 不删除卡内原件，不提交音频、语料、密钥或设备地址。

导入的原子发布、冲突后缀、音频哈希与阶段结果已实现并有离线回归；统一数据根目录、Markdown 元数据、转写复用及完整硬件验收仍属于 M3/M4。

## 待决事项

| 决策 | 解决阶段 | 需要的证据 |
|---|---|---|
| DSH Host/Skill 支持版本及加载接口 | M1 | 实际运行时检查和加载记录 |
| CLI 固定版本、Python/Bleak、系统/蓝牙及卡片兼容范围 | M2a | 独立 CLI 实机与单文件导入记录 |
| DSH 设备工具接口、互斥及子进程生命周期 | M2b | 工具调用、并发、取消及失败恢复记录 |
| DSH 导入目标、数据根目录及完整性 | M3 | 经工具执行的单文件导入和失败恢复记录 |
| Slot、Client–Host 通信及浏览器直连兼容性 | 可选增强 | 单独的界面与连接交接记录 |
| 转写后端实现与验证（默认 `dsh`，doubao/openai/local 可选）及归档格式 | M4 | 成功、复用、冲突与失败场景 |
| CLI 分发方式及发布渠道 | M5 | 干净环境安装和发布包验证 |
