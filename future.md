# 职迹未来功能

本文档只记录首版暂不实际落地的内容。首版代码已经为业务 CRUD 预留 MCP 兼容的 service 接口，但 MCP 协议服务本身默认不启用。

## MCP 与智能体连接

状态：未落地，已预留业务服务边界。

计划内容：

- 提供本地 stdio MCP Server。
- 允许 Claude、Cursor、VS Code 或其他 MCP Host 连接职迹。
- 支持 AI 根据口语化描述查询公司、状态、岗位、简历和日程。
- 支持 AI 根据口语化描述新增、修改和删除业务数据。
- MCP 只调用 application service，不允许执行任意 SQL。
- 查询操作自动执行。
- 新增、修改、删除先生成变更预览，经用户确认后提交。
- 状态删除、简历删除和逻辑关联约束不能被 AI 绕过。
- MCP 工具输入输出使用稳定的 JSON DTO。

预留工具方向：

- `search_opportunities`
- `get_opportunity`
- `create_opportunity`
- `update_opportunity`
- `delete_opportunity`
- `list_statuses`
- `create_status`
- `list_industries`
- `create_industry`
- `update_industry`
- `delete_industry`
- `delete_status`
- `search_companies`
- `list_resume_versions`
- `list_calendar_events`
- `create_calendar_event`
- `update_calendar_event`
- `delete_calendar_event`
- 首版已经新增 `src/main/mcp-contracts.ts` 强类型工具注册表，覆盖上述领域的 list/get/create/update/delete/reorder/changeStatus/complete；它不是 MCP Server，也不会直接执行 SQL。

## 跨平台

状态：未落地。

- 使用 Rust 开发 Windows 自定义安装器，替代当前 Velopack 默认安装器；安装目录选择、安装/卸载体验和数据目录保护由自定义安装器负责。
- macOS 安装与更新。
- Linux 安装与更新。
- 跨平台原生 SQLite 和简历目录验证。

## 发布与更新验证

状态：部分未落地。

- 使用真实 GitHub Release 完成更新检查、下载、应用和重启的端到端验证。
- 持续完善 GitHub 仓库发布和自动发布 CI 的版本验证。
- Rust 自定义安装器、安装目录选择和新的安装/卸载体验。

## 数据能力

状态：未落地。

- 数据导出和导入。
- 数据库与简历文件备份。
- 云同步。
- 账号体系。
- 多设备同步。

## 求职扩展

状态：未落地。

- 浏览器插件一键收藏岗位。
- 从招聘网页提取公司和岗位。
- AI 简历分析。
- JD 匹配。
- 简历定制。
- 模拟面试。
- 多人协作。
