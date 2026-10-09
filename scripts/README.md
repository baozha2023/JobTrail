# 脚本维护说明

所有命令从仓库根目录运行。`scripts/` 中的 `.mjs` 分为构建发布、自动测试、安装包验收和共享辅助模块；入口可以由 `package.json`、测试自动发现或其他脚本调用。

## 构建与发布

| 脚本                                                         | 调用方与用途                                                   |
| ------------------------------------------------------------ | -------------------------------------------------------------- |
| `pack-velopack.mjs`                                          | `pnpm release:win`：生成安装器与更新资产                       |
| `resolve-velopack-baseline.mjs`、`release-proxy.mjs`         | `pack-velopack.mjs`：基线资产解析与发布网络访问                |
| `finalize-velopack-assets.mjs`、`company-catalog-assets.mjs` | `pack-velopack.mjs`：整理更新资产、校验并生成公司目录 manifest |

这些模块对应的 `*.test.mjs` 由 `pnpm test` 自动发现，不需要逐个加入命令。测试不执行发布。

`electron-download-proxy.test.mjs` 同样由 `pnpm test` 发现：通过构建链实际使用的 `@electron/get` 在隔离子进程中下载合成文件，并验证 HTTPS CONNECT，确保安全 override 保留代理支持。测试只访问本地代理，不读取个人下载缓存。

## 自动测试与安装包验收

| 入口                                                 | 覆盖范围                                                                                                                                              |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm test`                                          | Node 脚本测试和 `tests/*.test.ts`；后者通过 `run-vitest-electron.mjs`、`vitest-electron-entry.mjs` 使用 Electron 的 SQLite ABI                        |
| `pnpm test:watch`                                    | Electron 环境的 Vitest 监听；不包含 Node 脚本测试                                                                                                     |
| `pnpm test:desktop:package`                          | `test-packaged-desktop.mjs` 验证隔离安装包桌面；`test-startup-errors.mjs` 验证启动错误边界；`test-desktop-lifecycle.mjs` 验证后台窗口、托盘和重复启动 |
| `pnpm test:mcp:package`                              | `test-packaged-mcp.mjs` 验证独立 MCP、系统 Edge 与 sandbox、动态网页、无 Edge 错误及协议行为                                                          |
| `pnpm test:mcp:launcher`                             | `test-mcp-launcher.mjs` 用 Cargo 锁文件构建启动器，再验证更新与 MCP 启动                                                                              |
| `pnpm test:agent:package`、`pnpm test:exams:package` | `test-packaged-agent.mjs`、`test-packaged-exams.mjs` 验证智能体和试卷完整流程                                                                         |
| `pnpm test:compatibility:package`                    | `test-packaged-compatibility.mjs` 使用原始正式版本代码生成数据和备份，验证升级、恢复及数据保留                                                        |
| `pnpm test:diagnostics:package`                      | `test-packaged-diagnostics.mjs` 验证 MCP / Agent 文件诊断与输出隔离                                                                                   |
| `pnpm test:discovery:local`                          | 岗位发现连接安全、界面、合成会话重启、MCP 冷启动及已有桌面复用；全部使用隔离安装目录，不访问招聘网站                                                  |

开发和验收机器须安装 Edge Stable，保持浏览器更新。网页读取使用系统 Edge，不下载或打包独立的 Playwright Chromium。MCP 验收会访问 https://playwright.dev/，需要可用公网连接；浏览器缓存使用隔离路径，缺失 Edge 用子进程环境变量隔离搜索位置模拟，不修改本机安装。桌面验收同样隔离 Edge 搜索位置，验证本地功能。该模拟不等同于全新虚拟机验收。

安装包验收前运行 `pnpm package:win`，启动器相关验收需要 Rust 工具链；兼容验收还需先构建启动器并保留脚本引用的 Git 历史。版本断言用于发现旧产物，但不能识别同版本号的源码改动，应用源码变更后仍须重新打包。

`test:discovery:local` 还需要 `native/bootstrap/target/debug/launcher.exe` 和 `native/bootstrap/target/release/uninstaller.exe`。首次运行前分别执行 `cargo build --locked --manifest-path native/bootstrap/Cargo.toml --bin launcher` 和 `cargo build --locked --release --manifest-path native/bootstrap/Cargo.toml --bin uninstaller`。

岗位发现发布验收还包含以下入口；数据与会话均使用独立临时目录：

- `node scripts/test-discovery-network.mjs`：在真实安装包与隔离 Session 中验证 TLS 证书拒绝、页面及 Service Worker、Session.fetch、内网阻断、DNS 重绑定、系统 HTTP 代理和不支持代理时禁止直连。仅使用本机合成服务及临时证书，不安装系统证书或访问招聘网站，属于 `test:discovery:local`。连接层单元测试另覆盖混合 DNS、HTTP 流与头部、CONNECT 边界、代理认证失败和关闭/恢复。
- `node scripts/test-discovery-dialogs.mjs`：合成数据验证登录平台默认勾选、未登录禁用、手动取消选择保留、退出同步、搜索/取消共用按钮和旋转图标，以及账号/历史弹窗、城市选择和历史删除。登录和会话失效提示验证共享扫码面板、二维码解码、无额外网站窗口及取消后保留提示；网站验证提示使用隔离 Session 的本地 HTTPS 页面验证同行按钮、独立窗口安全设置、重复点击、关窗不误消提示及队列推进。这些合成场景不代表真实网站验证成功。属于 `test:discovery:local`。
- `node scripts/test-packaged-session-restart.mjs`：合成会话材料验证重启保留，运行时不访问真实账号。属于 `test:discovery:local`。
- `node scripts/test-discovery-mcp-startup.mjs` 及追加 `--existing`：验证 MCP 后台启动、并发启动合并和复用已有桌面。两个模式都属于 `test:discovery:local`。
- `node scripts/test-desktop-lifecycle.mjs`：验证隐藏后台页面存在时的退出、托盘和重复启动；属于 `test:desktop:package`。
- `pnpm test:discovery:package`：直接通过共享服务探测四平台匿名搜索，抽样验证岗位网页、完整 JD 和界面保存；这不是需要先登录的搜索按钮流程。平台阻断、无结果导致未执行详情/保存、抽样 JD 不完整均记录为未通过，不能仅以搜索结束判定成功。
- `node scripts/test-packaged-qr.mjs`、`node scripts/test-packaged-qr-verification.mjs`：真实二维码及官方验证窗口，需要公网连接；网站阻断不表示搜索、JD 或登录验收通过。官方验证脚本在未触发 challenge 时会明确记录验证路径未执行，不代表验证交互通过。
- `node scripts/test-discovery-live.mjs [平台|all] [用例|all]`：源码级手动联网诊断，调用 `discovery-live-worker.ts`；每次建立全新的匿名数据和 Session，不读取开发目录配置、数据库或登录态。独立观察来源响应并按生产适配器解析结果核对数据库身份集合、薪资准入、续查和 10/20/50 条稳定分页；不能作为解析器正确性的独立证据，不覆盖 JD 或真实扫码登录。用例为 `salary`、`salary-min`、`salary-max`、`agent`、`java-beijing`、`java-shanghai`、`no-city`、`empty`。阻断结果使进程非零退出，并保存脱敏报告至 `dist/qa/`。

`release:win` 自动执行 `test:discovery:local`；真实联网、扫码及人工验证入口仍需单独执行并记录实际范围。已知发布阻断以 `CLAUDE.md` 和 `docs/job-discovery.md` 为准。

## 共享模块与异步等待

历史迁移、协议协商、启动器更新和代理测试分别验证对应的长期契约。源码级联网诊断验证来源集合、查询矩阵与分页；界面验收验证账号、搜索、历史和人工处理交互，二者覆盖范围独立。

`test-launcher-update.mjs` 由启动器测试和发布脚本共同调用。`assert-root-error-dialog.ps1` 由 MCP 安装包测试调用，负责 Windows 原生错误对话框断言。

涉及 IPC 的异步条件使用 `packaged-test-helpers.mjs` 的 `waitFor` 等待 Promise 完成；DOM 条件使用 `page.waitForFunction`。二维码图片使用解码结果确认可用，未执行的验证、详情或保存路径明确记录为未通过。

公共网络 URL 边界由 `tests/web-retrieval.test.ts` 覆盖：10240 字符接受、超过上限拒绝，长 URL 仍须通过协议、端口、凭据及公网地址检查。岗位响应分类、登录阻断优先级及已提交批次保留由岗位发现适配器和运行时测试覆盖。

## 隔离与版本约定

- `packaged-test-helpers.mjs` 只硬链接不可变程序文件。安装根目录的 `config.json`、`data`、`resumes`、`chat-uploads`、`browser-sessions`、`.runtime` 和 `logs` 不带入隔离环境；依赖内部同名目录仍保留。调用方只在自己的临时目录读写数据、清理产物，不修改硬链接程序文件。
- `config-test-helpers.mjs` 仅用于合成测试配置，复用构建密钥但不输出密钥或配置内容。
- 当前版本测试从 `package.json`、持久化版本常量和内置目录读取元数据。历史兼容样本、协议版本、格式契约断言及专门测试版本比较的值应固定，不能批量替换为当前版本。
- v1/v2 冻结样本、旧版本导出代码和 legacy MCP 用例仍是兼容性保障，不按版本号的新旧删除。legacy / modern 测试显式选择协议并断言协商结果。
- 内置目录已有地点；字典清理、精确数量和性能测试须使用可控的合成目录，或采用专用地点前缀限定查询，不能假设新库的地点表为空。真实目录 seed 由独立用例核对完整关联和去重结果。
- `out/`、`dist/`、依赖目录和忽略的个人文件不是待维护的源码脚本，不通过手工修改构建产物修复测试。
