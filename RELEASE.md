# Release checklist

## 0.4.0 单图标与持续连接发布

用户已确认 QA 通过并授权发布。版本范围包括单图标连接、对话引导、持久 BLE worker、连接/断开工具，以及队列取消和清理警告修复；仍为开发预览版。**[dsh-recorder-card@0.4.0](https://www.npmjs.com/package/dsh-recorder-card/v/0.4.0) 已发布并核验。** 发布时间为 `2026-11-01T15:35:44.368Z`（北京时间 23:35:44），latest 指向 0.4.0，description 与 package.json 一致。首次认证查询 E404 后重新验证成功；发布接受后曾短暂返回版本 E404，随后元数据与下载核验通过。

发布前 113 项 Node、54 项 Python 测试通过；30 文件包预检、实际 tarball 与工作区逐文件比对、18 份 Markdown 本地链接检查及 diff 检查通过。本地包 SHA-256 为 `89eb7d7816ab0e94da28cbda029339380a2ac71dd5f713dc38ab2243fb0c3f0c`，shasum 为 `08ba10011d91133d2d821b11abc0c658186ed3fe`。真实桌面图标/主题、连接和引导提交证据，以及尚未完成的物理掉线、持续会话导入恢复和有凭据的 Agent 回复验证，见 [Remote 记录](docs/client-host-remote.md)。本次发布不扩大这些实机结论，未新增 DSH 安装或硬件操作，也未创建 Git 提交、推送或标签。

注册表的 shasum、integrity 均与本地一致；重新下载的 tarball 与本地测试包逐字节一致。发布证据和下载包保留在忽略目录 `.cache/releases/0.4.0/`。严格执行 24 小时发布年龄门槛的环境应等到北京时间 **2026-11-02 23:36 之后**再安装；本次没有修改或添加年龄豁免。

## 0.3.1 缓存修复发布

用户已确认 QA 通过并授权发布。0.3.1 修复缓存返回前音频指纹复核及换路径后的归档关联。发布前 93 项 Node 测试、28 文件包预检、语法/文档链接检查通过；从实际 tarball 提取的转写模块也通过 13 项回归。与 0.3.0 的包差异仅为转写模块、package.json 和相关 README/Skill 说明。详见 [缓存验证记录](docs/transcription-validation.md)。

**[dsh-recorder-card@0.3.1](https://www.npmjs.com/package/dsh-recorder-card/v/0.3.1) 已发布并核验。** 注册表时间为 `2026-11-01T10:18:51.481Z`（北京时间 18:18:51），latest 指向 0.3.1，description 与 package.json 一致。npm 接受后曾短暂 E404，随后元数据及下载均通过核对。

下载包与本地测试包的 SHA-256 一致：`e5a2f8135708fcd1279d3630e8f4a2ab1654c1509f10ebabd23e9b798b34bc50`；注册表 shasum `31a51bdf28cf6be9dc9872a3859c924c8aa65cec` 及 integrity 也一致。严格 `minimumReleaseAge: 1440` 的环境应等到北京时间 **2026-11-02 18:19 之后**再安装 0.3.1；本轮未执行 DSH 安装或添加豁免。

未提交、推送或创建 Git 标签。本轮没有新增 DSH/硬件/云 ASR 操作；0.3.0 的实机证据不扩大为 0.3.1 的新增实机验收。

## 0.3.0 历史发布记录

此前已发布 **[dsh-recorder-card@0.3.0](https://www.npmjs.com/package/dsh-recorder-card/v/0.3.0)**。注册表发布时间为 `2026-11-01T10:02:58.385Z`（北京时间 18:02:58），当时 latest 指向 0.3.0，description 与当前 package.json 一致。npm 接受请求后曾短暂返回 E404，随后可见性与下载均已核实。

本轮自检：89 项 Node、46 项 Python 测试通过；28 文件包预检、25 个 JS 文件语法和 17 份 Markdown 的本地链接目标检查通过。真实 Host SenseVoice 转写/工具复用及隔离原生桌面配置/认证/主题模拟证据见 [M4](docs/transcription-validation.md) 与 [Remote](docs/client-host-remote.md)。这是开发者自检，不是独立 QA。

已发布 tarball 的 SHA-256 为 `8595bca8c691204343f9216682492192e1c3524a7efcd6c394382fa94ba0b31d`，npm shasum 为 `d2200c091578c32309edc6d53a86c7d262b853c0`。注册表 shasum/integrity 与本地产物一致，重新下载的包也通过逐字节 SHA-256 比较。

新隔离 Web profile 从 npm 安装成功，随后实际 Host 的 Gateway SenseVoice 转写和 Agent 归档复用通过。注意：pnpm 11.7.0 默认安装明确的新版本时自动添加了 `minimumReleaseAgeExclude`，该次安装不能称为遵守 24 小时门槛的验证。已移除测试目录自动豁免；第二个全新 profile 显式启用 `minimumReleaseAge: 1440` 与 `minimumReleaseAgeStrict: true`，正确返回 `ERR_PNPM_NO_MATURE_MATCHING_VERSION`，没有添加豁免。严格策略下应等待北京时间 **2026-11-02 18:03 之后**再装；未修改日常 profile 或绕过其策略。

发布前对照本清单。DSH 插件**无应用商店审核**：用户输入一个 spec 即直接安装。装插件 = 在用户 DSH 的 Node 进程 / 浏览器中运行你的代码，信任来自开源与可读源码，而非平台背书。

## 历史版本核对待办

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
