# 统一诊断系统

## 范围与版本

日志结构版本为 `1`，与客户端版本、SQLite `user_version`、配置 `configVersion` 独立管理。业务数据库和配置的升级、备份导入使用各自的正式版本迁移链。

日志读取与导出仅接受当前事件结构。旧文件只用于判断是否符合安全清理条件，不转换为当前事件；业务操作名不采用白名单。增加业务操作、错误码或可选属性不升日志版本；核心字段不兼容变更才升版。

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

## 岗位发现

岗位发现使用 Chromium 的系统网络模式，网络错误由采集、扫码、账号检查或页面加载的对应诊断边界记录，并保留原始异常原因。URL 形状拒绝由 `discovery.<platform>.network-check` 记录。不再提供独立代理层及 `discovery.connection` 事件；不记录请求/响应头、Cookie、二维码、正文或代理认证材料。网络职责见[岗位发现说明](job-discovery.md)。

`DISCOVERY_UNAVAILABLE` 表示桌面运行时或受控管道暂不可用，`DISCOVERY_FAILED` 表示发现服务执行失败。`DISCOVERY_JOB_OFFLINE` 表示已确认岗位下架并完成发现数据清理，UI 展示“已下架”，受控管道保留该错误码供 MCP 识别；它不是网络或登录失败。来源业务状态（登录限制、验证码、查询范围未验证、超时等）作为结构化结果返回，不把平台阻断伪装成空结果。二维码组件区分 network/protocol/verification，只展示固定提示；诊断与测试报告不记录 Cookie、登录令牌、二维码图片或临时扫码标识。接口与验收范围见 [岗位发现说明](job-discovery.md)。

猎聘二维码状态包含 `verification.available`、`verification.window`（closed/loading/ready/error）及固定的窗口错误原因（unavailable/network/blocked/blank/timeout/site_error）。`site_error` 包含 HTTP 错误及 HTTP 200 的“页面不存在”错误页；只有可见的验证码交互节点才进入 ready，图片、返回首页按钮或页面标题不能单独作为依据。猎聘请求与页面的浏览器标识不含应用产品名，包含真实 Chromium/Electron 版本；窗口使用网站标题，官方 URL 不附加应用参数。这些 UI 状态不作为认证成功证据；加载完成和用户关闭窗口都不代表通过网站验证或登录。服务端验证地址及查询参数只在 Main 内存使用，不通过 IPC、MCP、错误消息或诊断日志返回。测试报告只记录验证地址的 origin/path，不保存查询参数。

普通重启保留平台上次确认的状态、时间及证据，`session_recheck_required` 表示本次运行还未复核；`authentication_check_inconclusive` 表示页面未提供充分证据，不能据此清除既有确认记录。备份恢复才清除导入的平台确认元数据，本机 Chromium 会话文件不受影响。

专用查询返回固定来源原因：`control_not_found`、`city_selection_not_confirmed`、`query_not_observed`、`pagination_not_confirmed` 分别表示官方控件、单地点选择、查询响应和源页码未核实；`response_contract_changed`、`batch_accounting_mismatch` 表示外部响应或数量契约失败；`batch_save_failed` 保留未提交批次供重试。`cursor_expired_restarted` 明确告知重新提交官方查询，`no_growth` 只表示连续批次无增长，不能等同网站末页。前程无忧搜索响应含官方 `aliyun_waf_aa` 验证标识时归为 `challenge`，不归为普通 JSON 解析失败。

单条岗位解析失败记录 `discovery.<platform>.parse-skipped`，属性仅含批次条目数及失败数；解码器抛异常时另以 `discovery.<platform>.item-parse` 记录脱敏异常，级别为 warn。猎聘、前程无忧城市过滤记录 `discovery.<platform>.city-filtered`，包含过滤前有效条目数及排除数。部分条目跳过不产生用户提示；非空批次全无有效岗位身份或响应无法识别时，以 `parse_error / response_contract_changed` 停止该来源，真实空列表及过滤后为空不触发。`response_too_large`、`batch_accounting_mismatch` 和响应体读取失败归入 `network_error`。不写入岗位原文、请求响应正文或认证材料。过滤前身份保留在内存批次中，用于缓存、预算和无增长判断，不持久化为数据库字段。

BOSS 的有效岗位缺少薪资文本时返回 `session_expired`，当前批次不入库，通过人工处理队列提示重新扫码登录；“面议”和真实空列表不触发该状态。当前查询响应确认的登录或验证阻断优先于后续控件缺失，取消及其他明确错误按各自原因记录。

网络预检的 `WEB_INVALID_URL` 区分“网页地址过长”“网页地址无效”和协议、端口或地址格式限制。URL 最长 10240 字符；HTTP/HTTPS、80/443 端口、禁止内嵌凭据及公网地址校验分别执行。页面统计上报、WebSocket 等子请求同样受网络规则约束。`network-check` 记录单个请求校验失败，不能根据其条数推断岗位数量或整轮搜索失败；采集结果以 `collect.<state>` 及来源进度为准。日志不包含请求参数或认证材料。

采集每轮结束记录 `discovery.<platform>.collect.<state>` 及岗位数、跳过数和本轮批次数，用于区分正常预算停止与异常；失败保留 `discovery.<platform>.collect` 的具体异常。扫码失败记录 `discovery.<platform>.qr`，扫码验证窗口失败记录 `discovery.<platform>.qr-verification`；搜索验证复核复用采集日志。网络预检和页面加载分别记录 `network-check`、`navigation`。管道服务端拒绝/执行失败、连接重试、启动锁及清理异常记录在 `discovery.broker.*` 下，包装错误保留 cause。正常启动时尚无管道描述文件只记录 startup 事件，不作为异常。IPC/MCP 继续负责上抛异常的最终记录；纯计算和 Repository 不重复建立日志入口。人工验证成功后的续跑沿相同采集日志记录，取消仍为操作结果。
