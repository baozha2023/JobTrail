# 职迹项目上下文与开发规范

## 项目定位

职迹是一个本地优先的桌面求职管理工具，帮助用户记录公司、行业分类、岗位、简历版本、求职状态和日程，覆盖从“感兴趣”到“Offer/淘汰/主动放弃”的完整过程。

产品名称统一为“职迹”。技术标识使用 `zhiji`，用于 Electron package name、Velopack packId 和构建脚本，不直接展示给用户。

## 技术栈

- Electron
- Vue 3 + TypeScript
- electron-vite
- Naive UI
- Pinia
- vue-i18n
- better-sqlite3
- Velopack

首发以 Windows x64 为主要验证目标。应用图片等静态资源统一存储在项目根目录的 `resource/`，构建和打包产物统一输出到项目根目录的 `dist/`。开发环境的应用设置、业务数据库和简历文件存储在项目根目录；Velopack 安装环境的这些业务数据存储在 Velopack 安装根目录，不得写入 `current/`。

## 分层规则

```text
renderer
  -> preload typed bridge
  -> main IPC handlers
  -> application services
  -> repositories / file storage
  -> SQLite / internal files
```

- renderer 不直接访问 SQLite、Node.js API 或文件系统。
- preload 只能暴露明确的、经过类型约束的函数。
- 不暴露完整的 `ipcRenderer`。
- main 进程负责数据库、文件复制、文件打开和 Velopack。
- 业务 CRUD 必须先进入 `src/main/services`，界面和未来 MCP 都复用这些服务；SQL 只能位于对应 Repository。
- 服务输入和输出必须是 JSON 可序列化 DTO，不能依赖 Vue 响应式对象、Electron 对象或文件句柄。
- Repository 只负责持久化，不承载界面规则；删除限制和参数校验放在 service 层。
- 左侧导航提供独立的“状态管理”“行业分类”“简历版本”“公司管理”页面，各类基础数据的新增、编辑、删除和查询只能从对应页面发起。
- 求职记录和日历页面只能读取状态、简历版本和公司作为关联选项，不提供这三类业务的快捷写入。
- 行业分类作为独立基础数据维护，并通过 `company_industries` 多对多关联公司。
- 日历提醒只使用 Windows 本地通知：主进程每 5 分钟检查一次，只有提醒时间已到、日程未完成且未发送过才通知；不实现邮箱通知。
- 设置页面只负责主题、语言和更新检查，不承载状态、简历版本或公司管理。

## 配置规范

配置文件位于：

开发环境：`<项目根目录>/config.json`  
Velopack 安装环境：`<Velopack 安装根目录>/config.json`

配置默认值：

```json
{
  "configVersion": 1,
  "themeMode": "system",
  "locale": "zh-CN",
  "closeBehavior": "quit",
  "launchAtStartup": false,
  "companyReadValidityMonths": 3,
  "velopack": {},
  "mcp": {
    "enabled": false,
    "requireWriteConfirmation": true
  }
}
```

配置服务必须校验已知字段、保留未知字段，并通过临时文件加原子替换写入。配置损坏时备份原文件并恢复默认值。`companyReadValidityMonths` 为正整数，默认 3；公司招聘官网链接被点击后记录 `last_read_at`，超过该配置月份数后显示为未读。

- `closeBehavior` 为 `tray` 时关闭主窗口仅隐藏到系统托盘，为 `quit` 时直接退出应用。
- `launchAtStartup` 为 `true` 时通过 Electron 登录项设置开机启动，为 `false` 时关闭开机启动。

## 国际化与主题

- UI 固定文案只支持 `zh-CN` 和 `en-US`。
- 数据库里的状态、公司名、岗位名、备注和 JD 不参与翻译。
- 所有状态选择器、筛选器和状态标签直接显示 `statuses.label`。
- 主题支持 `light`、`dark`、`system`。
- `system` 模式跟随 Electron `nativeTheme`。
- Windows 使用无边框窗口和应用自定义标题栏；窗口控制通过受限 preload API 提供。

## 数据库规则

数据库位于：

开发环境：`<项目根目录>/data/zhiji.db`  
Velopack 安装环境：`<Velopack 安装根目录>/data/zhiji.db`

- 使用 better-sqlite3，并在 main 进程加载。
- 开启 WAL 和 busy timeout；禁止创建 SQLite 物理外键，跨表关联统一作为逻辑外键由 service 层维护。
- 不创建 `schema_migrations`、`app_settings` 或 `opportunity_status_history`。
- 使用 SQLite `PRAGMA user_version` 保存结构版本。
- 数据库当前完整结构版本为 `8`，首发阶段直接维护最终初始化 schema，不写过程性 `ALTER TABLE` SQL。
- 开发环境修改数据库结构后，直接删除开发数据库及其 `-wal`、`-shm` 文件，重新由初始化代码创建；禁止为开发环境增加迁移或转换层。
- 数据库表声明以 `database.md` 为准。
- 修改数据库结构时必须同步更新 `database.md`。
- 状态正在被求职记录使用时禁止删除。
- 生产环境中的内置状态、内置行业分类和内置公司的主体数据禁止编辑和删除，service 直接返回 `BUILTIN_DATA` 和“该数据为内置，无法删除/修改”；开发环境放开内置数据的增删改查权限，删除仍需遵守状态、行业和公司被逻辑关联使用时的保护规则。内置公司的收藏标记允许作为用户偏好修改。显示顺序调整仍由独立重排接口处理。
- 最后一个状态禁止删除。
- 状态显示顺序只能通过状态 service 的重排接口修改，renderer 不直接写入排序字段。
- 被求职记录引用的简历版本禁止删除。
- 数据库开发禁止使用 `REFERENCES`、`ON DELETE` 等物理外键语法；所有关联存在性校验、删除保护和关联清理必须集中在业务 service 层。

## 简历文件规则

- 允许导入 PDF、DOC、DOCX。
- 导入后复制到应用内部的 `resumes` 目录。
- 使用 `crypto.randomUUID()` 生成文件名。
- `resume_versions.relative_path` 只保存 UUID 文件名和扩展名，例如 `uuid.pdf`。
- 不保存外部原始绝对路径。
- 只能通过 main 进程的文件服务打开或删除内部文件。

## Velopack 规则

- Velopack 启动钩子必须位于 main 入口最前面。
- 使用 Velopack 内置默认机制，不使用 Squirrel 或 electron-updater。
- 更新使用 Velopack JavaScript SDK 的 GitHub 仓库源，地址指向仓库根路径；不使用 GitHub Release 的 `releases/latest/download` 资产下载路径。
- GitHub Release 更新源固定为 `https://github.com/baozha2023/JobTrail`，由更新模块内置，不从 `config.json` 读取，设置页面也不提供显示或修改入口。
- 更新检查结果只由主进程持有；下载和应用更新的 IPC 不接受 renderer 传入的 `UpdateInfo`，只能使用主进程刚刚检查得到的结果。
- 默认不包含 prerelease，使用默认 Windows channel。
- Vite/Rollup 必须外置 Electron 和原生依赖，并正确处理 `.node` 文件。
- `dev`、`test` 和 `build` 不重复执行 native rebuild；只有升级 Electron 或 better-sqlite3 后，在关闭所有职迹实例的前提下手动执行 `pnpm rebuild:native`。
- 版本发布使用 `.github/workflows/release.yml` 执行 `vpk download github -> vpk pack -> vpk upload github`，生成并发布 GitHub Release 资产；当前 `vpk pack` 只生成 Velopack 默认 `Setup.exe`、Portable 包和 Release 资产，不生成 MSI；本地 `pnpm release:win` 的所有产物统一写入 `dist/`。

## MCP 预留规则

首版不启动 MCP Server，但所有相关业务 CRUD 必须保持 MCP 兼容：

- 状态、行业、公司（别名由公司服务内部维护）、简历版本、求职机会和日程的 CRUD 统一由对应 service 层提供。
- 服务 DTO 必须可直接转换为 MCP tool input/output schema。
- 不提供任意 SQL 接口。
- 不允许未来 MCP 绕过 service 直接写数据库。
- 未来 MCP 采用本地 stdio 传输。
- 查询工具可以自动执行；写入工具预留“预览变更 -> 用户确认 -> 提交变更”流程。
- MCP 默认关闭，写入确认默认开启。
- 未落地的 MCP 功能必须记录在 `future.md`。

## 代码与测试规范

- 使用 TypeScript strict 模式。
- 优先使用小型纯函数、明确 DTO 和显式错误码。
- 不在组件内拼接 SQL。
- 数据库写操作必须使用事务。
- 所有新增业务行为至少包含 service 单元测试。
- 打包前验证 better-sqlite3 原生模块、配置目录、数据库目录和简历目录。

## 首发阶段变更策略

- 产品尚未上架，代码和数据库结构允许直接、彻底修改。
- 不设计旧版本兼容层、兼容 API、数据回退路径或过渡实现。
- 不为了假设的历史数据、旧客户端或未来需求增加冗余判断。
- 业务入口保持收紧：一个业务只保留明确的主入口，避免跨页面快捷写入。
- 发现更合理的结构时，直接同步修改文档、类型、服务、数据库和界面，并完整重新验证。
