# 职迹 SQLite 数据库（v1）

本文记录当前代码定义的数据库结构与持久化规则。应用表的建表实现位于 `src/main/database.ts`；业务写入规则由 `src/main/repositories/`、`src/main/services/` 和 `src/main/agent/` 实现。下文用表格列出应用自身管理的 v1 表和显式索引，不包含 SQLite 内部表或 LangGraph 依赖自行创建的 checkpoint 表。

## 文件与版本

| 内容     | 开发环境                     | 安装环境                              |
| -------- | ---------------------------- | ------------------------------------- |
| 数据库   | `<项目根目录>/data/zhiji.db` | `<JobTrail 安装根目录>/data/zhiji.db` |
| 配置     | `<项目根目录>/config.json`   | `<JobTrail 安装根目录>/config.json`   |
| 简历文件 | `<项目根目录>/resumes/`      | `<JobTrail 安装根目录>/resumes/`      |
| 聊天附件 | `<项目根目录>/chat-uploads/` | `<JobTrail 安装根目录>/chat-uploads/` |

数据库使用 `better-sqlite3`。连接设置为 `journal_mode=WAL`、`busy_timeout=5000`；运行时可能出现 `zhiji.db-wal` 和 `zhiji.db-shm`。更新前的数据库快照通过 SQLite 在线备份取得，包含已提交的 WAL 内容。`PRAGMA data_version` 仅用于检测其他连接的改动，不是结构版本。

结构版本使用 SQLite 内置 `PRAGMA user_version`，当前为 **1**；应用不创建 `schema_migrations` 表：

1. `user_version=0`：在一个 `IMMEDIATE` 事务内创建下述 15 张表和 12 个显式索引，写入种子数据，最后将 `user_version` 设为 1；失败时整笔事务回滚。
2. `user_version=1`：正常打开，不再次建表或写入种子数据。
3. 其他版本：抛出 `DatabaseVersionError` 并关闭连接；不尝试修改或降级原数据库。

当前代码只处理新库与结构版本 1，没有数据库迁移流程。`config.json` 的 `configVersion=1` 独立于 `user_version`；内置公司目录的 `catalog_version` 也独立于两者。

## 数据约定

- 时间字段（`*_at`）按 UTC Unix 毫秒存储；`reminder_minutes` 是分钟数。
- 布尔字段按 `INTEGER` 的 0/1 存储，并由数据库约束限制取值。
- 表之间没有 SQLite 物理外键或级联删除定义。下文所说的关联都是逻辑关联，由 Service 层校验、清理或阻止删除。
- 下表的“约束”列描述数据库实际声明的主键、非空、唯一、默认值和检查条件；名称非空、时区有效、ID 存在等更严格的规则由 Service 层验证。
- 原始简历与聊天附件文件保存在文件系统；`resume_versions` 和 `chat_attachments` 表只保存相对路径、大小、哈希等元数据。配置和 API 密钥不存入这些应用表。

## 应用表结构

### 状态与行业

`statuses` 保存求职状态；`industries` 保存行业分类。`sort_order` 是显示顺序，`is_builtin` 标记内置数据。

#### `statuses`

| 字段         | 类型    | 约束                 | 说明     |
| ------------ | ------- | -------------------- | -------- |
| `id`         | INTEGER | 主键、自增           | 状态 ID  |
| `label`      | TEXT    | 非空、唯一           | 状态名称 |
| `sort_order` | INTEGER | 非空                 | 显示顺序 |
| `is_builtin` | INTEGER | 非空、默认 0、仅 0/1 | 是否内置 |
| `created_at` | INTEGER | 非空                 | 创建时间 |
| `updated_at` | INTEGER | 非空                 | 更新时间 |

#### `industries`

| 字段         | 类型    | 约束                 | 说明     |
| ------------ | ------- | -------------------- | -------- |
| `id`         | INTEGER | 主键、自增           | 行业 ID  |
| `name`       | TEXT    | 非空、唯一           | 行业名称 |
| `sort_order` | INTEGER | 非空                 | 显示顺序 |
| `is_builtin` | INTEGER | 非空、默认 0、仅 0/1 | 是否内置 |
| `created_at` | INTEGER | 非空                 | 创建时间 |
| `updated_at` | INTEGER | 非空                 | 更新时间 |

内置状态和行业在生产环境不可编辑、删除，排序可以由业务接口重排；开发环境允许编辑内置项，但仍受引用保护。状态被求职记录当前状态或历史节点使用时不能删除，且至少保留一个状态；行业被公司使用时不能删除。

### 公司与内置目录

`companies.builtin_key` 非空表示内置公司，是目录中稳定的小写 UUID v4；普通用户公司为 `NULL`。公司 ID 是本地自增 ID，不是目录身份。`is_favorite` 和 `last_read_at` 是用户偏好。行业关联和别名分别存入 `company_industries`、`company_aliases`。

#### `companies`

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

| 字段              | 类型    | 约束            | 说明                     |
| ----------------- | ------- | --------------- | ------------------------ |
| `id`              | INTEGER | 主键、必须为 1  | 固定单行标识             |
| `format_version`  | INTEGER | 非空            | 目录 JSON 格式版本       |
| `catalog_version` | INTEGER | 非空            | 已应用的目录内容版本     |
| `content_sha256`  | TEXT    | 非空、长度为 64 | 原始目录 JSON 的 SHA-256 |
| `applied_at`      | INTEGER | 非空            | 最近应用时间             |

#### `company_industries`

| 字段          | 类型    | 约束                            | 说明         |
| ------------- | ------- | ------------------------------- | ------------ |
| `company_id`  | INTEGER | 非空；与 `industry_id` 联合主键 | 公司 ID      |
| `industry_id` | INTEGER | 非空；与 `company_id` 联合主键  | 行业 ID      |
| `created_at`  | INTEGER | 非空                            | 关联创建时间 |

#### `company_aliases`

| 字段         | 类型    | 约束                           | 说明        |
| ------------ | ------- | ------------------------------ | ----------- |
| `id`         | INTEGER | 主键、自增                     | 别名 ID     |
| `company_id` | INTEGER | 非空；与 `alias` 联合唯一      | 所属公司 ID |
| `alias`      | TEXT    | 非空；与 `company_id` 联合唯一 | 搜索别名    |
| `created_at` | INTEGER | 非空                           | 创建时间    |

`builtin_company_catalog_state` 固定使用 `id=1`，记录已应用目录的格式版本、内容版本、原始 JSON 的 SHA-256 和应用时间。目录版本变化是数据内容更新，不递增数据库 `user_version`。公司被求职记录引用时不能删除；删除公司时同步清除行业关联和别名。生产环境禁止编辑或删除内置公司的主体数据，但允许调整收藏和记录招聘链接的访问时间。

### 简历、求职记录与状态历史

`resume_versions.relative_path` 指向 `resumes/` 中的 UUID 文件名；`size_bytes` 和 `sha256` 允许为空。`opportunities.status_id` 保存当前状态；`opportunity_status_events` 保存实际发生的创建或变更节点，`status_label` 是写入当时的状态名称快照。

#### `resume_versions`

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

| 字段                | 类型    | 约束                 | 说明                              |
| ------------------- | ------- | -------------------- | --------------------------------- |
| `id`                | TEXT    | 主键                 | 会话 ID，也是 LangGraph thread ID |
| `title`             | TEXT    | 非空                 | 会话标题                          |
| `title_finalized`   | INTEGER | 非空、默认 0、仅 0/1 | 标题是否定稿                      |
| `input_tokens`      | INTEGER | 非空、默认 0         | 已报告的输入 token 累计           |
| `output_tokens`     | INTEGER | 非空、默认 0         | 已报告的输出 token 累计           |
| `cache_read_tokens` | INTEGER | 非空、默认 0         | 已报告的缓存命中 token 累计       |
| `created_at`        | INTEGER | 非空                 | 创建时间                          |
| `updated_at`        | INTEGER | 非空                 | 最近更新时间                      |

#### `agent_chat_events`

| 字段              | 类型    | 约束                                         | 说明            |
| ----------------- | ------- | -------------------------------------------- | --------------- |
| `seq`             | INTEGER | 主键、自增                                   | 展示顺序        |
| `id`              | TEXT    | 非空、唯一                                   | 幂等事件 ID     |
| `conversation_id` | TEXT    | 非空                                         | 所属会话 ID     |
| `kind`            | TEXT    | 非空、仅 `user`/`assistant`/`tool`/`compact` | 展示事件类型    |
| `payload`         | TEXT    | 非空                                         | 结构化事件 JSON |
| `created_at`      | INTEGER | 非空                                         | 归档时间        |

#### `agent_model_usage`

| 字段                | 类型    | 约束                       | 说明                     |
| ------------------- | ------- | -------------------------- | ------------------------ |
| `id`                | TEXT    | 主键                       | 模型调用的幂等记录 ID    |
| `conversation_id`   | TEXT    | 非空                       | 所属会话 ID              |
| `kind`              | TEXT    | 非空、仅 `agent`/`compact` | 普通回复或压缩调用       |
| `input_tokens`      | INTEGER | 可空                       | 模型报告的输入 token     |
| `output_tokens`     | INTEGER | 可空                       | 模型报告的输出 token     |
| `cache_read_tokens` | INTEGER | 可空                       | 模型报告的缓存命中 token |
| `created_at`        | INTEGER | 非空                       | 调用记录时间             |

#### `chat_attachments`

| 字段              | 类型    | 约束       | 说明                       |
| ----------------- | ------- | ---------- | -------------------------- |
| `id`              | TEXT    | 主键       | 附件 ID                    |
| `conversation_id` | TEXT    | 非空       | 所属会话 ID                |
| `original_name`   | TEXT    | 非空       | 原始文件名                 |
| `relative_path`   | TEXT    | 非空、唯一 | `chat-uploads/` 内的文件名 |
| `mime_type`       | TEXT    | 非空       | 已校验的内容类型           |
| `size_bytes`      | INTEGER | 非空       | 文件大小                   |
| `sha256`          | TEXT    | 非空       | 文件哈希                   |
| `created_at`      | INTEGER | 非空       | 上传时间                   |

会话 `id` 同时作为 LangGraph thread ID。LangGraph `SqliteSaver` 在同一个 SQLite 文件中维护自己的 checkpoint 数据；图状态保存工作记忆与摘要，`agent_chat_events` 独立保存展示历史。删除会话时，服务会删除 checkpoint thread、归档事件、用量记录、附件元数据和附件文件。用户消息中的简历、求职记录及技能引用在归档事件和图消息元数据中保留结构化片段；界面标签按当前语言生成。

## 显式索引

以下是 `DatabaseManager.initialize()` 创建的全部 12 个显式索引。主键与唯一约束由 SQLite 自身维护，不重复列在此表中。

| 索引名                                    | 表                          | 键                                |
| ----------------------------------------- | --------------------------- | --------------------------------- |
| `idx_opportunities_status_id`             | `opportunities`             | `status_id`                       |
| `idx_opportunity_status_events_flow`      | `opportunity_status_events` | `opportunity_id, occurred_at, id` |
| `idx_opportunity_status_events_status_id` | `opportunity_status_events` | `status_id`                       |
| `idx_opportunities_company_id`            | `opportunities`             | `company_id`                      |
| `idx_opportunities_deadline_at`           | `opportunities`             | `deadline_at`                     |
| `idx_opportunities_updated_at`            | `opportunities`             | `updated_at`                      |
| `idx_company_industries_industry_id`      | `company_industries`        | `industry_id`                     |
| `idx_calendar_events_range`               | `calendar_events`           | `start_at, end_at`                |
| `idx_agent_conversations_updated_at`      | `agent_conversations`       | `updated_at DESC`                 |
| `idx_agent_chat_events_conversation`      | `agent_chat_events`         | `conversation_id, seq`            |
| `idx_agent_model_usage_conversation`      | `agent_model_usage`         | `conversation_id, created_at`     |
| `idx_chat_attachments_conversation_id`    | `chat_attachments`          | `conversation_id`                 |

## 逻辑关联与写入边界

| 保存方字段                                                                                                   | 目标                     | 维护方式                       |
| ------------------------------------------------------------------------------------------------------------ | ------------------------ | ------------------------------ |
| `company_industries.company_id`、`company_aliases.company_id`                                                | `companies.id`           | 公司服务在删除公司时清理关联   |
| `company_industries.industry_id`                                                                             | `industries.id`          | 行业被公司使用时禁止删除       |
| `opportunities.company_id`                                                                                   | `companies.id`           | 公司被求职记录使用时禁止删除   |
| `opportunities.status_id`、`opportunity_status_events.status_id`                                             | `statuses.id`            | 当前或历史状态被使用时禁止删除 |
| `opportunities.resume_version_id`                                                                            | `resume_versions.id`     | 简历被求职记录使用时禁止删除   |
| `opportunity_status_events.opportunity_id`                                                                   | `opportunities.id`       | 删除求职记录时删除节点         |
| `calendar_events.opportunity_id`                                                                             | `opportunities.id`       | 删除求职记录时置为 `NULL`      |
| `calendar_event_reminders.calendar_event_id`                                                                 | `calendar_events.id`     | 删除日程时删除提醒记录         |
| `agent_chat_events.conversation_id`、`agent_model_usage.conversation_id`、`chat_attachments.conversation_id` | `agent_conversations.id` | 删除会话时清理归档、用量和附件 |

求职记录、公司目录等跨表业务操作通过 Service 和 `UnitOfWork` 执行；外层工作单元使用 `IMMEDIATE` 事务，同步的嵌套操作使用 SQLite 嵌套事务。智能体归档使用自身事务，附件文件及元数据由 `AgentFileStore` 管理。Renderer 和 MCP 不直接写表。以上关联维护不是数据库外键约束，直接在 SQLite 中写入仍可能绕过业务校验。

## 首次种子数据与公司目录

首次建库时，在同一事务中写入：

- 13 个内置状态，ID 和 `sort_order` 均为 1–13，按顺序为：感兴趣、待投递、已投递、初筛、笔试、AI面试、一面、二面、三面、HR面、Offer、淘汰、主动放弃。
- 83 个内置行业，ID 为 1–83，`sort_order` 为 0–82。具体名称与顺序由 `src/main/database.ts` 的 `DEFAULT_INDUSTRIES` 固定。
- 仓库 `resource/jobtrail-company-catalog.json` 中的 580 家内置公司及其行业关联、别名。公司 ID 由本地 SQLite 生成；目录的 `builtinKey` 才是跨目录版本的稳定身份。初始 `is_favorite=0`、`last_read_at=NULL`。
- 一条 `builtin_company_catalog_state` 记录，`format_version=1`、`catalog_version=1`，`content_sha256` 为打包目录 JSON 原始文本的 SHA-256。

版本 1 数据库再次打开时不会重新 seed，也不会在软件升级时自动合并公司目录。用户在设置中主动更新目录时，应用校验发布资产的大小、SHA-256、格式、目录版本和最低软件版本。更新在一个 `IMMEDIATE` 事务中按 `builtin_key` 匹配，更新目录拥有的名称、招聘官网、行业和别名，保留本地公司 ID、创建时间、收藏、已读时间及业务关联。行业关联和别名按差异维护：未变化的记录不写入，值替换时更新原记录，只有实际增减时才插入或删除；同名的用户公司可转为内置公司。新目录未收录的旧内置公司保留。冲突或约束错误会回滚整次同步。
