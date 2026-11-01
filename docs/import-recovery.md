# 按文件名导入与恢复边界

## 2026-11-02 用户实机反馈

用户报告已跑通「持久连接 → 对话引导 → 本地 SenseVoice 转写 → 指纹归档」，调试约 2 小时 35 分钟；同时报告同步 13 条录音时 10 条因空闲超时/掉线失败。此处记录用户反馈，不等同于本轮开发者重新执行的实机测试，也不代表所有恢复场景通过。

0.4.0 工具只能选择首条，迫使用户在需要其他录音时切到外部 CLI。外部进程无法使用 Host 已占有的 BLE 会话，这才引入释放、等待广播、再导入的交接。本轮优先消除这个工具缺口。

## 0.5.0 实现（发布状态见 RELEASE）

1. `recorder_list` 获取列表后，调用 `recorder_import({ filename: "列表中的完整文件名" })`；省略 `filename` 保持首条行为。仅精确匹配，不做大小写/扩展名猜测，不接受本地路径或逗号列表，找不到或重名歧义则失败。
2. Agent 与 Remote 共用 `RecorderService.importFile`。已连接时走 `connectedCall("importFile")`，worker 在同一个上游 Session 内读取完整列表、选择、导入；成功仍返回 `cleanup: retained`。可选转写随后走共享 DSH 管线，不为转写另开 BLE 连接。
3. 未显式连接时，Host 走原有一次性适配器，使用单个 `--filename=<name>` 参数。固定上游的 `--import-first`、`--import-all`、`--filename` 三者互斥；不采用 `--import-all --filename` 组合。
4. 每次导入一条。多条用户已选录音由 Agent 顺序调用并记录每条结果，失败即停；不引入无人确认的整卡下载或自动批量重试。
5. 新增 Remote `importFile(filename, options?, signal?)`，仍返回原有导入/转写/清理分阶段结构；`importFirst` 保持兼容。客户端契约已同步，不恢复工具栏配置表单。

固定协议的列表名称字段只有 20 字节，`noteYYYYMMDD-HHMMSS.wav` 可能显示为 `noteYYYYMMDD-HHMMSS.`。工具参数应使用列表返回的原字符串（包括末尾点号），传输函数会按固定上游规则恢复扩展名。用户提供完整文件名时，Agent 应先核对其唯一对应的列表项；不能直接把自行补出的扩展名传给精确匹配接口，也不能在存在歧义时随意选一条。

## 中断与重试

| 错误 | 含义 | 恢复方式 |
|---|---|---|
| `RECORDER_DEVICE_DISCONNECTED` | worker 观察到断线回调，或传输异常时客户端明确不再连接 | 检查设备并重新连接，再明确重试失败文件 |
| `RECORDER_TRANSFER_INTERRUPTED` | 上游传输未完成，但没有确认物理掉线 | 不把它解释为必然掉线；重新建立会话后从头重试 |
| `RECORDER_CLEANUP_FAILED` | 连接释放仍未确认，优先于普通传输错误 | 先处理设备占用/释放问题，不自动重试 |
| `RECORDER_ABORTED` / `RECORDER_TIMEOUT` | 调用取消或执行时限到达 | 检查设备及已有输出；强制退出不保证清理完成 |

导入沿用暂存、PCM 完整性检查、SHA-256 和原子不覆盖发布。普通中断清理暂存；强制结束可能留下暂存目录，不能将其视为成功文件。音频已成功但转写失败时，只重试返回路径的转写，不重新传输音频。

固定来源为 `de42d1fbf19fc92064ac4688f71f42730c82267f`。`vendor/upstream/tools/qs668_protocol.py` 的 `cmd_import_file(filename, offset=0)` 编码 32 位小端 offset；`qs668-bringup.py` 的 `import_file` 始终传入 0，把通知数据暂存在内存中。字段存在不足以证明固件支持跨连接续传：仍需核实偏移计量单位、重连后文件身份、响应是否重发头部/重叠数据、完成状态与完整性校验。因此本轮不启用 offset，不改固定上游文件和哈希，不声称支持断点续传。自动重连和小批恢复另按路线图验收。

## Transfer diagnostics

2026-11-02 在上述指定名称导入之后补充，纳入 0.5.0；发布状态见 [RELEASE](../RELEASE.md)。本轮用户选择先完成诊断代码和离线验证，因此没有连接录音卡、启动真实 DSH 或调用 ASR。下文历史实机候选包不包含这些诊断变更。

适配器观察固定上游 Session 已有的导入写入和解析后通知入队，不额外读取通知、不改变帧顺序或超时策略，不修改 vendored 源文件及哈希。持久 worker 的请求通过内部心跳发送快照；一次性导入把快照写入既有原子报告，均约每秒一次。Host 在成功、异常、超时或取消时携带最近一次有效诊断；原有完整性检查与不覆盖发布仍决定导入是否成功。

| 字段 | 含义与排查方式 |
|---|---|
| `version`, `operation`, `phase`, `outcome` | 固定版本 1、操作及最近阶段；结果区分 running/succeeded/failed/cancelled。仅描述设备操作，不能替代可选转写状态。 |
| `failedPhase` | 首个观察到失败的阶段。`importWrite` 表示原有写入调用未返回；`transfer` 且无 `firstFrameMs` 表示截至快照尚未观察到导入通知，不能据此判定物理掉线。 |
| `queueMs`, `elapsedMs`, 阶段 `*Ms` | Host 排队、执行总耗时和扫描/连接/状态/列表/导入写入/传输/校验/发布/清理耗时。阶段可嵌套，不能相加当作总耗时；没有观测值则省略。 |
| `firstFrameMs`, `firstDataMs`, `lastDataMs`, `endFrameMs`, `endCode` | 从操作开始到首个导入帧、首/末数据帧和完成通知的时间偏移，及完成码；均非墙钟时间，完成码 0 也不替代 WAV 完整性验证。 |
| `bytesReceived`, `dataFrames`, `attempts` | 观察到的 2-4 数据帧负载字节、帧数和导入命令写入次数。聚合固定上游的尝试，非去重字节数、文件偏移或完成百分比；列表大小与解码后 PCM 大小不能直接相比。 |
| `cleanup`, `snapshotAgeMs` | 清理独立状态和最后快照距收到/写入时的年龄。强制终止后保留计数但标记清理未确认；最后一段数据可能未进入快照。 |

Host 缺少 Python 快照时只能提供排队/启动阶段和已观察计数，不能据此宣称设备未执行。明确尚未派发的排队取消才标记 `cleanup: not-needed`。当前诊断覆盖持久请求和一次性导入；一次性扫描/状态/列表/录音、独立 ASR 暂不输出这些字段。没有新增用户进度流、自动重连、批次下载或字节续传。

成功结果增加可选 `diagnostics`；Remote 错误使用 `details.diagnostics`，Agent 的稳定错误码不变，消息末尾附有界 JSON。官方 DSH 工具取消逻辑会替换错误消息，故共享 Service 另将最近一次有诊断的操作原子写入 `dataDir/recorder-diagnostics.json`，格式为 `{ recordedAt, diagnostics }`。文件只保留一条，后续有诊断的操作会替换它，排查前应先保存；写入失败仅告警，不掩盖操作结果。内容不含原始帧、音频、文件名、路径、设备标识或转写，并纳入忽略/包内容检查。

开发者离线自检：129 项 Node、63 项 Python 通过。新增用例覆盖固定上游 Session 的分片解析计数、写入阻塞与无通知区分、完成帧后的截断 WAV 拒绝、心跳与第一次断开失败、请求间快照隔离、排队取消、强制超时/取消、清理错误传递、官方 Tool/Gateway 契约、原子覆盖诊断文件及存储失败不掩盖主错误。这是本会话自检，非独立 QA；非首条、长音频、连续导入和中断恢复仍待实机验收。

## Profile upgrade

用户报告插件管理器升级到 0.4.0 时，profile 的 `cordis.patch.yml` 丢失 `repoRoot` 与 `agent-default-model` 条目。当前尚未复现，不能认定这是正常行为，也不能确定具体写入者。

本轮核对本机 `E:/dshwork/dsh-src` 中 `@deepseek-ai/dsh-plugin-manager` 0.2.0-rc.2 参考源码：

- `lib/index.js` 的 `installBundle` 安装后通过 `selectBundle` 更新 profile `package.json` 的 bundle 选择；已有 bundle 不重复添加。
- `lib/types/patch.js` 的 `writePluginEnabled` 解析已有 YAML，只修改匹配条目的 `disabled` 或追加启停覆盖项，保留其他条目；这段代码不支持“升级应删除无关模型配置”的结论。
- 该核对没有重演用户当时安装版、profile、并发编辑及重载路径，不足以定位此次丢失。录音卡插件自身不负责重写 profile patch。

升级操作采用以下人工核对步骤：

1. 确认正在使用的 profile 路径；把其 `cordis.patch.yml`、`package.json` 复制到私密备份目录，记录时间与升级前版本。不要把设备地址、模型凭据或整个 profile 提交到本仓库。
2. 升级并重启 Host 后，对比 patch 的条目及配置值，检查模型、`speechToText`/识别器、录音卡的 `python`/`dataDir` 等覆盖项；不要仅以图标出现判定配置全部保留。
3. 配置缺失时先保存升级后副本和管理器日志，再按差异恢复需要的条目并复验。不要盲目用旧文件覆盖升级后所有变化。
4. 若再次复现，准备不含敏感数据的前后 patch、安装命令/管理器操作、DSH 版本与时间，定位实际写入来源后再向 DSH 提交缺陷。

`repoRoot` 在随包 CLI 下通常无需配置，但删除无用开发覆盖不应连带删除默认模型条目。用户设备选择仍保存在 `dataDir/recorder-settings.json`；本轮不修改日常 profile 或升级策略。

## 本轮开发者自检

基线为 `25bb98d`，开始时已有用户对 [ROADMAP](../ROADMAP.md) 的未提交修改，已保留并补充实现边界。119 项 Node、58 项 Python 离线测试通过，覆盖：

- 真实固定上游 Session/导入函数配合模拟 Bleak，精确选择非首条、连续导入仍用同一连接、重名发布不覆盖；不存在/大小写不同/仅 stem 的选择不退回首条。
- 一次性参数只包含一个文件名；Agent 注册表与官方 Client/Host Gateway 传递选取参数、分阶段结果和稳定错误码。
- 共享 Service 在持久连接内导入并转写，不启动一次性 CLI；模拟掉线时取消传输、清理暂存且不报告成功。
- 原有取消、清理失败、归档与协议回归继续通过。

这些是开发者自检，不是独立 QA。上述离线阶段没有访问真实录音、云端 ASR 或日常 DSH。后续实机执行记录如下；非首条、长音频传输和中断后重连仍需验收。

## 2026-11-02 指定名称实机验收

- 用户指定一条测试 WAV 并确认设备就绪。检查发现日常 DSH 持久 worker 仍占有蓝牙；用户通过图标菜单断开后，确认录音卡进程数为 0，才启动隔离验证，没有强制终止日常 DSH。
- 将工作区候选 npm 包安装到 `.cache/named-live-20261102/dsh-home` 的独立 headless profile，使用真实 DSH 0.2.0-rc.2 Host（Node `v24.18.1`）、既有 Python 3.12.7/Bleak 环境及包内固定 CLI。候选包仍使用 `0.4.0` 元数据，仅供本地验收，与 npm 已发布 0.4.0 不同；SHA-256 为 `aec7535316f1a60c50c26b7f82e749609bf7924b12cab821f9c797b09ca03022`。安装后核对工具、Service、Host CLI 与 worker 文件内容一致。
- 首轮连接和读取 13 条列表成功，但用户提供的完整 `.wav` 名称不等于列表截断名称，精确匹配检查中止，未调用导入。核对固定协议后，确认完整名称唯一对应列表中以点号结尾的 20 字节名称，再把列表原名传给 `recorder_import.filename`。
- 第二轮北京时间约 03:17:56–03:19:08，通过真实 `ctx.tools.execute` 完成连接、列表、指定名称导入。未转写、录音或删除。返回 `status: succeeded`、`cleanup.status: retained`、`transcription.status: not-requested`。
- 输出为 169,004 字节、16 kHz 单声道 PCM16 WAV，84,480 帧、5.28 秒。重新读取文件计算 SHA-256，与工具返回值一致；独立 Python wave 读取全部采样帧通过，且文件内容哈希与此前用户已确认播放正确的测试音频一致。本轮没有再次人工试听。
- 导入后共享 Service 与真实 Host Remote `connectionState` 均返回 `connected`；再次通过 Agent 工具读取列表成功，仍有 13 条，原测试录音仍在。结束时主动断开返回 `disconnected`，进程检查确认没有残留录音卡 worker。
- 本次指定录音恰好位于列表第 1 条：验证了 `filename` 参数走真实 Agent/Host/worker 链路及持久连接保留，**不能替代非首条选择的实机证据**。非首条仅有离线回归；13 条批量恢复、物理掉线/续传、桌面 Client 新方法及本轮转写仍未验证。

原始报告、安装/Host 日志和音频位于忽略目录 `.cache/named-live-20261102/`；便于本地播放的副本为 `archive/audio/named-import-test-20261102.wav`，同样忽略且未覆盖现有音频。本轮没有修改日常 profile、提交、推送或发布。后续仅补充了 Skill 的列表截断名称说明，候选包哈希对应运行时验收时的包。
