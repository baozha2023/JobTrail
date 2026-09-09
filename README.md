# 职迹 JobTrail

职迹是一款面向 Windows 的本地优先求职管理桌面应用。它把公司、岗位、简历版本、求职进度和面试日程集中在一个地方，帮助你持续记录从发现岗位到投递、面试和最终结果的完整过程。

当前版本：`v0.4.0` · 支持平台：Windows x64 · 界面语言：简体中文 / English

## 为什么使用职迹

- **数据保存在本地**：业务数据使用 SQLite 存储，简历复制到应用自己的文件目录，不依赖账号或云服务。
- **求职信息集中管理**：岗位、公司、状态、简历和日程互相关联，不再依靠多个表格零散维护。
- **覆盖完整求职流程**：从“感兴趣”“待投递”到多轮面试、Offer、淘汰或主动放弃均可追踪。
- **原生 Windows 体验**：支持离线安装、系统托盘、开机启动、本地提醒、应用内更新和卸载。

## 功能概览

### 求职记录

- 记录公司、岗位、部门、地点、来源、岗位链接、JD 和备注。
- 记录发现日期、投递日期和截止日期。
- 为岗位关联当前状态和实际使用的简历版本。
- 支持关键词搜索，以及按状态、公司筛选。
- 支持分页、新增、编辑和删除。
- 内置“感兴趣”“待投递”“初筛”“笔试”“AI面试”“一面”“二面”“三面”“HR面”“Offer”“淘汰”“主动放弃”等状态。

### 日历与提醒

- 使用月视图管理面试、笔试、截止日期及其他求职日程。
- 支持独立日程，也可以关联现有求职记录。
- 支持时间点、时间段、跨日期和全天日程。
- 按日程自身的 IANA 时区计算日期和显示时间。
- 支持提前提醒、完成标记、编辑和删除。
- Windows 本地提醒由主进程定时检查；已完成或已提醒的日程不会重复通知。

### 公司与行业

- 内置常用公司资料和 83 个行业分类。
- 一家公司可以关联多个行业。
- 支持按公司名称和别名模糊搜索，并可按行业筛选。
- 支持收藏公司、打开招聘官网并记录官网已读状态。
- 招聘官网默认在 3 个月后重新显示为未读，有效期可在设置中调整。
- 正式安装版中的内置公司、行业和状态受到保护，不能修改或删除；用户创建的数据可以正常维护。

### 简历版本

- 导入 PDF、DOC 和 DOCX 简历。
- 编辑版本名称与备注，并调整显示顺序。
- 从职迹中直接打开已导入文件。
- 文件导入后使用随机 UUID 文件名保存，同时记录大小和 SHA-256。
- 被求职记录引用的简历版本不能删除，避免产生失效关联。

### 桌面设置

- 浅色、深色或跟随系统主题。
- 简体中文与 English 界面切换。
- 关闭窗口时直接退出，或隐藏到系统托盘。
- 当前用户开机自动启动。
- 检查、下载并应用 Velopack 更新。
- 从设置页启动卸载程序；卸载会删除程序、配置、业务数据和简历。

## 安装

从 [GitHub Releases](https://github.com/baozha2023/JobTrail/releases/latest) 下载最新的 `JobTrail-Setup-<version>.exe`。

安装器是完整的离线安装包，不会在安装过程中下载程序载荷。启动后先显示默认安装位置、实际所需空间和目标磁盘可用空间；如需更改，点击“更改安装位置”选择父目录，安装器会在其中创建 `JobTrail` 文件夹。点击安装后，同一窗口切换为安装进度，并为当前 Windows 用户注册开始菜单、卸载入口等信息。一个用户只应保留一份职迹安装。安装窗口支持 Windows 每显示器动态 DPI 缩放。

安装完成后可在“设置 → 更新”中检查新版本。更新只替换程序运行时，不会覆盖配置、数据库和简历目录。

> [!IMPORTANT]
> 早期版本使用的原始 Velopack 安装目录不会自动转换为 v0.3.0 起采用的新目录布局。升级前请备份旧数据库和简历文件，再安装新版本并迁移数据。

> [!NOTE]
> 当前发布包未配置商业代码签名证书，Windows 可能显示“未知发布者”或 SmartScreen 提示。请只从本项目的 GitHub Releases 下载。

## 本地数据

职迹目前没有账号、云同步或遥测上传功能。业务数据和导入的简历均保存在本机。

| 内容   | 开发环境                   | 安装环境                              |
| ------ | -------------------------- | ------------------------------------- |
| 配置   | `<项目目录>/config.json`   | `<JobTrail 安装根目录>/config.json`   |
| 数据库 | `<项目目录>/data/zhiji.db` | `<JobTrail 安装根目录>/data/zhiji.db` |
| 简历   | `<项目目录>/resumes/`      | `<JobTrail 安装根目录>/resumes/`      |

安装环境中的程序版本位于 `<JobTrail 安装根目录>/.runtime/current/`，由 Velopack 管理。正常更新只替换程序版本，不会删除业务数据；完整卸载会清空 `<JobTrail 安装根目录>`，删除其中的程序、配置、数据库和简历。卸载前请先备份重要数据。

建议定期备份以下内容：

```text
config.json
data/zhiji.db
resumes/
```

SQLite 开启 WAL。复制正在运行的数据库前应先退出职迹，确保主数据库及临时日志已经完整落盘。

## MCP 智能体连接

职迹内置本地 stdio MCP Server，可供 Claude、Cursor、VS Code、CC-Switch 等 MCP Host 使用。在“设置 → MCP配置”中启用后，选择对应 Host 并复制配置片段即可。职迹不会自动改写第三方软件的配置。

- 固定提供 37 个工具，覆盖状态、行业、公司、简历、求职记录和日程的读取与维护。
- MCP 默认关闭；启用后读取操作可直接执行，写操作默认要求预览和明确确认。
- 确认请求有 10 分钟有效期，并绑定调用参数和当前数据状态；拒绝、取消、过期、篡改或数据已变化均不会写入。
- 所有工具复用 Application Service 和现有业务保护，不接受任意 SQL，也不能修改或删除正式环境的内置数据。
- 同时支持现代 MCP `2026-07-28` 协议和旧版 Host；不支持确认能力的 Host 在默认安全配置下只能读取。
- 桌面客户端和 MCP 使用同一 SQLite 数据库的独立 WAL 连接；MCP 提交后，已打开的桌面客户端会自动刷新业务数据。

正式安装版的启动配置使用安装根目录中的 `JobTrail.exe`，参数为 `--mcp`。开发环境需先执行 `pnpm build`，再使用设置页给出的 Electron 命令和参数。

## 技术架构

```text
Vue Renderer
    ↓ 类型安全 API
Electron Preload
    ↓ 受限 IPC
Main IPC Handlers
    ↓
Application Services
    ↓
Unit of Work (IMMEDIATE transaction + file lifecycle hooks)
    ↓
Repositories / File Storage
    ↓
SQLite / Local Files
```

- Renderer 不直接访问 Node.js、文件系统或 SQLite。
- Preload 只暴露经过类型约束的业务 API，不暴露完整 `ipcRenderer`。
- 业务规则、关联校验和删除保护集中在 Service 层。
- 所有写操作由 Service 层工作单元串行化，并通过提交/回滚钩子协调简历文件与数据库。
- SQL 仅位于 Repository 层，并使用参数化查询。
- 页面状态按业务域拆分到 composable，视图负责组合和展示。

主窗口启用了 `contextIsolation`、Electron sandbox 和内容安全策略，关闭了 Renderer 的 Node.js 集成。应用禁止任意新窗口和站内导航，IPC 只接受受信任主窗口的 main frame 调用；外部链接仅允许 HTTP/HTTPS 协议。

## 技术栈

- Electron 43
- Vue 3 + TypeScript
- electron-vite 5
- Naive UI、Pinia、vue-i18n
- better-sqlite3
- MCP TypeScript SDK + Zod
- Velopack 1.2
- Rust：Windows 启动器、离线安装器和卸载器
- Vitest、Node.js Test Runner

## 本地开发

### 环境要求

- Windows x64
- Node.js 24 LTS
- pnpm 11.3+

安装依赖并启动开发环境：

```powershell
pnpm install --frozen-lockfile
pnpm dev
```

`better-sqlite3` 是 Electron 原生模块。`pnpm install` 的 `postinstall` 会为当前 Electron 版本准备对应二进制。升级 Electron 或 `better-sqlite3` 后，请先关闭正在运行的职迹实例，再执行：

```powershell
pnpm rebuild:native
```

### 常用命令

| 命令                     | 用途                                         |
| ------------------------ | -------------------------------------------- |
| `pnpm dev`               | 启动 Electron 开发环境                       |
| `pnpm typecheck`         | 检查 Renderer 与 Main/Preload 类型           |
| `pnpm test`              | 运行发布基线测试和 Electron ABI 下的业务测试 |
| `pnpm format`            | 使用 Prettier 格式化代码                     |
| `pnpm format:check`      | 检查代码格式                                 |
| `pnpm build`             | 类型检查并构建生产代码                       |
| `pnpm package:win`       | 生成 Windows 未安装目录                      |
| `pnpm test:mcp:package`  | 验证未安装目录中的 MCP stdio 服务            |
| `pnpm test:mcp:launcher` | 验证根启动器的 MCP 管道、等待和退出          |
| `pnpm release:win`       | 生成离线安装器和 Velopack 更新资产           |

## Windows 发布

执行发布构建还需要：

- Rust stable MSVC 工具链
- Visual Studio C++ Build Tools
- .NET 8 SDK
- Velopack CLI `vpk` 1.2.0

```powershell
dotnet tool install --global vpk --version 1.2.0
pnpm release:win
```

发布脚本会：

1. 构建 Electron Windows 目录包。
2. 从固定 GitHub Feed 选择并校验低于目标版本的最新 Full 包。
3. 使用 Velopack 生成 Full/Delta 更新资产和更新 Feed。
4. 构建 Rust 根启动器、卸载器和内嵌程序载荷的离线安装器。
5. 校验 Feed 中每个资产的文件大小与 SHA-256。

产物位于 `dist/velopack/`：

```text
JobTrail-Setup-<version>.exe
releases.win.json
zhiji-<version>-full.nupkg
zhiji-<version>-delta.nupkg   # 存在可用历史基线时生成
```

项目不发布 Portable、MSI 或 Velopack 原生 Setup；`dist/win-unpacked/` 只用于开发验证。本地和 GitHub Actions 使用同一套发布脚本，CI 只接受与 `package.json` 版本一致的 `vX.Y.Z` 标签。

## 项目结构

```text
src/
├─ main/                 Electron 主进程、IPC、Service、Repository 和本地存储
├─ preload/              Renderer 的类型安全桥接层
├─ renderer/             Vue 页面、状态、领域 composable、样式和国际化
└─ shared/               Main、Preload 与 Renderer 共享的 DTO 和工具

native/bootstrap/        Rust 启动器、离线安装器和卸载器
scripts/                 测试入口、构建和 Velopack 发布脚本
resource/                应用图标等静态资源
docs/database.md         SQLite 结构与数据规则的唯一声明
docs/future.md           尚未交付的功能规划
CLAUDE.md                AI 辅助开发上下文与强制工程规范
```

## 当前边界

v0.4.0 尚未提供以下能力：

- macOS 或 Linux 发行版
- 账号、云同步和多设备同步
- 数据导入导出及自动备份
- 浏览器插件、网页岗位自动提取
- AI 简历分析、JD 匹配或模拟面试
- MCP Resources、Prompts、HTTP/OAuth 或远程连接

## 开发文档

- [AI 辅助开发上下文](CLAUDE.md)
- [数据库声明](docs/database.md)
- [未来功能规划](docs/future.md)

## License

本项目采用 [MIT License](LICENSE)。
