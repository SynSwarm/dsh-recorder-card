# Release checklist

**发布后修复待复核：** QA 发现 0.3.0 的缓存复用存在音频变化校验遗漏及换路径后归档关联陈旧的问题。工作区已修复并通过 93 项 Node 回归，尚未发布；0.3.0 不包含这些修复。详见 [缓存验证记录](docs/transcription-validation.md)。后续发布需使用新版本号。

当前已发布 **[dsh-recorder-card@0.3.0](https://www.npmjs.com/package/dsh-recorder-card/v/0.3.0)**。注册表发布时间为 `2026-11-01T10:02:58.385Z`（北京时间 18:02:58），latest 已指向 0.3.0，description 与当前 package.json 一致。npm 接受请求后曾短暂返回 E404，随后可见性与下载均已核实。

本轮自检：89 项 Node、46 项 Python 测试通过；28 文件包预检、25 个 JS 文件语法和 17 份 Markdown 的本地链接目标检查通过。真实 Host SenseVoice 转写/工具复用及隔离原生桌面配置/认证/主题模拟证据见 [M4](docs/transcription-validation.md) 与 [Remote](docs/client-host-remote.md)。这是开发者自检，不是独立 QA。

已发布 tarball 的 SHA-256 为 `8595bca8c691204343f9216682492192e1c3524a7efcd6c394382fa94ba0b31d`，npm shasum 为 `d2200c091578c32309edc6d53a86c7d262b853c0`。注册表 shasum/integrity 与本地产物一致，重新下载的包也通过逐字节 SHA-256 比较。

新隔离 Web profile 从 npm 安装成功，随后实际 Host 的 Gateway SenseVoice 转写和 Agent 归档复用通过。注意：pnpm 11.7.0 默认安装明确的新版本时自动添加了 `minimumReleaseAgeExclude`，该次安装不能称为遵守 24 小时门槛的验证。已移除测试目录自动豁免；第二个全新 profile 显式启用 `minimumReleaseAge: 1440` 与 `minimumReleaseAgeStrict: true`，正确返回 `ERR_PNPM_NO_MATURE_MATCHING_VERSION`，没有添加豁免。严格策略下应等待北京时间 **2026-11-02 18:03 之后**再装；未修改日常 profile 或绕过其策略。

发布前对照本清单。DSH 插件**无应用商店审核**：用户输入一个 spec 即直接安装。装插件 = 在用户 DSH 的 Node 进程 / 浏览器中运行你的代码，信任来自开源与可读源码，而非平台背书。

## 当前发布状态

项目已记录 npm 开发预览版 `dsh-recorder-card@0.1.0` 发布。该状态不代表 DSH 安装、启用、硬件或完整流程验收通过；M1–M5 仍按[路线图](ROADMAP.md)验收。

- [ ] 从 npm 注册表核对 `0.1.0` 的发布时间、tarball 地址和完整性摘要。
- [ ] 将发布包与工作区逐项比较，确认已发布改动，补齐 [CHANGELOG](CHANGELOG.md) 的发布日期和版本范围。当前尚无完成该核对的记录。
- [ ] 在干净环境中验证已发布版本的 Host 安装/启用和 Skill 发现；卡片显示单列为可选增强。

## 审核与信任模型

| 闸门 | 性质 |
|---|---|
| `inspect()` 校验 | 自动：spec 合法 + 声明了 `dsh.bundle.patch` |
| 版本兼容检查 | 自动：核对 `peerDependencies` 与用户 DSH 版本 |
| 安装脚本批准 | 用户确认：包带 build script 时拦截并请求批准 |
| 内容审核 | **无** |

## 包配置与外部依赖

- [x] `private: false`（否则 `npm publish` 拒绝）
- [x] `files` 字段（限定发布内容，否则 `tests/`、`docs/`、`.cursor/` 等被发出）
- [x] `peerDependencies`（`@deepseek-ai/cordis` + `@deepseek-ai/dsh-skill`，让版本兼容检查生效）
- [x] 固定 Python CLI 原样随包分发，保留版本、哈希与完整 MIT 声明；不再要求用户 clone 或配置 repoRoot。Python/Bleak/requests 安装与设备配置见[运行说明](skill/references/runtime.md)。
- [ ] 按[分发验证记录](docs/distribution-validation.md)复核实际发布包、干净 profile 和支持平台；保留 pnpm 安全年龄门槛。
- [x] npm 账号 + `npm publish`（已发布 `dsh-recorder-card@0.1.0`）

## 强烈建议（体验 / 可发现性）

- [ ] `locale/en.json` + `locale/zh.json`（`meta.title`/`description`）+ 顶层 `icon`——否则插件面板只有光秃秃的包名
- [x] npm `description` / `keywords` 已在当前 `package.json` 中配置。
- [ ] 发布前核对 npm 简介是否准确区分已实现能力和规划，并与中英文 README 一致。
- [ ] 在 GitHub 设置仓库简介和 topics，可使用 `deepseek`、`dsh`、`ble`、`voice-recorder`；核对公开展示结果。
- [ ] vendor 协议记录上游 commit
- [x] 上游完整版权与 MIT 声明保存在 `vendor/LICENSE`，覆盖协议模块与历史浏览器测试夹具中的上游部分；包预检检查许可文本及随包分发。
- [ ] 发布下一版本前更新版本号和 CHANGELOG，按实际发布内容与日期记录；已发布的 `0.1.0` 不重复使用。

## 后续版本发布步骤

1. 明确本次版本范围及已完成的验收；开发预览继续标注未完成能力。宣称支持完整流程前须完成 M1–M5，并落实 Python CLI 分发及依赖说明。
2. （可选）补齐 `locale/` + `icon`。
3. 运行 `npm run check:package` 核对实际 dry-run 清单。运行文件以 package.json 的 exports/files 为准，包含 Host/Client 入口、Remote 合约、共享服务、设备设置、转写归档管线、适配器、vendor 与 Skill 资源；另有 npm 自动包含的 `package.json`、README 和 LICENSE。确认 Skill 的本地引用随包提供，开发文档、测试及私人数据未进入包。
4. 更新为尚未发布的新版本号，整理对应 CHANGELOG。核对后运行 `npm publish`，保存版本、发布时间和包完整性摘要。
5. 干净环境验证：按目标 DSH 的实际 CLI schema 安装该次发布的明确版本（候选命令：`dsh plugin add dsh-recorder-card@<version>`，替换占位符）。记录安装参数、`application` 与 `warnings`，确认 `application: applied`、Host 可加载且 Skill 可发现及读取资源；卡片显示单列为可选项。完整流程另按 M2a/M2b/M3/M4 验收，仅安装成功不足以声明可用。
