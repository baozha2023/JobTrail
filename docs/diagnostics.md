# 统一诊断系统

## 范围与版本

当前日志结构版本为 `1`，与客户端版本、SQLite `user_version`、配置 `configVersion` 分开管理。本次不变更业务数据结构。正式客户端升级和旧业务备份导入仍调用原来的版本迁移链。

旧日志保留、读取转换、导出兼容和业务操作白名单方案已经废止。旧文件只被识别为“是否可安全清除”，不会解析成新事件。增加业务操作、错误码或可选属性不升日志版本；核心字段不兼容变更才升版。

## 模块边界

| 模块                                          | 责任                                                                  |
| --------------------------------------------- | --------------------------------------------------------------------- |
| `shared/error-codes.ts`                       | 唯一错误码注册表：级别、分类、UI 文案键                               |
| `shared/diagnostics.ts`                       | 无 Electron、文件系统、Vue 依赖的事件契约、验证、脱敏、异常标准化     |
| `main/diagnostics.ts`                         | 公共入口、AsyncLocalStorage、早期缓冲、请求内去重、子进程 stderr 校验 |
| `main/diagnostics/writer.ts`                  | 每进程文件、缓冲、轮转、聚合、备用 stderr、健康计数                   |
| `main/diagnostics/storage.ts`                 | 文件归属、维护锁、旧文件清除、保留期限和空间预算                      |
| `main/diagnostics/export.ts`                  | 文件边界快照、二次脱敏、ZIP 与哈希验证、原子替换                      |
| `main/ipc/diagnostics.ts`                     | 设置页的日志目录与诊断包导出接口                                      |
| `preload/index.ts`、`renderer/diagnostics.ts` | IPC 确认与重试、前端异常上报、安全错误引用                            |

业务服务不创建日志文件、不负责 JSON 序列化、不维护错误过滤名单。Velopack 和 Rust 启动器日志属于独立原生运行时，不转换成应用日志。

## 公共入口与记录责任

```ts
const result = await runOperation({ operation: 'catalog.refresh' }, async () => {
  return await refreshCatalog()
})

// 当前层决定恢复时记录；原样上抛时由外层记录。
try {
  await cleanup()
} catch (error) {
  captureError(error, { operation: 'catalog.cleanup' })
}
```

`captureError` 返回 `{ eventId, traceId, spanId, parentSpanId? }`。已处理失败的跨进程响应传播该引用，不传播异常对象。`runOperation` 记录开始、结果和耗时；正常取消使用 `cancelled`。`recordEvent` 只接收定义好的事件字段与受限属性。

业务错误使用 `AppServiceError(code, message, details?, { cause })`；不要丢弃原始原因。主事务与回滚失败一起放入 `AggregateError`。当前层已经恢复、重试、降级的异常必须记录；原样重新抛出的异常交由最终边界处理。全局监听只兜底，不能替代业务接入。

同一 trace 内的同一异常去重；不同请求复用同一个 Error 仍分别记录。传输重试保留 eventId。Node 使用 AsyncLocalStorage；IPC 信封、worker 请求、内置 MCP `_meta` 显式传播上下文。外部 MCP 请求没有上下文时创建新 trace；SDK 在工具执行前进行的参数校验也独立记录。所有诊断 ID 都不参与业务授权。

## 协议与信息边界

文件头声明 `format: jobtrail-diagnostics`、schemaVersion、进程、PID、实例 UUID 和创建时间。事件包含时间、级别、kind、operation、客户端版本、进程/PID、写入实例、序号、eventId、trace/span、错误与结果。Renderer/Preload 由 Main 接收，PID 由受信任 WebContents 决定，使用接收器写入实例及序号。Worker/MCP 有自己的写入实例。

属性仅允许耗时、计数、尝试次数、退出码、结构版本及关联事件 ID。新增属性需同时添加类型、边界校验及契约测试，不能改为 `Record<string, unknown>`。

- message 最多 4 KiB，堆栈最多 20 帧，cause 最多 5 层，聚合项最多 10 项，异常树另有总节点预算；单事件最多 32 KiB。
- 先脱敏再截断。移除已登记模型密钥、认证头、Cookie、令牌、URL 凭据和查询值、机器绝对路径，保留应用/依赖相对堆栈。
- 不调用异常的任意 getter、toJSON 或自定义字符串转换；只读取数据描述符及运行时原生 stack accessor。
- JSON 解析和 Zod 校验错误可能夹带用户输入，因此保留失败类型与原因位置，替换其正文。
- 不采集 SDK 完整异常对象、请求响应正文、配置、环境变量、简历、聊天或作答。自由文本脱敏不可能识别任意隐私，调用者仍须遵守数据边界。
- 跨进程接收和导出重新校验、脱敏；不信任生产者的“已脱敏”标记。

已知校验/不存在/冲突错误默认 warn；密钥缺失、网络、文件、数据库及未知异常为 error；进程无法继续时 fatal；取消为 info。未知错误使用 INTERNAL_ERROR 并保留脱敏原因、原始外部 code 和堆栈。UI 只读取注册表国际化键，追加错误码和完整 eventId。

## 文件生命周期与故障状态

文件名为 `<process>-<pid>-<instance>-<segment>.active.jsonl`，关闭后变为 `.closed.jsonl`。分片上限 5 MiB，默认保留 14 天，目录目标 50 MiB。每进程独立文件避免相互覆盖和 PID 重用冲突。

普通事件最多缓冲 1 MiB、100 ms，warn/error/fatal 优先写。同类事件在 10 秒窗口保留前 100 条，其后聚合代表事件、首末时间及次数；汇总以 `diagnostics.aggregate` 记录。健康状态同时累计 aggregated。窗口和去重缓存有固定上限。

写盘失败转向脱敏 stderr，并计入 writeFailures；安装版主进程接收子进程备用记录时保留原 eventId 和 trace，并在独立文件中保存、计入传输降级；备用输出也失败时计入 dropped。部分写入的分片停止追加，恢复后开启新分片，记录 `diagnostics.recovered`。早期初始化之前有界缓冲并输出 stderr。关闭、更新退出和导出前刷写。强杀、断电、所有输出设备失效可能丢失记录，不承诺零丢失。

回执区分 written、buffered、fallback、unavailable、duplicate；buffered 仅表示已接收。Preload 等待确认，最多重试一次，每次最多 2 秒。失败会产生带传输降级标记的脱敏备用记录。日志内部失败不得反向改变已经成功的业务结果。

维护在启动、定时和导出前进行，使用独占锁。仅处理日志目录内符合应用命名规则的普通文件；拒绝链接和目录外路径。确认的旧无版本文件删除，当前文件正常保留，未来版本和未知/损坏文件跳过。仍存活进程的活跃文件延期清理。仅关闭或已退出进程的分片参与保留清理；活跃文件导致超额时暴露 overBudget，不强删。

内部健康状态提供 degraded、writeFailures、transportFailures、dropped、aggregated、deletedFiles、maintenanceFailures、skippedFiles、overBudget，并写入诊断包清单供排查。跳过、失败和累计缺失均为诊断证据；不要把“没有异常提示”当作日志完整的证明。

## 设置页和诊断包

设置页提供 `diagnostics.openDirectory()` 打开日志目录，以及 `exportBundle()` 让用户选择 ZIP 目标，仅导出最近 24 小时的当前结构记录。页面不显示或查询日志健康状态，也不提供刷新日志状态按钮。取消不产生失败提示。

ZIP 包含日志及 manifest：应用/Electron/Node/系统/架构版本、数据库/配置结构号、健康状态、清理与跳过统计、损坏/半行计数、文件大小及 SHA-256。不包含业务数据库、配置、附件、环境变量，不自动上传。

导出按文件长度快照读取，不冻结业务数据库，容忍轮转、文件消失和末尾半行。目标目录生成临时 ZIP，读取并验证每个文件哈希，成功后替换目标；失败保留之前的目标。文件句柄关闭后清理临时文件。日志目录本身不可作为导出目标。

## 扩展和排查

新增错误码：注册 code、默认级别、分类及 UI 键；UI 可见码补中英文翻译；测试代码到文案和默认策略的对应关系。不要在组件或日志引擎新增业务特例。

新增操作：选择稳定、非用户生成的点分名称，在最终边界调用公共入口，传递已有上下文；需要事件属性时使用受限类型。原始异常用 cause 保留，用户提示经全局 message 展示。

用户提供诊断编号后，搜索 JSONL 的 eventId；再按 traceId 和 relatedEventId 连接主进程、worker、MCP 的过程。先看健康和导出清单，确认是否有降级、聚合、缺失、损坏行或跳过文件，再判断失败原因。不要索取整个数据目录来替代诊断包。

契约验证覆盖异常树、危险 getter、秘密和路径过滤、错误码、请求隔离、传输去重、文件故障恢复、轮转聚合、维护锁、旧文件清除、ZIP 内容和目标保护。发布前还须运行完整业务测试、真实 Electron 包测试及旧客户端/备份迁移矩阵。
