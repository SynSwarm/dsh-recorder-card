# 随包 CLI 分发验证（2026-11-01）

**后续更新：** 同日 0.3.0 候选构建已在真实 DSH Web 创造模式通过扫描、地址持久化和首条导入；音频与先前用户确认的测试文件哈希一致，见 [Remote 实机记录](client-host-remote.md)。以下仍保留较早隔离依赖实验的失败及范围；M5 整体未完成。

本轮移除安装用户对外部上游 checkout 的依赖，不发布 npm、不修改用户日常 DSH profile，也不关闭 pnpm 的 minimumReleaseAge。

固定版本为 `de42d1fbf19fc92064ac4688f71f42730c82267f`；三个 Python 脚本、requirements 和 MIT 原样随包分发。`vendor/upstream/SOURCE.json` 记录来源与哈希；设备脚本原有 SOURCE_HASHES 未修改，转写增加独立校验。

默认源码定位到包内 `vendor/upstream/`。用户数据默认 `~/.dsh-recorder-card`，可用 `dataDir` 覆盖；源码与数据目录分离。测试数据、设备标识和原始日志只保存到忽略目录 `.cache/m5/`，不进入 npm 或 Git。

## 验证方法

1. 在 `.cache/m5/venv` 新建不继承全局 site-packages 的 Python 环境，仅安装 `bleak requests`。
2. 运行包预检并生成实际 npm tgz，解包到隔离目录。检查三份 Python 源码、许可、哈希和 Skill 资源完整。
3. 从无上游 checkout 的解包目录调用适配器，省略 repoRoot。验证缺依赖诊断、依赖检查及帮助输出；从解包后的 Host 服务启动受控调用。
4. 在用户授权的设备就绪后，用包内 CLI 扫描，配置所选 deviceAddress，读取列表并导入用户允许的首条测试录音；验证 WAV 结构、解码与数据路径。原始设备标识不写入公开记录。
5. 比较前后安装包目录摘要，确认缓存、音频、转写和字节码未写入源码目录。

## 较早分发实验结果（历史）

- Python 3.12.7 的全新 venv（不继承全局 site-packages）安装 Bleak 3.0.2、requests 2.34.2，依赖检查通过。系统 Python 仅负责创建 venv，使用系统已有蓝牙驱动；不是全新操作系统。
- 实际 npm tarball 共 21 个文件；包内设备源码两个原有哈希不变，转写源码独立哈希通过，MIT/Skill 资源齐全。
- Node 63 项与 Python 46 项回归通过。包含无 clone 的默认源码加载、缺依赖诊断、实际上游类/导入函数、数据路径分离及同名保护。测试按钮定位同步支持既有图标的 aria-label，未改变界面实现。
- 官方 CLI 将本地 tgz 安装到新建 `.cache/m5/dsh-profile` 成功，出现 peer 提示但 Host 加载正常；未手改 pnpm-workspace.yaml 或 release-age 设置。真实 DSH Node 24.18.1 中四项检查通过：包内固定源码、六工具注册、新 Skill、缺少设备地址时在设备访问前失败。
- 包内 Host 服务省略 repoRoot，使用隔离解释器和 dataDir：唤醒后扫描到唯一设备，确认列表 13 条。首次扫描未发现设备的结果如实保留。
- 列表之后的新导入调用超时，返回 TimeoutError，未发布音频；安装包目录逐文件摘要保持不变。此失败不算导入验收通过，设备重启后的直接复测、刷新扫描后的复测也超时（三次导入均未成功）。随后用此前工作的本机 WinRT 3.2.1 环境对照，连接返回 BleakDeviceNotFoundError，再次扫描也未发现设备。隔离环境使用 WinRT 4.x，但本次无法排除休眠或连接恢复因素，不认定依赖版本为根因，也未强行锁定版本。未删除卡内录音，未进行云转写。

## 验收边界

本地 tarball 与隔离依赖环境验证不等于 npm 已发布版本验证，也不是一台全新 Windows 安装。目标 DSH 的实际 Agent 配置入口、干净 profile 安装、硬件兼容性及完整 DSH 转写仍需分别记录；不得据此把整个 M5 标为通过。

本轮已验证 21 文件测试包的 SHA-256：`a2539b6abac58f0a572605f500d0adb7ae10a39668b06c8e71692f47e13f1e16`。后续并行工作新增 service/remote 导出，使当前包变为 23 文件；上述扫描/列表/导入尝试只对应 21 文件包。

最终 23 文件包的 SHA-256：`3c5c01638b66121d7f73f7e33878b143f1c1c4ed1851d88e2b2851d438f94a3b`。最终源码重新通过 Node 63 项、Python 46 项、包预检和文档本地链接检查；在第二个全新隔离 profile 中完成官方 CLI 安装及上述四项真实 Host 检查，解包后的依赖/源码检查也通过。没有重复连接硬件；并行 Remote 的实际运行不属于本轮验收。

**结论：外部 checkout 依赖已从默认安装路径移除；包分发和隔离 Host 加载通过本轮自检，真实新用户导入验收未通过，M5 保持未完成。** 下一步需先确认卡片持续广播及 Windows 连接状态，在稳定环境复测导入，再验证实际发布版本。源码与本地包均未提交或发布。
