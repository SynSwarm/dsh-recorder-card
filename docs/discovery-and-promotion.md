# 发现、目录收录与推广

核对日期：2026-11-02。面向维护者，公开能力以 [README](../README.zh.md)、验收边界以 [ROADMAP](../ROADMAP.md)、实际发布以 [RELEASE](../RELEASE.md) 为准。本文件包含准备材料，不代表已改 GitHub 设置、提交目录、获准收录或发帖。

## 定位与首屏

核心表述：**把实体录音卡里的线下录音带进 DSH，在对话中选择、导入，再按需转写与归档。** 面向已有兼容录音卡的用户，首屏直接写明实体硬件、Host 蓝牙及 Python 依赖。

只陈述可验证差异：音频来自专用设备，Host 通过 BLE 导入。不要使用“唯一硬件入口”“拾音一定更好”“全离线免费”“所有录音卡通用”等缺少比较或兼容性证据的说法。DSH 转写是否在本机执行取决于识别器，豆包回退会上传音频。保留开发预览标记和已发布/未发布、实现/验收的区别。

## 分发与发现的区别

官方 README 建议仓库添加 `dsh-plugin` topic。当前官方文档也已有可启用的实验性 Discover/自定义插件索引入口，但不预置索引源，索引由第三方提供。因此更准确的表述是“没有统一官方目录收录审批；npm/Git 分发、topic 发现、第三方目录收录分别处理”，不能笼统写成“DSH 没有市场界面”。最新上游文档不等于本项目已验证的 0.2.0-rc.2 环境支持同样界面。[官方社区约定](https://github.com/deepseek-ai/deepseek-harness#community-and-support) · [官方索引指南](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/plugin-market.md)

topic 增加可发现性，但每个目录有自己的筛选、同步及审核规则；不承诺同时、立即或必然收录。目录记录、npm 包、DSH 加载和硬件验收是四件不同的事。

## 仓库材料

本项目已经声明 `dsh.bundle.patch: ./cordis.patch.yml` 和 `dsh.client`，无需为了推广虚构 `dsh.plugin` 字段。包名含 dsh 不替代有效 manifest。工作区已补充 npm `repository`、`homepage`、`bugs`、MIT 标识及发现关键词；这些元数据需要后续新版本发布才进入 npm，不能修改已发布的 0.5.0。[当前清单](../package.json)

GitHub About 建议文案：

> Import recordings from compatible BLE recorder cards into DSH, with optional transcription and fingerprint-linked archives. Development preview; hardware required.

建议 topics（GitHub 仓库设置与 npm keywords 分开配置）：

```text
dsh-plugin deepseek-harness dsh ble bluetooth recorder audio-transcription meeting-transcription
```

- [x] README 首屏说明用途、实体设备要求、验证状态及安装入口；中英文同步。
- [x] 工作区 package.json 已有 bundle 声明，并补齐来源链接与发现关键词。
- [ ] 核对远端仓库公开可读、默认分支包含上述文件，设置或确认 `dsh-plugin` topic、About 简介；保存核对时间与仓库 URL。
- [ ] 上传 GitHub social preview 并检查实际分享效果。可采用 1280×640 PNG、低于 1 MB，内容用项目名、“Recorder card → DSH”、硬件要求与开发预览标记；只使用获准公开的实物或测试截图。GitHub 的预览设置不能保证 npm 或所有社交平台也使用同一张图，不承诺点击率提升幅度。[GitHub 图像要求](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/customizing-your-repositorys-social-media-preview)

## 渠道核对与顺序

| 渠道 | 已核实的入口与规则 | 本项目下一步 |
|---|---|---|
| GitHub topic / dshfind | dshfind 的维护者说明：扫描公开仓库的 `dsh-plugin` topic，按日同步；两次同步后仍缺失再反馈，可能存在筛选。不是所有目录的通用收录保证。[来源](https://github.com/hikariming/dshfind#submit-your-plugin) | 先确认 topic，后检查目录实际条目和 npm 映射；尚未确认本项目收录。 |
| awesome-dsh-plugin | PR 添加 `data/plugins/<owner>__<repo>.yml`，含 category、英文功能描述；需有效 bundle、真实代码、仓库满一天和 topic。CI 通过仍需维护者审阅；无需手改生成的 README。[贡献规则](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md) | 优先准备 `voice` 分类条目，复查现有条目避免重复，再按授权提交。无“最大目录”或流量保证。 |
| dsh-market | 当前 README 明确：它是市场应用，目录来自 awesome-dsh-plugin；插件条目应向后者提 PR。[提交规则](https://github.com/dsh-market/dsh-market#submit-your-plugin) | 通过上述目录路径；不照旧建议创建 `[提交工具]` Issue。 |
| dsplugin.app | 发布页预检公开仓库、topic 与 `dsh.bundle.patch`，再生成 GitHub Issue，由维护者合并目录审核 PR 后更新。格式核对不代表安全审计。[发布页](https://dsplugin.app/publish) | 目录 PR 材料齐备后，按站点当时规则预检并记录 Issue/合并结果。 |
| 1024Store | 目录 README 同时列出 topic 自动发现与 PR 收录；自动候选检查 package.json、bundle patch 及文件存在，不只是包名含 dsh。[目录说明](https://github.com/imsai-sh/awesome-deepseek-harness-plugins#readme) | 先查自动发现结果，缺失时依其贡献指南处理；不承诺 topic 一加就展示可安装按钮。 |
| dsh.so | 本轮无法读取该站首页及提交页，不能确认安全扫描、ID 正则或 Declared/Verified 标签规则。 | 保留候选；能访问并核实规则后再定优先级，不宣称已通过其扫描或认证。 |

优先顺序：README 与来源元数据 → 远端 topic/About → awesome 条目及 dshfind 同步核对 → dsplugin/1024Store 等渠道 → 实际收录结果复核。dsh.so 的规则待核实，不作为今天必须完成的阻塞项。

各渠道记录“未提交 / 已提交（链接、日期）/ 待补材料 / 已合并 / 已展示”，不要把提交成功等同于收录。收录后检查描述、npm 包归属、安装版本及兼容性提示是否正确。

## Awesome 条目草稿

目标文件：`data/plugins/SynSwarm__dsh-recorder-card.yml`。以下是待提交材料；复核目标目录的最新规则、仓库可读性和重复条目后使用。

```yaml
url: https://github.com/SynSwarm/dsh-recorder-card
name: SynSwarm/dsh-recorder-card
category: voice
description:
  en: 'Import recordings from compatible BLE recorder cards into DSH, with optional transcription and fingerprint-linked archives; development preview requiring hardware and Python.'
  zh: '把兼容 BLE 录音卡中的录音导入 DSH，按需转写并建立指纹关联归档；开发预览，需要实体设备和 Python。'
```

PR 说明应注明：npm 包 `dsh-recorder-card`、MIT、Host 执行边界、已验证 DSH 版本及具体短录音证据。不要添加“官方推荐”“已安全认证”或“完整硬件支持”的徽章。

## 社区帖草稿

可按 LINUX DO / V2EX 的实际板块规则改写；目前没有本项目渠道转化数据，不断言某个平台效果最好。官方 README 将 GitHub Discussions 列为反馈入口，不等于允许在任意板块发广告；先查看分类规则。

标题：**做了一个把实体录音卡接进 DSH 的插件，想找同类设备用户验证兼容性**

正文：

> 我做了 dsh-recorder-card，想把录音卡里已经录好的会议、采访或语音笔记带进 DSH。电脑运行的 Host 通过 BLE 连接卡片；点击连接图标后，在对话里查看列表、选择录音、导入本地，再按需转写成 Markdown 归档。
>
> 使用前需要兼容的实体 BLE 录音卡、电脑蓝牙及 Python 3.11+。固定上游 CLI 已随包提供，不需要另行 clone。转写可以用已准备好的 DSH 识别器，云端回退会上传音频，需要明确请求转写。
>
> npm 0.5.0 是开发预览。一条短测试录音已通过真实 DSH 指定名称导入和音频完整性检查；本机 SenseVoice 转写与归档复用另有验证。该录音恰为列表首条，非首条、长录音、中断恢复和远程录音控制仍未完整验收。工作区正在补慢链路处理，这部分尚未发布，不承诺 BLE 提速或断点续传。
>
> 源码与安装说明：https://github.com/SynSwarm/dsh-recorder-card
>
> 如果你已有兼容设备，欢迎反馈型号、固件、DSH/系统版本和可复现的非个人测试结果。请勿在公开 Issue 上传个人录音、转写或设备地址。

发帖前按当时版本更新上述段落；演示尽量用获准公开的短测试片段，展示连接、选取、导入和输出路径。示意图标明示意，不把模拟过程描述为实机成功。推广效果用实际访问来源、有效反馈和成功安装记录评估，先积累证据再决定投入。
