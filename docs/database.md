# 职迹 SQLite 数据库（v5）

本文记录数据库表结构、字段含义、约束及版本差异。

## 文件与版本

| 内容     | 开发环境                     | 安装环境                              |
| -------- | ---------------------------- | ------------------------------------- |
| 数据库   | `<项目根目录>/data/zhiji.db` | `<JobTrail 安装根目录>/data/zhiji.db` |
| 配置     | `<项目根目录>/config.json`   | `<JobTrail 安装根目录>/config.json`   |
| 简历文件 | `<项目根目录>/resumes/`      | `<JobTrail 安装根目录>/resumes/`      |
| 聊天附件 | `<项目根目录>/chat-uploads/` | `<JobTrail 安装根目录>/chat-uploads/` |

数据库使用 `better-sqlite3`，连接设置为 `journal_mode=WAL`、`busy_timeout=5000`；WAL 辅助文件为 `zhiji.db-wal` 和 `zhiji.db-shm`。`PRAGMA data_version` 表示其他连接的数据改动，不是结构版本。

数据库结构版本使用 SQLite 内置 `PRAGMA user_version`，本文对应 **v5**。配置 `configVersion` 和备份封装版本均为 **1**，与数据库结构版本独立。

**v2.1.0 的数据库最终定版为 v5**：30 张应用表、31 个显式索引，六平台约束固定在版本化 SQL 中。v1 至 v4 的正式结构和迁移保持冻结；v2.1.0 内不提供开发中间态兼容、`5 → 5` 修补或启动补表。正式发布前发现结构问题，直接修订 v5 定义、`4 → 5` 迁移及校验，本地开发库经备份后手动同步。v2.1.0 正式发布后再改变持久化结构或语义，才递增到 v6。

## 数据约定

- 时间字段（`*_at`）按 UTC Unix 毫秒存储；`reminder_minutes` 是分钟数。
- 提醒分钟值的业务取值为正数或 null，不包含 0；数据库底层约束为非负数。
- 布尔字段按 `INTEGER` 的 0/1 存储，并由数据库约束限制取值。
- 表之间没有 SQLite 物理外键或级联删除定义。下文所说的关联都是业务层维护的逻辑关联。
- 下表的“约束”列描述数据库实际声明的主键、非空、唯一、默认值和检查条件；名称非空、时区有效、ID 存在等更严格的规则属于业务约束。
- 原始简历与聊天附件文件保存在文件系统；`resume_versions` 和 `chat_attachments` 表只保存相对路径、大小、哈希等元数据。配置和 API 密钥不存入这些应用表。

## 应用表结构

### 表与版本总览

这里的 v1、v2、v3、v4、v5 指数据库 `PRAGMA user_version`，不是客户端版本。每张表下的字段表格描述当前 v5 定义；历史约束变化在对应表下说明。`✓` 表示该版本包含此应用表，`按需` 表示使用 LangGraph 时成对创建，`—` 表示该版本没有此表。

| 表                              | v1     | v2     | v3     | v4     | v5     |
| ------------------------------- | ------ | ------ | ------ | ------ | ------ |
| `statuses`                      | ✓      | ✓      | ✓      | ✓      | ✓      |
| `industries`                    | ✓      | ✓      | ✓      | ✓      | ✓      |
| `companies`                     | ✓      | ✓      | ✓      | ✓      | ✓      |
| `builtin_company_catalog_state` | ✓      | ✓      | ✓      | ✓      | ✓      |
| `company_industries`            | ✓      | ✓      | ✓      | ✓      | ✓      |
| `company_aliases`               | ✓      | ✓      | ✓      | ✓      | ✓      |
| `resume_versions`               | ✓      | ✓      | ✓      | ✓      | ✓      |
| `opportunities`                 | ✓      | ✓      | ✓      | ✓      | ✓      |
| `opportunity_status_events`     | ✓      | ✓      | ✓      | ✓      | ✓      |
| `calendar_events`               | ✓      | ✓      | ✓      | ✓      | ✓      |
| `calendar_event_reminders`      | ✓      | ✓      | ✓      | ✓      | ✓      |
| `agent_conversations`           | ✓      | ✓      | ✓      | ✓      | ✓      |
| `agent_chat_events`             | ✓      | ✓      | ✓      | ✓      | ✓      |
| `agent_model_usage`             | ✓      | ✓      | ✓      | ✓      | ✓      |
| `chat_attachments`              | ✓      | ✓      | ✓      | ✓      | ✓      |
| `exam_papers`                   | —      | ✓      | ✓      | ✓      | ✓      |
| `exam_questions`                | —      | ✓      | ✓      | ✓      | ✓      |
| `exam_answers`                  | —      | ✓      | ✓      | ✓      | ✓      |
| `locations`                     | —      | —      | ✓      | ✓      | ✓      |
| `company_locations`             | —      | —      | ✓      | ✓      | ✓      |
| `discovery_jobs`                | —      | —      | —      | ✓      | ✓      |
| `discovery_observations`        | —      | —      | —      | ✓      | ✓      |
| `discovery_runs`                | —      | —      | —      | ✓      | ✓      |
| `discovery_requests`            | —      | —      | —      | ✓      | ✓      |
| `discovery_sources`             | —      | —      | —      | ✓      | ✓      |
| `discovery_results`             | —      | —      | —      | ✓      | ✓      |
| `discovery_views`               | —      | —      | —      | ✓      | ✓      |
| `discovery_view_items`          | —      | —      | —      | ✓      | ✓      |
| `discovery_platforms`           | —      | —      | —      | ✓      | ✓      |
| `discovery_saved`               | —      | —      | —      | ✓      | ✓      |
| **应用表数量**                  | **15** | **18** | **20** | **30** | **30** |
| `checkpoints`                   | 按需   | 按需   | 按需   | 按需   | 按需   |
| `writes`                        | 按需   | 按需   | 按需   | 按需   | 按需   |

以下每张表均单独标明存在版本。未特别说明的表，从引入版本到 v5 的字段和 SQL 约束保持一致。

### 状态与行业

`statuses` 保存求职状态，以 `is_builtin` 标记内置数据；`industries` 保存固定两级的行业树，以 `builtin_key` 是否为空推导内置属性。两表均使用 `sort_order` 表示显示顺序，行业顺序限定在同级内。

#### `statuses`

存在版本：**v1、v2、v3、v4、v5**（v1 引入）。

| 字段         | 类型    | 约束                 | 说明     |
| ------------ | ------- | -------------------- | -------- |
| `id`         | INTEGER | 主键、自增           | 状态 ID  |
| `label`      | TEXT    | 非空、唯一           | 状态名称 |
| `sort_order` | INTEGER | 非空                 | 显示顺序 |
| `is_builtin` | INTEGER | 非空、默认 0、仅 0/1 | 是否内置 |
| `created_at` | INTEGER | 非空                 | 创建时间 |
| `updated_at` | INTEGER | 非空                 | 更新时间 |

#### `industries`

存在版本：**v1、v2、v3、v4、v5**（v1 引入）。

| 字段          | 类型    | 约束                               | 说明                                       |
| ------------- | ------- | ---------------------------------- | ------------------------------------------ |
| `id`          | INTEGER | 主键、自增                         | 本地行业 ID，与目录 UUID 无关              |
| `name`        | TEXT    | 非空、同级唯一                     | 行业名称，不同分组允许同名                 |
| `parent_id`   | INTEGER | 可空，非空时大于 0 且不等于自身 ID | 一级为空；二级引用一级                     |
| `builtin_key` | TEXT    | 可空、唯一                         | 内置行业稳定的小写 UUID v4；自定义二级为空 |
| `sort_order`  | INTEGER | 非空                               | 同级显示顺序，从 0 开始                    |
| `created_at`  | INTEGER | 非空                               | 创建时间                                   |
| `updated_at`  | INTEGER | 非空                               | 更新时间                                   |

表级约束要求 `parent_id` 与 `builtin_key` 至少一个非空，禁止自定义一级。一级名称唯一及同一父节点下的二级名称唯一由两个部分唯一索引保证。父节点必须存在且为一级，禁止第三层和层级转换，这些属于业务约束；表中没有层级字段或物理外键。

业务删除约束：一级行业有子节点时不能删除；二级行业被公司引用时不能删除。状态被求职记录当前状态或历史节点引用时不能删除，且至少保留一个状态。

### 公司与内置目录

`companies.builtin_key` 非空表示内置公司，是目录中稳定的小写 UUID v4；普通用户公司为 `NULL`。公司 ID 是本地自增 ID，不是目录身份。公司只能关联二级行业；自定义公司允许无行业，内置公司至少关联一个二级。`is_favorite` 和 `last_read_at` 是用户偏好。行业关联和别名分别存入 `company_industries`、`company_aliases`。

#### `companies`

存在版本：**v1、v2、v3、v4、v5**（v1 引入）。

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

存在版本：**v1、v2、v3、v4、v5**（v1 引入）。

| 字段              | 类型    | 约束            | 说明                     |
| ----------------- | ------- | --------------- | ------------------------ |
| `id`              | INTEGER | 主键、必须为 1  | 固定单行标识             |
| `format_version`  | INTEGER | 非空            | 目录 JSON 格式版本       |
| `catalog_version` | INTEGER | 非空            | 已应用的目录内容版本     |
| `content_sha256`  | TEXT    | 非空、长度为 64 | 原始目录 JSON 的 SHA-256 |
| `applied_at`      | INTEGER | 非空            | 最近应用时间             |

#### `company_industries`

存在版本：**v1、v2、v3、v4、v5**（v1 引入）。

| 字段          | 类型    | 约束                            | 说明         |
| ------------- | ------- | ------------------------------- | ------------ |
| `company_id`  | INTEGER | 非空；与 `industry_id` 联合主键 | 公司 ID      |
| `industry_id` | INTEGER | 非空；与 `company_id` 联合主键  | 行业 ID      |
| `created_at`  | INTEGER | 非空                            | 关联创建时间 |

#### `company_aliases`

存在版本：**v1、v2、v3、v4、v5**（v1 引入）。

| 字段         | 类型    | 约束                           | 说明        |
| ------------ | ------- | ------------------------------ | ----------- |
| `id`         | INTEGER | 主键、自增                     | 别名 ID     |
| `company_id` | INTEGER | 非空；与 `alias` 联合唯一      | 所属公司 ID |
| `alias`      | TEXT    | 非空；与 `company_id` 联合唯一 | 搜索别名    |
| `created_at` | INTEGER | 非空                           | 创建时间    |

`builtin_company_catalog_state` 固定使用 `id=1`，记录已应用目录的格式版本、内容版本、原始 JSON 的 SHA-256 和应用时间。目录版本与数据库 `user_version` 独立。被求职记录引用的公司不能删除。

#### `locations`

存在版本：**v3、v4、v5**（v3 引入）。

| 字段         | 类型    | 约束                         | 说明                |
| ------------ | ------- | ---------------------------- | ------------------- |
| `id`         | INTEGER | 主键、自增                   | 地点 ID，仅内部使用 |
| `name`       | TEXT    | 非空、原文精确唯一（BINARY） | 规范化地点标签      |
| `created_at` | INTEGER | 非空                         | 创建时间            |

#### `company_locations`

存在版本：**v3、v4、v5**（v3 引入）。

| 字段          | 类型    | 约束                            | 说明         |
| ------------- | ------- | ------------------------------- | ------------ |
| `company_id`  | INTEGER | 非空；与 `location_id` 联合主键 | 关联公司 ID  |
| `location_id` | INTEGER | 非空；与 `company_id` 联合主键  | 关联地点 ID  |
| `created_at`  | INTEGER | 非空                            | 关联创建时间 |

显式索引 `idx_locations_search ON locations(name COLLATE NOCASE)` 支持候选前缀查询；`idx_company_locations_location ON company_locations(location_id, company_id)` 支持筛选及剩余引用检查。公司维度查询使用联合主键索引。无触发器、物理外键或引用计数。

地点标签为去除首尾空白后的非空字符串，按完整文本精确去重；每家公司最多 100 项、每项最多 200 字符。公司地点与岗位地点独立。`locations` 是共享字典，地点必须至少被一家公司的 `company_locations` 引用，不保留孤立地点。

### 简历、求职记录与状态历史

`resume_versions.relative_path` 指向 `resumes/` 中的 UUID 文件名；`size_bytes` 和 `sha256` 允许为空。`opportunities.status_id` 保存当前状态；`opportunity_status_events` 保存实际发生的创建或变更节点，`status_label` 是写入当时的状态名称快照。

#### `resume_versions`

存在版本：**v1、v2、v3、v4、v5**（v1 引入）。

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

存在版本：**v1、v2、v3、v4、v5**（v1 引入）。

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

存在版本：**v1、v2、v3、v4、v5**（v1 引入）。

| 字段             | 类型    | 约束                         | 说明                 |
| ---------------- | ------- | ---------------------------- | -------------------- |
| `id`             | INTEGER | 主键、自增                   | 状态节点 ID          |
| `opportunity_id` | INTEGER | 非空                         | 所属求职记录 ID      |
| `status_id`      | INTEGER | 非空                         | 状态 ID              |
| `status_label`   | TEXT    | 非空                         | 写入时的状态名称快照 |
| `occurred_at`    | INTEGER | 非空                         | 节点发生时间         |
| `kind`           | TEXT    | 非空、仅 `created`/`changed` | 创建或状态变更       |

`created` 表示求职记录创建节点，`changed` 表示实际状态变更节点；状态未变不属于变更事件。历史顺序为 `occurred_at, id`。被求职记录引用的简历不能删除。

### 日程与提醒

`calendar_events.opportunity_id` 可空。`event_type` 保存所选类型的文本，数据库未限制其枚举值。`timezone` 保存时区名称；`is_all_day` 控制全天语义。提醒记录按日程和计算出的提醒时间去重。

#### `calendar_events`

存在版本：**v1、v2、v3、v4、v5**（v1 引入）。

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

存在版本：**v1、v2、v3、v4、v5**（v1 引入）。

| 字段                | 类型    | 约束                                  | 说明             |
| ------------------- | ------- | ------------------------------------- | ---------------- |
| `id`                | INTEGER | 主键、自增                            | 提醒记录 ID      |
| `calendar_event_id` | INTEGER | 非空；与 `reminder_at` 联合唯一       | 所属日程 ID      |
| `reminder_at`       | INTEGER | 非空；与 `calendar_event_id` 联合唯一 | 计算出的提醒时间 |
| `sent_at`           | INTEGER | 非空                                  | 实际发送时间     |

普通日程允许 `end_at=start_at` 表示时间点；全天日程使用当地日期的半开区间 `[start_at, end_at)`，要求结束日期晚于开始日期。日程是否完成由当前时间与 `end_at` 决定，不保存完成标记。

### 智能体会话

应用保存会话索引、完整展示事件、模型用量和附件元数据。`agent_chat_events.payload` 是结构化 JSON 文本，`seq` 决定展示顺序，`id` 用于幂等归档。`agent_model_usage` 中 token 数可空，表示模型端点没有提供该项；会话累计值只加总已报告的数值。附件文件位于 `chat-uploads/`，`relative_path` 唯一。

#### `agent_conversations`

存在版本：**v1、v2、v3、v4、v5**（v1 引入）。

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

存在版本：**v1、v2、v3、v4、v5**（v1 引入）。v1 的 `kind` 仅允许 `user`、`assistant`、`tool`、`compact`；v2 增加 `exam-paper`，v3/v4/v5 沿用 v2 约束。字段集合未变。

| 字段              | 类型    | 约束                                                      | 说明            |
| ----------------- | ------- | --------------------------------------------------------- | --------------- |
| `seq`             | INTEGER | 主键、自增                                                | 展示顺序        |
| `id`              | TEXT    | 非空、唯一                                                | 幂等事件 ID     |
| `conversation_id` | TEXT    | 非空                                                      | 所属会话 ID     |
| `kind`            | TEXT    | 非空、仅 `user`/`assistant`/`tool`/`compact`/`exam-paper` | 展示事件类型    |
| `payload`         | TEXT    | 非空                                                      | 结构化事件 JSON |
| `created_at`      | INTEGER | 非空                                                      | 归档时间        |

#### `agent_model_usage`

存在版本：**v1、v2、v3、v4、v5**（v1 引入）。v1 的 `kind` 仅允许 `agent`、`compact`；v2 增加 `grade`，v3/v4/v5 沿用 v2 约束。字段集合未变。

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

存在版本：**v1、v2、v3、v4、v5**（v1 引入）。

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

会话 `id` 同时作为 LangGraph thread ID。图状态保存工作记忆与摘要，`agent_chat_events` 独立保存展示历史。用户消息中的简历、求职记录及技能引用以结构化片段保存在归档事件和图消息元数据中。

### 笔试练习

笔试练习表从 v2 引入，与聊天通过逻辑关联连接，无物理外键。题目正文和作答均使用结构化 JSON。

#### `exam_papers`

存在版本：**v2、v3、v4、v5**（v2 引入）。

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

`counts` 保存三类题型的完整目标数量，总数大于零，每类不少于已生成数量。`revision` 是试卷内容的变更版本，与数据库结构版本独立。

#### `exam_questions`

存在版本：**v2、v3、v4、v5**（v2 引入）。

| 字段         | 类型    | 约束                         | 说明                          |
| ------------ | ------- | ---------------------------- | ----------------------------- |
| `id`         | TEXT    | 主键                         | 题目 UUID                     |
| `paper_id`   | TEXT    | 非空；与 `position` 联合唯一 | 所属试卷 ID                   |
| `request_id` | TEXT    | 非空、唯一                   | 追加幂等标识                  |
| `position`   | INTEGER | 非空；与 `paper_id` 联合唯一 | 业务要求从 1 开始的连续题号   |
| `content`    | TEXT    | 非空                         | 题型、题干及题型特有字段 JSON |

`single_choice` 固定四个选项、A–D 唯一答案及解析；`true_false` 保存布尔答案及解析；`short_answer` 仅保存题干。聊天 `exam-paper` 卡片的 payload 只引用 `paperId`，不保存题目副本。

#### `exam_answers`

存在版本：**v2、v3、v4、v5**（v2 引入）。

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

索引：`idx_exam_answers_paper(paper_id)`。判题结果对应的请求 ID、答案版本和试卷重置版本必须与当前记录一致。判题用量属于 `agent_model_usage(kind='grade')`。

### 岗位发现

岗位发现表由 v4 引入，v5 扩展其中三张表的平台约束以支持国聘和实习僧。所有文本主键显式 `NOT NULL`，不使用物理外键或触发器。

下面的“平台枚举”在 v5 固定为 `boss`、`liepin`、`zhilian`、`wuyou`、`iguopin`、`shixiseng`，v4 仅包含前四项；“正整数”和“非负整数”均由 `CHECK` 同时检查 SQLite 存储类型 `typeof(字段)='integer'` 及数值范围。未列默认值的字段没有 SQL 默认值。

#### `discovery_jobs`

存在版本：**v4、v5**（v4 引入）。保存平台内唯一的岗位身份及当前观察引用。v5 仅在 `platform` 的 `CHECK` 枚举中增加 `iguopin` 和 `shixiseng`，字段与其他约束不变。

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

存在版本：**v4、v5**（v4 引入）。保存不可变的岗位观察快照。

| 字段          | 类型    | 约束                                       | 说明                                           |
| ------------- | ------- | ------------------------------------------ | ---------------------------------------------- |
| `id`          | INTEGER | 主键、自增                                 | 观察 ID                                        |
| `job_id`      | TEXT    | 非空                                       | 所属 `discovery_jobs.id`                       |
| `payload`     | TEXT    | 非空；有效 JSON；UTF-8 字节数不超过 131072 | 原始与标准化字段、字段来源、缺失原因及读取时间 |
| `observed_at` | INTEGER | 非空；非负整数                             | 观察时间，与 payload 的 `readAt` 一致          |

#### `discovery_runs`

存在版本：**v4、v5**（v4 引入）。保存搜索条件、任务状态和搜索历史。

| 字段         | 类型    | 约束                                                                        | 说明                                |
| ------------ | ------- | --------------------------------------------------------------------------- | ----------------------------------- |
| `id`         | TEXT    | 主键、非空                                                                  | 搜索任务 UUID                       |
| `request_id` | TEXT    | 非空、唯一、长度大于 0                                                      | 创建任务时的原始幂等请求 ID         |
| `query`      | TEXT    | 非空；有效 JSON                                                             | 已规范化的完整查询条件，包含 `city` |
| `state`      | TEXT    | 非空；仅 `queued`/`running`/`completed`/`partial`/`cancelled`/`interrupted` | 整体任务状态                        |
| `created_at` | INTEGER | 非空；非负整数                                                              | 创建时间                            |
| `updated_at` | INTEGER | 非空；非负整数；不得早于 `created_at`                                       | 更新时间                            |

#### `discovery_requests`

存在版本：**v4、v5**（v4 引入）。保存请求到任务的权威幂等映射，允许同查询的在途请求合并到一个任务。

| 字段         | 类型 | 约束                   | 说明                                                   |
| ------------ | ---- | ---------------------- | ------------------------------------------------------ |
| `request_id` | TEXT | 主键、非空、长度大于 0 | 幂等请求 ID                                            |
| `run_id`     | TEXT | 非空                   | 对应 `discovery_runs.id`；任务原始请求必须映射回该任务 |

#### `discovery_sources`

存在版本：**v4、v5**（v4 引入）。保存每个搜索任务的各平台进度与统计。v5 仅在 `platform` 的 `CHECK` 枚举中增加 `iguopin` 和 `shixiseng`，字段与其他约束不变。

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

存在版本：**v4、v5**（v4 引入）。关联当前搜索准入的岗位及观察版本。

| 字段             | 类型    | 约束                       | 说明                       |
| ---------------- | ------- | -------------------------- | -------------------------- |
| `run_id`         | TEXT    | 非空；与 `job_id` 联合主键 | 所属搜索任务 ID            |
| `job_id`         | TEXT    | 非空；与 `run_id` 联合主键 | 准入岗位 ID                |
| `observation_id` | INTEGER | 非空；正整数               | 当前结果引用的观察 ID      |
| `relevance`      | INTEGER | 非空；非负整数             | 当前搜索结果的相关性排序值 |

#### `discovery_views`

存在版本：**v4、v5**（v4 引入）。保存稳定分页的浏览视图。

| 字段         | 类型    | 约束                                       | 说明                       |
| ------------ | ------- | ------------------------------------------ | -------------------------- |
| `id`         | TEXT    | 主键、非空                                 | 视图 UUID                  |
| `run_id`     | TEXT    | 非空                                       | 所属搜索任务 ID            |
| `sort`       | TEXT    | 非空；仅 `relevance`/`salary`/`discovered` | 相关性、薪资或发现时间排序 |
| `created_at` | INTEGER | 非空；非负整数                             | 视图创建时间               |

#### `discovery_view_items`

存在版本：**v4、v5**（v4 引入）。固定视图内的岗位序号及观察版本。

| 字段             | 类型    | 约束                                              | 说明                     |
| ---------------- | ------- | ------------------------------------------------- | ------------------------ |
| `view_id`        | TEXT    | 非空；与 `job_id` 联合主键；与 `ordinal` 联合唯一 | 所属视图 ID              |
| `ordinal`        | INTEGER | 非空；正整数；与 `view_id` 联合唯一               | 固定展示序号，允许不连续 |
| `job_id`         | TEXT    | 非空；与 `view_id` 联合主键                       | 岗位 ID                  |
| `observation_id` | INTEGER | 非空；正整数                                      | 视图固定引用的观察 ID    |

#### `discovery_platforms`

存在版本：**v4、v5**（v4 引入）。保存平台状态、检查证据与会话代次，不保存 Cookie、令牌等认证材料。v5 仅在 `platform` 的 `CHECK` 枚举中增加 `iguopin` 和 `shixiseng`，字段与其他约束不变。

| 字段       | 类型 | 约束                 | 说明                                       |
| ---------- | ---- | -------------------- | ------------------------------------------ |
| `platform` | TEXT | 主键、非空；平台枚举 | 平台标识                                   |
| `payload`  | TEXT | 非空；有效 JSON      | 平台状态、检查时间、代次、证据、能力及限制 |

#### `discovery_saved`

存在版本：**v4、v5**（v4 引入）。保存发现岗位与求职记录的幂等关联。

| 字段             | 类型    | 约束           | 说明                |
| ---------------- | ------- | -------------- | ------------------- |
| `job_id`         | TEXT    | 主键、非空     | 已保存的发现岗位 ID |
| `opportunity_id` | INTEGER | 非空；正整数   | 对应求职记录 ID     |
| `observation_id` | INTEGER | 非空；正整数   | 保存时采用的观察 ID |
| `created_at`     | INTEGER | 非空；非负整数 | 保存关联创建时间    |

#### 岗位发现的 JSON 与关联规则

观察 payload 保留网站原始字段、字段来源和缺失原因。薪资仅保存原文 salary、人民币标准月薪 salaryMin/salaryMax：单值只有下限，年薪对应月薪为年薪除以 12，日薪/时薪/外币/无法比较的原文对应两个空值。不持久化币种、周期、薪数及重复的原金额。readAt 是观察时间，detailReadAt 是成功完整读取 JD 的时间。

观察引用、求职引用和视图序号采用正整数约束；相关性分数以及来源计数、批次、页码、会话代次采用非负整数约束，状态为显式枚举；excluded_range/day/hour/foreign/unknown 分别统计超范围及不可比较原因。raw_count 是源响应条目数，valid_count 是城市和薪资过滤前、批内去重后的可解析候选累计数（包括后续批次重现）；rejected_count 是逐条解析失败的数量，duplicate_count 包含批内及当前采集上下文的跨批重复。count 是当前已保存的独立结果数量。累计获取数量不代表全站覆盖或独立岗位总量。

`relevance` 是基于当前搜索引用的观察、词频及字段长度统计得到的通用 BM25F 分数。视图中的岗位序号和观察引用是固定快照；同一视图内序号唯一，允许不连续，旧视图可引用已不在当前结果集中的岗位。岗位指纹在所需字段不完整时为空。

岗位观察的有效引用包括搜索结果、视图条目、保存关联及有业务引用的岗位当前观察；孤立岗位的当前观察指针不构成有效保留依据。当前观察、结果、视图条目和保存关联中的观察必须属于对应岗位。岗位 ID 必须符合平台身份哈希与规范 URL，任务和视图 ID 必须为 UUID。

持久化 query 是已规范化的完整搜索条件，必须包含 city 字段，未选城市时为空字符串。薪资解析值必须与原始薪资文本一致。

`browser-sessions/` 保存 Chromium 会话，不属于数据库或可移植备份；平台 Cookie、令牌不保存在业务表中。

## LangGraph 持久化依赖表

以下两张表从数据库 v1 起受支持，与应用表共用 `zhiji.db`，不计入 30 张应用表。两表必须同时存在或同时不存在，没有物理外键，通过 thread ID 和 checkpoint 标识建立逻辑关联。

### `checkpoints`

存在版本：**v1、v2、v3、v4、v5**（v1 引入，按需创建）。保存智能体图执行的持久化状态快照。

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

存在版本：**v1、v2、v3、v4、v5**（v1 引入，按需创建）。保存关联 checkpoint 的任务写入，供图执行恢复使用。

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

数据库 v5 包含以下 31 个显式索引。主键与唯一约束对应的 SQLite 自动索引不列在此表中。

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

## 逻辑关联

| 保存方字段                                                                                                   | 目标                     | 关联约束                           |
| ------------------------------------------------------------------------------------------------------------ | ------------------------ | ---------------------------------- |
| `company_industries.company_id`、`company_aliases.company_id`                                                | `companies.id`           | 关联和别名必须属于有效公司         |
| `company_locations.company_id`                                                                               | `companies.id`           | 地点关联必须属于有效公司           |
| `company_locations.location_id`                                                                              | `locations.id`           | 地点必须有效，且至少有一条公司引用 |
| `industries.parent_id`                                                                                       | `industries.id`          | 只可引用一级，有子节点时禁止删除   |
| `company_industries.industry_id`                                                                             | `industries.id`          | 行业被公司使用时禁止删除           |
| `opportunities.company_id`                                                                                   | `companies.id`           | 公司被求职记录使用时禁止删除       |
| `opportunities.status_id`、`opportunity_status_events.status_id`                                             | `statuses.id`            | 当前或历史状态被使用时禁止删除     |
| `opportunities.resume_version_id`                                                                            | `resume_versions.id`     | 简历被求职记录使用时禁止删除       |
| `opportunity_status_events.opportunity_id`                                                                   | `opportunities.id`       | 状态节点必须属于有效求职记录       |
| `calendar_events.opportunity_id`                                                                             | `opportunities.id`       | 可空，非空时必须引用有效求职记录   |
| `calendar_event_reminders.calendar_event_id`                                                                 | `calendar_events.id`     | 提醒记录必须属于有效日程           |
| `agent_chat_events.conversation_id`、`agent_model_usage.conversation_id`、`chat_attachments.conversation_id` | `agent_conversations.id` | 归档、用量及附件必须属于有效会话   |

以上关联属于业务约束，数据库未声明物理外键或级联删除。

## 内置数据与公司目录

初始内置数据包括：

- 13 个内置状态，ID 和 `sort_order` 均为 1–13，按顺序为：感兴趣、待投递、已投递、初筛、笔试、AI面试、一面、二面、三面、HR面、Offer、淘汰、主动放弃。
- 20 个一级门类与 97 个二级大类，依据国家统计局 [GB/T 4754—2017（按第 1 号修改单修订）](https://www.stats.gov.cn/sj/tjbz/gmjjhyfl/)。唯一数据来源为公司目录中的 `industries`，同级按目录顺序从 0 排序；本地 ID 由 SQLite 生成，不作为稳定身份。
- 仓库 `resource/jobtrail-company-catalog.json` 中的全部内置公司及其行业关联、别名，数量随目录内容更新。公司 ID 由本地 SQLite 生成；目录的 `builtinKey` 才是跨目录版本的稳定身份。初始 `is_favorite=0`、`last_read_at=NULL`。
- 一条 `builtin_company_catalog_state` 记录，`format_version` 与 `catalog_version` 分别来自打包目录的 `formatVersion`（当前为 2）与 `catalogVersion`，`content_sha256` 为目录 JSON 原始文本的 SHA-256。

目录根结构固定为 `{ formatVersion, catalogVersion, minimumAppVersion, industries, companies }`。行业条目为 `{ builtinKey, parentKey, code, name }`，一级 `parentKey=null`、代码 A–T，二级通过父节点 UUID 关联一级并使用两位标准代码。公司条目使用 `industryKeys` 引用二级 UUID，对应本地 `company_industries` 中的行业关联。

目录格式 v2 的每个公司条目必须包含 `locations`；内置内容版本为 6，包含 1,879 家公司及对应工作地点。目录内容版本与数据库结构版本独立。
