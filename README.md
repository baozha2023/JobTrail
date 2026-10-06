# 职迹 JobTrail

**简体中文** | [English](README.en.md)

职迹是一款面向 Windows 的本地求职管理桌面应用，将公司、岗位、简历、求职进度和面试日程集中在一起，帮助你有条理地推进每一次求职。

## 主要功能

- **求职记录**：管理岗位信息、投递状态和进度，关联简历与日程。
- **公司管理**：查找公司、浏览招聘官网，管理多个办公地点，按行业与办公地点组合筛选并收藏感兴趣的公司。
- **简历管理**：保存多份简历，记录每次投递使用的版本。
- **日历提醒**：安排面试、笔试和截止日期，接收本地提醒。
- **智能体助手**：连接自选模型，围绕简历和岗位展开对话；支持通过 MCP 连接外部 AI 工具。
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

以下为中文界面，求职记录、日程和简历使用示例数据。点击图片可查看大图。

| 求职记录                                                                            | 日历日程                                                                        |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| [![求职记录](docs/screenshots/applications.png)](docs/screenshots/applications.png) | [![日历日程](docs/screenshots/calendar.png)](docs/screenshots/calendar.png)     |
| 公司管理                                                                            | 行业分类                                                                        |
| [![公司管理](docs/screenshots/companies.png)](docs/screenshots/companies.png)       | [![行业分类](docs/screenshots/industries.png)](docs/screenshots/industries.png) |
| 简历版本                                                                            | 智能体助手                                                                      |
| [![简历版本](docs/screenshots/resumes.png)](docs/screenshots/resumes.png)           | [![智能体助手](docs/screenshots/assistant.png)](docs/screenshots/assistant.png) |

## 下载与使用

前往 [GitHub Releases](https://github.com/baozha2023/JobTrail/releases) 下载 Windows 安装包，按提示选择空目录安装。

安装后即可管理求职记录。如需使用智能体，在设置中填写模型服务地址、模型名称和 API Key；如需连接外部 AI 工具，在 MCP
设置中复制对应配置。MCP 默认开启，可在设置中关闭。

v1.6.0 起，动态网页读取使用系统已安装的 **Microsoft Edge Stable**，安装包不再附带独立 Chromium。请安装并保持 Edge 更新；无法启动 Edge 时会提示修复，本地管理和静态网页读取仍可使用，自动模式可能返回带有不完整提示的静态内容。

本地提醒需要应用保持运行，可以将窗口隐藏到托盘。

## 数据与隐私

职迹无需账号，不提供云同步，求职记录、简历和聊天历史保存在本机。使用智能体时，相关对话和选定内容会发送到你配置的模型服务。

可在设置中导出完整备份，并保存到安装目录之外。**导入会替换当前数据，卸载会清空安装目录，请提前备份。**

## 本地开发

准备 Windows、Node.js、pnpm 和 Microsoft Edge Stable，并按[配置说明](CLAUDE.md)创建本地私有构建配置 `private-build.config.json`
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
CLI。开发与发布约定见[项目开发规范](CLAUDE.md)。

## 项目文档

- [项目开发规范](CLAUDE.md)
- [数据库结构](docs/database.md)

## 许可证

[MIT License](LICENSE)
