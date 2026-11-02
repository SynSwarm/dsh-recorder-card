# dsh-recorder-card

[English](README.md) · [贡献指南](CONTRIBUTING.md) · [路线图](ROADMAP.md) · [架构](docs/architecture.md) · [更新记录](CHANGELOG.md)

**把实体录音卡里的线下录音带进 DeepSeek Harness（DSH）**：在对话中选取录音，通过 BLE 导入，再按需转写和归档。

**使用前需要一张兼容的实体 BLE 录音卡**，以及运行 DSH Host 的电脑上的 Python 3.11+、蓝牙硬件和权限。远程 Host 使用它所在机器的蓝牙；具体卡片和固件兼容性仍需验证。

> **第三方开发预览。** npm 0.5.0 已提供按名称导入和传输诊断；一条短测试录音通过真实 DSH 导入和音频校验，本机 SenseVoice 转写及归档复用另有 Host 验证。非首条、长录音、中断恢复及远程录音控制尚未完整验收。工作区新增的慢链路修复**尚未发布**。[开始安装](#安装与首次使用) · [验证状态](#当前状态) · [发布记录](RELEASE.md)

## 项目用途

面向已经使用录音卡记录会议、采访或语音笔记的用户：录完后把音频带入 DSH 工作流。采集发生在卡片上，使用时无需通过电脑麦克风录制。

实现依据[上游 AI 录音卡协议](https://github.com/nextproto1024/ai-recorder-card-open-protocol)。具体卡片和固件是否兼容，需要实测确认；产品名称相同不代表协议兼容。

**音频路径：** 录音卡 → BLE → DSH Host 上的随包 Python CLI → 本地音频 → 可选转写及指纹关联的 Markdown 归档。

- 点击一个图标连接，在对话中查看列表并选择卡内文件原名。
- 导入本地目录前检查 PCM 完整性，已有音频不覆盖，卡内原件保留。
- 需要时再请求转写，优先使用已准备好的 DSH 识别器；云端回退会上传音频，需明确提出转写。

连接图标与八个 Agent 工具共用持久 Host 服务，无需 Web Bluetooth 或单独 clone 上游。运行边界见[架构](docs/architecture.md)，已经测到哪一步见[验收记录](docs/import-recovery.md)。

连接清理失败时，图标会保留“连接释放未确认”警告，待执行的设备请求先返回错误、不访问 BLE；请检查设备后再明确重试。进程退出本身不代表设备清理成功。

## 安装与首次使用

以下适用于 0.4.0 及以后版本。0.3.x 使用旧配置卡片界面，更早版本可能仍要求外部 checkout。安装方式：

```sh
dsh plugin add dsh-recorder-card
python -m pip install bleak requests
```

Python 依赖只需安装一次，使用与插件 `python` 配置相同的解释器。也可在插件安装目录运行 `python -m pip install -r vendor/upstream/tools/requirements.txt`。

Host 需要 Python 3.11+、可用蓝牙及访问权限。插件已包含固定版本 Python CLI，无需 clone 上游或填写 `repoRoot`。如果 `python` 不在 DSH 的 PATH 中，在插件 `python` 字段填写同一个解释器的绝对路径。

1. 先唤醒卡片，断开手机和其他蓝牙客户端。点击录音卡图标，或让 Agent 调用 `recorder_connect`，自动连接并保存选择，无需填写地址。多设备时等待你选择。
2. 在对话中说“查看录音列表”或“断开录音卡”。切换设备可用图标右键菜单，或让 Agent 用 `recorder_connect` 的空地址重新扫描；高级 `deviceAddress` 配置仍作为回退保留。npm 0.3.1 用户继续使用原卡片的设备地址输入框。
3. 调用 `recorder_list`，选择允许导入的录音。0.4.0 仅导入首条；0.5.0 支持 `recorder_import({ "filename": "列表中的完整文件名" })`，省略 `filename` 保持首条行为，默认不转写。多条按用户选定顺序逐条调用，遇到传输错误即停止，不必切到手动 CLI。
4. 默认音频位于 Host 用户目录 `~/.dsh-recorder-card/archive/audio/`；以工具返回的绝对路径为准。转写是单独的可选步骤：DSH 本地识别器需要先准备模型；豆包云端需要 ASR 凭据。扫描和导入不需要转写凭据。

DSH/pnpm 若配置 `minimumReleaseAge=1440`，新版本发布 24 小时内可能暂时无法安装；等待成熟版本即可，不修改年龄门槛。

升级前备份当前 profile 的 `cordis.patch.yml` 与 `package.json`，升级后比较自定义配置，并验证所选模型与转写服务仍生效。配置丢失的原因尚未复现，不能视为正常升级行为；见[升级核对记录](docs/import-recovery.md#profile-upgrade)。

新增错误码区分 `RECORDER_DEVICE_DISCONNECTED`（已观察到掉线）与 `RECORDER_TRANSFER_INTERRUPTED`（传输未完成，不能据此判定掉线）。检查设备、重新连接后可明确重试该文件，当前从头传输，不支持字节断点续传或自动重连。清理未确认时先处理清理警告；已经导入成功但转写失败时仅重试转写。

0.5.0 另补充传输诊断：分阶段耗时、收到的帧数/字节数，以及中断时最后快照的新旧程度。Host 将最近一次诊断写入 `dataDir/recorder-diagnostics.json`，不包含音频、文件名或设备标识。计数不代表完成百分比或音频完整性，界面尚无进度流。字段与边界见[诊断说明](docs/import-recovery.md#transfer-diagnostics)；本项仅完成离线验证。

缺依赖时，错误会给出当前 Python 的安装命令。可在已安装插件目录执行 `python -B runtime/recorder_cli.py --check-deps` 做无蓝牙检查。完整平台支持范围及新用户实机验收仍以[发布验证记录](docs/distribution-validation.md)为准。

## 当前状态

“已有实现”仅表示存在代码，不代表已经通过 DSH 或硬件测试。已记录 Windows 上 DSH Desktop 0.2.0-rc.2 隔离 headless profile 的 Host 基线。

| 能力 | 实现状态 | 验证情况 / 剩余工作 |
|---|---|---|
| Bundle 清单和 Skill provider | 已实现 | M1 隔离 DSH 验证通过：加载、Skill 访问、启停与子进程清理 |
| 单图标连接及对话引导 | 0.4.0 已实现 | 原生桌面连接变色、引导提交及草稿保留通过；模型回复、物理掉线及多实体卡待验证 |
| 通过对话导入录音 | 首条和按列表原名导入均已随 0.5.0 发布 | 真实 DSH Agent 指定名称导入及连接保留通过；测试文件位于首条，非首条与中断恢复待实机复测 |
| 浏览器直连 BLE | 已从发布入口移除 | 旧实现仅保留为历史回归测试夹具 |
| Host 调用 Python CLI | 固定源码适配器及进程管理层已实现 | 内部列表调用实测、队列/取消本地测试通过；DSH 生命周期已验证，硬件工具验收待完成，固定 CLI 源码已随包分发，无需另行 clone |
| `recorder_*` Agent 设备工具 | 八个工具已注册，提供配置 schema 与结构化进程结果 | schema、错误及取消测试通过；真实 Host 转写/复用通过，硬件操作仍待验收 |
| 可选界面的 Client–Host 通信 | 0.5.0 十二个方法；0.4.0 为十一个 | 新增 `importFile`，见[设计与验证](docs/client-host-remote.md)；没有传输进度流 |
| 转写后端与归档完整性 | 已实现音频/Markdown 安全发布、指纹复用与分阶段结果 | DSH 本机 SenseVoice 转写与工具复用通过；完整硬件恢复仍待验收 |

验收标准见 [ROADMAP.md](ROADMAP.md)。[独立 CLI 部分实机记录](docs/cli-validation.md)已验证扫描、状态/列表响应及一条录音的传输与 WAV 完整解码；用户已确认播放正常、内容正确，录音控制和其他验收项仍待完成。后续已通过内部 Host 列表调用实测；远程开始录音无确认，实体键录音保存后列表成功增加。完整 DSH 工具验收仍未通过。

导入已保护同名音频，完整暂存文件在冲突时另取名字发布，并分别返回导入和转写状态。发布前验证 RIFF/WAVE PCM 结构，截断或未知格式报告未确认。转写失败或连接清理未确认返回 `status: partial`，并保留独立阶段详情，不能视为全流程成功。见[运行合约](skill/references/runtime.md#safe-import-and-separate-transcription-results)。

本地回归覆盖官方 Client/Host Gateway 的进程内 JSON 通信、卡片 hooks、取消、部分导入结果，以及与 Agent 工具共享服务。旧浏览器 BLE 测试保留为历史回归。运行 `npm test`；限制见[本地检查](CONTRIBUTING.md#local-checks-without-hardware)，不能替代桌面或实机验收。

点击录音卡图标，自动连接上次设备；首次使用时扫描，只有一张卡时连接并记住，多张卡时在对话中选择。灰色表示未连接，闪动表示连接中，绿色表示 Host 确认 BLE 连接；连接中再次点击可取消。连接成功后向当前对话发送引导请求，保留输入框草稿；列表、首条导入和转写通过对话完成。右键或 Shift+F10 可断开、切换设备。工具栏不再展开配置表单。转写须明确提出，云端回退会上传音频。

工作区另新增可选导入预算预检，尚未发布：提供有明确依据的 `preflight: { expectedBytes, bytesPerSecond }`（预计导出字节数、参考负载速率），估算超预算时开传前拒绝并建议 `cliTimeoutMs`。省略参数保持原流程；卡内列表大小不是导出 WAV 大小，通过预检也不保证传完。见[用法与限制](skill/references/runtime.md#import-budget-preflight)，本项待 QA 与实机验证。

## 开发环境要求

**工作区慢链路修复，尚未发布**：`cliTimeoutMs` 同步到两条 Python 路径；导入空闲阈值在 12–20 秒内适应帧间隔，补充间隔统计，并在传输中止后检查本地断开及有界重新广播。需要 10 分钟 Python 操作预算时，可配置 `cliTimeoutMs: 610000`，其中 10 秒留给启动/清理。本项仅离线验证，不提高 BLE 速率，也不新增自动批量恢复或字节续传。见[范围与待验收项](docs/import-recovery.md#slow-link-fixes)。

- 提供插件开发能力的 DSH 环境；已有 Windows DSH Desktop 0.2.0-rc.2 基线，其他版本及 profile 仍需验证。
- 可选卡片需要 DSH Client Gateway 和会话活动 Slot；蓝牙设备与权限位于 Host，不依赖浏览器 Web Bluetooth。
- 本地语法检查需要 Node.js；最低支持版本待结合目标 DSH 运行时确定。
- Host CLI 主线需要 Python 3.11+ 与 Bleak/requests；源码及依赖清单位于 `vendor/upstream/tools/`，随 npm 包分发。

## 首次开发验证

1. 完成[贡献指南](CONTRIBUTING.md)中的本地检查；在计划运行 Host 的机器上准备 Python/Bleak 并检查包内 CLI 和蓝牙环境。
2. 先做 M2a 独立 CLI 实验：扫描、状态、列表和一条非个人录音的导入/播放验证，再补齐录音控制和异常场景。它不依赖 DSH 加载通过。
3. 在目标环境复现 [M1 Host 验证](docs/dsh-integration.md)。Windows 隔离环境基线已通过；卡片显示仍单独记录为可选项。
4. 具备 M1 加载与相应 M2a 设备基础后，按 M2b → M3 → M4 验证工具、导入与转写；远程录音控制单列兼容性验收，不阻挡已有录音主线。分别记录实现、离线与实机结果，独立 CLI 成功不代表插件完整流程可用。

## 架构

| 组件 | 文件 | 当前职责 |
|---|---|---|
| Host | [index.js](index.js) | Skill/工具注册、共享 recorder Service 和 Remote 控制器 |
| Agent 工具 | [runtime/tools.js](runtime/tools.js) | 八个录音卡工具；进程完成与设备/文件验收分别报告 |
| Host 进程管理 | [runtime/host-cli.js](runtime/host-cli.js) | 共享设备队列、参数检查、时限、取消及停用清理；真实 DSH 待验 |
| CLI 适配器 | [runtime/recorder_cli.py](runtime/recorder_cli.py) | 校验随包源码、列表/录音确认、单进程时限与连接清理 |
| Client | [client.js](client.js) | 调用 Host Remote 的 React 卡片；不持有浏览器 BLE 连接 |
| Skill | [skill/SKILL.md](skill/SKILL.md) | 能力检查、资源定位及设备操作约束 |
| 协议 | [vendor/recorder-protocol.js](vendor/recorder-protocol.js) | CRC、组帧、解析及命令原语 |
| 加载配置 | [cordis.patch.yml](cordis.patch.yml) | 插件加载条目 |

BLE 连接归属、随包 CLI 配置及规划中的数据流见[架构与待决事项](docs/architecture.md)。

## 转写与归档

0.3.1 修复：缓存返回前重新核对当前音频指纹；相同内容移动或复制到新路径时，复用正文并另存关联当前路径/标题的 Markdown，保留旧归档。推算时间沿用原始来源，记录在 `transcription_source_audio` / `recorded_at_source_audio`；这些是历史来源，不是当前音频链接。

`transcriptionProvider` 默认为 `dsh`：使用 Host 的 `speechToText` 服务及其所选识别器，不等于调用 DeepSeek 云 API。使用前须分别确认：相关包可供 Host 加载、活动 profile 已挂载服务和识别器、所选识别器已就绪。仅安装包不会自动满足后两项。

官方 `@deepseek-ai/dsh-experimental-speech-to-text` 提供服务；已验证的本地识别器由 `@deepseek-ai/dsh-experimental-speech-to-text-sensevoice` 提供，还需配置并准备模型。相关包不随本插件分发，可能由 DSH 内置；仅在宿主缺少时另行安装兼容版本。核对过的 Windows DSH Desktop `0.2.0-rc.2` 已内置这些包，但默认 `dsh-base` / `dsh-web-app` 未引用它们；本项目实测通过额外 profile patch 挂载，见 [M4 记录](docs/transcription-validation.md)。其他版本需单独核实。`@deepseek-ai/dsh-experimental-api-speech-to-text` 提供官方语音 Remote 接口，使用相应语音界面时按需配置，不是本插件直接调用转写服务的硬依赖。

仅当整个 `speechToText` 服务未挂载时回退随包 CLI 的豆包云 ASR；服务存在但识别器未注册、模型未准备、识别失败或取消时不回退。也可显式配置 `doubao`，它需要 Host 环境或 `dataDir/.env` 中的凭据并会上传音频。OpenAI 与独立 `local` provider 仍属后续规划。

成功结果包含 `provider`、`recognizer`、实际 Markdown `path`、`audioSha256` 和 `reused`；失败保留音频，可单独重试 `recorder_transcribe`。DSH 返回纯文本，没有分段时间戳或说话人识别；归档中明确标注文件名推算的起始时间（时区未知）和默认“说话人1”。

## 数据规划

```text
archive/audio/    # 计划存放导入的音频
archive/corpus/   # 转写 Markdown
```

使用 `audio_sha256`、provider、识别器及语言关联转写；复用前检查正文完整性。空结果不会发布，同名但内容不同不会误复用，`force: true` 会另存结果并保留旧文件。相对输出与转写输入以 `dataDir` 为基准，默认 `~/.dsh-recorder-card`；`repoRoot` 仅表示 CLI 源码位置。设备缓存与可选 `.env` 也位于数据目录，包目录不写入用户数据。当前转写接受完整的标准 44 字节头、16 kHz 单声道 PCM16 WAV，上限 64 MiB；所选识别器可以有更小的限制，不自动分段或重采样。

音频、转写、设备地址和密钥不得提交到版本库。参见 [.gitignore](.gitignore)；使用外部仓库时，也需检查其忽略规则。

## 贡献

使用 AI 工具协作时，从 [AGENTS.md](AGENTS.md) 进入，再读取[开发者](docs/roles/open-source-developer.md)或 [QA](docs/roles/qa.md) 职责。这些文档供不同工具共用，`.cursor/rules/` 仅为可选的 Cursor 适配层。工具未自动发现入口时，按[角色使用说明](CONTRIBUTING.md#development-and-qa-roles)显式要求读取。

请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。行为或状态变化时，同步维护本文件和 [README.md](README.md)。已完成的变化写入 [CHANGELOG.md](CHANGELOG.md)，未来工作放入 [ROADMAP.md](ROADMAP.md)。

维护者准备目录提交或社区介绍时，可使用[发现与推广清单](docs/discovery-and-promotion.md)。

## 许可证与相关项目

[MIT](LICENSE) © 2026 SynSwarm DAO。

随包 Python CLI 与协议副本包含 NextProto AI 录音卡开放协议的代码，© 2026 NextProto，遵循[上游 MIT 许可证](vendor/LICENSE)。该声明随 npm 包分发。退役浏览器实现保留于测试夹具，继续保留 attribution。

- [AI 录音卡开放协议](https://github.com/nextproto1024/ai-recorder-card-open-protocol)：外部协议与 CLI 来源。
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)：目标宿主运行时。
