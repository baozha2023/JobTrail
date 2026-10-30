# 脚本维护说明

所有命令从仓库根目录运行。`scripts/` 中的 `.mjs` 分为构建发布、自动测试、安装包验收和共享辅助模块；入口可以由 `package.json`、测试自动发现或其他脚本调用。

`pnpm package:win` 在编译后显式调用 Electron 官方 `install-electron`，确保当前锁定版本的二进制已下载并校验，再将 `node_modules/electron/dist` 交给 electron-builder。当前 Electron 43.8.4 不通过包的 postinstall 自动下载，不能依赖曾经运行过开发环境或测试才具备该目录。

## 构建与发布

| 脚本                                                         | 调用方与用途                                                   |
| ------------------------------------------------------------ | -------------------------------------------------------------- |
| `pack-velopack.mjs`                                          | `pnpm release:win`：生成安装器与更新资产                       |
| `resolve-velopack-baseline.mjs`、`release-proxy.mjs`         | `pack-velopack.mjs`：基线资产解析与发布网络访问                |
| `finalize-velopack-assets.mjs`、`company-catalog-assets.mjs` | `pack-velopack.mjs`：整理更新资产、校验并生成公司目录 manifest |
| `cleanup-release-output.mjs`                                 | `pack-velopack.mjs`：发布成功后按固定清单清理中间产物          |

`pnpm release:win` 在全部验收、安装器和更新资产生成及校验成功后，自动删除 `dist/win-unpacked/`、`dist/qa/`、`dist/compatibility/`、`builder-debug.yml`、`builder-effective-config.yaml`、`exam-smoke.png` 和 `exam-smoke-failure.png`（文件均位于 `dist/`），以及 `dist` 下以 `.discovery-dialogs-`、`.discovery-mcp-`、`.session-restart-`、`.onboarding-` 开头并带六位字母数字随机后缀的隔离验收目录。保留 `dist/velopack/` 发布资产和清单外文件；构建失败时不执行此收尾清理，便于排查。清理拒绝链接目录或类型异常，失败使发布命令非零退出。需要保留的验收报告应事先另存；发布成功后若要单独运行安装包验收，先重新执行 `pnpm package:win`。

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
| `pnpm test:agent:package`、`pnpm test:exams:package` | `test-packaged-agent.mjs`、`test-packaged-exams.mjs` 验证智能体和试卷完整流程；智能体 worker 通过测试专用 bootstrap 禁止外部 fetch，验证随包本地分词  |
| `pnpm test:compatibility:package`                    | `test-packaged-compatibility.mjs` 使用 1.0.0—2.3.0 原始正式版本代码生成数据和备份，验证升级、恢复及数据保留                                           |
| `pnpm test:diagnostics:package`                      | `test-packaged-diagnostics.mjs` 验证 MCP / Agent 文件诊断与输出隔离                                                                                   |
| `pnpm test:discovery:local`                          | 岗位发现连接安全、界面、合成会话重启、MCP 冷启动及已有桌面复用；全部使用隔离安装目录，不访问招聘网站                                                  |

开发和验收机器须安装 Edge Stable，保持浏览器更新。网页读取使用系统 Edge，不下载或打包独立的 Playwright Chromium。MCP 验收会访问 https://playwright.dev/，需要可用公网连接；浏览器缓存使用隔离路径，缺失 Edge 用子进程环境变量隔离搜索位置模拟，不修改本机安装。桌面验收同样隔离 Edge 搜索位置，验证本地功能。该模拟不等同于全新虚拟机验收。

通用网页读取器会校验系统 DNS 结果并连接获准的公网地址。代理软件的 Fake-IP 模式若返回 `198.18.0.0/15` 等非公网地址，会按安全规则返回 `WEB_BLOCKED`；关闭该模式后仍需确认目标地址可达。`WEB_UNAVAILABLE` 仅表示读取不可用，应结合隔离安装的诊断日志定位连接或页面错误，不能仅凭错误码认定为代理问题。遇到此类环境故障，调整网络后重跑 `test:mcp:package` 和 `test:mcp:launcher`，不放宽公网地址校验，也不将跳过的外网验收记录为通过。

安装包验收前运行 `pnpm package:win`，启动器相关验收需要 Rust 工具链；兼容验收还需先构建启动器并保留脚本引用的 Git 历史。版本断言用于发现旧产物，但不能识别同版本号的源码改动，应用源码变更后仍须重新打包。

`test-desktop-lifecycle.mjs` 使用隔离数据运行真实桌面，覆盖系统英文首次启动、语言传至界面，以及手动切换中文后重启不再检测或覆盖。系统语言通过测试入口替换 Electron API 返回值，不修改 Windows 语言设置；检测失败与中文兜底由配置和语言单元测试覆盖。

`cargo test --manifest-path native/bootstrap/Cargo.toml --locked` 覆盖原生程序的语言检测、中英文文案完整性、真实 Windows 安装控件在 96/120/144/192 DPI 下的文字布局，以及卸载确认/完成窗口与取消保护。原生界面测试仅操作测试进程自己的窗口，不执行安装或卸载；目录清理、关联保护和更新回滚由对应 Rust 测试覆盖。

`test:discovery:local` 还需要 `native/bootstrap/target/debug/launcher.exe` 和 `native/bootstrap/target/release/uninstaller.exe`。首次运行前分别执行 `cargo build --locked --manifest-path native/bootstrap/Cargo.toml --bin launcher` 和 `cargo build --locked --release --manifest-path native/bootstrap/Cargo.toml --bin uninstaller`。

岗位发现发布验收还包含以下入口；数据与会话均使用独立临时目录：

- `pnpm test:onboarding:package`：验证全应用 9 步和岗位发现 12 步引导、重启续接、两套独立进度、真实账号弹窗前后切换、空结果、中英文、深浅色、窄窗口缩放、焦点与设置页重新开始，截图保存到 `dist/qa/onboarding-*.png`。另用合成岗位与隔离本地 HTTPS 页面验证同一原生网页在引导期间隐藏、退出后恢复。不申请二维码、不登录、不提交搜索。属于 `test:desktop:package`；其他安装包脚本通过真实引导入口跳过基础引导，并通过正式配置 IPC 结束专项引导，避免干扰各自业务验收。
- `node scripts/test-discovery-network.mjs`：在真实安装包与隔离 Session 中确认所有平台均采用系统网络配置，再以临时本机代理和 HTTPS 服务验证 Chromium 的 TLS、Session.fetch、页面、Service Worker、Cookie、重定向和取消。模拟代理只作用于测试 Session，不改变 Windows 设置、不安装系统证书、不访问招聘网站，属于 `test:discovery:local`。账号会话单元测试覆盖系统配置初始化、并发、失败重试及关闭/恢复。
- `node scripts/test-discovery-dialogs.mjs`：合成数据验证登录平台默认勾选、未登录禁用、手动取消选择保留、退出同步、搜索/取消共用按钮和旋转图标，以及账号/历史弹窗、城市选择和历史删除。尺寸与缩放检查前先恢复最小化或隐藏的窗口、退出最大化，等待原生尺寸与渲染视口同步；失败时记录目标尺寸、实际尺寸、缩放和窗口状态。登录和会话失效提示验证共享扫码面板、二维码解码、无额外网站窗口及取消后保留提示；网站验证提示使用隔离 Session 的本地 HTTPS 页面验证同行按钮、独立窗口安全设置、重复点击、关窗不误消提示及队列推进。这些合成场景不代表真实网站验证成功。属于 `test:discovery:local`。
- `node scripts/test-packaged-session-restart.mjs`：合成会话材料验证重启保留，运行时不访问真实账号。属于 `test:discovery:local`。
- `node scripts/test-discovery-mcp-startup.mjs` 及追加 `--existing`：验证 MCP 后台启动、并发启动合并和复用已有桌面。两个模式都属于 `test:discovery:local`，并在 `finally` 中核对真实 HKCU 的职迹卸载登记与运行前完全一致。启动器只刷新属于本安装根的既有登记，未登记的验收目录不会创建或覆盖用户登记；`APPDATA` 不能隔离注册表。
- `node scripts/test-desktop-lifecycle.mjs`：验证隐藏后台页面存在时的退出、托盘和重复启动；属于 `test:desktop:package`。
- `pnpm test:discovery:package`：在隔离安装目录检查各平台账号界面、匿名搜索的后端登录准入、零批次/零结果以及历史查看；不访问真实账号，不宣称已验证登录后的列表、JD 或保存链路。
- `node scripts/test-packaged-qr.mjs [平台] [app|wechat]`、`node scripts/test-packaged-qr-verification.mjs`：真实二维码及官方验证窗口，需要公网连接。二维码脚本可指定平台和方式，检查界面切换、图片解码、未扫码状态、刷新后保留方式及关闭取消，例如 `boss app`、`liepin app`、`zhilian wechat`；单方式报告分别保存，避免覆盖。网站阻断不表示搜索、JD 或登录验收通过。官方验证脚本在未触发 challenge 时会明确记录验证路径未执行，不代表验证交互通过。
- `node scripts/test-discovery-live.mjs [平台|all] [用例|all]`：源码级手动联网诊断，调用 `discovery-live-worker.ts`；每次建立全新的匿名数据和 Session，不读取开发目录配置、数据库或登录态。独立观察来源响应并按生产适配器解析结果核对数据库身份集合、薪资准入、续查和 10/20/50 条稳定分页；不能作为解析器正确性的独立证据，不覆盖 JD 或真实扫码登录。用例为 `salary`、`salary-min`、`salary-max`、`agent`、`java-beijing`、`java-shanghai`、`no-city`、`empty`。阻断结果使进程非零退出，并保存脱敏报告至 `dist/qa/`。

`release:win` 自动执行 `test:discovery:local`；真实联网、扫码及人工验证入口仍需单独执行并记录实际范围。通用验收要求见 `AGENTS.md` 和 `docs/job-discovery.md`；实际发布阻断以当次测试报告和运行日志为准。

`node scripts/test-agent-discovery-live.mjs --live-model` 是用户明确授权后才运行的手动验收，不加入开发启动、常规测试或发布链。先运行 `pnpm build`；脚本只读当前开发环境加密配置，在内存中使用配置的 API 与模型，隔离启动完整 Electron 客户端、utility process 和 MCP 子进程。模型真实生成调用 ID 和参数，测试中按阶段限定岗位发现读取工具并明确当前步骤，每个恢复场景使用独立岗位身份，避免已有详情缓存跳过验收调用；招聘网站通过独立 Session 的本地官方域名合成页面提供阻断、二维码、搜索和完整详情。覆盖网站手动关窗、扫码取消与自动关窗、原任务复核与采集、一次性自动续聊及完整 JD 读取，报告和截图写入被忽略的 `.runtime/chat-recovery-qa/`。不输出 API Key，不读真实求职或聊天数据；合成官网通过不代表真实网站扫码／验证通过。

使用真实开发环境已有登录会话测试招聘网站，仅属于用户本次指定的专项检查，不随开发启动、构建、打包、常规测试或发布自动执行。后续构建不重复使用本次账号检查授权；自动回归使用隔离数据、合成会话和本地测试页面。

`discovery-account-audit.mjs` 是人工授权现有账号诊断的只读核对模块，需要调用方提供当前 Electron 应用及主页面；不会自行启动账号或提交搜索。它仅捕获招聘列表字段白名单，独立比对官方字段、SQLite 观察、10/20/50 条分页、城市、薪资及续查固定视图，不导出认证材料。`sourceRowsUncovered` 明确记录缺少原始来源证据的条目。真实网站的通用验收要求见 [岗位发现说明](../docs/job-discovery.md#发布约束)，实际覆盖范围以对应报告为准。安装包弹窗测试还覆盖官网自行关闭页面但原生窗口保持打开，以及仅手动关闭原生窗口才开始复核。

## 共享模块与异步等待

`exam-pdf-acceptance.mjs` 由试卷安装包验收调用，使用隔离数据库构造三种题型、旧题空答案及不同的评分参考答案，通过真实导出按钮生成逐题答案和末尾答案两种 PDF，验证答案来源、未完成卷、多页 Markdown 和打印窗口释放。PDF 与首、中、末页 PNG 保留在 `dist/exam-pdf-review/` 供视觉检查；这些合成样本不包含真实开发数据。

历史迁移、协议协商、启动器更新和代理测试分别验证对应的长期契约。源码级联网诊断验证来源集合、查询矩阵与分页；界面验收验证账号、搜索、历史和人工处理交互，二者覆盖范围独立。

`test-launcher-update.mjs` 由启动器测试和发布脚本共同调用。`assert-root-error-dialog.ps1` 由 MCP 安装包测试调用，负责 Windows 原生错误对话框断言。

涉及 IPC 的异步条件使用 `packaged-test-helpers.mjs` 的 `waitFor` 等待 Promise 完成；DOM 条件使用 `page.waitForFunction`。`skipToursForTest` 在首屏 `load` 完成后才操作引导及刷新页面，避免 Vue 已挂载但 Main 初始导航尚未完成时中断加载；普通界面验收通过正式配置 IPC 显式选择中文，避免首次语言检测使固定中文选择器依赖测试机器的系统语言。持久化验收传入 `null` 保留来源配置语言，首次系统语言检测由桌面生命周期专项验证。二维码图片使用解码结果确认可用，未执行的验证、详情或保存路径明确记录为未通过。

公共网络 URL 边界由 `tests/web-retrieval.test.ts` 覆盖：10240 字符接受、超过上限拒绝，长 URL 仍须通过协议、端口、凭据及公网地址检查。岗位响应分类、登录阻断优先级及已提交批次保留由岗位发现适配器和运行时测试覆盖。

智能体上下文由 `agent-token-context.test.ts`、`agent-context.test.ts` 和 `agent-model.test.ts` 覆盖：服务端输入基准与新增消息计数、工具调用参数及结果、模型／端点／历史变化时基准失效、缺失 usage、输出空间预留、压缩前后记录和 checkpoint 重启恢复。用量显示只在模型响应或压缩完成后更新，测试通过延迟模型响应验证工具结果和历史刷新不会发布中间估算；`agent-coordinator.test.ts` 与 `agent-store.test.ts` 覆盖迟到的历史响应不能覆盖新事件，以及事件序号缺口的历史补读能够生效。压缩回归还验证切换模型后的跳过压缩记录与显示快照一致。累计用量只采用端点报告值，图片和未知模型的本地计数仍是估算。界面测试确认上下文只显示占用数值，不出现预计或校准说明；安装包智能体验收继续拦截外部分词请求。

## 隔离与版本约定

- `packaged-test-helpers.mjs` 只硬链接不可变程序文件。安装根目录的 `config.json`、`data`、`resumes`、`chat-uploads`、`browser-sessions`、`.runtime` 和 `logs` 不带入隔离环境；依赖内部同名目录仍保留。调用方只在自己的临时目录读写数据、清理产物，不修改硬链接程序文件。
- `config-test-helpers.mjs` 仅用于合成测试配置，复用构建密钥但不输出密钥或配置内容。
- 当前版本测试从 `package.json`、持久化版本常量和内置目录读取元数据。历史兼容样本、协议版本、格式契约断言及专门测试版本比较的值应固定，不能批量替换为当前版本。
- v1/v2 冻结样本、旧版本导出代码和 legacy MCP 用例仍是兼容性保障，不按版本号的新旧删除。legacy / modern 测试显式选择协议并断言协商结果。
- 内置目录已有地点；字典清理、精确数量和性能测试须使用可控的合成目录，或采用专用地点前缀限定查询，不能假设新库的地点表为空。真实目录 seed 由独立用例核对完整关联和去重结果。
- `out/`、`dist/`、依赖目录和忽略的个人文件不是待维护的源码脚本，不通过手工修改构建产物修复测试。

内置智能体双队列的真实模型验收：`node scripts/test-agent-discovery-live.mjs --live-model --queue`。仅在用户明确授权后运行，读取开发环境模型设置但不输出密钥，使用隔离应用、数据库和合成官网页面。覆盖运行中排满三条外部消息、容量拒绝、原位编辑／删除、网站验证通知优先、Renderer 重载、停止和失败后续跑；模型回答及岗位工具参数来自真实 API。HTTP 失败由验收中继在收到真实模型回答后注入，网站验证由合成页面控制。结果写入 `.runtime/agent-queue-qa/`，不接入常规构建或发布。

该脚本还检查首次进程启动和空闲进程复用时的直接发送：回执为运行中、Main 从未发布该消息的等待快照，真实聊天组件直接显示消息且不出现队列区域；结果记录在报告的 `directAdmissions`。协调器回归同时覆盖初始化期间仍可等待三条消息、初始化重试、初始化或执行前校验期间取消、三进程名额及跨聊天 FIFO。

牛客接入的历史回归：`pnpm test` 覆盖混合请求缺省 `recruitType`、两类卡片、分页整批提交、账号与 App 扫码协议、详情排除推荐、七平台 v6 逐行保留及回滚。`persistence-v6.test.ts` 和 `persistence-v7.test.ts` 分别验证冻结的历史目标，不随当前目标升版；冻结 v1/v2 文件不改写。当前备份与打包验收目标统一为企业性质 v9，`test:discovery:local` 按九平台执行隔离网络、账号弹窗、重启与 MCP 测试，不使用真实账号。真实牛客扫码与搜索验收另行人工执行，不加入构建链。

NCSS 接入（v2.6.0，数据库 v8）：`ncss-adapter.test.ts` 覆盖固定完整条件、官方城市代码、错误类型整条跳过、合法低质量保留、短页及固定总数、提交后推进、官方原码页面、OAuth state 和学生角色证据。`qr-verification.test.ts` 覆盖原页面转入人工验证、越界重定向、加载和脚本读取超时及释放；`qr-login.test.ts` 验证超时后不误报登录、释放页面并允许重新发起。`persistence-v8.test.ts` 从八平台 v7 合成样本验证逐行保留、DDL 一致、失败回滚和 v7 SQL/JSON 冻结。备份用例覆盖 v1—v8；打包兼容测试新增原始 2.5.0 提交 `6f15578`。合成测试不代表真实扫码、风控或重启免扫码通过，实际范围记录在对应测试报告和运行日志中。

`node scripts/test-ncss-live.mjs` 使用独立打包数据目录执行人工扫码验收，先确认未登录门禁，再运行 Java／销售在北京、上海及地点留空的搜索、续查、详情及保存。清除会话后需要再次人工扫码，然后正常退出重启，验证历史、保存记录及官方会话复核结果。认证材料仅在该隔离 Chromium profile；报告只记录查询条件、统计及缺失字段原因。该脚本不加入自动构建链。

企业性质（v2.7.0，数据库 v9）：`company-natures.test.ts`、`company-nature-view.test.ts`、`persistence-v9.test.ts` 覆盖固定字典、空值、目录同步、真实选择组件、分页、迁移保留与失败回滚，MCP 双协议验证查询字典和公司录入、清空、筛选及过期确认。`tests/fixtures/v8/` 锁定 v2.6.0 的历史 SQL 哈希。备份覆盖 v1—v8 导入至 v9 与新版往返；打包兼容验收新增 v2.6.0 原始提交 `3890679`。规模查询可设置 `JOBTRAIL_LOCATION_PERF_REPORT` 保存 1 万家公司、20 万条地点关联的性质组合筛选报告。目录录入规则见 [数据库说明](../docs/database.md#company_natures)。

性质筛选仅接受六种字典代码，不接受 null；单测和安装包 MCP 双协议验收均覆盖“选择性质排除空值、清空筛选包含空值、非法空值选项拒绝”。历史升级验收逐行比对时，明确要求旧公司的 `company_nature` 和旧题的 `default_answer` 都为 NULL。

v2.8.0 保持数据库 v9、配置 v2、备份封装 v1。`opportunity-company-picker.test.ts` 使用真实 Naive UI 选择器验证名称、别名和部分匹配的 Enter 行为、显式创建、创建后刷新失败、摘要不含地点、重复提交及过期表单隔离；`company-store.test.ts` 覆盖过期列表响应，`database.test.ts` 比较快捷输入与管理页输入的自定义公司默认值及内置标识拒绝。安装包历史验收加入 v2.7.0 原始提交 `590cf80`，v9 到 v9 不执行迁移、不补字段或重新 seed；旧版正式迁移仍按既有版本链验收。
