# 职迹

职迹（`zhiji`）是一款基于 Electron 的本地优先求职管理桌面应用，用于集中管理公司、岗位、简历版本、求职状态和日程，记录从发现岗位到投递、面试以及最终结果的完整过程。

## 当前版本

- 版本：`0.2.0`
- 首发平台：Windows x64
- 界面语言：简体中文、English
- 主题：浅色、深色、跟随系统
- 数据存储：本地 SQLite 和应用内部简历文件

## 功能

### 求职记录

- 以表格管理公司和岗位
- 支持搜索、状态筛选、公司筛选和分页
- 支持关联简历版本、岗位链接、JD、地点、截止时间和投递时间
- 支持新增、编辑和删除求职记录
- 默认状态包括“感兴趣”“待投递”“初筛”“笔试”“AI面试”“一面”“二面”“三面”“HR面”“Offer”“淘汰”“主动放弃”

### 日历

- 月视图日历
- 支持全天日程和时间段日程
- 支持提醒、完成、编辑、删除
- 日程可以关联求职记录，也可以独立存在

### 基础数据管理

- 状态管理：新增、编辑、删除和上下移动排序
- 行业分类：新增、编辑、删除和上下移动排序
- 简历版本：导入、编辑、打开和删除
- 公司管理：新增、编辑、删除、收藏和招聘官网跳转
- 公司别名只用于搜索，不在公司和求职记录界面展示

### 设置

- 主题和语言切换
- 关闭主窗口时最小化到托盘或直接退出
- 开机自启
- Velopack 更新检查

## 技术栈

- Electron
- Vue 3
- TypeScript
- electron-vite
- Naive UI
- Pinia
- vue-i18n
- better-sqlite3
- Velopack

## 项目结构

```text
src/
├─ main/       Electron 主进程、数据库、文件存储、业务服务和 IPC
├─ preload/    类型安全的渲染进程桥接 API
├─ renderer/   Vue 页面、组件、样式和国际化
└─ shared/     主进程与渲染进程共享的类型定义

claude.md      项目上下文与开发规范
database.md    SQLite 数据库唯一声明文档
future.md      首版未落地功能规划
scripts/       构建和 Velopack 打包脚本
resource/      应用图片等静态资源
```

## 开发环境

建议使用：

- Node.js 22+
- pnpm 11+
- Windows x64

安装依赖：

```bash
pnpm install
```

启动开发环境：

```bash
pnpm dev
```

`better-sqlite3` 是原生模块。依赖安装后的 `postinstall` 会准备 Electron 对应的原生模块；开发、测试和构建脚本不会重复重建，避免应用运行时占用 `.node` 文件导致 Windows `EPERM`。升级 Electron 或 `better-sqlite3` 后，请先关闭正在运行的职迹实例，再手动执行 `pnpm rebuild:native`。

## 常用命令

```bash
# 类型检查
pnpm typecheck

# 运行测试
pnpm test

# 构建 Electron 文件
pnpm build

# 构建 Windows 未安装目录
pnpm package:win

# 构建 Windows 文件并执行 Velopack 打包
pnpm release:win
```

运行 `pnpm release:win` 前，需要在本机安装并配置可执行的 `vpk` 命令。脚本会使用 `zhiji` 作为 Velopack 的 `packId`、使用“职迹”作为 Windows 安装项名称，从 `package.json` 读取版本号，并将所有构建/打包产物写入 `dist/`。当前仅生成 Velopack 默认 `Setup.exe`、Portable 包和 Release 资产，不生成 MSI；未来计划使用 Rust 自定义安装器。GitHub Actions 发布流程位于 `.github/workflows/release.yml`，推送 `v*` 标签后会自动构建 Windows 包、生成 Velopack Release 资产并发布到当前仓库。

## 数据和配置位置

只有业务数据、简历文件和应用配置保存到项目目录或 Velopack 安装根目录；Electron 自身的缓存、日志等底层数据仍使用系统默认目录。

开发环境：

```text
<项目目录>/config.json
<项目目录>/data/zhiji.db
<项目目录>/resumes/
```

打包运行：

```text
<Velopack 安装根目录>/config.json
<Velopack 安装根目录>/data/zhiji.db
<Velopack 安装根目录>/resumes/
```

Velopack 的版本文件位于安装根目录的 `current/` 中，该目录由 Velopack 管理并会在更新时替换；业务数据不会写入 `current/`。

默认配置示例：

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

配置文件支持保留未知字段，写入采用临时文件和原子替换。配置损坏时会先备份，再恢复默认配置。

## 数据库约定

- SQLite 结构版本使用 `PRAGMA user_version`。
- 当前结构版本为 `8`，包含日程提醒发送记录表、简历版本排序字段、公司已读时间字段和多行业公司关联表。
- 时间字段使用 UTC Unix 毫秒时间戳。
- 跨表关联统一使用逻辑外键，数据库不使用物理外键约束。
- 数据库结构以 [database.md](database.md) 为唯一声明。
- 首发阶段不提供过程性 `ALTER TABLE` 迁移或转换层。
- 状态正在被求职记录使用时不能删除，最后一个状态也不能删除。
- 被求职记录引用的简历版本不能删除。

## 架构约束

渲染进程不能直接访问 SQLite、Node.js API 或文件系统。所有业务增删改查必须经过主进程的业务 service，再由 preload 暴露类型安全的 IPC API。

当前业务服务位于 `src/main/services/`，SQL 仅位于 `src/main/repositories/`；未来 MCP 也必须复用这些服务，不能绕过 service 执行任意 SQL。

## Velopack 更新

Velopack 已从首版接入。GitHub Release 更新源固定为 `https://github.com/baozha2023/JobTrail`，由程序内置，不在设置页面显示，也不支持修改。`config.json` 不保存更新源或 prerelease 开关：

```json
{ "velopack": {} }
```

运行时使用 Velopack `UpdateManager`，从固定 GitHub 仓库的 Release 检查、下载并应用更新；更新源使用仓库根地址，不是 `releases/latest/download` 资产下载路径。发布流程使用 `vpk download github -> vpk pack -> vpk upload github`，不使用 Squirrel 或其他更新框架。

更新元数据由主进程持有，下载和应用更新不会信任渲染进程传入的更新对象。

## MCP 状态

首版暂不启动 MCP Server，但业务 CRUD 已按未来 MCP 复用要求设计。未来计划使用本地 stdio MCP Server，让 AI 智能体通过自然语言查询和管理求职数据；新增、编辑、删除等写入操作将采用“预览变更 → 用户确认 → 提交变更”流程。

详细规划见 [future.md](future.md)。

## 开发规范

开始开发前请阅读：

1. [claude.md](claude.md)
2. [database.md](database.md)
3. [future.md](future.md)

## License

MIT
