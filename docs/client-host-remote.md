# Client→Host Remote：实现与验证

状态：0.4.0 实现单图标、持续连接和对话引导，0.3.1 使用旧配置卡片。下文按日期保留各次候选构建的验收证据和当时的未发布状态，不将旧证据扩大为后续修复已实机验收。最新发布状态见 [RELEASE](../RELEASE.md)。

## 调用路径与配置

`client.js` → `ctx.remote.recorder` → `recorderController` → `recorder` Service → 随包 Python CLI → Host 蓝牙。

[index.js](../index.js) 在同一插件生命周期内创建一个 [RecorderService](../runtime/service.js)，工具直接使用该实例，Remote 通过 Cordis 注入同一服务。主 Loader 条目仍只有 `recorder-card`：无需重复 Service 配置，也不新增三个各自持有配置的条目。子控制器等待 `recorder` 和 `typert`；缺少 Gateway 的 headless 场景不会阻塞八个 Agent 工具。

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

## 十二个方法（0.5.0 新增 importFile，0.4.0 为十一个）

| 方法 | 业务参数 | 返回值 |
|---|---|---|
| `connect(address?, signal?)` | 缺省重连已保存设备；空字符串清除选择后扫描 | `{ status, name, address?, devices?, message? }`，多设备返回 `selection-required` |
| `disconnect(signal?)` | 无 | 同上，成功状态 `disconnected`；释放失败走错误通道 |
| `connectionState(signal?)` | 无；只读 Host 内存，不访问 BLE | 同上；由 Bleak 断线回调更新 |
| `getDevice(signal?)` | 无 | `{ deviceAddress, source }`，source 为 `saved / config / none` |
| `saveDevice(address, signal?)` | 设备标识字符串；空字符串清除选择 | 同上，持久化成功后返回 |
| `scan(signal?)` | 无，不需要设备地址 | `{ code, out, err }` |
| `status(signal?)` | 无，使用 Host 配置的地址 | 同上 |
| `list(signal?)` | 无，使用 Host 配置的地址 | 同上 |
| `record(action, signal?)` | `state / start / pause / resume / save` | 同上；`state` 调用只读状态方法 |
| `importFirst(options, signal?)` | `options` 可为 undefined；字段 `outDir?`、`transcribe?` | `{ status, import, transcription, cleanup }` |
| `importFile(filename, options, signal?)` | 完整卡内文件名；`options` 同上，可传 undefined | 同一导入结果结构；已连接时复用原 Session |
| `transcribe(file, force, signal?)` | 非空路径，`force` 为 boolean 或 undefined | `{ status, provider, recognizer, path, audioPath, audioSha256, reused, fallbackReason? }` |

普通进程结果不等于全工作流成功，扫描无结果不等于发现设备。导入 `partial` 会分别显示转写失败与清理未确认，并保留已保存音频路径；转写重试不再次导入，且不能清除之前的连接释放警告。未知错误由 Gateway 统一处理，已知 CLI/配置/取消/超时错误映射为稳定 Remote 错误码。

## Client 生命周期与界面边界

工作区的 ProcessResult、ConnectionState、ImportResult 增加可选 `diagnostics`，Host 与内联 Client 契约同步；已知错误经 `RemoteError.details.diagnostics` 保留同一结构。只含阶段、计数和时间等固定字段，拒绝未知字段；转写结构不变。worker 的内部心跳不作为 Client 订阅流暴露，界面不展示完成百分比。字段含义、取消后落盘及离线验证见[传输诊断](import-recovery.md#transfer-diagnostics)。

客户端 manifest 声明 Gateway 依赖，`apply()` 先 `$mount`，等待 `remote.recorder`、`slots`、`sessions` 和 `conversation`，注册列表 Slot `conversation.input.left`，避免覆盖语音输入占用的单项 activity Slot。组件卸载取消自己的连接请求和状态轮询；已建立的 Host 会话属于共享 Service，切换对话不主动断开。Host 插件卸载释放连接和子进程。跨 Agent 与图标操作在同一连接上串行化；整个持续会话占据模块级 BLE 队列，其他实例不能启动竞争进程。

录音卡图标点击后连接上次设备；首次扫描仅一个结果时自动连接并保存，多设备时通过对话选择。灰色/闪动/绿色分别表示未连接/连接中/Host 确认连接；每 1.5 秒读取 `connectionState()`，不会轮询 BLE `status()`。连接中再次点击取消。右键或 Shift+F10 提供断开、切换设备。错误提示是固定浮层，不挤占工具栏。

对话接口核对自安装版 DSH 0.2.0-rc.2 的 `dsh-client-ui-conversation/lib/client.js`：使用 `ctx.sessions.scope(sessionId).get("conversation").send(text)`，发送到点击时的会话，保留草稿；不伪造 Assistant 消息。成功提示只请求引导，禁止自动导入、录音和上传。多设备名以 JSON 数据传入，要求 Agent 等待用户选择，再调用 `recorder_connect`。没有会话/模型不可用时保留明确失败提示，不宣称已得到 Agent 回应。

`recorder_worker.py` 使用固定上游 Session，保持连接并串行执行原有完整列表、录音确认与安全导入逻辑。失败操作关闭会话以隔离迟到帧；已发送操作的取消/超时终止整个进程树。导入成功时 `cleanup.status: retained` 表示 Host 有意持有连接，可继续对话操作，不等于连接已释放。一次性 CLI 路径仍返回 succeeded/not-needed/unconfirmed。首次断开失败不因上游清空 client 或再次 disconnect 返回而消失。

意外断线同时唤醒 worker 的等待逻辑并取消正在执行的设备操作；Host 收到断线事件后停止接受新请求、关闭 stdin，使 Python 读取线程也能退出。共享队列仍等到进程/管道关闭才释放，不能仅凭 disconnected 状态启动竞争操作。10 秒内未退出时升级为进程树终止并提示释放未确认。持久会话内尚未发送的排队请求取消后立即返回 AbortError，不写入设备、不终止前一请求；只有已发送请求的取消才终止会话。

生产 Client 不依赖 `navigator.bluetooth`。退役实现迁入 `tests/fixtures/legacy-web-bluetooth.js`，仅用于历史回归，不随包分发。图标为录音卡轮廓；样式使用宿主别名 token，绿色使用安装版实际提供的 `--dsw-alias-state-success-primary`，不导入私有 UI 包。

清理失败单独保留为连接终态 `cleanup-unconfirmed`，并附带 `message`，不同于导入结果中的 `cleanup.status: unconfirmed`。Python 的空闲退出 finally 也通过事件发送首次断开失败；Host 收到后不会被随后的普通断线事件、进程关闭或重复 disconnect 覆盖。没有事件的非零/异常退出也保守报告释放未确认。Remote 契约、Agent 连接结果及图标均支持此状态，UI 显示检查设备提示。

进程退出后全局队列可以结束旧占用，但旧请求不能静默继续：警告发生前已排队的每个请求均以 `CleanupError` 返回，不启动设备操作；尚未收到该警告的其他 Service 实例，其首次设备请求也先返回错误。调用方收到后应提示用户检查设备，再明确重试，不能自动循环重试。此机制是错误通知，不是验证用户已实际检查设备。新的连接确认成功后清除共享通知，但其他已失败实例仍保留自己的清理终态；独立转写不受设备队列通知影响。

## 契约维护

[runtime/remote-contract.js](../runtime/remote-contract.js) 是描述符与 wire 校验的唯一维护来源，Host 和 `typert.remote-client.js` 直接导入它。运行 `npm run sync:client` 将无依赖工厂复制到浏览器 ModuleLoader 入口；生成结果提交入库，用户无需构建。`npm test` 首先检查副本漂移。新增方法时同时更新控制器、契约、UI（如需）与验证。

## 2026-11-01 单图标与持续连接自检（未发布）

- 本轮为开发者自检。103 项 Node、51 项 Python 回归通过；包含官方 Gateway 的连接/选择/retained 导入契约、Agent 选卡/断开工具、连接取消、组件/插件卸载、掉线通知、跨实例 BLE 占用及上游真实 Session 首次断开失败。Python 使用模拟 Bleak，未访问无线设备。
- 使用用户已确认就绪的测试卡，在隔离数据目录通过随包 worker 完成连接、读取状态、保持 5 秒、主动断开、再次连接与退出清理；未录音、导入、删除或上传音频。
- 本地候选包安装到隔离 DSH Desktop 0.2.0-rc.2 profile，真实 `dsh-app:` 创造模式页面显示 30×30 单图标；连接后为绿色 `rgb(34, 197, 94)`，原工具栏不再展开配置表单。右键菜单主动断开通过。
- 在输入框保留合成草稿后点击图标，连接引导确实进入同一会话，草稿内容未被覆盖。模型执行随后报 `MISSING_CREDENTIAL`，因为该隔离环境没有 API Key；不将“提交引导成功”写成“Agent 回复已验证”。过程中发现会话作用域属性访问必须改为 `get("conversation")`，已修复并加入回归。
- 主题变量依据本机安装版 `dsh-client-ui-theme/lib/client.js` 核对；未使用旧界面中不存在的 content/background-primary 别名。最终样式使用 label、bg-layer、border-l2 和 state-success-primary 系列。
- 最终主题检查使用真实 Electron 页面的系统主题媒体模拟：未连接图标由浅色模式 `rgb(97, 102, 107)` 切换为深色模式 `rgb(207, 211, 214)`；菜单背景分别为白色与 `rgb(44, 44, 46)`，宽高均保持 30×30。未验证操作系统主题持久化。候选 tarball SHA-256 为 `08a05a8de8d28142b05e13d701c7ed0d3ac3655765057146f29da1f6f550c48c`；此后仅调整 Host 缩进与文档，不据此声称 npm 发布。
- 原始结果在忽略目录 `.cache/ui-live/`，设备配置、日志及截图不提交。测试包沿用工作区 0.3.1 元数据仅供本地安装，与 npm 已发布 0.3.1 内容不同；没有发布、提交或修改日常 DSH profile。
- 仍未验证物理意外断电/距离掉线、多个实体设备选择、持续会话完整导入恢复及有凭据的 Agent 回复。上述异常已有模拟覆盖，不替代实机验收。

## 2026-11-01 队列问题修复自检（未发布）

此前单图标构建的提交前复核发现断线后队列未释放、排队取消延迟两个 P2，现已修复并完成开发者自检：109 项 Node、53 项 Python 测试、包预检及 diff 检查通过。新增测试先复现失败，再验证排队取消不影响活动请求、断线后等待进程关闭才释放全局队列、退出超时升级终止，以及实际 Python 子进程在空闲/执行中模拟断线后退出（使用固定上游 Session、模拟 Bleak）。忙碌断线和首次清理失败同时发生的错误保留也通过。原始输出位于 `.cache/ui-live/qa-queue-*.log`；本次没有真实 BLE、DSH 或物理断线复测，不替代下一轮独立 QA。

## 2026-11-01 空闲清理失败上报自检（未发布）

先用固定上游 Session、模拟断开失败复现 Python 空闲清理缺少通信事件，并复现 Host 在非零退出后覆盖终态。修复后，真实 Python 子进程模拟空闲清理失败，确认 `cleanup-unconfirmed` 和首个错误信息保留到进程退出后；两项已排队扫描及新实例的首次扫描均返回 `CleanupError`，没有启动 BLE 操作。调用方收到错误后可明确重试，新连接成功能清除共享通知，但不会覆盖旧实例的终态。另覆盖没有清理事件的异常退出、官方 Remote 的状态/错误传输，以及组件在 worker 退出后才挂载时的警告显示。去掉一项重复的退出超时测试后，113 项 Node、54 项 Python 测试通过；包预检、契约同步及 diff 检查通过。原始记录位于 `.cache/ui-live/qa-idle-*.log`。本轮为开发者自检，没有真实设备或 DSH 桌面复测，尚待独立 QA。

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
