# 职迹 SQLite 数据库（v4）

本文记录当前代码定义的数据库结构与持久化规则。应用表的建表定义位于 `src/main/persistence/schema-v4.ts`，由 `src/main/database.ts` 初始化；业务写入规则由 `src/main/repositories/`、`src/main/services/` 和 `src/main/agent/` 实现。下文逐表列出 30 张应用表及 2 张 LangGraph 按需创建表的字段、类型、约束、用途和存在版本；SQLite 自动管理的内部表（如 `sqlite_sequence`）不作为业务表列出。

数据库 v4 是客户端 v2.0.0 的目标结构，配置版本 1、备份封装版本 1 保持不变。v2.0.0 尚未正式发布期间，DDL、行内 JSON、身份与关联、容量边界及恢复校验语义均直接在 v4 上修正，同步更新测试基线；不为开发中间态新增版本、迁移或兼容分支。正式发布后才冻结 v4，之后的结构或持久化语义变更通过新版本及正式迁移完成。

正式发布后的结构变更、配置迁移、跨版本升级和回滚要求，见 [数据库与配置文件长期维护和升级指南](persistence-upgrade-guide.md)。

## 文件与版本

| 内容     | 开发环境                     | 安装环境                              |
| -------- | ---------------------------- | ------------------------------------- |
| 数据库   | `<项目根目录>/data/zhiji.db` | `<JobTrail 安装根目录>/data/zhiji.db` |
| 配置     | `<项目根目录>/config.json`   | `<JobTrail 安装根目录>/config.json`   |
| 简历文件 | `<项目根目录>/resumes/`      | `<JobTrail 安装根目录>/resumes/`      |
| 聊天附件 | `<项目根目录>/chat-uploads/` | `<JobTrail 安装根目录>/chat-uploads/` |

数据库使用 `better-sqlite3`。连接设置为 `journal_mode=WAL`、`busy_timeout=5000`；运行时可能出现 `zhiji.db-wal` 和 `zhiji.db-shm`。更新前的数据库快照通过 SQLite 在线备份取得，包含已提交的 WAL 内容。`PRAGMA data_version` 仅用于检测其他连接的改动，不是结构版本。

结构版本使用 SQLite 内置 `PRAGMA user_version`，当前为 **4**；配置 `configVersion` 仍为 **1**。客户端自带的目标版本统一定义在 `src/main/persistence/versions.ts`，客户端发布版本不参与数据迁移路径判断。

桌面每次启动先调用 `ensurePersistenceReady`，在业务连接打开前检查版本；正式 v1/v2/v3 数据经过连续白名单 `1 → 2 → 3 → 4` 迁移。迁移在数据库副本中执行，校验后借助恢复日志协调数据库和加密配置替换。中断时恢复两者，失败不重置用户数据。等于目标版本不重复迁移，高于目标或缺少路径时拒绝业务写入。MCP 与 worker 只接受当前结构，不自行迁移。

全新空库直接初始化 v4（30 张应用表、31 个显式索引，其中岗位发现占 10 张表、12 个索引）。v1/v2/v3 建表定义冻结在各自的 `schema-vN.ts`；v2 增加试卷三张表，并扩展聊天事件和用量类型。固定 `MIGRATE_V2_V3` 仅创建两张空地点表和索引，`MIGRATE_V3_V4` 仅创建岗位发现表和索引，均不 seed、不更新目录状态或既有时间字段。迁移保留既有业务数据、试卷、聊天序号、工具问答及 LangGraph checkpoint。非空未知 v0 库不能当作空库初始化。

v4 内部只有一套当前确认的结构。标记为 v4 但缺表、缺列、缺索引、存在额外字段或约束不一致的数据库直接拒绝，不探测并补建，也不兼容开发中间态。`tests/persistence-migrations.test.ts` 核对完整应用 DDL 指纹，覆盖表、字段、约束和显式索引；发布前修正结构时同步更新指纹，正式发布后基线冻结。LangGraph 的 `checkpoints`、`writes` 是按需成对创建的依赖表，不计入上述数量；出现时须完整符合固定定义。

旧备份按其来源版本校验，再在导入临时目录中执行同一迁移链；导入不会修改原备份。新版导出记录数据库版本 4、配置版本 1，备份封装版本仍为 1。配置结构版本、加密封装版本及公司目录版本均独立管理。v2/v3/v4 均执行试卷校验；v3/v4 检查地点文本、关联有效性及无孤立地点；v4 另检查岗位发现身份、结果、浏览视图和观察关联。

配置只接受完整、严格的当前结构，包含 `configVersion`、`themeMode`、`statusFlowTheme`、`locale`、`closeBehavior`、`launchAtStartup`、`companyReadValidityMonths`、`mcp`、`ai`。嵌套字段以 `AppConfig` 为准，所有层级均拒绝缺失或未知字段；不保留 `velopack` 配置。默认值仅在整个配置文件不存在时创建，设置的局部更新须合并为完整配置后保存。无效或不支持的配置保留原文件并拒绝启动，备份导入先按来源配置版本校验，再转换并校验目标版本。

配置 v1 的完整校验规则和新建默认值统一定义在 `src/main/persistence/config-v1.ts`。`ConfigService` 复用这些定义，负责加解密、文件读写和局部设置更新；迁移入口复用同一版本的校验规则。默认值不用于补齐已有配置的缺失字段。数据库各版本的建表定义则由 `persistence/validation.ts` 统一校验，避免在每个 schema 文件内重复实现结构检查。

### 发布前开发库维护

首个正式版发布前，修改建库 SQL 不会自动修改已有的开发库。已有开发库即使 `user_version=1`，也可能保留较早的测试结构；版本号相同不代表实际结构一致。调整表结构时，必须同时核对现有开发库，并在备份后单独维护，不能只验证新建测试库。不得通过重置版本号、重新 seed 或删除数据库来修复缺列。

2026-09-26 已在停止客户端和 MCP、备份数据库及个人文件后，于应用外事务中将开发库对齐到当前结构：重建 20＋97 行业树和 580 家公司的二级关联，更新目录状态与哈希，并清空六张聊天表和聊天附件。公司 ID、稳定标识及其他属性、求职记录、状态历史、日程、简历和配置均已核对保留。一次性维护逻辑未加入仓库或应用启动、构建、发布流程。

正式版发布后的结构变更必须递增数据库版本并提供迁移，不能沿用这种发布前维护方式。

`tests/fixtures/v1/` 固定了首次正式版的合成数据库、配置、简历和聊天附件。`manifest.json` 保存各文件 SHA-256；测试只在临时副本上打开数据，并校验业务记录仍可读取。正式版发布后该样本不得改写，未来迁移应以它作为已发布数据的升级输入。

该样本还包含多轮聊天、完成的工具问答、模型用量和等待用户回答的中断，以及实际 checkpoint 和 writes。行内 JSON 与 LangGraph 序列化语义也是数据库版本的一部分；未来依赖或消息格式升级须验证这些样本，不能只比较 SQL 表结构。

## 数据约定

- 时间字段（`*_at`）按 UTC Unix 毫秒存储；`reminder_minutes` 是分钟数。
- 日程服务、IPC 和 MCP 只接受正数提醒分钟值或 null，不接受 0；现有表的底层非负约束不等于所有非负值都属于有效业务输入。
- 布尔字段按 `INTEGER` 的 0/1 存储，并由数据库约束限制取值。
- 表之间没有 SQLite 物理外键或级联删除定义。下文所说的关联都是逻辑关联，由 Service 层校验、清理或阻止删除。
- 下表的“约束”列描述数据库实际声明的主键、非空、唯一、默认值和检查条件；名称非空、时区有效、ID 存在等更严格的规则由 Service 层验证。
- 原始简历与聊天附件文件保存在文件系统；`resume_versions` 和 `chat_attachments` 表只保存相对路径、大小、哈希等元数据。配置和 API 密钥不存入这些应用表。
- 设置页完整备份通过 SQLite 在线快照包含全部业务表及 LangGraph checkpoint 表。导出与导入复用快照结构、完整性和文件引用校验；源数据不受支持或文件缺失时，导出失败且保留原有备份。导入在隔离目录验证，重启时整套替换数据库、配置、简历与聊天附件，不合并数据库。
- 简历删除先将文件移到 `resumes/.trash/`，再提交数据库删除；下次启动时，若数据库仍引用该文件则恢复原路径，否则完成清理。恢复时持有数据库写锁，避免与其他进程正在执行的删除相互干扰。更新冻结期间暂缓恢复。

## 应用表结构

### 表与版本总览

这里的 v1、v2、v3、v4 指数据库 `PRAGMA user_version`，不是客户端版本。每张表下的字段表格描述当前 v4 定义；历史约束变化在对应表下说明。`✓` 表示该版本包含此应用表，`按需` 表示使用 LangGraph 时成对创建，`—` 表示该版本没有此表。

| 表                              | v1     | v2     | v3     | v4     |
| ------------------------------- | ------ | ------ | ------ | ------ |
| `statuses`                      | ✓      | ✓      | ✓      | ✓      |
| `industries`                    | ✓      | ✓      | ✓      | ✓      |
| `companies`                     | ✓      | ✓      | ✓      | ✓      |
| `builtin_company_catalog_state` | ✓      | ✓      | ✓      | ✓      |
| `company_industries`            | ✓      | ✓      | ✓      | ✓      |
| `company_aliases`               | ✓      | ✓      | ✓      | ✓      |
| `resume_versions`               | ✓      | ✓      | ✓      | ✓      |
| `opportunities`                 | ✓      | ✓      | ✓      | ✓      |
| `opportunity_status_events`     | ✓      | ✓      | ✓      | ✓      |
| `calendar_events`               | ✓      | ✓      | ✓      | ✓      |
| `calendar_event_reminders`      | ✓      | ✓      | ✓      | ✓      |
| `agent_conversations`           | ✓      | ✓      | ✓      | ✓      |
| `agent_chat_events`             | ✓      | ✓      | ✓      | ✓      |
| `agent_model_usage`             | ✓      | ✓      | ✓      | ✓      |
| `chat_attachments`              | ✓      | ✓      | ✓      | ✓      |
| `exam_papers`                   | —      | ✓      | ✓      | ✓      |
| `exam_questions`                | —      | ✓      | ✓      | ✓      |
| `exam_answers`                  | —      | ✓      | ✓      | ✓      |
| `locations`                     | —      | —      | ✓      | ✓      |
| `company_locations`             | —      | —      | ✓      | ✓      |
| `discovery_jobs`                | —      | —      | —      | ✓      |
| `discovery_observations`        | —      | —      | —      | ✓      |
| `discovery_runs`                | —      | —      | —      | ✓      |
| `discovery_requests`            | —      | —      | —      | ✓      |
| `discovery_sources`             | —      | —      | —      | ✓      |
| `discovery_results`             | —      | —      | —      | ✓      |
| `discovery_views`               | —      | —      | —      | ✓      |
| `discovery_view_items`          | —      | —      | —      | ✓      |
| `discovery_platforms`           | —      | —      | —      | ✓      |
| `discovery_saved`               | —      | —      | —      | ✓      |
| **应用表数量**                  | **15** | **18** | **20** | **30** |
| `checkpoints`                   | 按需   | 按需   | 按需   | 按需   |
| `writes`                        | 按需   | 按需   | 按需   | 按需   |

以下每张表均单独标明存在版本。未特别说明的表，从引入版本到 v4 的字段和 SQL 约束保持一致。

### 状态与行业

`statuses` 保存求职状态，以 `is_builtin` 标记内置数据；`industries` 保存固定两级的行业树，以 `builtin_key` 是否为空推导内置属性。两表均使用 `sort_order` 表示显示顺序，行业顺序限定在同级内。

#### `statuses`

存在版本：**v1、v2、v3、v4**（v1 引入）。

| 字段         | 类型    | 约束                 | 说明     |
| ------------ | ------- | -------------------- | -------- |
| `id`         | INTEGER | 主键、自增           | 状态 ID  |
| `label`      | TEXT    | 非空、唯一           | 状态名称 |
| `sort_order` | INTEGER | 非空                 | 显示顺序 |
| `is_builtin` | INTEGER | 非空、默认 0、仅 0/1 | 是否内置 |
| `created_at` | INTEGER | 非空                 | 创建时间 |
| `updated_at` | INTEGER | 非空                 | 更新时间 |

#### `industries`

存在版本：**v1、v2、v3、v4**（v1 引入）。

| 字段          | 类型    | 约束                               | 说明                                       |
| ------------- | ------- | ---------------------------------- | ------------------------------------------ |
| `id`          | INTEGER | 主键、自增                         | 本地行业 ID，与目录 UUID 无关              |
| `name`        | TEXT    | 非空、同级唯一                     | 行业名称，不同分组允许同名                 |
| `parent_id`   | INTEGER | 可空，非空时大于 0 且不等于自身 ID | 一级为空；二级引用一级                     |
| `builtin_key` | TEXT    | 可空、唯一                         | 内置行业稳定的小写 UUID v4；自定义二级为空 |
| `sort_order`  | INTEGER | 非空                               | 同级显示顺序，从 0 开始                    |
| `created_at`  | INTEGER | 非空                               | 创建时间                                   |
| `updated_at`  | INTEGER | 非空                               | 更新时间                                   |

表级约束要求 `parent_id` 与 `builtin_key` 至少一个非空，禁止自定义一级。一级名称唯一及同一父节点下的二级名称唯一由两个部分唯一索引保证；父节点存在且为一级、禁止第三层和层级转换由业务服务验证，不保存层级字段，也不建立物理外键。

内置状态在生产环境允许编辑名称，也允许在未被求职记录当前状态或历史节点使用时删除；内置行业在安装版仅允许排序，开发环境允许改名和删除，二级还可移动到其他一级。自定义二级在两种环境均可增删改。一级有子节点不能删除；二级被公司引用不能删除。状态被求职记录当前状态或历史节点使用时不能删除，且至少保留一个状态。

行业重排接口为 `{ parentId, order }`：`parentId=null` 表示一级，否则必须是一级 ID；`order` 必须包含该组所有节点且不能重复。移动二级时追加到目标分组末尾，并整理原组顺序。行业管理页用可展开、收起的树形表格，不分页。

### 公司与内置目录

`companies.builtin_key` 非空表示内置公司，是目录中稳定的小写 UUID v4；普通用户公司为 `NULL`。公司 ID 是本地自增 ID，不是目录身份。公司只能关联二级行业；自定义公司允许无行业，内置公司至少关联一个二级。公司筛选允许选择一级以汇总其全部二级，通过 `EXISTS` 查询保证总数和分页不重复。`is_favorite` 和 `last_read_at` 是用户偏好。行业关联和别名分别存入 `company_industries`、`company_aliases`。

#### `companies`

存在版本：**v1、v2、v3、v4**（v1 引入）。

| 字段           | 类型    | 约束                 | 说明                                |
| -------------- | ------- | -------------------- | ----------------------------------- |
| `id`           | INTEGER | 主键、自增           | 本地公司 ID                         |
| `name`         | TEXT    | 非空、唯一           | 公司名称                            |
| `builtin_key`  | TEXT    | 可空、唯一           | 内置公司的稳定身份；用户公司为 NULL |
| `career_url`   | TEXT    | 可空                 | 招聘官网链接                        |
| `last_read_at` | INTEGER | 可空                 | 上次打开招聘链接的时间              |
| `is_favorite`  | INTEGER | 非空、默认 0、仅 0/1 | 是否收藏                            |
| `created_at`   | INTEGER | 非空                 | 创建时间                            |
| `updated_at`   | INTEGER | 非空                 | 更新时间                            |

#### `builtin_company_catalog_state`

存在版本：**v1、v2、v3、v4**（v1 引入）。

| 字段              | 类型    | 约束            | 说明                     |
| ----------------- | ------- | --------------- | ------------------------ |
| `id`              | INTEGER | 主键、必须为 1  | 固定单行标识             |
| `format_version`  | INTEGER | 非空            | 目录 JSON 格式版本       |
| `catalog_version` | INTEGER | 非空            | 已应用的目录内容版本     |
| `content_sha256`  | TEXT    | 非空、长度为 64 | 原始目录 JSON 的 SHA-256 |
| `applied_at`      | INTEGER | 非空            | 最近应用时间             |

#### `company_industries`

存在版本：**v1、v2、v3、v4**（v1 引入）。

| 字段          | 类型    | 约束                            | 说明         |
| ------------- | ------- | ------------------------------- | ------------ |
| `company_id`  | INTEGER | 非空；与 `industry_id` 联合主键 | 公司 ID      |
| `industry_id` | INTEGER | 非空；与 `company_id` 联合主键  | 行业 ID      |
| `created_at`  | INTEGER | 非空                            | 关联创建时间 |

#### `company_aliases`

存在版本：**v1、v2、v3、v4**（v1 引入）。

| 字段         | 类型    | 约束                           | 说明        |
| ------------ | ------- | ------------------------------ | ----------- |
| `id`         | INTEGER | 主键、自增                     | 别名 ID     |
| `company_id` | INTEGER | 非空；与 `alias` 联合唯一      | 所属公司 ID |
| `alias`      | TEXT    | 非空；与 `company_id` 联合唯一 | 搜索别名    |
| `created_at` | INTEGER | 非空                           | 创建时间    |

`builtin_company_catalog_state` 固定使用 `id=1`，记录已应用目录的格式版本、内容版本、原始 JSON 的 SHA-256 和应用时间。目录版本变化是数据内容更新，不递增数据库 `user_version`。公司被求职记录引用时不能删除；删除公司时同步清除行业关联和别名。生产环境禁止编辑或删除内置公司的主体数据，但允许调整收藏和记录招聘链接的访问时间。

#### `locations`

存在版本：**v3、v4**（v3 引入）。

| 字段         | 类型    | 约束                         | 说明                |
| ------------ | ------- | ---------------------------- | ------------------- |
| `id`         | INTEGER | 主键、自增                   | 地点 ID，仅内部使用 |
| `name`       | TEXT    | 非空、原文精确唯一（BINARY） | 规范化地点标签      |
| `created_at` | INTEGER | 非空                         | 创建时间            |

#### `company_locations`

存在版本：**v3、v4**（v3 引入）。

| 字段          | 类型    | 约束                            | 说明         |
| ------------- | ------- | ------------------------------- | ------------ |
| `company_id`  | INTEGER | 非空；与 `location_id` 联合主键 | 关联公司 ID  |
| `location_id` | INTEGER | 非空；与 `company_id` 联合主键  | 关联地点 ID  |
| `created_at`  | INTEGER | 非空                            | 关联创建时间 |

显式索引 `idx_locations_search ON locations(name COLLATE NOCASE)` 支持候选前缀查询；`idx_company_locations_location ON company_locations(location_id, company_id)` 支持筛选及剩余引用检查。公司维度查询使用联合主键索引。无触发器、物理外键或引用计数。

地点标签 trim 后精确去重，每家公司最多 100 项、每项最多 200 字符，拒绝空白、非字符串和 null。公司与岗位地点独立。新增可省略；更新省略表示保留，`[]` 表示清空。共享地点 Repository 只增删本公司的关联，不重命名公共地点；删除公司先通过既有保护，再解除关联，仅删除本次受影响且 `NOT EXISTS` 剩余引用的地点。公司 Service 的 `UnitOfWork` 保证所有变化在一个 `IMMEDIATE` 事务内完成；目录批量操作最后统一清理。

`CompanySummary` 保留旧公司字段，用于公司选择器和智能体引用，摘要 SQL 不访问地点表。`Company` 在摘要基础上增加 `locations: string[]`，只为当前分页或目标公司批量读取。`CompanyQuery.locations` 使用完整标签精确筛选，多个地点为 OR，与关键词、行业为 AND，通过参数化 `EXISTS` 避免重复公司。

`companies:search-locations` / Preload `searchLocations({ prefix?, page, pageSize })` 返回 `PageResult<string>`。后端每页上限 100，UI 每页 50、展开加载、滚动翻页、200 毫秒防抖。前缀采用 SQLite LIKE（ASCII 大小写不敏感），转义 `%`、`_`、`\` 后仅在末尾加通配符；稳定排序 `name COLLATE NOCASE, id`。编辑可创建草稿标签，筛选只选择已有标签。候选缓存随公司写入、目录同步和外部变化失效，保留选择及编辑草稿；已删除标签的筛选值仍生效，不自动放宽。MCP 既有公司工具同步支持地点字段，不提供字典维护工具。

### 简历、求职记录与状态历史

`resume_versions.relative_path` 指向 `resumes/` 中的 UUID 文件名；`size_bytes` 和 `sha256` 允许为空。`opportunities.status_id` 保存当前状态；`opportunity_status_events` 保存实际发生的创建或变更节点，`status_label` 是写入当时的状态名称快照。

#### `resume_versions`

存在版本：**v1、v2、v3、v4**（v1 引入）。

| 字段            | 类型    | 约束       | 说明                  |
| --------------- | ------- | ---------- | --------------------- |
| `id`            | INTEGER | 主键、自增 | 简历版本 ID           |
| `name`          | TEXT    | 非空       | 简历名称              |
| `relative_path` | TEXT    | 非空、唯一 | `resumes/` 内的文件名 |
| `size_bytes`    | INTEGER | 可空       | 文件大小              |
| `sha256`        | TEXT    | 可空       | 文件哈希              |
| `note`          | TEXT    | 可空       | 备注                  |
| `sort_order`    | INTEGER | 非空       | 显示顺序              |
| `created_at`    | INTEGER | 非空       | 创建时间              |
| `updated_at`    | INTEGER | 非空       | 更新时间              |

#### `opportunities`

存在版本：**v1、v2、v3、v4**（v1 引入）。

| 字段                | 类型    | 约束       | 说明              |
| ------------------- | ------- | ---------- | ----------------- |
| `id`                | INTEGER | 主键、自增 | 求职记录 ID       |
| `company_id`        | INTEGER | 非空       | 公司 ID           |
| `title`             | TEXT    | 非空       | 岗位名称          |
| `department`        | TEXT    | 可空       | 部门              |
| `location`          | TEXT    | 可空       | 工作地点          |
| `source`            | TEXT    | 可空       | 岗位来源          |
| `job_url`           | TEXT    | 可空       | 岗位链接          |
| `description`       | TEXT    | 可空       | 岗位描述          |
| `status_id`         | INTEGER | 非空       | 当前状态 ID       |
| `resume_version_id` | INTEGER | 可空       | 使用的简历版本 ID |
| `discovered_at`     | INTEGER | 可空       | 发现时间          |
| `applied_at`        | INTEGER | 可空       | 投递时间          |
| `deadline_at`       | INTEGER | 可空       | 截止时间          |
| `notes`             | TEXT    | 可空       | 备注              |
| `created_at`        | INTEGER | 非空       | 创建时间          |
| `updated_at`        | INTEGER | 非空       | 更新时间          |

#### `opportunity_status_events`

存在版本：**v1、v2、v3、v4**（v1 引入）。

| 字段             | 类型    | 约束                         | 说明                 |
| ---------------- | ------- | ---------------------------- | -------------------- |
| `id`             | INTEGER | 主键、自增                   | 状态节点 ID          |
| `opportunity_id` | INTEGER | 非空                         | 所属求职记录 ID      |
| `status_id`      | INTEGER | 非空                         | 状态 ID              |
| `status_label`   | TEXT    | 非空                         | 写入时的状态名称快照 |
| `occurred_at`    | INTEGER | 非空                         | 节点发生时间         |
| `kind`           | TEXT    | 非空、仅 `created`/`changed` | 创建或状态变更       |

创建求职记录时，Service 在同一事务写入 `created` 节点；状态确实变化时写入 `changed` 节点，状态未变不追加。读取历史时按 `occurred_at, id` 排序；重新打开数据库不会为缺失的历史节点补造记录。删除求职记录时删除其状态节点，并将关联日程的 `opportunity_id` 置空。被求职记录引用的简历不能删除；简历文件删除配合数据库事务的提交和回滚钩子处理。

### 日程与提醒

`calendar_events.opportunity_id` 可空。`event_type` 保存所选类型的文本，数据库未限制其枚举值。`timezone` 保存时区名称；`is_all_day` 控制全天语义。提醒记录按日程和计算出的提醒时间去重。

#### `calendar_events`

存在版本：**v1、v2、v3、v4**（v1 引入）。

| 字段               | 类型    | 约束                      | 说明                     |
| ------------------ | ------- | ------------------------- | ------------------------ |
| `id`               | INTEGER | 主键、自增                | 日程 ID                  |
| `opportunity_id`   | INTEGER | 可空                      | 关联的求职记录 ID        |
| `title`            | TEXT    | 非空                      | 日程标题                 |
| `event_type`       | TEXT    | 非空                      | 日程类型文本             |
| `start_at`         | INTEGER | 非空                      | 开始时间                 |
| `end_at`           | INTEGER | 非空、不得早于 `start_at` | 结束时间                 |
| `is_all_day`       | INTEGER | 非空、默认 0、仅 0/1      | 是否全天                 |
| `timezone`         | TEXT    | 非空                      | 显示和日期归属使用的时区 |
| `location`         | TEXT    | 可空                      | 地点或会议链接           |
| `description`      | TEXT    | 可空                      | 日程说明                 |
| `reminder_minutes` | INTEGER | 可空；非空时不得小于 0    | 提前提醒分钟数           |
| `created_at`       | INTEGER | 非空                      | 创建时间                 |
| `updated_at`       | INTEGER | 非空                      | 更新时间                 |

#### `calendar_event_reminders`

存在版本：**v1、v2、v3、v4**（v1 引入）。

| 字段                | 类型    | 约束                                  | 说明             |
| ------------------- | ------- | ------------------------------------- | ---------------- |
| `id`                | INTEGER | 主键、自增                            | 提醒记录 ID      |
| `calendar_event_id` | INTEGER | 非空；与 `reminder_at` 联合唯一       | 所属日程 ID      |
| `reminder_at`       | INTEGER | 非空；与 `calendar_event_id` 联合唯一 | 计算出的提醒时间 |
| `sent_at`           | INTEGER | 非空                                  | 实际发送时间     |

Service 验证时区和时间范围：普通日程允许 `end_at=start_at` 表示时间点；全天日程使用当地日期的半开区间 `[start_at, end_at)`，要求结束日期晚于开始日期。日程是否完成由当前时间与 `end_at` 计算，不保存完成标记。提醒查询要求提醒时间已到、日程尚未结束且相同 `(calendar_event_id, reminder_at)` 尚未发送；删除日程时同步删除提醒记录。

### 智能体会话

应用保存会话索引、完整展示事件、模型用量和附件元数据。`agent_chat_events.payload` 是结构化 JSON 文本，`seq` 决定展示顺序，`id` 用于幂等归档。`agent_model_usage` 中 token 数可空，表示模型端点没有提供该项；会话累计值只加总已报告的数值。附件文件位于 `chat-uploads/`，`relative_path` 唯一。

#### `agent_conversations`

存在版本：**v1、v2、v3、v4**（v1 引入）。

| 字段                | 类型    | 约束                 | 说明                              |
| ------------------- | ------- | -------------------- | --------------------------------- |
| `id`                | TEXT    | 主键                 | 会话 ID，也是 LangGraph thread ID |
| `title`             | TEXT    | 非空                 | 会话标题                          |
| `title_finalized`   | INTEGER | 非空、默认 0、仅 0/1 | 标题是否定稿                      |
| `deleting`          | INTEGER | 非空、默认 0、仅 0/1 | 会话删除待清理标记                |
| `input_tokens`      | INTEGER | 非空、默认 0         | 已报告的输入 token 累计           |
| `output_tokens`     | INTEGER | 非空、默认 0         | 已报告的输出 token 累计           |
| `cache_read_tokens` | INTEGER | 非空、默认 0         | 已报告的缓存命中 token 累计       |
| `created_at`        | INTEGER | 非空                 | 创建时间                          |
| `updated_at`        | INTEGER | 非空                 | 最近更新时间                      |

#### `agent_chat_events`

存在版本：**v1、v2、v3、v4**（v1 引入）。v1 的 `kind` 仅允许 `user`、`assistant`、`tool`、`compact`；v2 增加 `exam-paper`，v3/v4 沿用 v2 约束。字段集合未变。

| 字段              | 类型    | 约束                                                      | 说明            |
| ----------------- | ------- | --------------------------------------------------------- | --------------- |
| `seq`             | INTEGER | 主键、自增                                                | 展示顺序        |
| `id`              | TEXT    | 非空、唯一                                                | 幂等事件 ID     |
| `conversation_id` | TEXT    | 非空                                                      | 所属会话 ID     |
| `kind`            | TEXT    | 非空、仅 `user`/`assistant`/`tool`/`compact`/`exam-paper` | 展示事件类型    |
| `payload`         | TEXT    | 非空                                                      | 结构化事件 JSON |
| `created_at`      | INTEGER | 非空                                                      | 归档时间        |

#### `agent_model_usage`

存在版本：**v1、v2、v3、v4**（v1 引入）。v1 的 `kind` 仅允许 `agent`、`compact`；v2 增加 `grade`，v3/v4 沿用 v2 约束。字段集合未变。

| 字段                | 类型    | 约束                               | 说明                     |
| ------------------- | ------- | ---------------------------------- | ------------------------ |
| `id`                | TEXT    | 主键                               | 模型调用的幂等记录 ID    |
| `conversation_id`   | TEXT    | 非空                               | 所属会话 ID              |
| `kind`              | TEXT    | 非空、仅 `agent`/`compact`/`grade` | 普通回复、压缩或判题调用 |
| `input_tokens`      | INTEGER | 可空                               | 模型报告的输入 token     |
| `output_tokens`     | INTEGER | 可空                               | 模型报告的输出 token     |
| `cache_read_tokens` | INTEGER | 可空                               | 模型报告的缓存命中 token |
| `created_at`        | INTEGER | 非空                               | 调用记录时间             |

#### `chat_attachments`

存在版本：**v1、v2、v3、v4**（v1 引入）。

| 字段              | 类型    | 约束                 | 说明                       |
| ----------------- | ------- | -------------------- | -------------------------- |
| `id`              | TEXT    | 主键                 | 附件 ID                    |
| `conversation_id` | TEXT    | 非空                 | 所属会话 ID                |
| `deleting`        | INTEGER | 非空、默认 0、仅 0/1 | 附件删除待清理标记         |
| `original_name`   | TEXT    | 非空                 | 原始文件名                 |
| `relative_path`   | TEXT    | 非空、唯一           | `chat-uploads/` 内的文件名 |
| `mime_type`       | TEXT    | 非空                 | 已校验的内容类型           |
| `size_bytes`      | INTEGER | 非空                 | 文件大小                   |
| `sha256`          | TEXT    | 非空                 | 文件哈希                   |
| `created_at`      | INTEGER | 非空                 | 上传时间                   |

会话 `id` 同时作为 LangGraph thread ID。LangGraph `SqliteSaver` 在同一个 SQLite 文件中维护自己的 checkpoint 数据；图状态保存工作记忆与摘要，`agent_chat_events` 独立保存展示历史。删除会话时先将 `deleting` 持久化并从列表隐藏，再清理 checkpoint thread、归档事件、用量记录、附件元数据和附件文件；中断后在下次启动继续。单个附件删除也先标记、后清理。用户消息中的简历、求职记录及技能引用在归档事件和图消息元数据中保留结构化片段；界面标签按当前语言生成。

### 笔试练习

以下表与聊天通过逻辑关联连接，由 `ExamService` 校验、事务写入及清理，无物理外键。题目正文和作答均使用结构化 JSON。公开接口运行时进行题型校验，备份与迁移同时校验题型 JSON、题号、题量及关联。

#### `exam_papers`

存在版本：**v2、v3、v4**（v2 引入）。

| 字段              | 类型    | 约束                                            | 说明                         |
| ----------------- | ------- | ----------------------------------------------- | ---------------------------- |
| `id`              | TEXT    | 主键                                            | 试卷 UUID                    |
| `conversation_id` | TEXT    | 非空                                            | 所属聊天 ID                  |
| `request_id`      | TEXT    | 非空、唯一                                      | 创建幂等标识                 |
| `task_id`         | TEXT    | 非空                                            | 创建任务标识                 |
| `title`           | TEXT    | 非空                                            | 试卷标题                     |
| `topic`           | TEXT    | 非空                                            | 出题方向                     |
| `difficulty`      | TEXT    | 非空                                            | 难度                         |
| `counts`          | TEXT    | 非空                                            | 各题型约定数量的 JSON        |
| `status`          | TEXT    | 非空；仅 `generating`/`completed`/`interrupted` | 生成状态                     |
| `reset_version`   | INTEGER | 非空、默认 0                                    | 每次重置递增，拒绝旧作答请求 |
| `revision`        | INTEGER | 非空、默认 0                                    | 变更版本，供界面合并         |
| `created_at`      | INTEGER | 非空                                            | 创建时间                     |
| `updated_at`      | INTEGER | 非空                                            | 更新时间                     |

索引：`idx_exam_papers_conversation(conversation_id, created_at)`。

MCP `update_exam_paper` 可按需更新 `topic`、`difficulty`、`counts`，至少传入一项；`counts` 提供三类题型的完整目标数量，总数大于零且每类不少于已生成数量。更新在事务中校验聊天归属并递增 `revision`，重复相同设置不写入。修改保留题目、作答及已有评分；新题与新判题使用新设置，进行中的判题使用请求发起时的背景。修改题量后若已有题数恰好满足目标，状态变为 completed；已完成卷增加题量后变为 interrupted，下一题追加时恢复 generating，继续使用原卡片。此操作不改变数据库结构版本。

#### `exam_questions`

存在版本：**v2、v3、v4**（v2 引入）。

| 字段         | 类型    | 约束                         | 说明                          |
| ------------ | ------- | ---------------------------- | ----------------------------- |
| `id`         | TEXT    | 主键                         | 题目 UUID                     |
| `paper_id`   | TEXT    | 非空；与 `position` 联合唯一 | 所属试卷 ID                   |
| `request_id` | TEXT    | 非空、唯一                   | 追加幂等标识                  |
| `position`   | INTEGER | 非空；与 `paper_id` 联合唯一 | 业务要求从 1 开始的连续题号   |
| `content`    | TEXT    | 非空                         | 题型、题干及题型特有字段 JSON |

`single_choice` 固定四个选项、A–D 唯一答案及解析；`true_false` 保存布尔答案及解析；`short_answer` 仅保存题干。首题插入与聊天 `exam-paper` 卡片事件在同一事务中完成，卡片 payload 只引用 `paperId`。

#### `exam_answers`

存在版本：**v2、v3、v4**（v2 引入）。

| 字段               | 类型    | 约束                                                                              | 说明                                      |
| ------------------ | ------- | --------------------------------------------------------------------------------- | ----------------------------------------- |
| `question_id`      | TEXT    | 主键                                                                              | 所属题目 ID，每题仅保留最新作答           |
| `paper_id`         | TEXT    | 非空                                                                              | 所属试卷 ID                               |
| `value`            | TEXT    | 非空                                                                              | 字符串、布尔值或 null 的 JSON             |
| `version`          | INTEGER | 非空、默认 0                                                                      | 答案修改版本                              |
| `submitted`        | INTEGER | 非空、默认 0、仅 0/1                                                              | 是否有有效提交结果                        |
| `result`           | TEXT    | 可空                                                                              | 客观题判定或简答评分、评价、参考答案 JSON |
| `grade_request_id` | TEXT    | 可空                                                                              | 当前判题请求 UUID                         |
| `grade_status`     | TEXT    | 非空、默认 `idle`；仅 `idle`/`queued`/`running`/`completed`/`error`/`interrupted` | 判题状态                                  |
| `updated_at`       | INTEGER | 非空                                                                              | 更新时间                                  |

索引：`idx_exam_answers_paper(paper_id)`。修改答案清除原结果并使旧请求失效；重置删除本卷全部作答并递增 `reset_version`。判题结果只在请求 ID、答案版本、重置版本均匹配时写回。旧请求实际产生的用量仍幂等记入 `agent_model_usage(kind='grade')`，不改变聊天上下文估算。

删除聊天时先清理试卷关联数据。启动恢复将遗留生成任务、排队和运行中的判题标记为中断，不自动重新请求模型。完整备份包含试卷、题目、未提交文字、作答、评分和用量；恢复后执行同样的任务中断恢复。

### 岗位发现

v4 直接定义 v2.0.0 的目标结构。仅保留正式 v1/v2/v3 到 v4 的升级链，不提供开发中间结构的启动修补或兼容字段。版本化 DDL 中的平台、状态和容量边界显式定义，不从运行时注册表动态生成；发布前直接修正 v4，正式发布后新增平台或修改约束须通过新版本及正式迁移。所有文本主键显式 NOT NULL；引用由 Service 事务和恢复校验维护，不使用物理外键或触发器。

下面的“平台枚举”固定为 `boss`、`liepin`、`zhilian`、`wuyou`；“正整数”和“非负整数”均由 `CHECK` 同时检查 SQLite 存储类型 `typeof(字段)='integer'` 及数值范围。未列默认值的字段没有 SQL 默认值。

#### `discovery_jobs`

存在版本：**v4**（v4 引入）。保存平台内唯一的岗位身份及当前观察引用。

| 字段                     | 类型    | 约束                                     | 说明                               |
| ------------------------ | ------- | ---------------------------------------- | ---------------------------------- |
| `id`                     | TEXT    | 主键、非空                               | 平台与岗位身份计算的 SHA-256 标识  |
| `platform`               | TEXT    | 非空；平台枚举；与 `identity` 联合唯一   | 来源平台                           |
| `identity`               | TEXT    | 非空、长度大于 0；与 `platform` 联合唯一 | 平台岗位 ID 或规范 URL 推导的身份  |
| `url`                    | TEXT    | 非空                                     | 规范岗位 URL                       |
| `created_at`             | INTEGER | 非空；非负整数                           | 首次入库时间                       |
| `current_observation_id` | INTEGER | 非空；正整数                             | 当前 `discovery_observations.id`   |
| `duplicate_fingerprint`  | TEXT    | 可空                                     | 跨平台疑似重复指纹；字段不足时为空 |

#### `discovery_observations`

存在版本：**v4**（v4 引入）。保存不可变的岗位观察快照。

| 字段          | 类型    | 约束                                       | 说明                                           |
| ------------- | ------- | ------------------------------------------ | ---------------------------------------------- |
| `id`          | INTEGER | 主键、自增                                 | 观察 ID                                        |
| `job_id`      | TEXT    | 非空                                       | 所属 `discovery_jobs.id`                       |
| `payload`     | TEXT    | 非空；有效 JSON；UTF-8 字节数不超过 131072 | 原始与标准化字段、字段来源、缺失原因及读取时间 |
| `observed_at` | INTEGER | 非空；非负整数                             | 观察时间，与 payload 的 `readAt` 一致          |

#### `discovery_runs`

存在版本：**v4**（v4 引入）。保存搜索条件、任务状态和搜索历史。

| 字段         | 类型    | 约束                                                                        | 说明                                |
| ------------ | ------- | --------------------------------------------------------------------------- | ----------------------------------- |
| `id`         | TEXT    | 主键、非空                                                                  | 搜索任务 UUID                       |
| `request_id` | TEXT    | 非空、唯一、长度大于 0                                                      | 创建任务时的原始幂等请求 ID         |
| `query`      | TEXT    | 非空；有效 JSON                                                             | 已规范化的完整查询条件，包含 `city` |
| `state`      | TEXT    | 非空；仅 `queued`/`running`/`completed`/`partial`/`cancelled`/`interrupted` | 整体任务状态                        |
| `created_at` | INTEGER | 非空；非负整数                                                              | 创建时间                            |
| `updated_at` | INTEGER | 非空；非负整数；不得早于 `created_at`                                       | 更新时间                            |

#### `discovery_requests`

存在版本：**v4**（v4 引入）。保存请求到任务的权威幂等映射，允许同查询的在途请求合并到一个任务。

| 字段         | 类型 | 约束                   | 说明                                                   |
| ------------ | ---- | ---------------------- | ------------------------------------------------------ |
| `request_id` | TEXT | 主键、非空、长度大于 0 | 幂等请求 ID                                            |
| `run_id`     | TEXT | 非空                   | 对应 `discovery_runs.id`；任务原始请求必须映射回该任务 |

#### `discovery_sources`

存在版本：**v4**（v4 引入）。保存每个搜索任务的各平台进度与统计。

| 字段               | 类型    | 约束                                 | 说明                                           |
| ------------------ | ------- | ------------------------------------ | ---------------------------------------------- |
| `run_id`           | TEXT    | 非空；与 `platform` 联合主键         | 所属搜索任务 ID                                |
| `platform`         | TEXT    | 非空；平台枚举；与 `run_id` 联合主键 | 来源平台                                       |
| `state`            | TEXT    | 非空；来源状态枚举，见下文           | 当前来源状态                                   |
| `count`            | INTEGER | 非空；非负整数                       | 当前已保存的独立结果数                         |
| `batches`          | INTEGER | 非空；非负整数                       | 已提交的批次数                                 |
| `source_page`      | INTEGER | 非空；非负整数                       | 已提交的来源页码                               |
| `raw_count`        | INTEGER | 非空；非负整数                       | 累计源响应条目数                               |
| `valid_count`      | INTEGER | 非空；非负整数                       | 城市、薪资过滤前且批内去重后的可解析候选累计数 |
| `duplicate_count`  | INTEGER | 非空；非负整数                       | 批内及当前采集上下文中的跨批重复数             |
| `rejected_count`   | INTEGER | 非空；非负整数                       | 逐条解析失败而跳过的数量                       |
| `excluded_range`   | INTEGER | 非空；非负整数                       | 不符合薪资区间的数量                           |
| `excluded_day`     | INTEGER | 非空；非负整数                       | 因日薪不可比较而排除的数量                     |
| `excluded_hour`    | INTEGER | 非空；非负整数                       | 因时薪不可比较而排除的数量                     |
| `excluded_foreign` | INTEGER | 非空；非负整数                       | 因外币薪资不可比较而排除的数量                 |
| `excluded_unknown` | INTEGER | 非空；非负整数                       | 因薪资无法解析或比较而排除的数量               |
| `generation`       | INTEGER | 非空；非负整数                       | 采集使用的平台会话代次                         |
| `cursor`           | TEXT    | 可空                                 | 平台适配器的续查游标                           |
| `remote`           | TEXT    | 非空；有效 JSON                      | 实际远程关键词、城市与城市代码                 |
| `message`          | TEXT    | 非空                                 | 固定错误或状态原因；无原因时为空字符串         |
| `cached_at`        | INTEGER | 可空；非空时为非负整数               | 复用搜索批次缓存的时间标记                     |

`state` 的 SQL 枚举为 `queued`、`running`、`completed`、`partial`、`login_required`、`session_expired`、`challenge`、`unsupported_city`、`scope_unverified`、`parse_error`、`timeout`、`network_error`、`cancelled`、`interrupted`。

#### `discovery_results`

存在版本：**v4**（v4 引入）。关联当前搜索准入的岗位及观察版本。

| 字段             | 类型    | 约束                       | 说明                  |
| ---------------- | ------- | -------------------------- | --------------------- |
| `run_id`         | TEXT    | 非空；与 `job_id` 联合主键 | 所属搜索任务 ID       |
| `job_id`         | TEXT    | 非空；与 `run_id` 联合主键 | 准入岗位 ID           |
| `observation_id` | INTEGER | 非空；正整数               | 当前结果引用的观察 ID |
| `relevance`      | INTEGER | 非空；非负整数             | 入库时的相关性排序值  |

#### `discovery_views`

存在版本：**v4**（v4 引入）。保存稳定分页的浏览视图。

| 字段         | 类型    | 约束                                       | 说明                       |
| ------------ | ------- | ------------------------------------------ | -------------------------- |
| `id`         | TEXT    | 主键、非空                                 | 视图 UUID                  |
| `run_id`     | TEXT    | 非空                                       | 所属搜索任务 ID            |
| `sort`       | TEXT    | 非空；仅 `relevance`/`salary`/`discovered` | 相关性、薪资或发现时间排序 |
| `created_at` | INTEGER | 非空；非负整数                             | 视图创建时间               |

#### `discovery_view_items`

存在版本：**v4**（v4 引入）。固定视图内的岗位序号及观察版本。

| 字段             | 类型    | 约束                                              | 说明                                   |
| ---------------- | ------- | ------------------------------------------------- | -------------------------------------- |
| `view_id`        | TEXT    | 非空；与 `job_id` 联合主键；与 `ordinal` 联合唯一 | 所属视图 ID                            |
| `ordinal`        | INTEGER | 非空；正整数；与 `view_id` 联合唯一               | 固定展示序号；下架清理后允许序号不连续 |
| `job_id`         | TEXT    | 非空；与 `view_id` 联合主键                       | 岗位 ID                                |
| `observation_id` | INTEGER | 非空；正整数                                      | 视图固定引用的观察 ID                  |

#### `discovery_platforms`

存在版本：**v4**（v4 引入）。保存平台状态、检查证据与会话代次，不保存 Cookie、令牌等认证材料。

| 字段       | 类型 | 约束                 | 说明                                       |
| ---------- | ---- | -------------------- | ------------------------------------------ |
| `platform` | TEXT | 主键、非空；平台枚举 | 平台标识                                   |
| `payload`  | TEXT | 非空；有效 JSON      | 平台状态、检查时间、代次、证据、能力及限制 |

#### `discovery_saved`

存在版本：**v4**（v4 引入）。保存发现岗位与求职记录的幂等关联。

| 字段             | 类型    | 约束           | 说明                |
| ---------------- | ------- | -------------- | ------------------- |
| `job_id`         | TEXT    | 主键、非空     | 已保存的发现岗位 ID |
| `opportunity_id` | INTEGER | 非空；正整数   | 对应求职记录 ID     |
| `observation_id` | INTEGER | 非空；正整数   | 保存时采用的观察 ID |
| `created_at`     | INTEGER | 非空；非负整数 | 保存关联创建时间    |

#### 岗位发现的 JSON 与关联规则

观察 payload 保留网站原始字段、字段来源和缺失原因。薪资仅保存原文 salary、人民币标准月薪 salaryMin/salaryMax：单值只填下限，年薪除以 12，日薪/时薪/外币/无法比较的原文对应两个空值。不持久化币种、周期、薪数及重复的原金额。readAt 是观察时间，detailReadAt 是成功完整读取 JD 的时间；列表刷新不能擦除完整 JD 或延长详情缓存。

观察引用、求职引用和视图序号采用正整数约束；相关性分数以及来源计数、批次、页码、会话代次采用非负整数约束，状态为显式枚举；excluded_range/day/hour/foreign/unknown 分别统计超范围及不可比较原因。raw_count 是源响应条目数，valid_count 是城市和薪资过滤前、批内去重后的可解析候选累计数（包括后续批次重现）；rejected_count 记录逐条解析失败并跳过的数量，城市排除另记脱敏日志，duplicate_count 包含批内及当前采集上下文的跨批重复。count 是当前已保存的独立结果数量，详情变化移出结果后同步减少。游标恢复会重新观察源批次，因此累计获取数量不代表全站覆盖或独立岗位总量。

索引覆盖观察(job_id,id DESC)、任务(created_at DESC,id)、请求(run_id)、结果(observation_id/job_id)、视图(run_id)、视图条目(job_id/observation_id)、保存关联(opportunity_id/observation_id)，以及岗位的 current_observation_id 和 (duplicate_fingerprint,platform)。视图唯一序号索引直接用于分页。相似岗位使用指纹索引查找，不扫描全部历史观察；字段不完整时不生成指纹。

首次创建视图按薪资、发现时间或入库时的相关性排序，后续只追加未收录岗位。计数和 LIMIT/OFFSET 只使用同一 view_id，不执行业务筛选。薪资排序用上限或单值下限，不可比较值置后；岗位 ID 用于同值稳定排序。详情变化更新当前结果，旧视图允许继续引用已移出当前结果的岗位，刷新建立的新视图才应用变化。

历史清理先删除任务和所属视图，再回收无业务根引用的岗位及无引用观察。结果、旧视图、保存关联和仍有业务根的岗位当前观察均为有效引用；当前观察指针不得使孤立岗位永久保留。删除求职记录来源关联同样执行回收。

恢复校验检查最终 JSON 契约、身份哈希与规范 URL、当前观察归属和指纹、原始请求映射、来源覆盖和计数、任务及视图 UUID、结果/视图/保存观察归属以及视图序号的正整数和唯一性。持久化 query 必须是已规范化的完整搜索条件，包括必有的 city 字段（未选城市保存空字符串）；输入默认值和 trim 不能用于修补库内数据。确认下架后允许序号不连续，剩余岗位不重新编号；新增岗位从现有最大序号后追加。外部观测内容不能伪造薪资解析值。

browser-sessions/ 不属于数据库或可移植备份。普通重启保留登录确认状态及原确认时间；搜索需要重新登录或验证时再显示平台提示。备份恢复先按明确的 user_version 校验，再撤销 v4 导入账号状态，重新检查本机会话；不通过探测表是否存在容忍不完整 v4。旧正式客户端留下的恢复日志按来源版本完成恢复，再走正式升级链。运行中任务在重启后中断，浏览器游标丢弃。

## LangGraph 持久化依赖表

以下两张表从数据库 v1 起均受支持，由 LangGraph `SqliteSaver` 在使用时成对创建，与应用表共用 `zhiji.db`；未使用时可以同时不存在，不计入 30 张应用表。固定结构定义在 `src/main/persistence/schema-checkpoint.ts`，校验不允许只存在其中一张或出现结构差异。两表没有物理外键，由 checkpointer 管理序列化内容与逻辑关联；备份保留已有数据，删除会话时清理对应 thread 的两表记录。

### `checkpoints`

存在版本：**v1、v2、v3、v4**（v1 引入，按需创建）。保存智能体图执行的持久化状态快照。

| 字段                   | 类型 | 约束                                 | 说明                             |
| ---------------------- | ---- | ------------------------------------ | -------------------------------- |
| `thread_id`            | TEXT | 非空；联合主键组成字段               | LangGraph thread ID，对应会话 ID |
| `checkpoint_ns`        | TEXT | 非空、默认空字符串；联合主键组成字段 | checkpoint 命名空间              |
| `checkpoint_id`        | TEXT | 非空；联合主键组成字段               | 命名空间内的 checkpoint ID       |
| `parent_checkpoint_id` | TEXT | 可空                                 | 上一个 checkpoint ID             |
| `type`                 | TEXT | 可空                                 | checkpoint 数据的序列化类型标记  |
| `checkpoint`           | BLOB | 可空                                 | 序列化的图状态快照               |
| `metadata`             | BLOB | 可空                                 | 序列化的 checkpoint 元数据       |

联合主键为 `(thread_id, checkpoint_ns, checkpoint_id)`。

### `writes`

存在版本：**v1、v2、v3、v4**（v1 引入，按需创建）。保存关联 checkpoint 的任务写入，供图执行恢复使用。

| 字段            | 类型    | 约束                                 | 说明                                   |
| --------------- | ------- | ------------------------------------ | -------------------------------------- |
| `thread_id`     | TEXT    | 非空；联合主键组成字段               | 所属 thread ID                         |
| `checkpoint_ns` | TEXT    | 非空、默认空字符串；联合主键组成字段 | checkpoint 命名空间                    |
| `checkpoint_id` | TEXT    | 非空；联合主键组成字段               | 所属 checkpoint ID                     |
| `task_id`       | TEXT    | 非空；联合主键组成字段               | 执行任务 ID                            |
| `idx`           | INTEGER | 非空；联合主键组成字段               | 任务内写入索引，内部特殊通道可使用负值 |
| `channel`       | TEXT    | 非空                                 | 图状态通道名称                         |
| `type`          | TEXT    | 可空                                 | 写入值的序列化类型标记                 |
| `value`         | BLOB    | 可空                                 | 序列化的通道写入值                     |

联合主键为 `(thread_id, checkpoint_ns, checkpoint_id, task_id, idx)`。`idx` 没有非负约束，不套用岗位发现的计数规则。

## 显式索引

以下是 `DatabaseManager.initialize()` 创建的全部 31 个显式索引。主键与唯一约束由 SQLite 自身维护，不重复列在此表中。

| 索引名                                    | 表                          | 键                                                    |
| ----------------------------------------- | --------------------------- | ----------------------------------------------------- |
| `idx_opportunities_status_id`             | `opportunities`             | `status_id`                                           |
| `idx_opportunity_status_events_flow`      | `opportunity_status_events` | `opportunity_id, occurred_at, id`                     |
| `idx_opportunity_status_events_status_id` | `opportunity_status_events` | `status_id`                                           |
| `idx_opportunities_company_id`            | `opportunities`             | `company_id`                                          |
| `idx_opportunities_deadline_at`           | `opportunities`             | `deadline_at`                                         |
| `idx_opportunities_updated_at`            | `opportunities`             | `updated_at`                                          |
| `idx_industries_root_name`                | `industries`                | `name`，唯一，条件 `parent_id IS NULL`                |
| `idx_industries_child_name`               | `industries`                | `parent_id, name`，唯一，条件 `parent_id IS NOT NULL` |
| `idx_industries_parent_order`             | `industries`                | `parent_id, sort_order, id`                           |
| `idx_company_industries_industry_id`      | `company_industries`        | `industry_id`                                         |
| `idx_calendar_events_range`               | `calendar_events`           | `start_at, end_at`                                    |
| `idx_agent_conversations_updated_at`      | `agent_conversations`       | `updated_at DESC`                                     |
| `idx_agent_chat_events_conversation`      | `agent_chat_events`         | `conversation_id, seq`                                |
| `idx_agent_model_usage_conversation`      | `agent_model_usage`         | `conversation_id, created_at`                         |
| `idx_chat_attachments_conversation_id`    | `chat_attachments`          | `conversation_id`                                     |
| `idx_exam_papers_conversation`            | `exam_papers`               | `conversation_id, created_at`                         |
| `idx_exam_answers_paper`                  | `exam_answers`              | `paper_id`                                            |
| `idx_locations_search`                    | `locations`                 | `name COLLATE NOCASE`                                 |
| `idx_company_locations_location`          | `company_locations`         | `location_id, company_id`                             |
| `idx_discovery_job_duplicate`             | `discovery_jobs`            | `duplicate_fingerprint, platform`                     |
| `idx_discovery_job_current`               | `discovery_jobs`            | `current_observation_id`                              |
| `idx_discovery_observation_job`           | `discovery_observations`    | `job_id, id DESC`                                     |
| `idx_discovery_runs_created`              | `discovery_runs`            | `created_at DESC, id`                                 |
| `idx_discovery_requests_run`              | `discovery_requests`        | `run_id`                                              |
| `idx_discovery_results_observation`       | `discovery_results`         | `observation_id`                                      |
| `idx_discovery_results_job`               | `discovery_results`         | `job_id`                                              |
| `idx_discovery_views_run`                 | `discovery_views`           | `run_id`                                              |
| `idx_discovery_view_job`                  | `discovery_view_items`      | `job_id`                                              |
| `idx_discovery_view_observation`          | `discovery_view_items`      | `observation_id`                                      |
| `idx_discovery_saved_opportunity`         | `discovery_saved`           | `opportunity_id`                                      |
| `idx_discovery_saved_observation`         | `discovery_saved`           | `observation_id`                                      |

## 逻辑关联与写入边界

| 保存方字段                                                                                                   | 目标                     | 维护方式                         |
| ------------------------------------------------------------------------------------------------------------ | ------------------------ | -------------------------------- |
| `company_industries.company_id`、`company_aliases.company_id`                                                | `companies.id`           | 公司服务在删除公司时清理关联     |
| `company_locations.company_id`                                                                               | `companies.id`           | 公司服务在删除保护通过后清理关联 |
| `company_locations.location_id`                                                                              | `locations.id`           | 清理本次受影响且无引用的地点     |
| `industries.parent_id`                                                                                       | `industries.id`          | 只可引用一级，有子节点时禁止删除 |
| `company_industries.industry_id`                                                                             | `industries.id`          | 行业被公司使用时禁止删除         |
| `opportunities.company_id`                                                                                   | `companies.id`           | 公司被求职记录使用时禁止删除     |
| `opportunities.status_id`、`opportunity_status_events.status_id`                                             | `statuses.id`            | 当前或历史状态被使用时禁止删除   |
| `opportunities.resume_version_id`                                                                            | `resume_versions.id`     | 简历被求职记录使用时禁止删除     |
| `opportunity_status_events.opportunity_id`                                                                   | `opportunities.id`       | 删除求职记录时删除节点           |
| `calendar_events.opportunity_id`                                                                             | `opportunities.id`       | 删除求职记录时置为 `NULL`        |
| `calendar_event_reminders.calendar_event_id`                                                                 | `calendar_events.id`     | 删除日程时删除提醒记录           |
| `agent_chat_events.conversation_id`、`agent_model_usage.conversation_id`、`chat_attachments.conversation_id` | `agent_conversations.id` | 删除会话时清理归档、用量和附件   |

求职记录、公司目录等跨表业务操作通过 Service 和 `UnitOfWork` 执行；外层工作单元使用 `IMMEDIATE` 事务，同步的嵌套操作使用 SQLite 嵌套事务。智能体归档使用自身事务，附件文件及元数据由 `AgentFileStore` 管理。Renderer 和 MCP 不直接写表。以上关联维护不是数据库外键约束，直接在 SQLite 中写入仍可能绕过业务校验。

## 首次种子数据与公司目录

首次建库时，在同一事务中写入：

- 13 个内置状态，ID 和 `sort_order` 均为 1–13，按顺序为：感兴趣、待投递、已投递、初筛、笔试、AI面试、一面、二面、三面、HR面、Offer、淘汰、主动放弃。
- 20 个一级门类与 97 个二级大类，依据国家统计局 [GB/T 4754—2017（按第 1 号修改单修订）](https://www.stats.gov.cn/sj/tjbz/gmjjhyfl/)。唯一数据来源为公司目录中的 `industries`，同级按目录顺序从 0 排序；本地 ID 由 SQLite 生成，不作为稳定身份。
- 仓库 `resource/jobtrail-company-catalog.json` 中的全部内置公司及其行业关联、别名，数量随目录内容更新。公司 ID 由本地 SQLite 生成；目录的 `builtinKey` 才是跨目录版本的稳定身份。初始 `is_favorite=0`、`last_read_at=NULL`。
- 一条 `builtin_company_catalog_state` 记录，`format_version` 与 `catalog_version` 分别来自打包目录的 `formatVersion`（当前为 2）与 `catalogVersion`，`content_sha256` 为目录 JSON 原始文本的 SHA-256。

已初始化数据库再次打开或迁移时不会重新 seed，也不会在软件升级时自动合并公司目录。用户在设置中主动更新目录时，应用校验发布资产的大小、SHA-256、格式、目录版本和最低软件版本。更新在一个 `IMMEDIATE` 事务中按 `builtin_key` 匹配，更新目录拥有的名称、招聘官网、行业和别名，保留本地公司 ID、创建时间、收藏、已读时间及业务关联。行业关联和别名按差异维护：未变化的记录不写入，值替换时更新原记录，只有实际增减时才插入或删除；同名的用户公司可转为内置公司。新版本目录未收录的旧内置公司清除 `builtin_key` 并更新 `updated_at`，转为自定义公司；保留本地 ID、其他字段、行业关联、别名和求职记录，按自定义公司的权限处理。转换数量单独返回并显示；同版本同哈希不触发转换。冲突或约束错误会回滚整次同步。

目录根结构固定为 `{ formatVersion, catalogVersion, minimumAppVersion, industries, companies }`。行业条目为 `{ builtinKey, parentKey, code, name }`，一级 `parentKey=null`、代码 A–T，二级通过父节点 UUID 关联一级并使用两位标准代码。公司条目使用 `industryKeys` 引用二级 UUID；本地接口仍使用解析后的 `industryIds`。不解析旧目录字段。

行业树与公司关联在同一目录同步事务中更新：先按稳定 UUID 匹配行业，再解析公司的二级引用。已有节点保留本地 ID 与同级排序，新节点追加到分组末尾；移动节点追加到目标分组。目录中的同名新节点遇到自定义行业时整次回滚，不收编或覆盖自定义行业。目录未包含的现有行业保留，不自动删除。

`@行业` 仅提供二级候选，Main 校验层级并重新解析完整的“一级 / 二级”路径。MCP 与 IPC 共用行业业务服务。备份导出、导入还校验父子关系、公司二级引用及内置公司的非空行业关联。

首个正式版之前的开发数据不在迁移支持范围内；应用和发布流程不包含一次性开发库转换。正式 v1 基线与可追溯的合成 v2 样本保持冻结。v1/v2/v3 通过已注册的正式迁移步骤升级至 v4，保留公司、行业、试卷、聊天及其他业务记录。

目录格式 v2 的每个公司条目必须包含 `locations`；内置内容版本为 6，包含 1,879 家公司及对应工作地点。目录内容版本与数据库结构版本独立。旧客户端在严格解析新格式前收到升级提示。首次 seed 使用共享地点 Repository；已有安装的软件升级不自动同步目录。主动同步按集合比较地点，顺序变化不写入；全部公司处理后统一清理失去引用的地点，和目录状态同事务提交。同名自定义公司收编时采用目录地点（包括空集合）；退出目录时保留地点。
