# dsh-recorder-card

[English](README.md) · [贡献指南](CONTRIBUTING.md) · [路线图](ROADMAP.md) · [架构](docs/architecture.md) · [更新记录](CHANGELOG.md)

**`dsh-recorder-card`** 是一个开发中的第三方 **DeepSeek Harness (DSH)** 插件，用于通过 BLE 接入 **AI 录音卡**。

> **开发预览：** 当前仓库包含插件骨架和浏览器卡片实现，导入、转写和归档尚未打通。Host 加载与生命周期已在隔离的 DSH 0.2.0-rc.2 profile 中通过；硬件与完整流程仍待验收。上述工作区变化尚未发布。已发布到 npm：`dsh-recorder-card`（开发预览版）。

## 项目用途

目标流程是：用专用设备记录会议、采访或笔记，通过 BLE 传回音频，再在 DSH 中归档并转写。硬件录音不使用电脑麦克风。

实现依据[上游 AI 录音卡协议](https://github.com/nextproto1024/ai-recorder-card-open-protocol)。具体卡片和固件是否兼容，需要实测确认；产品名称相同不代表协议兼容。

主路线为 **DSH Host → Python CLI → 录音卡**，要求 Host 所在机器可访问蓝牙设备。浏览器 Web Bluetooth 卡片为可选增强；Host 已注册六个基于 CLI 的 Agent 工具；注册已验证，通过 DSH 操作硬件仍待验收。

## 当前状态

“已有实现”仅表示存在代码，不代表已经通过 DSH 或硬件测试。已记录 Windows 上 DSH Desktop 0.2.0-rc.2 隔离 headless profile 的 Host 基线。

| 能力 | 实现状态 | 验证情况 / 剩余工作 |
|---|---|---|
| Bundle 清单和 Skill provider | 已实现 | M1 隔离 DSH 验证通过：加载、Skill 访问、启停与子进程清理 |
| 浏览器连接、电量、录音状态与控制 | 已有实现（可选增强，已降级） | 需验证目标浏览器的 Web Bluetooth、权限及实机行为；不阻塞主线 |
| 浏览器文件列表 | 已有实现（可选增强，已降级） | 同上，不阻塞主线 |
| 浏览器文件导入 | 占位 | 按钮仅显示提示，尚缺传输和 Host 落盘 |
| Host 调用 Python CLI | 固定源码适配器及进程管理层已实现 | 内部列表调用实测、队列/取消本地测试通过；DSH 生命周期已验证，硬件工具验收待完成，外部 CLI 仍需另行获取 |
| `recorder_*` Agent 设备工具 | 六个工具已注册，提供配置 schema 与结构化进程结果 | schema、错误及取消测试通过；硬件操作和默认 DSH 转写仍待验收 |
| 可选界面的 Client–Host 通信 | 未实现 | 后续通过 Host 获取状态和发命令 |
| 转写后端与归档完整性 | 已实现音频安全发布与分阶段结果 | DSH 转写、转写复用及完整归档仍待验收 |

验收标准见 [ROADMAP.md](ROADMAP.md)。[独立 CLI 部分实机记录](docs/cli-validation.md)已验证扫描、状态/列表响应及一条录音的传输与 WAV 完整解码；用户已确认播放正常、内容正确，录音控制和其他验收项仍待完成。后续已通过内部 Host 列表调用实测；远程开始录音无确认，实体键录音保存后列表成功增加。完整 DSH 工具验收仍未通过。

导入已保护同名音频，完整暂存文件在冲突时另取名字发布，并分别返回导入和转写状态。发布前验证 RIFF/WAVE PCM 结构，截断或未知格式报告未确认。转写失败或连接清理未确认返回 `status: partial`，并保留独立阶段详情，不能视为全流程成功。见[运行合约](skill/references/runtime.md#safe-import-and-separate-transcription-results)。

本地回归测试通过模拟 hooks 和 BLE，覆盖通知解析、会话和列表请求清理、列表超时与不完整结果提示，以及会话内串行写入。运行 `npm test`；覆盖范围和限制见[本地检查](CONTRIBUTING.md#local-checks-without-hardware)。这些检查不能替代 DSH 或实机验证。

在可选浏览器直连模式中，列表超时、写入失败或结束响应未确认成功后，需先断开并重新连接，再读取列表。当前连接禁止列表重试，避免把迟到响应当作新请求的完整结果。已收到的条目仍明确标为未确认，状态刷新和录音控制可继续使用。

## 安装状态

目前尚无已验证的最终用户安装流程。

- **本地开发：** 按[贡献指南](CONTRIBUTING.md)中的候选 DSH 加载流程验证，并记录准确的运行时版本和结果。
- **npm：** 已发布 `dsh-recorder-card`，安装 spec 为 `dsh plugin add dsh-recorder-card`。DSH 内的最终用户安装和启用尚未验证。
- **GitHub / Web 界面安装：** 尚未验证 bundle 安装和启用；通过发布验收后再补充用户安装步骤。

## 开发环境要求

- 提供插件开发能力的 DSH 环境；支持的版本及 profile 尚未确定。
- 浏览器实验需要 Chrome 或 Edge、可用的 `navigator.bluetooth`、蓝牙访问权限，以及协议兼容的录音卡。需记录实际测试的浏览器和系统组合。
- 本地语法检查需要 Node.js；最低支持版本待结合目标 DSH 运行时确定。
- Host CLI 主线需要：单独获取的上游仓库、Python，以及该版本上游声明的依赖。本仓库不包含 `tools/` 目录或 Python 依赖清单。

## 首次开发验证

1. 完成[贡献指南](CONTRIBUTING.md)中的本地检查；在计划运行 Host 的机器上准备固定版本的外部 CLI、Python/Bleak 和蓝牙环境。
2. 先做 M2a 独立 CLI 实验：扫描、状态、列表和一条非个人录音的导入/播放验证，再补齐录音控制和异常场景。它不依赖 DSH 加载通过。
3. 在目标环境复现 [M1 Host 验证](docs/dsh-integration.md)。Windows 隔离环境基线已通过；卡片显示仍单独记录为可选项。
4. M1 与 M2a 通过后，按 M2b → M3 → M4 验证 DSH 设备工具、单文件导入和默认转写。独立 CLI 成功不代表插件完整流程可用。

## 架构

| 组件 | 文件 | 当前职责 |
|---|---|---|
| Host | [index.js](index.js) | Skill 与工具注册、配置；Client 通信待接入 |
| Agent 工具 | [runtime/tools.js](runtime/tools.js) | 六个 CLI 工具；进程完成与设备/文件验收分别报告 |
| Host 进程管理 | [runtime/host-cli.js](runtime/host-cli.js) | 共享设备队列、参数检查、时限、取消及停用清理；真实 DSH 待验 |
| CLI 适配器 | [runtime/recorder_cli.py](runtime/recorder_cli.py) | 校验外部源码、列表/录音确认、单进程时限与连接清理 |
| Client | [client.js](client.js) | 使用浏览器 BLE 的 React 卡片；导入为占位 |
| Skill | [skill/SKILL.md](skill/SKILL.md) | 能力检查、资源定位及设备操作约束 |
| 协议 | [vendor/recorder-protocol.js](vendor/recorder-protocol.js) | CRC、组帧、解析及命令原语 |
| 加载配置 | [cordis.patch.yml](cordis.patch.yml) | 插件加载条目 |

BLE 连接归属、外部 CLI 配置及规划中的数据流见[架构与待决事项](docs/architecture.md)。

## 转写规划

默认接入目标已确定为 DSH 内置语音转写；豆包、OpenAI 兼容 ASR 接口和本地 SenseVoice ONNX 为后续可选后端。目前它们不是已支持的 provider 选项。现有 Host 方法只调用外部脚本，没有实现 DSH 后端、provider 选择或 `transcriptionProvider` 配置。M4 先实现并验证既定默认后端，再扩展支持范围。

## 数据规划

```text
archive/audio/    # 计划存放导入的音频
archive/corpus/   # 计划存放转写 Markdown
```

计划使用 `audio_sha256` 指纹关联音频与转写，避免错误复用。当前仓库尚未实现或验证这一存储约定。Host 封装中的相对输出路径以配置的 `repoRoot` 为基准，该位置可能是外部仓库。

音频、转写、设备地址和密钥不得提交到版本库。参见 [.gitignore](.gitignore)；使用外部仓库时，也需检查其忽略规则。

## 贡献

使用 AI 工具协作时，从 [AGENTS.md](AGENTS.md) 进入，再读取[开发者](docs/roles/open-source-developer.md)或 [QA](docs/roles/qa.md) 职责。这些文档供不同工具共用，`.cursor/rules/` 仅为可选的 Cursor 适配层。工具未自动发现入口时，按[角色使用说明](CONTRIBUTING.md#development-and-qa-roles)显式要求读取。

请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。行为或状态变化时，同步维护本文件和 [README.md](README.md)。已完成的变化写入 [CHANGELOG.md](CHANGELOG.md)，未来工作放入 [ROADMAP.md](ROADMAP.md)。

## 许可证与相关项目

[MIT](LICENSE) © 2026 SynSwarm DAO。

协议副本及 `client.js` 中的内联副本包含 NextProto AI 录音卡开放协议的代码，© 2026 NextProto，遵循[上游 MIT 许可证](vendor/LICENSE)。该声明随 npm 包分发。

- [AI 录音卡开放协议](https://github.com/nextproto1024/ai-recorder-card-open-protocol)：外部协议与 CLI 来源。
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)：目标宿主运行时。
