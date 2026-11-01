# M4 转写与归档验证（2026-11-01）

本记录区分实现、自检与实际运行，不作为 M3–M5 整体验收结论。

## 0.3.0 发布后：缓存关联修复（未发布）

QA 发现缓存读取期间音频变化未复核，以及同内容换路径后归档仍引用旧文件。新增四项回归在已下载的 0.3.0 转写模块上全部失败；工作区修复后，完整 Node 测试为 93 项通过，28 文件包预检、25 个 JS 语法检查、17 份 Markdown 本地链接检查和 diff 格式检查通过。原并发测试也改为断言“一次识别、一次复用”，不假设两个异步文件读取的完成顺序。

修复范围：同路径缓存返回前重新检查当前文件指纹；跨路径复用另存绑定当前音频与标题的归档，原文和时间线保留，历史来源用独立字段注明。新归档在暂存完成后、发布前统一复核输入。测试包含变化、截断、删除、移动、重复导入、跨路径并发、DSH 与模拟豆包正文复用、旧归档保留及原路径再次命中。检查不保证音频在结果返回后不被外部进程修改。

本轮是开发者自检，没有新增真实 DSH、BLE 或云 ASR 操作，也没有重新运行未修改的 Python 部分。以下 0.3.0 实测保留为历史证据，不覆盖本次未发布修复。

## 接口与实现

依据本机 DSH Desktop 0.2.0-rc.2 的官方 `dsh-experimental-speech-to-text`、`dsh-experimental-api-speech-to-text` 和 SenseVoice provider 源码：`resolve({ audio })` 选择识别器，`transcribe(spec, signal)` 返回纯文本与音频/推理时长，没有分段时间戳或说话人。

`Config.transcriptionProvider` 默认为 `dsh`。共享 recorder Service 可选注入 `speechToText`；仅服务缺席回退豆包，服务存在但无法识别时直接失败。也可显式选 `doubao`，云上传和凭据要求见 [运行合约](../skill/references/runtime.md)。本轮没有调用云 ASR。

归档位于 dataDir/archive/corpus，包含音频指纹、provider、识别器、语言、正文哈希及推算时间的来源。DSH 结果标注默认“说话人1”和无分段时间；不能把文件名时间当作有时区的实测时间。内容哈希与 provider 身份隔离缓存，同名不同内容不复用；强制转写另存，不覆盖旧文件。只接受完整标准头 16 kHz 单声道 PCM16 WAV，最多 64 MiB，识别器可施加更小限制；没有自动分段/重采样。

## 真实 Host 证据

- Windows、本机 DSH Desktop 0.2.0-rc.2 官方 CLI，Host Node 24.18.1；隔离 Web profile，安装包含 M4 的实际本地 0.3.0 npm 包。
- 在隔离 patch 中挂载官方 speechToText 与 SenseVoiceSmall INT8，使用本机已有模型的只读路径，工作目录在 `.cache/m4/`。实际 provider 声明 `location: host-local`，缓存状态为 standby；没有下载模型。
- 输入是此前用户已授权并确认播放正确的 5.28 秒测试 WAV。本轮不重新访问 BLE，不删除或改写音频。
- 通过真实 Host `typertGateway.dispatchRpc('recorder/transcribe', …)` 执行识别：返回 `provider: dsh`、`recognizer: sensevoice-local`、`reused: false`，发布含非空正文的 Markdown；正文内容只保存在本地私有目录。
- 随后通过真实 `ctx.tools.execute` 调用 `recorder_transcribe`：成功复用该产物，`reused: true`。检查归档声明无分段时间及默认说话人。这里是实际工具注册表调用，没有通过 LLM 对话发起。
- 运行报告 `.cache/m4/report.json` 及转写产物不进入 Git 或 npm。包预检要求归档实现随包提供，排除数据和测试目录。

## 自动回归与限制

最终自检为 89 项 Node、46 项 Python 全部通过，包预检 28 文件。原生桌面使用的中间验收包 SHA-256 为 `a0d1e96ce66c8f5f2695f3d858493e4c9778225e702d222b28a314cee0161b35`；之后补充了缓存返回前的取消检查、豆包时间线来源标记及文档。0.3.0 发布后重新下载并核对 SHA-256，再从该 npm 包所在的新隔离 profile 复验真实 Gateway SenseVoice 转写与 Agent 工具复用，均通过；该 Host 已退出。最终包摘要和安装年龄策略限制见 [发布记录](../RELEASE.md)。原生桌面截图仍对应中间包，不声称桌面测试使用了最终包。

回归覆盖官方 speechToText 注册表、纯文本归一化、正文损坏/空结果拒绝、同名不同音频、强制重转写保留旧文件、同键并发复用、输入在识别期间变化、服务缺席回退、显式豆包产物校验、现有服务失败不回退、停用取消，以及导入后的转写/清理双失败。工具和 Remote 使用严格结构化成功结果，Client 显示产物路径与实际 provider。

真实识别仅覆盖这段短测试录音，未评价识别准确率、长音频、云端豆包、模型更换或真实 BLE 中断后恢复。本轮未运行新的“硬件导入并转写”一次性调用；先前 Web 实机导入与本轮已保存音频转写是分开的证据。M3 及完整硬件异常恢复仍未验收，M4 不宣称整体完成。
