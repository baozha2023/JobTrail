# 职迹 JobTrail

**简体中文** | [English](README.en.md)

职迹是一款面向 Windows 的本地求职管理桌面应用，将公司、岗位、简历、求职进度和面试日程集中在一起，帮助你有条理地推进每一次求职。

## 主要功能

- **求职记录**：管理岗位信息、投递状态和进度，关联简历与日程。
- **公司管理**：查找公司、浏览招聘官网，管理多个办公地点，按行业与办公地点组合筛选并收藏感兴趣的公司。
- **岗位发现（Beta）**：BOSS 直聘、猎聘、智联招聘、前程无忧、国聘、实习僧和鱼泡直聘统一搜索，按平台提供微信或 App 扫码登录，支持薪资筛选、相关性排序、岗位详情、内置网页、搜索历史、保存求职记录及 MCP。查询规则、账号管理及接口契约见[岗位发现说明](docs/job-discovery.md)。
- **简历管理**：保存多份简历，记录每次投递使用的版本。
- **日历提醒**：安排面试、笔试和截止日期，接收本地提醒。
- **智能体助手**：连接自选模型，引用简历与岗位、分析匹配度、生成笔试练习；支持上下文用量显示、对话压缩，以及通过 MCP 连接外部 AI 工具。
- **数据备份**：在设置中导出、导入完整备份，保存记录、配置、简历与聊天附件。

支持简体中文与 English、浅色与深色主题、系统托盘、开机启动和应用内更新。

## 技术栈

| 领域         | 技术                                                  | 用途                                  |
| ------------ | ----------------------------------------------------- | ------------------------------------- |
| 桌面应用     | Electron、TypeScript                                  | 主进程、预加载脚本及 Windows 桌面集成 |
| 用户界面     | Vue 3、Naive UI、Pinia、Vue I18n                      | 页面、组件、状态管理与多语言          |
| 本地数据     | SQLite、better-sqlite3                                | 在本机保存求职记录和应用数据          |
| 智能体与工具 | LangChain、LangGraph、MCP SDK                         | 智能体流程及外部工具连接              |
| 网页访问     | Playwright                                            | 公司招聘网页的浏览与信息获取          |
| 构建与发布   | electron-vite、Vite、electron-builder、Velopack、Rust | 应用构建、Windows 安装、启动与更新    |
| 测试         | Vitest、Node.js 测试运行器、Playwright                | 单元测试及打包后的桌面应用测试        |

## 界面预览

以下为当前客户端中文界面，使用示例数据。点击图片可查看大图。

| 求职记录                                                                            | 日历日程                                                                              |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| [![求职记录](docs/screenshots/applications.png)](docs/screenshots/applications.png) | [![日历日程](docs/screenshots/calendar.png)](docs/screenshots/calendar.png)           |
| 公司管理                                                                            | 岗位发现（Beta）                                                                      |
| [![公司管理](docs/screenshots/companies.png)](docs/screenshots/companies.png)       | [![岗位发现（Beta）](docs/screenshots/discovery.png)](docs/screenshots/discovery.png) |
| 行业分类                                                                            | 简历版本                                                                              |
| [![行业分类](docs/screenshots/industries.png)](docs/screenshots/industries.png)     | [![简历版本](docs/screenshots/resumes.png)](docs/screenshots/resumes.png)             |

**智能体助手**

[![智能体助手](docs/screenshots/assistant.png)](docs/screenshots/assistant.png)

## 下载与使用

前往 [GitHub Releases](https://github.com/baozha2023/JobTrail/releases) 下载 Windows 安装包，按提示选择空目录安装。

安装后即可管理求职记录。如需使用智能体，在设置中填写模型服务地址、模型名称和 API Key；如需连接外部 AI 工具，在 MCP
设置中复制对应配置。MCP 默认开启，可在设置中关闭。

动态网页读取使用系统已安装的 **Microsoft Edge Stable**，安装包不附带独立的 Playwright Chromium。请安装并保持 Edge 更新；无法启动 Edge 时会提示修复，本地管理和静态网页读取仍可使用，自动模式可能返回带有不完整提示的静态内容。

岗位发现仅允许选择已登录的平台。“需要登录”和“会话失效”提示打开扫码界面，“需要网站验证”提示打开网站窗口。扫码确认或网站验证关窗后，客户端复核原查询；通过后自动继续该平台搜索。

内置智能体也会在聊天中显示登录／验证卡片，复用同一处理流程。扫码经官方确认后弹窗自动关闭；网站验证完成后请手动关闭窗口。恢复成功后，聊天自动通知 AI 读取原任务最新结果并继续；正在输入的草稿和附件会保留。外接 MCP 智能体收到平台阻断状态后，需要提示你到职迹完成处理。

智能体运行中仍可输入并发送下一条消息，每个聊天最多排队三条，支持查看、编辑和删除。验证成功等内部通知会优先执行；单轮失败后继续处理下一条，待回答、待确认或提交结果未知时暂停消费。队列在切页和界面重载后保留，完整退出应用后清空。v2.4.0 沿用数据库 v6、配置 v2，从 v2.3.0 升级无需持久化迁移。

MCP 实时采集复用同一安装目录的客户端；客户端未运行时启动到托盘，不抢占焦点。本地搜索历史查询不要求客户端运行。岗位发现网页使用 Electron 内置 Chromium。

岗位发现由 Chromium 使用系统 DNS、代理/PAC、TLS 和连接配置，不另建代理或公共 DNS 回退。平台登录、搜索和详情共用各自独立的浏览器会话。完整网络边界及真实网站验收限制见[岗位发现说明](docs/job-discovery.md)。

本地提醒需要应用保持运行，可以将窗口隐藏到托盘。

### v2.3.0 使用引导

首次使用或升级后自动展示基础导航引导，首次进入岗位发现时展示专项引导。支持上一步、下一步、跳过和中断续看，设置页可分别重新开始。岗位发现引导会讲解账号弹窗与搜索流程，不自动登录或搜索。v2.3.0 的数据库定版为 v6、配置定版为 v2；从 v2.2.0 升级分别执行正式 `5 → 6` 和 `1 → 2` 迁移，更早正式版沿连续版本链升级，原数据与设置保留，完整备份包含引导进度。

## 数据与隐私

职迹无需注册应用账号，不提供云同步，求职记录、简历和聊天历史保存在本机。使用智能体时，相关对话和选定内容会发送到你配置的模型服务。

招聘平台登录会话由本机浏览器管理，不包含在可移植备份中。

可在设置中导出完整备份，并保存到安装目录之外。**导入会替换当前数据，卸载会清空安装目录，请提前备份。**

## 本地开发

准备 Windows、Node.js、pnpm 和 Microsoft Edge Stable，并按[配置说明](AGENTS.md)创建本地私有构建配置 `private-build.config.json`
。该文件不应提交到 Git，使用已有数据时请保留原构建密钥。

```powershell
pnpm install --frozen-lockfile
pnpm dev
```

常用命令：

| 命令                | 用途                |
| ------------------- | ------------------- |
| `pnpm typecheck`    | 类型检查            |
| `pnpm test`         | 运行测试            |
| `pnpm format:check` | 格式检查            |
| `pnpm build`        | 构建应用            |
| `pnpm release:win`  | 构建 Windows 安装包 |

安装包构建还需要 Rust MSVC、Visual Studio C++ Build Tools、.NET SDK 和 Velopack
CLI。开发与发布约定见[项目开发规范](AGENTS.md)。

## 项目文档

- [项目开发规范](AGENTS.md)
- [岗位发现](docs/job-discovery.md)
- [数据库结构](docs/database.md)
- [持久化升级规则](docs/persistence-upgrade-guide.md)
- [统一诊断系统](docs/diagnostics.md)
- [脚本与验收入口](scripts/README.md)

## 许可证

[MIT License](LICENSE)
