# M1：DSH 接口核对与加载验证记录

## 当前结论

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

## 下一次真实环境验证

在目标 DSH 中按[贡献指南](../CONTRIBUTING.md#candidate-dsh-development-loading-procedure)执行，记录版本/profile、检查返回值、安装参数及以下结果：

1. 检查 Skill、Slot 和本轮实际需要的运行时接口；确认与本地参考版本的差异。
2. 通过该环境的插件管理入口加载本工作区，保存 `application` 与 `warnings`。
3. 确认卡片显示、Skill 可发现、正文及 `references/runtime.md` / 协议模块可读。
4. 禁用、重新启用并检查重复注册、组件卸载和连接清理；浏览器控制不可用时明确保留视觉待验项。

上述真实环境证据补齐后，再更新 M1 验收状态。开发源码参考、已通过 QA 的修复和本轮自动检查分别记录，不互相替代。
