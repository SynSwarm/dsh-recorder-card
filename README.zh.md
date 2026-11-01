# dsh-recorder-card

[English](README.md) · [贡献指南](CONTRIBUTING.md) · [路线图](ROADMAP.md) · [架构](docs/architecture.md) · [更新记录](CHANGELOG.md)

**`dsh-recorder-card`** 是一个开发中的第三方 **DeepSeek Harness (DSH)** 插件，用于通过 BLE 接入 **AI 录音卡**。

> **开发预览：** 当前构建包含 Host 工具、随包 CLI、安全导入、默认 DSH 转写与指纹关联归档。真实 DSH Host 已通过本机 SenseVoice 转写及工具复用验证；完整硬件流程仍待验收。上述能力属于 0.3.0 开发预览版，npm 上更早版本的能力不同。

## 项目用途

目标流程是：用专用设备记录会议、采访或笔记，通过 BLE 传回音频，再在 DSH 中归档并转写。硬件录音不使用电脑麦克风。

实现依据[上游 AI 录音卡协议](https://github.com/nextproto1024/ai-recorder-card-open-protocol)。具体卡片和固件是否兼容，需要实测确认；产品名称相同不代表协议兼容。

主路线为 **DSH Host → 随包 Python CLI → 录音卡**，要求 Host 所在机器可访问蓝牙。六个 Agent 工具与可选卡片共用同一个 Host 服务；卡片已改用 Typert Remote，不再调用 Web Bluetooth。

## 当前状态

“已有实现”仅表示存在代码，不代表已经通过 DSH 或硬件测试。已记录 Windows 上 DSH Desktop 0.2.0-rc.2 隔离 headless profile 的 Host 基线。

| 能力 | 实现状态 | 验证情况 / 剩余工作 |
|---|---|---|
| Bundle 清单和 Skill provider | 已实现 | M1 隔离 DSH 验证通过：加载、Skill 访问、启停与子进程清理 |
| 卡片扫描、状态、列表与录音控制 | 已接入 Host Remote | 真实 DSH Web 创造模式的渲染、配置与扫描通过；录音控制及 Electron 专项待验证 |
| 卡片首条录音导入 | 已接入 Host Remote | 真实 Web 卡片导入通过：5.28 秒 WAV 完整解码且匹配已确认测试音频；取消/重试仍待验收 |
| 浏览器直连 BLE | 已从发布入口移除 | 旧实现仅保留为历史回归测试夹具 |
| Host 调用 Python CLI | 固定源码适配器及进程管理层已实现 | 内部列表调用实测、队列/取消本地测试通过；DSH 生命周期已验证，硬件工具验收待完成，固定 CLI 源码已随包分发，无需另行 clone |
| `recorder_*` Agent 设备工具 | 六个工具已注册，提供配置 schema 与结构化进程结果 | schema、错误及取消测试通过；真实 Host 转写/复用通过，硬件操作仍待验收 |
| 可选界面的 Client–Host 通信 | 六个设备/转写方法及两个持久化配置方法 | 见[设计与验证](docs/client-host-remote.md)；当前没有实时进度流 |
| 转写后端与归档完整性 | 已实现音频/Markdown 安全发布、指纹复用与分阶段结果 | DSH 本机 SenseVoice 转写与工具复用通过；完整硬件恢复仍待验收 |

验收标准见 [ROADMAP.md](ROADMAP.md)。[独立 CLI 部分实机记录](docs/cli-validation.md)已验证扫描、状态/列表响应及一条录音的传输与 WAV 完整解码；用户已确认播放正常、内容正确，录音控制和其他验收项仍待完成。后续已通过内部 Host 列表调用实测；远程开始录音无确认，实体键录音保存后列表成功增加。完整 DSH 工具验收仍未通过。

导入已保护同名音频，完整暂存文件在冲突时另取名字发布，并分别返回导入和转写状态。发布前验证 RIFF/WAVE PCM 结构，截断或未知格式报告未确认。转写失败或连接清理未确认返回 `status: partial`，并保留独立阶段详情，不能视为全流程成功。见[运行合约](skill/references/runtime.md#safe-import-and-separate-transcription-results)。

本地回归覆盖官方 Client/Host Gateway 的进程内 JSON 通信、卡片 hooks、取消、部分导入结果，以及与 Agent 工具共享服务。旧浏览器 BLE 测试保留为历史回归。运行 `npm test`；限制见[本地检查](CONTRIBUTING.md#local-checks-without-hardware)，不能替代桌面或实机验收。

点击麦克风图标会通过 Host 扫描；将结果中的设备标识填入卡片的设备地址输入框并保存后，再读取状态、列表或导入。扫描不表示持续连接。当前仅导入首条录音；“导入”与“导入并转写”分开，后者会将音频发送给 Host 已配置的 ASR 后端。

## 安装与首次使用

以下适用于 0.3.0 及以后版本；更早版本可能仍要求外部 checkout。安装方式：

```sh
dsh plugin add dsh-recorder-card
python -m pip install bleak requests
```

Python 依赖只需安装一次，使用与插件 `python` 配置相同的解释器。也可在插件安装目录运行 `python -m pip install -r vendor/upstream/tools/requirements.txt`。

Host 需要 Python 3.11+、可用蓝牙及访问权限。插件已包含固定版本 Python CLI，无需 clone 上游或填写 `repoRoot`。如果 `python` 不在 DSH 的 PATH 中，在插件 `python` 字段填写同一个解释器的绝对路径。

1. 在 DSH 中让 Agent 读取本插件 Skill 并调用 `recorder_scan`；扫描无需设备地址。先唤醒卡片，断开手机和浏览器连接。
2. 点击卡片的 **设置设备**，把扫描结果中的设备标识粘贴到 **设备地址**，点击 **保存设备地址**。立即生效、重启后保留，无需修改 YAML 或重新加载。保存的选择优先于旧 `deviceAddress` 配置；保存空地址可清除选择。
3. 调用 `recorder_list`，确认第一条是允许导入的录音，再调用 `recorder_import`（默认不转写）。当前仅支持导入列表第一条。
4. 默认音频位于 Host 用户目录 `~/.dsh-recorder-card/archive/audio/`；以工具返回的绝对路径为准。转写是单独的可选步骤：DSH 本地识别器需要先准备模型；豆包云端需要 ASR 凭据。扫描和导入不需要转写凭据。

DSH/pnpm 若配置 `minimumReleaseAge=1440`，新版本发布 24 小时内可能暂时无法安装；等待成熟版本即可，不修改年龄门槛。

缺依赖时，错误会给出当前 Python 的安装命令。可在已安装插件目录执行 `python -B runtime/recorder_cli.py --check-deps` 做无蓝牙检查。完整平台支持范围及新用户实机验收仍以[发布验证记录](docs/distribution-validation.md)为准。

## 开发环境要求

- 提供插件开发能力的 DSH 环境；支持的版本及 profile 尚未确定。
- 可选卡片需要 DSH Client Gateway 和会话活动 Slot；蓝牙设备与权限位于 Host，不依赖浏览器 Web Bluetooth。
- 本地语法检查需要 Node.js；最低支持版本待结合目标 DSH 运行时确定。
- Host CLI 主线需要 Python 3.11+ 与 Bleak/requests；源码及依赖清单位于 `vendor/upstream/tools/`，随 npm 包分发。

## 首次开发验证

1. 完成[贡献指南](CONTRIBUTING.md)中的本地检查；在计划运行 Host 的机器上准备 Python/Bleak 并检查包内 CLI 和蓝牙环境。
2. 先做 M2a 独立 CLI 实验：扫描、状态、列表和一条非个人录音的导入/播放验证，再补齐录音控制和异常场景。它不依赖 DSH 加载通过。
3. 在目标环境复现 [M1 Host 验证](docs/dsh-integration.md)。Windows 隔离环境基线已通过；卡片显示仍单独记录为可选项。
4. M1 与 M2a 通过后，按 M2b → M3 → M4 验证 DSH 设备工具、单文件导入和默认转写。独立 CLI 成功不代表插件完整流程可用。

## 架构

| 组件 | 文件 | 当前职责 |
|---|---|---|
| Host | [index.js](index.js) | Skill/工具注册、共享 recorder Service 和 Remote 控制器 |
| Agent 工具 | [runtime/tools.js](runtime/tools.js) | 六个 CLI 工具；进程完成与设备/文件验收分别报告 |
| Host 进程管理 | [runtime/host-cli.js](runtime/host-cli.js) | 共享设备队列、参数检查、时限、取消及停用清理；真实 DSH 待验 |
| CLI 适配器 | [runtime/recorder_cli.py](runtime/recorder_cli.py) | 校验随包源码、列表/录音确认、单进程时限与连接清理 |
| Client | [client.js](client.js) | 调用 Host Remote 的 React 卡片；不持有浏览器 BLE 连接 |
| Skill | [skill/SKILL.md](skill/SKILL.md) | 能力检查、资源定位及设备操作约束 |
| 协议 | [vendor/recorder-protocol.js](vendor/recorder-protocol.js) | CRC、组帧、解析及命令原语 |
| 加载配置 | [cordis.patch.yml](cordis.patch.yml) | 插件加载条目 |

BLE 连接归属、随包 CLI 配置及规划中的数据流见[架构与待决事项](docs/architecture.md)。

## 转写与归档

工作区修复（尚未发布，npm 0.3.0 不包含）：缓存返回前重新核对当前音频指纹；相同内容移动或复制到新路径时，复用正文并另存关联当前路径/标题的 Markdown，保留旧归档。推算时间沿用原始来源，记录在 `transcription_source_audio` / `recorded_at_source_audio`；这些是历史来源，不是当前音频链接。

`transcriptionProvider` 默认为 `dsh`：使用 Host 的 `speechToText` 服务及其所选识别器，不等于调用 DeepSeek 云 API。DSH 的 SenseVoice 可在 Host 本地识别，模型需先在 DSH 中准备。仅当整个服务未挂载时回退随包 CLI 的豆包云 ASR；服务存在但模型未准备、识别失败或取消时不回退。也可显式配置 `doubao`，它需要 Host 环境或 `dataDir/.env` 中的凭据并会上传音频。OpenAI 与独立 `local` provider 仍属后续规划。

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

## 许可证与相关项目

[MIT](LICENSE) © 2026 SynSwarm DAO。

随包 Python CLI 与协议副本包含 NextProto AI 录音卡开放协议的代码，© 2026 NextProto，遵循[上游 MIT 许可证](vendor/LICENSE)。该声明随 npm 包分发。退役浏览器实现保留于测试夹具，继续保留 attribution。

- [AI 录音卡开放协议](https://github.com/nextproto1024/ai-recorder-card-open-protocol)：外部协议与 CLI 来源。
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)：目标宿主运行时。
