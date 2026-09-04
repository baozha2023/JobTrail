# 职迹

职迹（`zhiji`）是一款基于 Electron 的本地优先求职管理桌面应用，用于集中管理公司、岗位、简历版本、求职状态和日程，记录从发现岗位到投递、面试以及最终结果的完整过程。

## 当前版本

- 版本：`0.1.0`
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
- 默认状态包括“已查看”“待投递”“初筛”“笔试”“面试”“Offer”等

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

`better-sqlite3` 是原生模块，安装和启动脚本会自动执行 Electron 对应的原生模块重建。

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

运行 `pnpm release:win` 前，需要在本机安装并配置可执行的 `vpk` 命令。脚本会使用 `zhiji` 作为 Velopack 的 `packId`，并从 `package.json` 读取版本号。

## 数据和配置位置

只有业务数据、简历文件和应用配置保存到项目或程序所在目录；Electron 自身的缓存、日志等底层数据仍使用系统默认目录。

开发环境：

```text
<项目目录>/config.json
<项目目录>/data/zhiji.db
<项目目录>/resumes/
```

打包运行：

```text
<exe 所在目录>/config.json
<exe 所在目录>/data/zhiji.db
<exe 所在目录>/resumes/
```

默认配置示例：

```json
{
  "configVersion": 1,
  "themeMode": "system",
  "locale": "zh-CN",
  "closeBehavior": "quit",
  "launchAtStartup": false,
  "velopack": {
    "githubRepository": "",
    "includePrerelease": false
  },
  "mcp": {
    "enabled": false,
    "requireWriteConfirmation": true
  }
}
```

配置文件支持保留未知字段，写入采用临时文件和原子替换。配置损坏时会先备份，再恢复默认配置。

## 数据库约定

- SQLite 结构版本使用 `PRAGMA user_version`。
- 当前结构版本为 `3`。
- 时间字段使用 UTC Unix 毫秒时间戳。
- 跨表关联统一使用逻辑外键，数据库不使用物理外键约束。
- 数据库结构以 [database.md](database.md) 为唯一声明。
- 首发阶段不提供过程性 `ALTER TABLE` 迁移或转换层。
- 状态正在被求职记录使用时不能删除，最后一个状态也不能删除。
- 被求职记录引用的简历版本不能删除。

## 架构约束

渲染进程不能直接访问 SQLite、Node.js API 或文件系统。所有业务增删改查必须经过主进程的业务 service，再由 preload 暴露类型安全的 IPC API。

当前业务服务位于 `src/main/services.ts`，未来 MCP 也必须复用这些服务，不能绕过 service 执行任意 SQL。

## Velopack 更新

Velopack 已从首版接入。GitHub 仓库创建后，在 `config.json` 中配置：

```json
{
  "velopack": {
    "githubRepository": "https://github.com/<owner>/<repository>",
    "includePrerelease": false
  }
}
```

仓库地址为空时会跳过更新检查。发布流程使用 Velopack 默认机制和 GitHub Release 资产，不使用 Squirrel 或其他更新框架。

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
