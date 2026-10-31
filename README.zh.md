# dsh-recorder-card

[English](README.md) · [贡献指南](CONTRIBUTING.md) · [路线图](ROADMAP.md) · [架构](docs/architecture.md) · [更新记录](CHANGELOG.md)

**`dsh-recorder-card`** 是一个开发中的第三方 **DeepSeek Harness (DSH)** 插件，用于通过 BLE 接入 **AI 录音卡**。

> **开发预览：** 当前仓库包含插件骨架和浏览器卡片实现，导入、转写和归档尚未打通。DSH 兼容性及实机行为仍待验证。已发布到 npm：`dsh-recorder-card`（开发预览版）。

## 项目用途

目标流程是：用专用设备记录会议、采访或笔记，通过 BLE 传回音频，再在 DSH 中归档并转写。硬件录音不使用电脑麦克风。

实现依据[上游 AI 录音卡协议](https://github.com/nextproto1024/ai-recorder-card-open-protocol)。具体卡片和固件是否兼容，需要实测确认；产品名称相同不代表协议兼容。

## 当前状态

“已有实现”仅表示存在代码，不代表已经通过 DSH 或硬件测试。目前尚未记录经过验证的兼容环境基线。

| 能力 | 实现状态 | 验证情况 / 剩余工作 |
|---|---|---|
| Bundle 清单和 Skill provider | 已有实现，本地合约与包检查通过 | 待验证 DSH 加载和 Skill 发现 |
| 浏览器连接、电量、录音状态与控制 | 已有实现 | 待目标浏览器及实机验证 |
| 浏览器文件列表 | 已有实现 | 待验证多帧列表和结束处理 |
| 浏览器文件导入 | 占位 | 按钮仅显示提示，尚缺传输和 Host 落盘 |
| Host 调用 Python CLI | 已有封装 | 未随包提供 CLI，配置及执行待验证 |
| `recorder_*` Agent 工具和前后端通信 | 未实现 | 待确认注册及通信接口 |
| 转写后端和归档完整性 | 规划中 | 尚无插件完整流程或已验证的默认后端 |

验收标准见 [ROADMAP.md](ROADMAP.md)。

本地回归测试通过模拟 hooks 和 BLE，覆盖通知解析、会话和列表请求清理、列表超时与不完整结果提示，以及会话内串行写入。运行 `npm test`；覆盖范围和限制见[本地检查](CONTRIBUTING.md#local-checks-without-hardware)。这些检查不能替代 DSH 或实机验证。

列表超时、写入失败或结束响应未确认成功后，需先断开并重新连接，再读取列表。当前连接禁止列表重试，避免把迟到响应当作新请求的完整结果。已收到的条目仍明确标为未确认，状态刷新和录音控制可继续使用。

## 安装状态

目前尚无已验证的最终用户安装流程。

- **本地开发：** 按[贡献指南](CONTRIBUTING.md)中的候选 DSH 加载流程验证，并记录准确的运行时版本和结果。
- **npm：** 已发布 `dsh-recorder-card`，安装 spec 为 `dsh plugin add dsh-recorder-card`。DSH 内的最终用户安装和启用尚未验证。
- **GitHub / Web 界面安装：** 尚未验证 bundle 安装和启用；通过发布验收后再补充用户安装步骤。

## 开发环境要求

- 提供插件开发能力的 DSH 环境；支持的版本及 profile 尚未确定。
- 浏览器实验需要 Chrome 或 Edge、可用的 `navigator.bluetooth`、蓝牙访问权限，以及协议兼容的录音卡。需记录实际测试的浏览器和系统组合。
- 本地语法检查需要 Node.js；最低支持版本待结合目标 DSH 运行时确定。
- 仅 Host CLI 实验需要：单独获取的上游仓库、Python，以及该版本上游声明的依赖。本仓库不包含 `tools/` 目录或 Python 依赖清单。

## 首次开发验证

1. 完成[贡献指南](CONTRIBUTING.md)中的本地检查和候选 DSH 加载流程。
2. 确认录音卡片能够显示，内置 Skill 能被发现。
3. 使用实机分别验证连接、状态、录音控制和文件列表。
4. 记录失败项及环境信息。导入和转写属于后续验收项，目前没有可用的快速开始命令。

## 架构

| 组件 | 文件 | 当前职责 |
|---|---|---|
| Host | [index.js](index.js) | Skill 注册和内部 Python CLI 封装；工具及通信待接入 |
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
