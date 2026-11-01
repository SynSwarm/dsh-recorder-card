# Release checklist

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
- [ ] 完整流程发布前确定 Python CLI 分发方式、固定上游版本及许可。当前开发使用外部 checkout，前提见[运行说明](skill/references/runtime.md)；依赖按选定上游版本安装，不将未验证的依赖列表当作安装保证。
- [x] npm 账号 + `npm publish`（已发布 `dsh-recorder-card@0.1.0`）

## 强烈建议（体验 / 可发现性）

- [ ] `locale/en.json` + `locale/zh.json`（`meta.title`/`description`）+ 顶层 `icon`——否则插件面板只有光秃秃的包名
- [x] npm `description` / `keywords` 已在当前 `package.json` 中配置。
- [ ] 发布前核对 npm 简介是否准确区分已实现能力和规划，并与中英文 README 一致。
- [ ] 在 GitHub 设置仓库简介和 topics，可使用 `deepseek`、`dsh`、`ble`、`voice-recorder`；核对公开展示结果。
- [ ] vendor 协议记录上游 commit
- [x] 上游完整版权与 MIT 声明保存在 `vendor/LICENSE`，覆盖协议模块和 Client 内联副本；包预检检查许可文本及随包分发。
- [ ] 发布下一版本前更新版本号和 CHANGELOG，按实际发布内容与日期记录；已发布的 `0.1.0` 不重复使用。

## 后续版本发布步骤

1. 明确本次版本范围及已完成的验收；开发预览继续标注未完成能力。宣称支持完整流程前须完成 M1–M5，并落实 Python CLI 分发及依赖说明。
2. （可选）补齐 `locale/` + `icon`。
3. 运行 `npm run check:package` 核对实际 dry-run 清单。运行文件限于 `index.js`、`client.js`、`cordis.patch.yml`、`vendor/`、`skill/`（含 `skill/references/`）、`runtime/recorder_cli.py`、`runtime/host-cli.js`、`runtime/tools.js`；另有 npm 自动包含的 `package.json`、README 和 LICENSE。确认 Skill 的本地引用随包提供，开发文档、测试及私人数据未进入包。
4. 更新为尚未发布的新版本号，整理对应 CHANGELOG。核对后运行 `npm publish`，保存版本、发布时间和包完整性摘要。
5. 干净环境验证：按目标 DSH 的实际 CLI schema 安装该次发布的明确版本（候选命令：`dsh plugin add dsh-recorder-card@<version>`，替换占位符）。记录安装参数、`application` 与 `warnings`，确认 `application: applied`、Host 可加载且 Skill 可发现及读取资源；卡片显示单列为可选项。完整流程另按 M2a/M2b/M3/M4 验收，仅安装成功不足以声明可用。
