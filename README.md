# 职迹 JobTrail

职迹是一款面向 Windows 的本地优先求职管理桌面应用。它把公司、岗位、简历版本、求职进度和面试日程集中在一个地方，帮助你持续记录从发现岗位到投递、面试和最终结果的完整过程。

当前版本：`v0.9.0`（正式版前过渡版本）· 支持平台：Windows x64 · 界面语言：简体中文 / English

## 为什么使用职迹

- **本地优先**：业务数据、简历与聊天历史保存在应用目录；使用内置智能体时，所选内容会发送至你配置的模型端点。
- **求职信息集中管理**：岗位、公司、状态、简历和日程互相关联，不再依靠多个表格零散维护。
- **覆盖完整求职流程**：从“感兴趣”“待投递”“已投递”到多轮面试、Offer、淘汰或主动放弃均可追踪。
- **原生 Windows 体验**：支持离线安装、系统托盘、开机启动、本地提醒、应用内更新和卸载。

## 功能概览

### 求职记录

- 记录公司、岗位、部门、地点、来源、岗位链接、JD 和备注。
- 记录发现日期、投递日期和截止日期。
- 为岗位关联当前状态和实际使用的简历版本。
- 支持关键词搜索，以及按状态、公司筛选。
- 支持分页、新增、编辑和删除。
- “状态流转”按钮按时间从左到右展示实际状态轨迹，较长轨迹可在弹窗底部横向滚动；可切换默认紫、海蓝和暖金主题，选择会被记住。
- 内置“感兴趣”“待投递”“已投递”“初筛”“笔试”“AI面试”“一面”“二面”“三面”“HR面”“Offer”“淘汰”“主动放弃”等状态。

### 日历与提醒

- 使用月视图管理面试、笔试、截止日期及其他求职日程。
- 支持独立日程，也可以关联现有求职记录。
- 支持时间点、时间段、跨日期和全天日程。
- 按日程自身的 IANA 时区计算日期和显示时间。
- 日程类型选项随界面语言显示，也可搜索或自行输入；保存和展示时使用所选或输入的原文名称。
- 支持提前提醒、编辑和删除；日程结束后自动显示为已完成。
- Windows 本地提醒由主进程定时检查；已结束或已提醒的日程不会重复通知。

### 公司与行业

- 内置 580 家已校验的公司资料和 83 个行业分类。
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
- 主动从最新 GitHub Release 校验并同步全量内置公司目录；尚未发布目录资产时会提示缺少数据。
- 从设置页启动卸载程序；卸载会删除程序、配置、业务数据和简历。

## 安装

从 [GitHub Releases](https://github.com/baozha2023/JobTrail/releases/latest) 下载最新的 `JobTrail-Setup-<version>.exe`。

安装器是完整的离线安装包，不会在安装过程中下载程序载荷。启动后先显示默认安装位置、实际所需空间和目标磁盘可用空间；如需更改，点击“更改安装位置”选择父目录，安装器会在其中创建
`JobTrail` 文件夹。点击安装后，同一窗口切换为安装进度，并为当前 Windows 用户注册开始菜单、卸载入口等信息。一个用户只应保留一份职迹安装。安装窗口支持
Windows 每显示器动态 DPI 缩放。安装成功后会自动打开职迹，无需再确认。

安装完成后可在“设置 → 更新”中检查新版本。更新只替换程序运行时；应用前会保存旧版 Full
包，并在暂停新的业务写入、关闭现有 MCP 会话后备份配置和数据库。新版本启动健康检查连续失败时，根启动器会自动回滚程序、配置和数据库；简历目录不参与版本切换。更新完成后，MCP Host 可重新连接。

> [!IMPORTANT]
> v1.0.0 是第一个正式版。测试版的数据库、配置和安装目录不提供升级兼容；请先备份需要留存的文件，卸载测试版，再选择空目录全新安装。

> [!NOTE]
> 当前发布包未配置商业代码签名证书，Windows 可能显示“未知发布者”或 SmartScreen 提示。请只从本项目的 GitHub Releases 下载。

## 本地数据

职迹目前没有账号、云同步或遥测上传功能。业务数据、导入的简历、聊天附件与对话历史均保存在本机。使用内置智能体时，聊天文字、选定的简历或岗位内容、附件提取文字，以及启用多模态后的图片、PDF
页面图像和文档内可识别图片会发送至你配置的模型端点。

当前 v0.9.0 的数据库结构版本和配置文件版本均为 1，计划作为 v1.0.0 正式首发的数据基线。软件版本升级而数据结构不变时，数据版本保持不变；未来正式版若改变数据库或配置的持久化结构，会提升对应版本并提供从已发布正式版升级的路径。测试版数据不纳入兼容范围。配置文件损坏、字段无效或版本不受支持时，应用会保留原文件并停止启动，不会自动写入默认配置；修复或移走原文件后可重新启动。

| 内容     | 开发环境                   | 安装环境                              |
| -------- | -------------------------- | ------------------------------------- |
| 配置     | `<项目目录>/config.json`   | `<JobTrail 安装根目录>/config.json`   |
| 数据库   | `<项目目录>/data/zhiji.db` | `<JobTrail 安装根目录>/data/zhiji.db` |
| 简历     | `<项目目录>/resumes/`      | `<JobTrail 安装根目录>/resumes/`      |
| 聊天附件 | `<项目目录>/chat-uploads/` | `<JobTrail 安装根目录>/chat-uploads/` |

安装环境中的程序版本位于 `<JobTrail 安装根目录>/.runtime/current/`，由 Velopack 管理。安装器只接受空目标目录。完整卸载会在明确确认后清空
`<JobTrail 安装根目录>`，删除其中的程序、配置、数据库和简历，不提供数据保留选项。卸载前请先备份重要数据。

建议定期备份以下内容：

```text
config.json
data/zhiji.db
resumes/
chat-uploads/
```

SQLite 开启 WAL。复制正在运行的数据库前应先退出职迹，确保主数据库及临时日志已经完整落盘。

## MCP 智能体连接

职迹内置本地 stdio MCP Server，可供 Claude、Cursor、VS Code、CC-Switch 等 MCP Host 使用。在“设置 → MCP配置”中启用后，选择对应
Host 并复制配置片段即可。职迹不会自动改写第三方软件的配置。

- 提供网页读取及状态、行业、公司、简历、求职记录和日程工具。
- MCP 默认关闭；启用后本地读取与网页读取可直接执行，本地写操作默认要求预览和明确确认。网页查询型 POST 的边界见下文。
- 确认请求有 10 分钟有效期，并绑定调用参数和当前数据状态；拒绝、取消、过期、篡改或数据已变化均不会写入。
- 所有工具复用 Application Service 和现有业务保护，不接受任意 SQL，也不能修改或删除正式环境的内置数据。
- 同时支持现代 MCP `2026-07-28` 协议和旧版 Host；不支持确认能力的 Host 在默认安全配置下只能读取。
- 桌面客户端和 MCP 使用同一 SQLite 数据库的独立 WAL 连接；MCP 提交后，已打开的桌面客户端会自动刷新业务数据。

正式安装版的启动配置使用安装根目录中的 `JobTrail.exe`，参数为 `--mcp`。开发环境需先执行 `pnpm build`，再使用设置页给出的
Electron 命令和参数。

## 内置智能体

在“设置 → 内置智能体”填写 OpenAI Chat Completions 兼容端点的 Base URL、Model ID 和 API
Key，并设置上下文窗口与自动压缩阈值，点击“保存模型设置”，然后从侧栏打开“智能体”。上下文窗口默认 256k token，达到 80%
时自动压缩较早的完整对话轮次。API Key 以明文保存在本地 `config.json`，设置页可回显；请自行保护该文件。远程端点要求 HTTPS 和
API Key；本机回环 HTTP 端点可以不填密钥。

- 聊天历史在右侧查看、切换，右键可重命名或删除；完整展示记录独立保存在 SQLite，LangGraph 在同一个数据库中保存可压缩的工作记忆与待回答问题。
- Enter 发送，Shift+Enter 换行，Ctrl+V 粘贴文字或图片；聊天框高度可以拖动调整。
- 输入 `@` 可按简历、求职记录、公司或行业分类并搜索选择；智能体可通过独立的 `read_resume` 只读工具按引用 ID
  读取简历名称、备注和可提取正文，简历匹配则使用 `match_resume`。输入 `/` 可选择简历匹配技能或主动运行 `/compact`
  压缩对话。选中的内容显示为行内标签。发送后立即显示用户消息并清空输入框与待发送附件；若发送结果无法确认，会暂停再次发送，待核对聊天历史后，只有确认未保存才恢复草稿和附件。触发压缩后也会立即清空输入框，并在完成前显示“正在压缩”状态。流式回答、工具调用和压缩活动按顺序交错展示。工具调用保留在聊天历史中，每项独占一行，连续调用可展开或收起查看输入与结果。聊天中的图片附件可点击查看完整预览，文档附件可使用系统默认应用打开。模型返回多个工具调用时并行执行可独立读取的调用，写入调用仍逐项确认。聊天框底部显示当前窗口占用，以及会话累计的输入、输出和缓存命中
  token。
- 可以上传 PDF、DOC、DOCX、TXT、MD；打开多模态开关后还可上传 PNG、JPEG、WebP。多模态开启时，PDF 会同时提供提取文字和页面图像，DOCX
  与 Markdown 会尽量补充可识别的内嵌图片；关闭时静默跳过文档视觉内容并继续使用可提取文字。
- 打开“启用 MCP 连接”后，内置智能体可读取和维护职迹数据，并可选择已有简历与岗位 JD 做证据化匹配；关闭后仍可普通聊天。
- 助手正文支持经过安全净化的 Markdown 标题、列表、表格、链接与代码块。公司的一般介绍会结合模型已有的稳定公开知识生成，本地公司记录只在需要时补充；启用
  MCP 后可读取公开网页，由智能体根据网页文字整理招聘信息。网站限制访问、需要登录或无法可靠读取时会说明原因。
- 智能体缺少关键信息时可一次询问 1–3
  个问题；提问卡片替代聊天输入框，并按当前题内容调整高度，不在卡片内滚动。每次只显示一题，可逐题前进或返回修改，最后一题提交所有答案。有备选答案时显示选项、简短说明与推荐标记，也始终可选“其他”自行填写。
- 开启“修改数据前向我确认”时，任何 MCP 写入均先显示服务端预览，得到明确同意后才执行。预览变化时需重新确认。

网页读取工具 `read_web_page` 可读取公开网页的标题、正文、标题层级和链接，包括 JavaScript 渲染后的内容。无限滚动页面可传
`scroll: true`：工具在受限浏览器中逐批滚动并收集新增内容，不依赖分页 URL。首次省略 `cursor` 或传 `0`，之后保持相同网址、渲染模式和
`scroll` 值，逐次传回 `nextCursor`；同一个游标会先续读当前批次，再读取下一批。每次最多返回 20,000 个 UTF-16 字符串单位的正文和
50 条链接，多出的内容继续通过游标读取。游标和浏览器会话仅在 MCP 进程内短时保留；过期后从 `0`
重新读取。工具不提取或保存岗位，不自动点击按钮，也不访问登录后的页面。`nextCursor` 为 `null` 时应检查 `incompleteReason` 和
`warnings`；观察到列表末尾并不证明网站数据已全部核实。
网页工具不检查目标站点的 robots.txt。一般请求使用 GET/HEAD；受限的同站 JSON POST 可用于路径明确为 `search`、`query`、`list`
等的查询接口，另有已核实的北森查询接口。通用规则只能根据路径和请求体判断查询意图，无法证明网站端没有记录或其他副作用，因此工具的
MCP `readOnlyHint` 为 `false`。表单、登录、提交、修改类及不符合规则的 POST
仍被拦截；浏览器请求不传递认证信息。公网地址校验、请求限额及网站权限拒绝处理始终生效。系统 DNS 若只返回代理使用的 `198.18.0.0/15` 地址，工具会通过固定公网 IP 的 Cloudflare DNS over HTTPS 解析目标域名，再校验并连接真实公网 IP；目标域名会发送给该 DNS 服务。暂时性网络或服务故障会在总时限内自动重试一次；权限、安全限制和确定性解析错误不重试。

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

主窗口启用了 `contextIsolation`、Electron sandbox 和内容安全策略，关闭了 Renderer 的 Node.js 集成。应用禁止任意新窗口和站内导航，IPC
只接受受信任主窗口的 main frame 调用；外部链接仅允许 HTTP/HTTPS 协议。

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

`better-sqlite3` 是 Electron 原生模块。`pnpm install` 的 `postinstall` 会为当前 Electron 版本准备对应二进制。升级 Electron
或 `better-sqlite3` 后，请先关闭正在运行的职迹实例，再执行：

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
2. 从固定 GitHub Feed 选择并校验低于目标版本、且不早于 v1.0.0 的最新正式版 Full 包；v1.0.0 不使用测试版包生成 Delta。
3. 使用 Velopack 生成 Full/Delta 更新资产和更新 Feed。
4. 构建 Rust 根启动器、卸载器和内嵌程序载荷的离线安装器。
5. 校验 Feed 中每个资产的文件大小与 SHA-256。
6. 逐字节复制全量公司目录并生成包含文件名、大小和 SHA-256 的 manifest。

产物位于 `dist/velopack/`：

```text
JobTrail-Setup-<version>.exe
releases.win.json
zhiji-<version>-full.nupkg
zhiji-<version>-delta.nupkg   # 存在可用历史基线时生成
jobtrail-company-catalog.json
jobtrail-company-catalog.manifest.json
SHA256SUMS.txt                 # 发布前手工生成的资产校验清单
```

## 项目结构

```text
src/
├─ main/                 Electron 主进程、IPC、Service、Repository 和本地存储
├─ preload/              Renderer 的类型安全桥接层
├─ renderer/             Vue 页面、状态、领域 composable、样式和国际化
└─ shared/               Main、Preload 与 Renderer 共享的 DTO 和工具

native/bootstrap/        Rust 启动器、离线安装器、卸载器和更新回滚
scripts/                 测试入口、构建和 Velopack 发布脚本
resource/                应用图标等静态资源
docs/database.md         SQLite 结构与数据规则的唯一声明
CLAUDE.md                AI 辅助开发上下文与强制工程规范
```

## 开发文档

- [AI 辅助开发上下文](CLAUDE.md)
- [数据库声明](docs/database.md)

## License

本项目采用 [MIT License](LICENSE)。
