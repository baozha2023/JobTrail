# 职迹 AI 辅助开发上下文

本文档是职迹（JobTrail）项目的规范性 AI 辅助开发上下文，定义项目架构、功能边界、接口规范与实现约定。所有开发工作必须遵循本文档规定的结构、命名、流程、质量和安全要求。

本文使用“必须”“禁止”“应当”表达强制约束；除非用户明确批准，不得自行放宽或绕过。

## 1. 项目定位

职迹是一款面向 Windows 的本地优先求职管理桌面应用，用于管理公司、行业分类、求职记录、简历版本、求职状态和日程，覆盖从发现岗位到投递、面试及最终结果的完整流程。

- 产品名称统一为“职迹”，英文项目名为 `JobTrail`。
- 技术标识统一为 `zhiji`，用于 npm package name、Electron AppUserModelID、Velopack packId 和相关构建配置。
- 版本号以 `package.json` 为主来源；Rust 发布组件的版本必须与其保持一致。
- 当前发行目标为 Windows x64；不得假设 macOS 或 Linux 已受支持。
- 应用坚持本地优先，不得擅自新增账号、云同步、遥测上传或远程数据依赖。

## 2. 权威来源与冲突处理

开发前必须阅读与任务相关的权威文件：

1. `CLAUDE.md`：架构、边界、接口、流程和安全要求。
2. `docs/database.md`：SQLite 表、字段、索引、约束和初始化规则的唯一声明。
3. `src/shared/types.ts`：跨进程业务 DTO 和公开类型。
4. `src/shared/ipc.ts`：Renderer 与 Main 之间的 IPC 通道契约。
5. `package.json`、`native/bootstrap/Cargo.toml`、`.github/workflows/release.yml`：工具链、版本和发布流程。
6. `docs/future.md`：明确尚未交付的规划，不得把其中内容描述成现有功能。
7. `README.md`：面向用户和贡献者的公开说明。

如实现与文档冲突，必须查明真实意图并在同一变更中统一代码、测试和文档；不得通过增加兼容分支同时保留两套相互冲突的行为。

## 3. 已交付功能边界

### 3.1 求职记录

- 管理公司、岗位、部门、地点、来源、岗位链接、JD、备注、发现日期、投递日期和截止日期。
- 每条求职记录必须关联公司和状态，可以关联一个简历版本。
- 支持关键词搜索，以及按状态和公司筛选。
- 支持新增、编辑、删除和状态变更。

### 3.2 日历与提醒

- 支持独立日程和关联求职记录的日程。
- 支持时间点、时间段、跨日期和全天日程。
- 日程使用有效 IANA 时区名称。
- 全天日程采用半开区间 `[startAt, endAt)`，结束日期不包含在日程中。
- Windows 本地提醒由 Main 进程定时调度，不实现邮件或远程通知。
- 已完成日程不提醒；相同日程与提醒时间只能成功记录一次。

### 3.3 基础数据

- 状态、行业、简历版本和公司分别拥有独立管理页面。
- 状态、行业和简历版本通过完整顺序数组重排，不允许 Renderer 直接写 `sort_order`。
- 公司与行业为多对多关系，公司别名只参与搜索。
- 公司招聘官网支持收藏和已读状态；已读有效期由 `companyReadValidityMonths` 控制。
- 正式安装版中的内置状态、行业和公司主体数据禁止修改、删除；开发环境可以放开维护，但仍必须执行关联删除保护。
- 内置公司的收藏状态属于用户偏好，允许修改。
- 设置页可由用户主动更新内置公司目录；应用启动、软件升级和 MCP 均不得触发目录同步。

### 3.4 简历文件

- 只允许导入 PDF、DOC、DOCX。
- 文件必须复制到应用内部 `resumes/` 目录，不得保存并依赖原始绝对路径。
- 被求职记录引用的简历版本禁止删除。

### 3.5 桌面能力

- 支持浅色、深色、跟随系统主题。
- UI 固定文案只支持 `zh-CN` 和 `en-US`。
- 支持系统托盘、关闭行为、当前用户开机启动、单实例、应用内更新和卸载。
- 卸载程序必须清空而非删除安装根目录，包括配置、数据库和简历；执行前必须明确警告且要求用户确认。

## 4. 未授权功能

以下能力未纳入当前稳定功能范围，除非用户明确要求，不得顺带实现：

- macOS、Linux 发行版。
- 账号、登录、云同步、多设备同步或遥测。
- 数据导入导出、自动备份或自动迁移。
- 浏览器插件、招聘网页抓取或自动解析。
- AI 简历分析、JD 匹配、简历生成或模拟面试。
- 除已明确支持的 MCP 2025/2026 两代协议外，为假设中的旧客户端、旧数据库或未来协议添加兼容层。
- 第二套更新框架、第二套数据访问入口或任意 SQL 接口。

功能必须收紧到明确主入口。求职记录和日历页面只能读取基础数据作为关联选项，不得重新加入状态、行业、公司或简历的快捷创建入口。

## 5. 总体架构

```text
Renderer (Vue)
  -> Preload typed bridge
  -> Main IPC handlers
  -> Application services
  -> Repositories / file storage
  -> SQLite / managed local files

Optional adapters (such as MCP)
  -> Application services
  -> same repositories / file storage
```

依赖方向必须单向向下：

- Renderer 禁止导入 Main、Repository、SQLite、Node.js 文件系统或 Electron 主进程 API。
- Preload 只负责类型安全桥接，不承载业务规则。
- IPC handler 负责调用来源校验、输入解析和结果封装，不承载持久化逻辑。
- Service 负责业务规则、关联校验、事务边界和稳定错误语义。
- Repository 只负责 SQL 与行映射，不承载 UI 或协议逻辑。
- File storage 只负责受控本地文件操作，不得向 Renderer 暴露任意文件能力。
- 可选适配器必须复用 Service，不得直接访问 Repository、数据库或内部文件。

禁止循环依赖、跨层捷径和为单个调用复制整套业务逻辑。

## 6. 目录职责

```text
src/main/
├─ desktop.ts                  Electron 桌面入口、生命周期与窗口启动
├─ mcp-node.ts                 独立 MCP stdio 进程入口
├─ ipc.ts                      IPC 模块注册入口
├─ ipc/                        分领域 IPC handler 与边界校验
├─ services/                   应用业务规则
│  └─ unit-of-work.ts          写事务与文件提交/回滚钩子
├─ repositories/              SQL、持久化和行映射
├─ database.ts                SQLite 初始化与生命周期
├─ company-catalog.ts         公司目录格式、校验及内置目录读取
├─ company-catalog-updater.ts 固定 Release 资产下载与完整性校验
├─ file-storage.ts            受控简历文件存储
├─ config.ts                  配置读取、校验和原子写入
├─ update-service.ts          更新状态机
├─ velopack.ts                Velopack IPC 适配
└─ mcp/                        可选 MCP 适配实现，不属于核心业务层

src/preload/                  受限的 contextBridge API
src/renderer/
├─ views/                     页面和展示组件
├─ composables/               分领域页面状态与业务操作编排
├─ stores/                    共享领域数据状态
├─ layout/                    窗口与导航布局
├─ i18n.ts                    固定 UI 文案
└─ styles.css                 全局样式

src/shared/
├─ types.ts                   JSON 可序列化 DTO 与公开接口
├─ ipc.ts                     IPC 通道映射
└─ calendar.ts                跨层日历纯函数

native/bootstrap/            Windows 启动器、离线安装器、卸载器
scripts/                     测试、构建和 Velopack 发布脚本
resource/                    应用图标和首次 seed/Release 共用的公司目录
docs/                        数据库声明与未来规划
```

新增文件必须放入职责匹配的目录。若现有目录无法合理容纳，先说明架构影响，再决定是否新增层级。

## 7. TypeScript 与命名约定

- 必须启用并保持 TypeScript strict 模式。
- Vue 组件使用 `PascalCase.vue`。
- composable 使用 `useXxx.ts`，导出函数使用 `useXxx`。
- Store 使用 `useXxxStore`。
- Service、Repository 类使用 `XxxService`、`XxxRepository`。
- 普通 TypeScript 文件使用 kebab-case；类型、接口和类使用 PascalCase；变量和函数使用 camelCase。
- 数据库字段使用 snake_case，跨进程 DTO 使用 camelCase；转换集中在 row mapper 或 Repository 边界。
- IPC channel 使用 `<domain>:<operation>`，例如 `companies:mark-read`、`calendar:complete`。
- 错误码使用稳定的 `UPPER_SNAKE_CASE`，不得把本地化错误消息当作程序判断依据。
- Rust 模块、函数和变量遵循 snake_case，类型遵循 PascalCase。
- 优先使用明确类型、小型纯函数和早返回；禁止用 `any` 掩盖边界问题。
- 外部输入先以 `unknown` 接收，再经过显式校验缩窄。
- 注释解释“为什么”和安全不变量，不复述代码表面行为。

不得保留无用参数、死代码、注释掉的旧实现、重复判断或未使用的兼容分支。

## 8. DTO 与 IPC 接口规范

### 8.1 DTO

- 跨进程输入输出必须定义在 `src/shared/types.ts`，并保持 JSON 可序列化。
- DTO 不得包含 Vue 响应式对象、Electron 对象、数据库连接、文件句柄、函数或类实例。
- Create DTO 明确必填字段；Update DTO 使用受控 `Partial`，但运行时必须拒绝空更新。
- 可空值使用 `null`，缺省输入使用 `undefined`；不得混用空字符串表达业务空值。
- 时间统一使用 UTC Unix 毫秒整数；布尔值在 DTO 中使用真正的 boolean。

### 8.2 通道声明

- 所有 Renderer/Main 通道必须先登记在 `src/shared/ipc.ts` 的 `IpcChannelMap`。
- 每个通道必须声明完整参数元组与返回类型。
- Preload 暴露的 API 必须与通道一一对应，不暴露通用 `invoke(channel, args)` 给 Renderer。
- IPC 统一返回判别联合：`{ ok: true, data }` 或 `{ ok: false, error }`。
- Renderer 必须按稳定错误码和用户消息处理失败，不得依赖异常堆栈。

### 8.3 输入校验

- IPC 边界必须验证对象形状、允许字段、类型、安全整数、正 ID、空白字符串和空更新。
- 业务 DTO 默认拒绝未知字段，避免静默接受拼写错误或越权字段。
- 配置对象是唯一例外：必须校验已知字段，同时保留未知字段以避免破坏外部扩展配置。
- Renderer 校验只用于交互反馈，不能替代 Main/Service 校验。

新增或修改 IPC 时，必须同步更新：

1. `src/shared/types.ts`
2. `src/shared/ipc.ts`
3. `src/main/ipc/validators.ts` 或对应边界 schema
4. `src/main/ipc/<domain>.ts`
5. `src/preload/index.ts`
6. Renderer 调用方
7. 正常、非法输入和调用来源测试

## 9. Service 与 Repository 规范

### 9.1 Service

Service 必须负责：

- ID、文本、时间范围和领域输入校验。
- 所有逻辑关联的存在性检查。
- 内置数据保护、最后状态保护和引用删除保护。
- 文本 trim、空文本转 null 等领域规范化。
- 多表写入、重排和文件/数据库协作的事务边界。
- 将底层异常转换成稳定 `AppServiceError`。

Service 返回公开 DTO，不返回数据库行。UI、IPC、MCP 或其他入口不得复制 Service 规则。

所有 Service 写操作必须加入共享 `UnitOfWork`：根工作单元使用 SQLite `IMMEDIATE` 事务，嵌套工作单元使用 savepoint。文件操作必须通过 `afterCommit`/`afterRollback` 钩子与数据库结果保持一致。协议适配层可以调用该 Service 工作单元以原子化预置条件检查与 Service 写入，但不得直接获取数据库连接。

### 9.2 Repository

Repository 必须：

- 使用参数化 SQL，不拼接未验证值。
- 只处理持久化、查询和数据库行映射。
- 对动态排序、列名或占位符使用代码内白名单或受控生成。
- 将 snake_case 行映射为 camelCase DTO。
- 为批量写入提供可由 Service 纳入事务的方法。

Repository 禁止读取 Renderer 状态、弹出 UI、访问 Electron 窗口或决定用户权限。

## 10. 数据库约定

- 使用 `better-sqlite3`，只允许在受信任的主进程侧加载，包括桌面 Main 和独立 MCP Node；Renderer 与 Preload 不得加载。
- 数据库结构以 `docs/database.md` 为唯一声明，任何 schema 变更必须同步更新该文件和测试。
- 当前 schema 使用 `PRAGMA user_version = 1`；版本变化必须由明确需求驱动。
- 开启 `journal_mode = WAL` 和 `busy_timeout = 5000`。
- 时间字段保存 UTC Unix 毫秒；布尔值保存为 INTEGER `0/1`。
- 禁止 SQLite 物理外键、`REFERENCES` 和 `ON DELETE`；跨表关系由 Service 作为逻辑外键维护。
- 禁止创建 `schema_migrations`、`app_settings` 或 `opportunity_status_history`。
- 首次初始化、seed 和 `user_version` 必须在同一事务中完成。
- Seed 只允许在 `user_version = 0` 的首次初始化事务中执行；已初始化数据库不得再次执行或合并 seed，也不得在启动时覆盖用户数据。
- 内置公司以 `companies.builtin_key` 是否为空判定；key 为稳定小写 UUID v4，不得因改名、排序或本地 ID 变化而替换。
- `resource/jobtrail-company-catalog.json` 是首次 seed 与 Release 共用的唯一全量公司目录；目录只允许由设置页主动更新，禁止在启动或软件升级时自动同步。
- 公司目录状态保存在 `builtin_company_catalog_state` 单行表中，并与公司、行业关系和别名变更在同一个 `IMMEDIATE` 事务提交。
- 目录更新只接受固定 GitHub Release 地址的 HTTPS 响应，必须限制最终主机、下载字节数，并以 manifest 的文件名、大小和原始 SHA-256 校验全量 JSON；随后校验格式版本、目录版本、最低应用版本、唯一 key/名称及行业关联。
- 同一内置 key 的目录更新保留公司 ID、创建时间、收藏、已读时间和业务关联；同名用户公司转为内置时也保留这些数据。目录中缺少的旧内置公司不删除；冲突使整个事务回滚。
- 数据库写操作和多步骤关系更新必须使用事务。
- 不得为假设历史数据擅自增加 `ALTER TABLE`、双写、回退读取或转换层；发布版本迁移需要用户明确批准和独立设计。

关键删除规则：

- 被求职记录引用的状态、公司和简历版本不能删除。
- 被公司引用的行业不能删除。
- 最后一个状态不能删除。
- 删除求职记录时，将相关日程的 `opportunity_id` 清空，不删除日程。
- 删除日程时同步删除其提醒发送记录。

## 11. 配置与本地路径

开发环境数据根目录为项目根目录；安装环境数据根目录为用户选择的 JobTrail 安装根目录。

```text
<root>/config.json
<root>/data/zhiji.db
<root>/resumes/
<root>/.runtime/current/    # 仅安装环境，由 Velopack 管理
```

- 业务数据不得写入 `.runtime/current/`。
- 配置服务必须验证已知字段、合并默认值并保留未知字段。
- 配置写入必须使用同目录随机临时文件和原子 rename。
- 配置损坏时先生成不可冲突的备份，再恢复默认配置。
- 不得在配置、日志、错误详情或仓库中写入密钥、令牌和用户隐私内容。
- 不得依赖工作目录推导安装数据路径；必须使用统一的安装路径解析函数。

## 12. 文件存储安全

- 简历源文件必须存在、是普通文件且不是符号链接。
- 导入前必须解析真实路径并校验扩展名。
- 内部文件名必须使用 `crypto.randomUUID()` 加允许的扩展名。
- `relative_path` 只能保存 UUID 文件名，不得包含目录、盘符或路径穿越片段。
- 每次打开、删除或恢复内部文件前必须重新验证文件名、存储目录和文件类型。
- `resumes/` 与内部回收目录不得是符号链接或目录联接。
- 导入失败必须清理本次生成的不完整文件。
- 简历删除采用“移动到内部临时回收位置 → 提交数据库事务 → 最终清理”的顺序；数据库失败时必须恢复文件。
- 不得通过 IPC 暴露任意读文件、写文件、删除路径或执行路径能力。

## 13. Renderer 实现约定

- 页面组件负责组合与展示；领域加载、表单状态和操作编排放入对应 composable。
- Pinia Store 只维护可共享领域状态，不承担 Main 业务规则。
- 异步搜索、筛选和刷新必须防止旧请求结果覆盖新请求结果，可使用递增请求序号或取消机制。
- 所有异步调用必须处理失败，面向用户显示本地化消息；禁止空 catch。
- 固定 UI 文案必须通过 vue-i18n，支持 `zh-CN` 与 `en-US`。
- 数据库中的用户文本、公司名、状态名、JD 和备注不翻译。
- 主题只支持 `light`、`dark`、`system`；system 必须跟随操作系统主题变化。
- 不使用 `v-html` 或 `innerHTML` 渲染外部/用户内容。
- 外部链接不得直接交给浏览器默认导航，必须经过受限的 `system.openExternal`。
- 表单不能通过隐藏字段提交 Service 未公开的属性。

## 14. Electron 与 IPC 安全

主窗口必须保持：

```text
contextIsolation: true
nodeIntegration: false
sandbox: true
```

同时必须满足：

- Renderer HTML 配置严格 CSP，不允许任意远程脚本和不受控执行。
- 禁止通过 `window.open` 创建新窗口。
- 禁止主窗口导航到非当前应用页面。
- 打包环境禁止使用环境变量覆盖 Renderer URL。
- IPC 只接受已登记主窗口的 `webContents` 且必须来自 `mainFrame`。
- Preload 不暴露完整 `ipcRenderer`、Node.js API、shell、fs 或 process。
- 外部 URL 只允许 `http:` 和 `https:`；拒绝 `javascript:`、`data:`、`file:` 等协议。
- 启动子进程必须使用明确可执行文件与参数数组，保持 `shell: false`，不得拼接用户输入命令。
- 禁止 `eval`、`new Function`、不受控反序列化和动态模块路径。
- 面向 Renderer 的错误不得泄露数据库语句、内部路径、堆栈或密钥。

安全检查必须存在于信任边界，不能只依赖 Renderer 按钮是否可见。

## 15. MCP 可选适配层

MCP 属于可选协议适配层，不得成为核心业务运行的前置条件。开发或修改 MCP 时必须遵守：

- 默认关闭，只允许通过明确配置启用。
- 使用本地 stdio；stdout 只输出 MCP 协议内容，诊断信息写入 stderr。
- 正式安装版只允许以唯一且精确的 `--mcp` 参数进入 MCP 模式，混入其他参数必须拒绝。
- MCP 2025 旧协议与 `2026-07-28` 现代协议是明确的双代兼容边界，两条路径均必须经过安全确认与打包冒烟验证。
- Tool 必须调用现有 Application Service，不得访问 Repository、直接执行 SQL 或绕过文件服务。
- 输入与输出使用严格 schema，拒绝未知字段，并与共享 DTO 的语义保持一致。
- `readOnly`、`destructive`、`idempotent` 标记必须反映真实行为。
- 读操作可以在启用后直接执行；写操作必须遵守配置的确认策略。
- 需要确认的写操作采用“生成预览 → 用户明确确认 → 校验状态指纹 → 提交”流程。
- 预览必须有有效期；确认时数据已变化必须使旧确认失效，重新展示最新预览并再次确认，不得提交旧意图。
- 删除、导入文件和关系变更不能借助 MCP 绕过 Service 的业务限制。
- MCP 错误返回稳定机器码和安全消息，不返回堆栈、SQL 或敏感路径。
- Renderer 只能获得建立本地连接所需的最小启动信息，不得获得内部服务对象。

若 MCP 尚未完成全部安全流程，README 和 UI 不得把它描述为稳定已交付能力。

## 16. 日历与提醒规则

- 时间段日程允许 `endAt === startAt` 表示时间点，其他情况必须满足 `endAt >= startAt`。
- 全天日程必须满足 `endAt > startAt`，并使用所属时区的本地日期边界转换为 UTC 毫秒。
- 月视图查询必须使用时间重叠语义，不能只按开始日期筛选。
- 显示和日期归属按日程自身时区计算，不以当前机器时区覆盖。
- `reminderMinutes` 只能为 null 或非负安全整数。
- 提醒调度默认每 5 分钟检查；发送成功后记录 `(calendar_event_id, reminder_at)`。
- 发送失败不得写入成功记录，以便后续重试。
- 应用退出必须停止 scheduler 并关闭数据库。

## 17. Velopack 更新规范

- `VelopackApp` 启动钩子必须位于 Main 入口的 Electron 初始化工作之前。
- 只使用 Velopack，不得并行引入 Squirrel、electron-updater 或第二套更新状态。
- Feed 固定为 `https://github.com/baozha2023/JobTrail/releases/latest/download`，通道固定为 `win`。
- Renderer 和配置不得提供更新源、channel 或 prerelease 覆盖。
- `UpdateInfo` 由 Main 在检查更新后持有；下载和应用接口不接受 Renderer 回传的更新对象。
- 检查、下载和应用必须互斥；应用前必须确认目标版本已经下载并与待应用版本一致。
- 更新重启使用 `--handoff-root` 转交根启动器，中转进程不得争用单实例锁。
- 业务数据和用户配置必须位于安装根目录，更新只替换 `.runtime/current/`。

## 18. Windows 安装与发布

- Rust crate `native/bootstrap` 提供根启动器、离线安装器和卸载器。
- 安装根目录包含 `JobTrail.exe`、`JobTrail-Uninstall.exe` 和 `.jobtrail-root`。
- 目标目录必须以 `JobTrail` 结尾；禁止系统目录、UNC、路径穿越、符号链接和目录联接。
- 安装器必须先显示目录选择页、实际所需空间和目标磁盘可用空间；安装开始后在同一窗口显示进度，并支持 Windows 每显示器动态 DPI 缩放。
- 当前用户只安装一份，注册表、快捷方式、开机启动和任务栏入口必须指向根启动器。
- 卸载 worker 从临时目录运行，等待应用退出，清理快捷方式和注册项后清空而非删除安装根目录。
- 卸载必须删除 `config.json`、`data/`、`resumes/` 和安装根目录中的其他用户数据；执行前必须明确警告且要求用户确认，卸载完成后安装根目录必须存在且为空。
- 卸载成功提示正文只显示“卸载完成”，不得附加目录或数据删除说明。
- 安装版 AppUserModelID 为 `zhiji`，开发版为 `zhiji.development`。
- PE 图标、窗口图标、任务栏标识和重启入口必须保持一致。

本地和 CI 必须统一执行 `pnpm release:win`。发布流程必须：

1. 从固定 Feed 选择低于目标版本的最新 Full 包。
2. 校验历史包大小与 SHA-256。
3. 使用 `vpk pack` 生成更新资产。
4. 按解压目录、Full 包和根程序计算目标磁盘所需空间，构建并内嵌 Rust 启动器、卸载器和程序载荷。
5. 校验最终 Feed 中每个资产。
6. 逐字节发布全量公司目录，并生成和复验文件名、大小及 SHA-256 manifest。

只有 Feed 为 404、为空或没有合适历史版本时允许 Full-only。网络错误、无效 Feed、歧义基线或校验失败必须终止构建。不得伪装成成功发布。

公开资产只包括自定义 `JobTrail-Setup-<version>.exe`、`releases.win.json`、nupkg、`jobtrail-company-catalog.json` 和 `jobtrail-company-catalog.manifest.json`；不发布 Portable、MSI、Velopack 原生 Setup 或 `win-unpacked`。

## 19. 错误处理与日志

- 预期业务失败使用 `AppServiceError` 和稳定错误码。
- `NOT_FOUND`、`BUILTIN_DATA`、`*_IN_USE`、`LAST_STATUS` 等错误语义不得退化为通用异常。
- 底层 SQLite 和文件异常必须在边界转换，不向用户暴露内部实现。
- catch 后必须处理、转换、恢复或记录；禁止无说明吞掉异常。
- 清理阶段失败不得反向报告已提交业务操作失败，但必须安全记录并保证下次可恢复或重试。
- 日志不得包含简历内容、完整 JD、密钥、令牌或不必要的绝对路径。

## 20. 测试与质量门槛

所有行为变更必须有与风险匹配的测试。至少覆盖正常路径、边界输入、拒绝路径和回归场景。

TypeScript/Electron 变更的标准检查：

```powershell
pnpm test
pnpm typecheck
pnpm format:check
pnpm build
pnpm audit --audit-level=low
```

Rust 安装与启动组件变更的标准检查：

```powershell
cargo fmt --manifest-path native/bootstrap/Cargo.toml -- --check
cargo test --manifest-path native/bootstrap/Cargo.toml --locked
cargo clippy --manifest-path native/bootstrap/Cargo.toml --locked --all-targets -- -D warnings
cargo audit --file native/bootstrap/Cargo.lock
```

发布链路或安装器变更还必须执行：

```powershell
pnpm release:win
```

并验证安装包、Feed、Full/Delta 包的名称、大小和 SHA-256。涉及 Windows 原生行为时，应进行安装、启动、单实例、托盘、开机启动、更新和卸载的实际验证。

测试必须在 Electron 对应 ABI 下加载 `better-sqlite3`。不得为了让测试通过而跳过原生模块、放松校验或只测试 mock 后的理想路径。

## 21. 变更流程

AI 和开发者处理每项任务时必须遵循：

1. 检查 `git status`、相关 diff 和当前分支，识别已有未提交修改。
2. 阅读本文件及与任务有关的权威源码、测试和文档。
3. 明确需求边界，区分现有功能、缺陷修复与新增功能。
4. 从共享类型和业务规则开始设计，自下而上保持接口一致。
5. 以最小完整垂直切片实现，不留下临时兼容入口或重复实现。
6. 添加或更新测试，覆盖失败和安全边界。
7. 同步更新 `docs/database.md`、README 或未来规划等受影响文档。
8. 执行与风险匹配的检查，修复全部可复现失败。
9. 检查 `git diff --check`、暂存区和工作区，确认没有误改、秘密、生成垃圾或未审查文件。
10. 向用户报告实际修改、验证结果和剩余风险，不宣称无法证明的“绝对零漏洞/零 Bug”。

简单、明确且低风险的问题可以直接修复。涉及产品方向、数据库迁移、公开接口破坏、安全模型、数据删除、发布兼容或大规模架构调整的复杂问题，必须先说明影响并取得用户批准。

## 22. Git 与工作区纪律

- 工作区可能包含用户或其他任务的修改，必须保留并绕开无关变更。
- 禁止使用 `git reset --hard`、`git checkout --` 或其他可能丢失用户修改的命令，除非用户明确授权。
- 只暂存本任务实际修改的文件或 hunk；禁止为了方便执行 `git add -A`。
- 未经要求不得提交、推送、创建标签或发布 Release。
- 不得手工编辑生成目录 `out/`、`dist/`、`node_modules/` 或 Rust `target/`。
- 依赖变更必须同时更新清单与 lockfile，并解释新增依赖的必要性。
- 禁止把本地数据库、配置、简历、密钥、安装载荷或临时文件提交到仓库。

## 23. 禁止的实现模式

- Renderer、Preload、MCP 或脚本直接写业务数据库。
- 任意 SQL、任意文件路径、任意 shell 命令或完整 `ipcRenderer` 暴露。
- 为相同业务建立多套 Service 或多条写入路径。
- 只在 UI 中限制操作而不在 Main/Service 校验。
- 拼接 SQL 值、动态执行字符串代码或启用 Electron Node integration。
- 用 catch-all、默认成功或静默降级掩盖数据损坏、网络失败和更新校验失败。
- 为未实现需求提前增加兼容字段、双写、别名 API 或废弃转发层。
- 复制粘贴大段校验、映射和业务逻辑而不提取已有公共能力。
- 将内部字段、数据库行或底层错误直接返回给 Renderer 或外部协议。
- 以“未来可能需要”为理由扩大权限、协议面或发布资产范围。

## 24. 完成定义

一项开发工作只有同时满足以下条件才算完成：

- 功能符合用户明确需求，没有擅自扩大范围。
- 分层、命名、接口和安全要求符合本文档。
- 正常路径、错误路径和关键边界已有验证。
- 类型检查、相关测试和格式检查通过。
- 数据库、配置、文件和更新不变量未被破坏。
- 文档与实际实现一致，未把规划描述为已交付能力。
- Git diff 只包含预期修改，没有无关覆盖、冗余代码和兼容残留。
- 已向用户准确说明验证范围、发布限制和仍需人工验证的事项。
