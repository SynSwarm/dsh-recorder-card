# M1：DSH 接口核对与加载验证记录

## 当前结论：M1 自验收通过（2026-11-01）

使用用户提供的 DSH 安装，通过官方 CLI 将本地测试 tarball 安装到工作区隔离 profile，验证了真实 Host 加载、六个工具注册、Skill 正文/资源访问，以及禁用、重启用和活动测试子进程清理。这里只通过 M1；M2a/M2b 的完整硬件验收、M3 导入与 M4 DSH 转写仍未通过，也没有发布此工作区版本。以下历史记录保留当时边界，不作为当前状态。

| 环境 / 项目 | 实测记录 |
|---|---|
| 系统 | Windows 11 Pro（既有 M2a 机器） |
| DSH | Desktop `0.2.0-rc.2`；安装目录 `D:\ProgramFiles\dsh` |
| 官方 CLI | `resources/runtime/cli/bin/dsh.cmd`；`--version` 核对通过 |
| Host Node | `24.18.1`（与本地测试 Node `24.14.0` 分开记录） |
| profile | `headless`，`DSH_HOME` 指向工作区 `.cache/dsh-validation`，与用户日常 profile 隔离 |
| 本地安装 | `dsh plugin --profile headless add <本地测试 tgz>`；测试包沿用工作区 `0.1.1` 元数据，不是 npm 重发 |
| 加载 | inventory 中 `include:recorder-card` 的 `fiberPhase: active` |
| 工具 | `recorder_scan/status/list/record/import/transcribe` 六项 schema 可发现 |
| Skill | `recorder-card-bringup` 可读取正文，`references/runtime.md` 可访问 |
| 缺少配置 | 调用 `recorder_status` 返回 `isError: true`、`RECORDER_CONFIG_OR_ARGUMENT`，没有启动设备操作 |
| 活动进程停用 | 外部测试脚本只写 PID 并等待；`recorder_transcribe` 被禁用中断，结果 `RECORDER_ABORTED`，原 PID 已不存在 |
| 禁用 / 重启用 | 两次 `setPluginEnabled` 均返回 `application: applied`、`warnings: []`；禁用后无工具/Skill，重新启用恰有六个工具 |

这些调用通过探针使用该 Host 的真实 `ctx.tools`、`ctx.skills`、`ctx.pluginManager` 服务完成，没有调用模型或云转写。当前聊天没有 `cordis_inspect_*` / `plugin_manager` 连接器，因此使用了官方 CLI 与服务验证作为替代；没有手改日常 profile。最初的启动阶段启用结果曾为 `restart-required`，未据此宣称已生效；上表的启停证据来自后续实际返回 `applied` 的操作与注册表检查。

安装日志存在 pnpm peer 提示；Host 在实际 DSH 包解析器下成功加载，不能据此宣称任意独立 Node 环境都可直接导入。直接动态导入带本地开发依赖的工作区会产生另一份 `HarnessError` 类，导致真实 Host 丢失错误码；正式安装测试包后此问题消失。应测试包的正常加载路径，不能用手动 `import(index.js)` 代替安装验证。

最终本地测试 tarball 的 SHA-256 为 `f9b20b2b1c48dfc8135a2e7778e7dc823cb7e5ac09edbc29673e6802613696cf`；重新安装该包后六项探针检查通过。自动自检为 Node 51 项、Python 23 项、包清单 14 个文件、本地 Markdown 链接目标 127 个，以及 `git diff --check`，均通过。测试包和原始报告保存在忽略目录，开发源码未提交、未发布。

### 复现要点

[Host 验证探针](../scripts/dsh-host-probe.mjs)保留在开发目录，不进入 npm 包。它会启停该测试 profile 的插件并结束测试 Host，仅应在专用临时 profile 中执行；探针要求 `config.profileHome` 与环境 `DSH_HOME` 一致，并存在手动建立的 `.recorder-test-profile` 标记。

1. 按贡献指南安装本地开发依赖、运行自动检查。使用 `npm pack --ignore-scripts --cache .cache/npm --pack-destination .cache` 生成本地测试包。
2. 将当前进程的 `DSH_HOME` 临时设为绝对的 `.cache/dsh-validation` 路径；通过上述官方 CLI 的 `plugin --profile headless add <tgz>` 安装。不要复制本机路径到他人的配置，也不要改日常 profile。
3. 在测试 home 建立 `.recorder-test-profile` 标记。建立 `fixture-cli/tools/qs668-transcribe.py`，内容仅为下面的无音频脚本。它不是设备 CLI，不得用于硬件验收。

```python
import os
from pathlib import Path
import time
Path("started.txt").write_text(str(os.getpid()), encoding="utf-8")
time.sleep(60)
```

4. 准备本地 `--patch` overlay：禁用 `headless-startup` / `headless-runner`，启用 `hmr`；插入探针绝对路径，config 提供 `profileHome` 和 `runtimeVersion: 0.2.0-rc.2`。为 `recorder-card` 覆盖 `python`（解释器路径）、`repoRoot`（该 fixture-cli 绝对路径），不填写设备地址。所有 overlay 和报告均留在忽略目录。
5. 运行 `dsh --profile headless --patch <overlay>`。读取测试 home 的 `probe-result.json`，要求 `passed: true`、六项 checks、禁用/启用均 `applied` 且无 warnings。测试结束恢复原来的环境变量。Windows 需允许测试进程终止自己的子进程树。

本轮没有连接录音卡、录音、导入真实音频或调用真实转写；没有验证桌面设置页、浏览器 Slot、用户现有 profile 或已发布 npm 包。活动进程清理是合成脚本证据，不等同于 BLE 协议取消、录音回滚或部分音频恢复。结论为开发者自检，尚无本轮独立 QA。

## 2026-10-31 历史结论

2026-10-31 完成本地源码核对、Host provider 合约测试和 npm 包内容预检。M1 **尚未验收**：本次环境没有 PATH 上的 `dsh`、`DSH_PROFILE` 或可调用的 `cordis_inspect_*` / `plugin_manager`，没有安装、启用或停用任何真实 profile。

用户同意参考本机 `E:\dshwork\dsh-src`。该目录包含选定包的构建产物，不是已验证运行的 DSH 安装。下列包的 `package.json` 均声明 `0.2.0-rc.2`，与本项目既定 `@deepseek-ai/dsh-skill` peer 版本一致；Cordis peer 保持 `~4.0.4`。这不是运行时兼容性通过的声明。

## 源码依据

文件路径相对于本地参考目录；摘要用于复查具体内容，不代表上游 commit。

| 文件 | SHA-256 |
|---|---|
| `dsh-skill/lib/index.js` | `4b88621be4e7ff09b05c175fc6dcb67e77a22e5c5570e3aa603338b2937ea791` |
| `dsh-skill-office/lib/index.js` | `203d1680ef0f6f35f5885aa2b6050a33ef0294ed0aa5ec9441dada9e0b987d84` |
| `dsh-experimental-client-ui-voice-input/lib/client.js` | `d2ac1fe89c91ef5c940063920d3663d96cdf6c40f6c19d24b7e7ee8ea083aead` |
| `dsh-plugin-manager/lib/types/tools.js` | `b7314b13486bd32657b20b931826a5f91bf2c421983438f29f7491ecd69d8eb0` |

| 接口 | 源码核对结果 | 尚需实测 |
|---|---|---|
| Skill provider | `ctx.skills.registerProvider(factory)`；provider 提供 `name`、`list()`、`get(candidate, options)` | 注册、目录发现、正文加载 |
| Skill 生命周期 | 注册表自行登记 Cordis effect，卸载时移除 provider、取消生命周期并失效缓存 | 重复启停后无残留注册 |
| Skill 读取 | `get` 接收取消信号；Office 示例从定义返回值中移除 `rank`、`locator` | 实际 Agent 加载和读取随包资源 |
| Client Slot | 官方语音输入使用 `slots.inject` + `slots.register` 注册 `conversation.input.activity` | 当前 profile 中 Slot 是否存在、注册选项/props、渲染与卸载 |
| 插件安装 | `plugin_manager` 支持 `action: install_bundle` 与目录 `target`，结果需检查 application/warnings | 真正安装和激活结果；当前没有执行 |
| Agent 工具 / Remote | 本插件仍未注册；本轮未实现这些接口 | 在目标运行时继续检查所需 schema |

## 本轮实现

- Host 仅读取自己拥有的 Skill locator，返回正文与公开元数据，不暴露发现阶段的 `rank` 和 `locator`；异步读取支持取消。
- 移除没有资源可清理的空 effect；provider 生命周期继续由已核对的 Skill 注册表管理。
- 安装后所需的[运行说明](../skill/references/runtime.md)放入 `skill/references/`；Skill 不再依赖未随 npm 包发布的开发文档。开发文档继续保留在仓库中。
- 新增 Host 合约测试及包预检，均不启动 Python、不访问设备、不改变 DSH profile。

## 本地证据与边界

环境：Windows PowerShell，Node.js `v24.14.0`。

- `npm.cmd test`：30 项通过，含 6 项 Host/manifest 合约测试和 24 项 Client/协议模拟回归。
- `npm.cmd run check:package`：npm dry-run 清单包含 10 个文件；Skill 的全部本地 Markdown 引用可在清单内解析。排除开发目录及常见私人数据文件。
- Host 测试通过捕获 provider 检查合约，未执行真实 Cordis 注册表；Client 回归使用既有模拟 hooks/BLE。不能据此标记真实卸载、Slot 渲染或硬件兼容通过。
- 包预检不安装 peer 依赖，也不发布或安装插件；不能替代干净环境安装。

## 路线调整后的验收范围

2026-10-31 主线调整为 Host Python CLI。上述源码与本地测试记录保留为历史证据，不将路线调整视为运行验证通过。M1 仅验收 Host 加载、Skill 与资源访问、Host 启停清理；M2a 的独立 CLI 实机验证可先开展，M2b 在 M1/M2a 通过后验证 DSH 设备工具。Slot、卡片与 Client–Host 通信归为可选增强。

## 2026-10-31 制定的真实环境验证步骤

在目标 DSH 中按[贡献指南](../CONTRIBUTING.md#candidate-dsh-development-loading-procedure)执行，记录版本/profile、检查返回值、安装参数及以下结果：

1. 检查插件加载与 Skill 接口，确认与本地参考版本的差异；Service/Tool 接口在 M2b 核实，Slot/通信接口按可选界面需求另验。
2. 通过该环境的插件管理入口加载本工作区，保存 `application` 与 `warnings`。
3. 确认 Host 加载、Skill 可发现、正文及 `references/runtime.md` / 协议模块可读；若 Client 依赖阻碍 Host 加载，先解决耦合再验收。
4. 禁用、重新启用并检查重复 provider 和 Host 资源残留。卡片显示、组件卸载和浏览器连接清理单独记录为可选项，不阻塞 M1。

上述真实环境证据补齐后，再更新 M1 验收状态。开发源码参考、已通过 QA 的修复和本轮自动检查分别记录，不互相替代。

## Host 进程管理层本地进展（2026-10-31）

新增 `runtime/host-cli.js`：模块内共享设备队列、参数基础检查、190 秒默认运行时限、8 MiB 输出上限、AbortSignal 取消及停用清理。`ctx.effect(() => asyncCleanup, label)` 的生命周期形式与本地 `dsh-plugin-manager/lib/index.js` 的 package cancellation 实现核对一致；该源码核对不代表实际 DSH 启停通过。

新增 13 项 Node 测试使用专用子进程，验证多实例串行、取消排队项、退出后恢复、活动子进程树终止，以及终止失败时报告错误且持续占用设备队列。Windows 沙箱限制终止操作，首次受限测试已清理；获准本机权限下复测通过。测试未连接录音卡，未调用外部转写。当前仍没有可用的 `dsh` PATH 入口或 `cordis_inspect_*` / `plugin_manager` 运行时连接；M1/M2b 继续保持未验收。

本轮完整自检：`npm.cmd test` 43 项、`npm.cmd run test:cli` 23 项通过；包预检确认 13 个文件，包含两份 runtime 文件且不包含测试/字节码缓存；119 个本地 Markdown 链接目标检查及 `git diff --check` 通过。未提交、未发布，也未操作硬件。
