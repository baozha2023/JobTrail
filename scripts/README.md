# 脚本维护说明

所有命令从仓库根目录运行。`scripts/` 中的 `.mjs` 分为构建发布、自动测试、安装包验收和辅助模块；不能仅凭没有同名 `package.json` 命令判断文件已废弃。

## 构建与发布

| 脚本                                                         | 调用方与用途                                                   |
| ------------------------------------------------------------ | -------------------------------------------------------------- |
| `pack-velopack.mjs`                                          | `pnpm release:win`：生成安装器与更新资产                       |
| `resolve-velopack-baseline.mjs`、`release-proxy.mjs`         | `pack-velopack.mjs`：基线资产解析与发布网络访问                |
| `finalize-velopack-assets.mjs`、`company-catalog-assets.mjs` | `pack-velopack.mjs`：整理更新资产、校验并生成公司目录 manifest |

这些模块对应的 `*.test.mjs` 由 `pnpm test` 自动发现，不需要逐个加入命令。测试不执行发布。

`electron-download-proxy.test.mjs` 同样由 `pnpm test` 发现：通过构建链实际使用的 `@electron/get` 在隔离子进程中下载合成文件，并验证 HTTPS CONNECT，确保安全 override 保留代理支持。测试只访问本地代理，不读取个人下载缓存。

## 自动测试与安装包验收

| 入口                                                 | 覆盖范围                                                                                                                       |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm test`                                          | Node 脚本测试和 `tests/*.test.ts`；后者通过 `run-vitest-electron.mjs`、`vitest-electron-entry.mjs` 使用 Electron 的 SQLite ABI |
| `pnpm test:watch`                                    | Electron 环境的 Vitest 监听；不包含 Node 脚本测试                                                                              |
| `pnpm test:desktop:package`                          | `test-packaged-desktop.mjs` 验证隔离安装包桌面；`test-startup-errors.mjs` 用构建后的桌面入口验证启动错误边界                   |
| `pnpm test:mcp:package`                              | `test-packaged-mcp.mjs` 验证独立 MCP、系统 Edge 与 sandbox、动态网页、无 Edge 错误及协议行为                                   |
| `pnpm test:mcp:launcher`                             | `test-mcp-launcher.mjs` 用 Cargo 锁文件构建启动器，再验证更新与 MCP 启动                                                       |
| `pnpm test:agent:package`、`pnpm test:exams:package` | `test-packaged-agent.mjs`、`test-packaged-exams.mjs` 验证智能体和试卷完整流程                                                  |
| `pnpm test:compatibility:package`                    | `test-packaged-compatibility.mjs` 使用原始正式版本代码生成数据和备份，验证升级、恢复及数据保留                                 |
| `pnpm test:diagnostics:package`                      | `test-packaged-diagnostics.mjs` 验证 MCP / Agent 文件诊断与输出隔离                                                            |

开发和验收机器须安装 Edge Stable，保持浏览器更新。v1.6.0 不再下载或打包 Playwright Chromium。MCP 验收会访问 https://playwright.dev/，需要可用公网连接；浏览器缓存使用隔离路径，缺失 Edge 用子进程环境变量隔离搜索位置模拟，不修改本机安装。桌面验收同样隔离 Edge 搜索位置，验证本地功能。该模拟不等同于全新虚拟机验收。

安装包验收前运行 `pnpm package:win`，启动器相关验收需要 Rust 工具链；兼容验收还需先构建启动器并保留脚本引用的 Git 历史。版本断言用于发现旧产物，但不能识别同版本号的源码改动，应用源码变更后仍须重新打包。

`test-launcher-update.mjs` 同时被启动器测试和发布脚本调用，属于共享验收模块。`assert-root-error-dialog.ps1` 由 MCP 安装包测试调用，用于检查 Windows 原生错误对话框；两者均需保留。

## 隔离与版本约定

- `packaged-test-helpers.mjs` 只硬链接不可变程序文件。安装根目录的 `config.json`、`data`、`resumes`、`chat-uploads`、`.runtime` 和 `logs` 不带入隔离环境；依赖内部同名目录仍保留。调用方只在自己的临时目录读写数据、清理产物，不修改硬链接程序文件。
- `config-test-helpers.mjs` 仅用于合成测试配置，复用构建密钥但不输出密钥或配置内容。
- 当前版本测试从 `package.json`、持久化版本常量和内置目录读取元数据。历史兼容样本、协议版本、格式契约断言及专门测试版本比较的值应固定，不能批量替换为当前版本。
- v1/v2 冻结样本、旧版本导出代码和 legacy MCP 用例仍是兼容性保障，不按版本号的新旧删除。legacy / modern 测试显式选择协议并断言协商结果。
- 内置目录已有地点；字典清理、精确数量和性能测试须使用可控的合成目录，或采用专用地点前缀限定查询，不能假设新库的地点表为空。真实目录 seed 由独立用例核对完整关联和去重结果。
- `out/`、`dist/`、依赖目录和忽略的个人文件不是待维护的源码脚本，不通过手工修改构建产物修复测试。
