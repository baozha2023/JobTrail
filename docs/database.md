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

1. `user_version=0`：在一个 `IMMEDIATE` 事务内创建下述 15 张表和 15 个显式索引，写入种子数据，最后将 `user_version` 设为 1；失败时整笔事务回滚。
2. `user_version=1`：正常打开，不再次建表或写入种子数据。
3. 其他版本：抛出 `DatabaseVersionError` 并关闭连接；不尝试修改或降级原数据库。

当前代码只处理新库与结构版本 1，没有数据库迁移流程。`config.json` 的 `configVersion=1` 独立于 `user_version`；内置公司目录的 `catalog_version` 也独立于两者。

配置只接受完整、严格的当前结构，包含 `configVersion`、`themeMode`、`statusFlowTheme`、`locale`、`closeBehavior`、`launchAtStartup`、`companyReadValidityMonths`、`mcp`、`ai`。嵌套字段以 `AppConfig` 为准，所有层级均拒绝缺失或未知字段；不保留 `velopack` 配置。默认值仅在整个配置文件不存在时创建，设置的局部更新须合并为完整配置后保存。无效或不支持的配置保留原文件并拒绝启动，备份导入使用相同校验。

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

### 状态与行业

`statuses` 保存求职状态，以 `is_builtin` 标记内置数据；`industries` 保存固定两级的行业树，以 `builtin_key` 是否为空推导内置属性。两表均使用 `sort_order` 表示显示顺序，行业顺序限定在同级内。

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
| `deleting`          | INTEGER | 非空、默认 0、仅 0/1 | 会话删除待清理标记                |
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

## 显式索引

以下是 `DatabaseManager.initialize()` 创建的全部 12 个显式索引。主键与唯一约束由 SQLite 自身维护，不重复列在此表中。

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

## 逻辑关联与写入边界

| 保存方字段                                                                                                   | 目标                     | 维护方式                         |
| ------------------------------------------------------------------------------------------------------------ | ------------------------ | -------------------------------- |
| `company_industries.company_id`、`company_aliases.company_id`                                                | `companies.id`           | 公司服务在删除公司时清理关联     |
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
- 一条 `builtin_company_catalog_state` 记录，`format_version=1`，`catalog_version` 来自打包目录的 `catalogVersion`，`content_sha256` 为目录 JSON 原始文本的 SHA-256。

版本 1 数据库再次打开时不会重新 seed，也不会在软件升级时自动合并公司目录。用户在设置中主动更新目录时，应用校验发布资产的大小、SHA-256、格式、目录版本和最低软件版本。更新在一个 `IMMEDIATE` 事务中按 `builtin_key` 匹配，更新目录拥有的名称、招聘官网、行业和别名，保留本地公司 ID、创建时间、收藏、已读时间及业务关联。行业关联和别名按差异维护：未变化的记录不写入，值替换时更新原记录，只有实际增减时才插入或删除；同名的用户公司可转为内置公司。新目录未收录的旧内置公司保留。冲突或约束错误会回滚整次同步。

目录根结构固定为 `{ formatVersion, catalogVersion, minimumAppVersion, industries, companies }`。行业条目为 `{ builtinKey, parentKey, code, name }`，一级 `parentKey=null`、代码 A–T，二级通过父节点 UUID 关联一级并使用两位标准代码。公司条目使用 `industryKeys` 引用二级 UUID；本地接口仍使用解析后的 `industryIds`。不解析旧目录字段。

行业树与公司关联在同一目录同步事务中更新：先按稳定 UUID 匹配行业，再解析公司的二级引用。已有节点保留本地 ID 与同级排序，新节点追加到分组末尾；移动节点追加到目标分组。目录中的同名新节点遇到自定义行业时整次回滚，不收编或覆盖自定义行业。目录未包含的现有行业保留，不自动删除。

`@行业` 仅提供二级候选，Main 校验层级并重新解析完整的“一级 / 二级”路径。MCP 与 IPC 共用行业业务服务。备份导出、导入还校验父子关系、公司二级引用及内置公司的非空行业关联。

1.0.0 发布前开发库在停止客户端、智能体和 MCP 后，于应用外备份并一次性重建行业与公司关联，同时清空六张聊天表及聊天附件；不修改其他业务数据。应用、构建与已提交测试不包含开发数据迁移或 `ALTER` 流程。正式发布后冻结本版持久化基线，未来版本变更再设计升级迁移。
