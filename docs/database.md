# 职迹数据库声明

## 数据库位置

- 开发环境：`<项目根目录>/data/zhiji.db`
- 安装环境：`<JobTrail 安装根目录>/data/zhiji.db`

应用配置不存储在数据库中，而是存储在：

- 开发环境：`<项目根目录>/config.json`
- 安装环境：`<JobTrail 安装根目录>/config.json`

配置文件版本 `configVersion` 为 `1`。

## SQLite 初始化规则

- 使用 `better-sqlite3`。
- `PRAGMA journal_mode = WAL`。
- `PRAGMA busy_timeout = 5000`。
- 禁止创建 SQLite 物理外键；所有跨表关联均为逻辑外键，由业务 service 校验和维护。
- 时间统一使用 UTC Unix 毫秒时间戳。
- 布尔值使用 INTEGER：`0=false`、`1=true`。
- 使用 SQLite 内置 `PRAGMA user_version` 记录结构版本。
- 不创建 `schema_migrations` 表。
- 当前完整结构版本为 `1`。新数据库直接以本文件中的结构初始化，不执行 `ALTER TABLE`、过程性迁移 SQL 或旧数据自动补图。

## 业务表

### statuses

| 字段       | 类型    | 约束               | 说明         |
| ---------- | ------- | ------------------ | ------------ |
| id         | INTEGER | PK AUTOINCREMENT   | 状态 ID      |
| label      | TEXT    | NOT NULL UNIQUE    | 状态名称     |
| sort_order | INTEGER | NOT NULL           | 显示顺序     |
| is_builtin | INTEGER | NOT NULL DEFAULT 0 | 是否内置状态 |
| created_at | INTEGER | NOT NULL           | 创建时间     |
| updated_at | INTEGER | NOT NULL           | 更新时间     |

默认状态：感兴趣、待投递、已投递、初筛、笔试、AI面试、一面、二面、三面、HR面、Offer、淘汰、主动放弃。

状态删除规则：

1. 生产环境内置状态直接返回 `BUILTIN_DATA` 和“该数据为内置，无法删除/修改”，禁止编辑和删除；开发环境放开内置状态的增删改查权限，但仍遵守求职记录及历史引用保护。
2. 查询 `opportunities.status_id` 或 `opportunity_status_events.status_id` 是否引用目标状态。
3. 有引用时返回 `STATUS_IN_USE` 和使用数量，禁止删除。
4. 只有一个状态时返回 `LAST_STATUS`，禁止删除。
5. 未被引用且不是最后一个状态时允许删除。

状态显示顺序通过状态业务服务整体重排 `sort_order`，管理表格不直接展示该内部字段。

### industries

| 字段       | 类型    | 约束               | 说明             |
| ---------- | ------- | ------------------ | ---------------- |
| id         | INTEGER | PK AUTOINCREMENT   | 行业分类 ID      |
| name       | TEXT    | NOT NULL UNIQUE    | 行业名称         |
| sort_order | INTEGER | NOT NULL           | 显示顺序         |
| is_builtin | INTEGER | NOT NULL DEFAULT 0 | 是否内置行业分类 |
| created_at | INTEGER | NOT NULL           | 创建时间         |
| updated_at | INTEGER | NOT NULL           | 更新时间         |

内置行业分类（固定字典，共 83 项）：互联网、游戏、人工智能、软件、芯片、硬件、通信与硬件、电子与硬件、计算机与IT服务、金融、银行、证券与投资、保险、电商与零售、消费品、食品饮料、医疗健康、生物医药、汽车、新能源、制造业、化工与材料、建筑与房地产、家居与物业、物流与供应链、交通运输、航空航天、能源与矿业、电力与公用事业、教育、旅游与酒店、媒体与内容、广告与营销、文化娱乐、专业服务与咨询、法律服务、人力资源、农业与农牧、政府与公共服务、跨境贸易、生活服务、环保与循环经济、其他服务、林业与木材、渔业与水产、烟草、纺织与服装、化妆品与美容、珠宝与奢侈品、批发贸易、医疗器械、互联网安全、云计算与数据服务、物联网、机器人与智能制造、科研与技术服务、检验检测与认证、会计审计与税务、设计与创意、知识产权服务、安保服务、国防军工、轨道交通、港口航运与海洋、邮政与快递、航空服务与机场、核工业、石油与天然气、水务与水处理、餐饮、体育与健身、养老与社会工作、出版与印刷、影视与演艺、宠物与兽医、租赁服务、维修与保养、国际组织、非营利与社会组织、殡葬与生命服务、地质勘查与测绘、气象与海洋观测、招标采购与工程服务。

生产环境内置行业分类禁止编辑和删除；开发环境放开内置行业分类的增删改查权限，但仍遵守被公司使用时的删除保护。自定义行业分类被公司使用时禁止删除。

### companies

| 字段         | 类型    | 约束               | 说明                                   |
| ------------ | ------- | ------------------ | -------------------------------------- |
| id           | INTEGER | PK AUTOINCREMENT   | 公司 ID                                |
| name         | TEXT    | NOT NULL UNIQUE    | 公司名称                               |
| builtin_key  | TEXT    | 可空 UNIQUE        | 内置公司稳定 UUID；用户公司为 NULL     |
| career_url   | TEXT    | 可空               | 招聘官网                               |
| last_read_at | INTEGER | 可空               | 上次点击招聘官网的 UTC Unix 毫秒时间戳 |
| is_favorite  | INTEGER | NOT NULL DEFAULT 0 | 是否收藏                               |
| created_at   | INTEGER | NOT NULL           | 创建时间                               |
| updated_at   | INTEGER | NOT NULL           | 更新时间                               |

不包含 `short_name`、`english_name`、`website`。

行业分类通过 `company_industries` 实现多对多关联。

### company_industries

| 字段        | 类型    | 约束     | 说明                                  |
| ----------- | ------- | -------- | ------------------------------------- |
| company_id  | INTEGER | NOT NULL | 公司 ID，逻辑关联 `companies.id`      |
| industry_id | INTEGER | NOT NULL | 行业分类 ID，逻辑关联 `industries.id` |
| created_at  | INTEGER | NOT NULL | 创建时间                              |

主键：`(company_id, industry_id)`。

索引：`idx_company_industries_industry_id`。

`builtin_key` 非空即为内置公司，公共 DTO 的 `isBuiltin` 由此推导，稳定 key 不向 Renderer 或 MCP 暴露。生产环境内置公司的主体数据禁止编辑和删除；开发环境放开内置公司的增删改查权限，但仍遵守被求职记录引用时的删除保护。`is_favorite` 是用户偏好，在所有环境均允许修改。

公司管理页面点击招聘官网链接时，由 `CompanyService.markRead()` 写入 `last_read_at`。是否已读由界面按 `config.json` 的 `companyReadValidityMonths` 判断：为空或当前时间达到上次已读时间加配置月份数时为“未读”，否则为“已读”。该配置默认值为 3 个月。

公司删除规则：

1. 生产环境中的内置公司直接返回 `BUILTIN_DATA` 和“该数据为内置，无法删除/修改”，禁止删除。
2. 查询 `opportunities.company_id` 是否引用目标公司。
3. 有引用时返回 `COMPANY_IN_USE` 和“当前公司正在被求职记录使用，不能删除”，禁止删除。
4. 未被引用时先删除公司的行业关联和别名，再删除公司记录。

### company_aliases

| 字段       | 类型    | 约束                                 | 说明     |
| ---------- | ------- | ------------------------------------ | -------- |
| id         | INTEGER | PK AUTOINCREMENT                     | 别名 ID  |
| company_id | INTEGER | NOT NULL 逻辑外键，指向 companies.id | 所属公司 |
| alias      | TEXT    | NOT NULL                             | 搜索别名 |
| created_at | INTEGER | NOT NULL                             | 创建时间 |

唯一约束：`UNIQUE(company_id, alias)`。

生产环境内置公司的别名禁止新增、编辑和删除；开发环境允许通过公司编辑接口维护内置公司的别名，并随公司删除一起清理。

### builtin_company_catalog_state

该表固定只有 `id = 1` 一行，与目录公司变更在同一事务提交。

| 字段            | 类型    | 约束                | 说明                  |
| --------------- | ------- | ------------------- | --------------------- |
| id              | INTEGER | PK，CHECK(id = 1)   | 固定值 1              |
| format_version  | INTEGER | NOT NULL            | JSON 格式版本         |
| catalog_version | INTEGER | NOT NULL            | 已应用目录版本        |
| content_sha256  | TEXT    | NOT NULL，长度为 64 | 原始目录 JSON SHA-256 |
| applied_at      | INTEGER | NOT NULL            | 最近应用时间          |

### resume_versions

| 字段          | 类型    | 约束             | 说明                |
| ------------- | ------- | ---------------- | ------------------- |
| id            | INTEGER | PK AUTOINCREMENT | 简历版本 ID         |
| name          | TEXT    | NOT NULL         | 简历版本名称        |
| relative_path | TEXT    | NOT NULL UNIQUE  | UUID 文件名及扩展名 |
| size_bytes    | INTEGER | 可空             | 文件大小            |
| sha256        | TEXT    | 可空             | 文件校验值          |
| note          | TEXT    | 可空             | 备注                |
| sort_order    | INTEGER | NOT NULL         | 显示顺序            |
| created_at    | INTEGER | NOT NULL         | 创建时间            |
| updated_at    | INTEGER | NOT NULL         | 更新时间            |

不包含 `file_name`、`mime_type` 或 `is_active`。`sort_order` 由简历版本 service 统一维护，管理页面通过上下箭头调整顺序，数据库不直接暴露排序字段编辑。文件固定存储在：

- 开发环境：`<项目根目录>/resumes/`
- 安装环境：`<JobTrail 安装根目录>/resumes/`

`relative_path` 示例：`550e8400-e29b-41d4-a716-446655440000.pdf`。

### opportunities

一条记录代表一个公司岗位求职机会。

| 字段              | 类型    | 约束                                  | 说明           |
| ----------------- | ------- | ------------------------------------- | -------------- |
| id                | INTEGER | PK AUTOINCREMENT                      | 求职机会 ID    |
| company_id        | INTEGER | NOT NULL 逻辑外键，指向 companies.id  | 公司           |
| title             | TEXT    | NOT NULL                              | 岗位名称       |
| department        | TEXT    | 可空                                  | 部门           |
| location          | TEXT    | 可空                                  | 工作地点       |
| source            | TEXT    | 可空                                  | 岗位来源       |
| job_url           | TEXT    | 可空                                  | 岗位链接       |
| description       | TEXT    | 可空                                  | JD 内容        |
| status_id         | INTEGER | NOT NULL 逻辑外键，指向 statuses.id   | 当前状态       |
| resume_version_id | INTEGER | 可空逻辑外键，指向 resume_versions.id | 使用的简历版本 |
| discovered_at     | INTEGER | 可空                                  | 发现时间       |
| applied_at        | INTEGER | 可空                                  | 投递时间       |
| deadline_at       | INTEGER | 可空                                  | 截止时间       |
| notes             | TEXT    | 可空                                  | 备注           |
| created_at        | INTEGER | NOT NULL                              | 创建时间       |
| updated_at        | INTEGER | NOT NULL                              | 更新时间       |

索引：`company_id`、`status_id`、`deadline_at`、`updated_at`。

### opportunity_status_events

每行是一个求职记录的实际状态节点，不能通过 UI 手动增删改。状态名称保留写入时的快照，不受之后重命名影响。

| 字段           | 类型    | 约束                                     | 说明                                    |
| -------------- | ------- | ---------------------------------------- | --------------------------------------- |
| id             | INTEGER | PK AUTOINCREMENT                         | 节点 ID                                 |
| opportunity_id | INTEGER | NOT NULL 逻辑外键，指向 opportunities.id | 所属求职记录                            |
| status_id      | INTEGER | NOT NULL 逻辑外键，指向 statuses.id      | 状态 ID                                 |
| status_label   | TEXT    | NOT NULL                                 | 写入时的状态名称                        |
| occurred_at    | INTEGER | NOT NULL                                 | UTC Unix 毫秒；创建或变更的实际写入时间 |
| kind           | TEXT    | NOT NULL，`created`/`changed` 之一       | 创建或状态变更                          |

索引：`(opportunity_id, occurred_at, id)` 用于按时间读取流转图，`status_id` 用于历史引用删除保护。相同时间以节点 ID 决定稳定顺序。新建求职记录写入 `created`，通过编辑或独立状态切换接口改变状态时写入 `changed`；状态未变化不增加节点。

### calendar_events

| 字段             | 类型    | 约束                                | 说明                                                          |
| ---------------- | ------- | ----------------------------------- | ------------------------------------------------------------- |
| id               | INTEGER | PK AUTOINCREMENT                    | 日程 ID                                                       |
| opportunity_id   | INTEGER | 可空逻辑外键，指向 opportunities.id | 关联求职机会                                                  |
| title            | TEXT    | NOT NULL                            | 日程标题                                                      |
| event_type       | TEXT    | NOT NULL                            | 日程类型名称；直接保存所选语言的选项文案并原样显示            |
| start_at         | INTEGER | NOT NULL                            | UTC Unix 毫秒开始时间；全天日程为其时区开始日期的 00:00       |
| end_at           | INTEGER | NOT NULL                            | UTC Unix 毫秒结束时间；全天日程为其时区不包含结束日期的 00:00 |
| is_all_day       | INTEGER | NOT NULL DEFAULT 0                  | 是否全天                                                      |
| timezone         | TEXT    | NOT NULL                            | 有效的 IANA 时区名称，用于日程显示和日期归属                  |
| location         | TEXT    | 可空                                | 地点或会议链接                                                |
| description      | TEXT    | 可空                                | 日程说明                                                      |
| reminder_minutes | INTEGER | 可空，非负                          | 提前提醒分钟数                                                |
| created_at       | INTEGER | NOT NULL                            | 创建时间                                                      |
| updated_at       | INTEGER | NOT NULL                            | 更新时间                                                      |

约束：时间段日程允许 `end_at = start_at` 表示时间点，其他情况 `end_at >= start_at`；全天日程采用半开区间 `[start_at, end_at)`，必须满足 `end_at > start_at`；`reminder_minutes` 为空或为非负整数。

完成状态由当前时间是否达到 `end_at` 自动计算，不存储完成标记，也不提供手动切换入口。已结束的日程不会触发提醒。

索引：`idx_calendar_events_range(start_at, end_at)`。

### calendar_event_reminders

| 字段              | 类型    | 约束                                       | 说明                                               |
| ----------------- | ------- | ------------------------------------------ | -------------------------------------------------- |
| id                | INTEGER | PK AUTOINCREMENT                           | 提醒发送记录 ID                                    |
| calendar_event_id | INTEGER | NOT NULL 逻辑外键，指向 calendar_events.id | 对应日程                                           |
| reminder_at       | INTEGER | NOT NULL                                   | 按日程开始时间和 reminder_minutes 计算出的提醒时间 |
| sent_at           | INTEGER | NOT NULL                                   | 实际发送时间                                       |

唯一约束：`UNIQUE(calendar_event_id, reminder_at)`。不额外创建重复的 `calendar_event_id` 索引。

该表只记录 Windows 本地通知发送结果，不包含邮箱或其他通知渠道。主进程每 5 分钟检查一次，只有日程未完成、`reminder_minutes` 不为空、当前时间已达到 `reminder_at` 且该表不存在对应记录时才发送通知并写入记录。删除日程时由业务 service 同步删除其提醒记录。

## 逻辑关联维护策略

- 禁止使用 `REFERENCES`、`ON DELETE` 等 SQLite 物理外键语法。
- `CompanyService` 删除公司前检查是否有求职记录引用；删除成功后同步删除行业关联和公司别名。
- `IndustryService` 删除行业前检查是否有公司引用。
- `StatusService` 删除状态前检查是否有求职记录当前或历史引用，并禁止删除最后一个状态。
- `ResumeService` 删除简历前检查是否有求职记录引用，并通过工作单元的提交/回滚钩子同步处理内部文件。
- `OpportunityService` 在同一事务写入状态节点；删除求职记录时删除节点，并将关联日程的 `opportunity_id` 清空。
- 所有新增和更新操作都必须在 Service 层校验逻辑外键目标记录存在；Renderer 和 MCP 不得绕过 Service 直接写表。

## Seed 规则

- 首次数据库初始化插入默认状态、内置行业分类、内置公司及目录状态。
- 内置公司以已校验的开发数据库为完整来源，共 559 家；目录保存名称、行业关联、招聘官网和别名，不保存开发数据库中的公司 ID。
- 初始化公司时由 SQLite 自增生成公司 ID，写入公司后按唯一名称查询实际 ID，再以该 ID 写入行业关联和别名。
- `is_favorite` 和 `last_read_at` 是用户偏好，不从开发数据库复制；新数据库中的内置公司分别初始化为未收藏和未读。
- 使用 `PRAGMA user_version` 判断首次初始化。
- seed 数据与 `PRAGMA user_version` 必须在同一事务中提交，避免初始化中断后留下无法识别的半成品数据库。
- 内置状态、内置行业分类和内置公司的主体数据不可删除，因此 seed 只负责首次初始化。
- 生产环境内置状态、内置行业分类和内置公司的主体数据禁止编辑，业务 service 返回 `BUILTIN_DATA`，提示“该数据为内置，无法删除/修改”；开发环境放开增删改查，但仍执行逻辑关联删除保护。显示顺序调整属于用户排序偏好，仍可通过重排接口修改；内置公司的收藏标记属于用户偏好，允许修改。
- 仓库中的 `resource/jobtrail-company-catalog.json` 是首次初始化与 Release 发布共用的唯一全量公司目录；每家公司使用稳定的小写 UUID v4 `builtinKey`。
- 已初始化数据库不得再次执行或合并 seed；应用启动和软件升级均不自动更新公司目录。

## 内置公司目录更新

- 用户只能从设置页主动更新。主进程从固定 GitHub Release `latest/download` 地址获取 manifest 和全量 JSON，校验大小、原始文件 SHA-256、严格格式、目录版本、最低应用版本和数据约束后再同步。
- 同一 key 覆盖名称、招聘官网、行业和别名，同时保留公司 ID、创建时间、收藏、已读时间及所有业务关联。
- 新 key 与用户公司同名时，将原记录转为内置公司并保留其本地身份和业务数据；目录中缺少的旧内置公司保留。
- 名称或 key 冲突、非法行业及任何约束错误会中止整个 `IMMEDIATE` 事务。成功后目录状态与公司数据一并提交。
- 下载数据只保存在内存，不写入配置文件或长期落盘；目录更新能力不通过 MCP 暴露。
