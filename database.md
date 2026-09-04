# 职迹数据库声明

## 数据库位置

开发环境：`<项目根目录>/data/zhiji.db`  
打包环境：`<exe 所在目录>/data/zhiji.db`

应用配置不存储在数据库中，而是存储在：

开发环境：`<项目根目录>/config.json`  
打包环境：`<exe 所在目录>/config.json`

## SQLite 初始化规则

- 使用 `better-sqlite3`。
- `PRAGMA journal_mode = WAL`。
- `PRAGMA busy_timeout = 5000`。
- 禁止创建 SQLite 物理外键；所有跨表关联均为逻辑外键，由业务 service 校验和维护。
- 时间统一使用 UTC Unix 毫秒时间戳。
- 布尔值使用 INTEGER：`0=false`、`1=true`。
- 使用 SQLite 内置 `PRAGMA user_version` 记录结构版本。
- 不创建 `schema_migrations` 表。
- 当前完整结构版本为 `3`。首发阶段直接以本文件中的最终结构初始化，不执行 `ALTER TABLE` 或过程性迁移 SQL。

## 业务表

### statuses

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id | INTEGER | PK AUTOINCREMENT | 状态 ID |
| label | TEXT | NOT NULL UNIQUE | 状态名称 |
| sort_order | INTEGER | NOT NULL | 显示顺序 |
| is_builtin | INTEGER | NOT NULL DEFAULT 0 | 是否内置状态 |
| created_at | INTEGER | NOT NULL | 创建时间 |
| updated_at | INTEGER | NOT NULL | 更新时间 |

默认状态：已查看、感兴趣、待投递、初筛、笔试、AI面试、一面、二面、三面、HR面、Offer、淘汰、主动放弃。

状态删除规则：

1. 查询 `opportunities.status_id` 是否引用目标状态。
2. 有引用时返回 `STATUS_IN_USE` 和使用数量，禁止删除。
3. 只有一个状态时返回 `LAST_STATUS`，禁止删除。
4. 未被引用且不是最后一个状态时允许删除。

状态显示顺序通过状态业务服务整体重排 `sort_order`，管理表格不直接展示该内部字段。

### industries

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id | INTEGER | PK AUTOINCREMENT | 行业分类 ID |
| name | TEXT | NOT NULL UNIQUE | 行业名称 |
| sort_order | INTEGER | NOT NULL | 显示顺序 |
| is_builtin | INTEGER | NOT NULL DEFAULT 0 | 是否内置行业分类 |
| created_at | INTEGER | NOT NULL | 创建时间 |
| updated_at | INTEGER | NOT NULL | 更新时间 |

内置行业分类：互联网、游戏、人工智能、软件、芯片、硬件、通信与硬件、电子与硬件、计算机与IT服务、金融、银行、证券与投资、保险、电商与零售、消费品、食品饮料、医疗健康、生物医药、汽车、新能源、制造业、化工与材料、建筑与房地产、家居与物业、物流与供应链、交通运输、航空航天、能源与矿业、电力与公用事业、教育、旅游与酒店、媒体与内容、广告与营销、文化娱乐、专业服务与咨询、法律服务、人力资源、农业与农牧、政府与公共服务、跨境贸易、生活服务、环保与循环经济、其他服务。

行业分类被公司使用时禁止删除。

### companies

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id | INTEGER | PK AUTOINCREMENT | 公司 ID |
| name | TEXT | NOT NULL UNIQUE | 公司名称 |
| industry_id | INTEGER | 可空逻辑外键，指向 industries.id | 行业分类 |
| career_url | TEXT | 可空 | 招聘官网 |
| is_builtin | INTEGER | NOT NULL DEFAULT 0 | 是否内置公司 |
| is_favorite | INTEGER | NOT NULL DEFAULT 0 | 是否收藏 |
| created_at | INTEGER | NOT NULL | 创建时间 |
| updated_at | INTEGER | NOT NULL | 更新时间 |

不包含 `short_name`、`english_name`、`website`。

索引：`industry_id`。

### company_aliases

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id | INTEGER | PK AUTOINCREMENT | 别名 ID |
| company_id | INTEGER | NOT NULL 逻辑外键，指向 companies.id | 所属公司 |
| alias | TEXT | NOT NULL | 搜索别名 |
| created_at | INTEGER | NOT NULL | 创建时间 |

唯一约束：`UNIQUE(company_id, alias)`。

### resume_versions

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id | INTEGER | PK AUTOINCREMENT | 简历版本 ID |
| name | TEXT | NOT NULL | 简历版本名称 |
| relative_path | TEXT | NOT NULL UNIQUE | UUID 文件名及扩展名 |
| size_bytes | INTEGER | 可空 | 文件大小 |
| sha256 | TEXT | 可空 | 文件校验值 |
| note | TEXT | 可空 | 备注 |
| is_active | INTEGER | NOT NULL DEFAULT 1 | 是否启用 |
| created_at | INTEGER | NOT NULL | 创建时间 |
| updated_at | INTEGER | NOT NULL | 更新时间 |

不包含 `file_name`、`mime_type`。文件固定存储在：

开发环境：`<项目根目录>/resumes/`  
打包环境：`<exe 所在目录>/resumes/`

`relative_path` 示例：`550e8400-e29b-41d4-a716-446655440000.pdf`。

### opportunities

一条记录代表一个公司岗位求职机会。

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id | INTEGER | PK AUTOINCREMENT | 求职机会 ID |
| company_id | INTEGER | NOT NULL 逻辑外键，指向 companies.id | 公司 |
| title | TEXT | NOT NULL | 岗位名称 |
| department | TEXT | 可空 | 部门 |
| location | TEXT | 可空 | 工作地点 |
| source | TEXT | 可空 | 岗位来源 |
| job_url | TEXT | 可空 | 岗位链接 |
| description | TEXT | 可空 | JD 内容 |
| status_id | INTEGER | NOT NULL 逻辑外键，指向 statuses.id | 当前状态 |
| resume_version_id | INTEGER | 可空逻辑外键，指向 resume_versions.id | 使用的简历版本 |
| discovered_at | INTEGER | 可空 | 发现时间 |
| applied_at | INTEGER | 可空 | 投递时间 |
| deadline_at | INTEGER | 可空 | 截止时间 |
| notes | TEXT | 可空 | 备注 |
| created_at | INTEGER | NOT NULL | 创建时间 |
| updated_at | INTEGER | NOT NULL | 更新时间 |

索引：`company_id`、`status_id`、`deadline_at`、`updated_at`。

### calendar_events

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id | INTEGER | PK AUTOINCREMENT | 日程 ID |
| opportunity_id | INTEGER | 可空逻辑外键，指向 opportunities.id | 关联求职机会 |
| title | TEXT | NOT NULL | 日程标题 |
| event_type | TEXT | NOT NULL | 日程类型 |
| start_at | INTEGER | NOT NULL | 开始时间 |
| end_at | INTEGER | NOT NULL | 结束时间 |
| is_all_day | INTEGER | NOT NULL DEFAULT 0 | 是否全天 |
| timezone | TEXT | NOT NULL | 时区 |
| location | TEXT | 可空 | 地点或会议链接 |
| description | TEXT | 可空 | 日程说明 |
| reminder_minutes | INTEGER | 可空 | 提前提醒分钟数 |
| is_completed | INTEGER | NOT NULL DEFAULT 0 | 是否完成 |
| created_at | INTEGER | NOT NULL | 创建时间 |
| updated_at | INTEGER | NOT NULL | 更新时间 |

约束：`end_at >= start_at`。

## 逻辑关联维护策略

- 禁止使用 `REFERENCES`、`ON DELETE` 等 SQLite 物理外键语法。
- `CompanyService` 删除公司前检查是否有求职记录引用；删除成功后同步删除公司别名。
- `IndustryService` 删除行业前检查是否有公司引用。
- `StatusService` 删除状态前检查是否有求职记录引用，并禁止删除最后一个状态。
- `ResumeVersionService` 删除简历前检查是否有求职记录引用，并同步删除内部文件。
- `OpportunityService` 删除求职记录时，将关联日程的 `opportunity_id` 清空。
- 所有新增和更新操作都必须在 service 层校验逻辑外键目标记录存在；renderer 和未来 MCP 不得绕过 service 直接写表。

## Seed 规则

- 首次数据库初始化插入默认状态、内置行业分类和内置公司。
- 使用 `PRAGMA user_version` 判断首次初始化。
- 用户删除内置状态后，后续启动不自动恢复。
- seed 操作必须幂等。
