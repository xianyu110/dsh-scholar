# Trajectory 与 Subagent 拓扑规范

> 规范性文档。本能力移植 DSH Web 的轨迹折叠、时间线、虚拟列表与子代理目录语义，但不复用 DSH Web slot、客户端运行时或原始事件暴露面。Scholar standalone 只通过同源 BFF 工作。

## 1. 两种轨迹与权威性

- **Research Trajectory**：来自 Kernel Outbox，展示 Project/Gate/Job/Run/Artifact/Evidence/Manuscript/Release 的权威业务轨迹；
- **Session Trajectory**：来自 DSH/Agent session adapter，展示消息、工具和 subagent 的运行过程，仅用于观察与导航；
- 两者通过安全的 `project_id`、`kernel_event_id`、gate/job/run/artifact refs 关联，但绝不复制 TerminalLog、Artifact bytes、TeX/source/data 或 raw secret；
- UI 必须明确标记 `authoritative` 与 `observational`，不得把 Session 事件当成科研事实。

## 2. Trajectory Module

Trajectory 是只读投影 Module。Kernel Outbox 仍是唯一业务账本；Session Adapter 可丢失或过期，不影响项目恢复。

~~~typescript
type TrajectorySource = 'kernel-outbox'|'dsh-session'|'external'
type TrajectoryNodeStatus =
  | 'queued'|'running'|'waiting'|'succeeded'|'failed'|'cancelled'
  | 'expired'|'redacted'|'unknown'

interface TrajectoryNodeSummary {
  node_id:string
  trajectory_id:string
  project_id:string
  parent_node_id:string|null
  relation:'root'|'child'|'fork'
  kind:'session'|'subagent'|'task'|'research-event'
  source:TrajectorySource
  label:string|null
  mode:'one-shot'|'continuable'|'read-only'|null
  status:TrajectoryNodeStatus
  has_children:boolean
  children_count:number|null
  started_at:string|null
  ended_at:string|null
  duration_ms:number|null
  tokens:{uncached_input:number;cache_read:number;cache_write:number;output:number}|null
  cost:{currency:string;amount:number;estimated:boolean;known:boolean}|null
  refs:Array<{kind:string;id:string}>
  permissions:{can_read_summary:boolean;can_read_detail:boolean;can_continue:boolean}
  retention:{retained_until:string|null;redacted:boolean;dropped_bytes:number}
}
~~~

Token 四桶互斥，reasoning 已属于 output；父节点汇总不得与子节点重复计费。运行时 duration 只累加 active interval，inactive 后冻结。未知 provider/status/usage 原样标 unknown，不猜值。

## 3. Subagent 地址、树与进入

子代理的稳定地址为 `{parent_session_id, child_session_id, mode}`。list 只返回 exact direct children，且只接受 `origin=subagent`；普通 fork 停止 subagent 后代聚合。目录读取和历史读取不得激活 Agent。

树节点至少显示：role/label、one-shot/continuable、running/inactive/diagnostic、开始/活动时长、四桶 token、估算 cost、children 状态和失败摘要。交互要求：

- 展开时懒加载直接子项；支持任意深度、cycle-safe、orphan fail-soft；
- 点击或 Enter 进入 child 详情，顶部 breadcrumb 可逐级返回 parent；
- 内部 route 使用 opaque project/trajectory/session IDs，可复制深链；不得把 Token、prompt、cwd 或宿主路径放 URL；
- one-shot、diagnostic、parent offline 或无权限时只读；
- continuable 只在 server 再次校验 exact live parent、child mode、project membership 和 capability 后允许 follow-up；接收只返回 message_id，不冒充已执行；
- 浏览器首版不提供 spawn、stop 或 cancel subagent；未来写操作需独立 Capability 和审计，不能从展示权限推导。

进入 child 后默认显示安全摘要、消息时间线、工具名/状态/耗时和安全输出 preview。原始工具参数、结果、prompt、环境变量和 provider detail 默认不返回；有 `trajectory_detail_read` 时也先经过结构化 allowlist、redaction 与大小限制。

### 3.1 阶段执行与拓扑接线

阶段并行只复用本规范的 observational topology，不新增一套研究状态机。DSH 插件的 StageAwareSubagentPlanner 在权威 NextAction 通过准入后启动 one-shot child；启动即 registerChildLink(state=running)，完成、取消或失败后 updateChildState，每条成功启动路径都在 finally 调用 run.dispose()。retry 必须创建新 node，终态 node 不复活。

Topology node 可增加 stage/action、perspective、attempt 和安全输入/输出 hash，但 Research phase、NextAction、Gate、Evidence 与 Release 只能来自 Kernel Research Outbox。页面中的 running/succeeded/failed/cancelled 计数是观察性投影，不能反向推进 Project。阶段矩阵、准入、预算、tool filter、provenance 与实施顺序见 subagent-stage-execution.md。

DSH plugin 的 lifecycle bridge 只走 service-token + `x-service-principal: dsh-plugin` 的 internal route，并再次校验 session→project 与 exact parent。route 规范化必须先于 service-token 判定；child id 已属于其他 project/parent 时禁止重绑，terminal state 单调且同状态重放幂等。`cancelled` 由 migration 0024 追加为 durable terminal state；旧库已有 history/followup 时迁移必须保留外键引用与审计行。

## 4. 事件、历史与实时恢复

统一事件 envelope：

~~~typescript
interface TrajectoryEvent {
  event_id:string
  event_seq:number
  event_version:1
  trajectory_id:string
  project_id:string
  node_id:string
  parent_node_id:string|null
  type:string
  source:TrajectorySource
  occurred_at:string
  payload:Record<string,unknown>
}
~~~

- `(trajectory_id,event_seq)` 唯一，event_id 幂等；终态不可逆，retry 是新 attempt/node；
- history 使用 message/event-aligned cursor 分页；tail 可以带 partial 和当前 projection，但不得激活 cold child；
- SSE 使用 `after_seq`、subscribed baseline、seq 去重、gap、reconnect/resync、bounded queue 与 retention metadata；AuthZ 被撤销立即关闭；
- raw detail 超限时写 session-scoped CAS spill，返回有界 head/tail preview、sha/size/ref/TTL；spill 失败必须安全降级且不泄漏；
- Research Outbox 永久保留其规范要求的业务事件；Session raw detail 可 TTL/purge，但 purge 必须产生 redacted/gap 审计。

## 5. DSH Web 可移植边界

可以移植或重写的纯逻辑：

- user/assistant/tool/subtool/context/compaction 的稳定折叠；
- rewind branch、nested subtool、稳定 record ID；
- sequence/duration/time timeline；
- direct-child tree、ARIA keyboard、token/duration fold；
- >100 rows 虚拟化、overscan、prepend scroll anchor、搜索与折叠。

不得直接依赖：Cordis `conversation.view` slot、`dshClient`、DSH SessionHistoryFace、ConversationSnapshot、RequestView、localStorage key、host CSS/composer overlay 或 `/api/subagent.*`。Scholar 必须实现本文 BFF/投影 Adapter；DSH source 只是可选输入。

## 6. UI

主导航保持简洁：Overview 的“研究轨迹”卡可展开；`/p/{project}/trajectory` 提供全屏详情；Agent topology 是其中的 Tree/Graph 切换，也可由 `/p/{project}/topology` 深链打开同一视图。

- 默认显示 root + 1 层和权威研究事件；更深 child 懒加载；
- Tree 显示清晰父子拓扑，Graph 只作为同一数据的可视化 adapter；两者选择同一 node；
- 右侧 inspector 包含 Summary、Messages、Tools、Timing、Usage/Cost、Permissions/Retention、关联 Research refs；
- Session 与 Research 两条泳道颜色/标签不同，状态不能只靠颜色；
- 10,000 节点时 DOM 保持有界，搜索和筛选在 BFF/投影层分页；
- 窄屏使用全屏树→详情 navigation，保留 breadcrumb 和 Back，不强塞三栏。

所有 label、状态、tooltip、aria、错误和空态使用 `trajectory`/`topology` locale namespace，zh/en key 完全一致；用户/模型文本和 raw event message 不翻译。

## 7. BFF 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/bff/research/projects/{project}/trajectories` | source/status/cursor 过滤 root |
| GET | `/bff/research/trajectories/{id}/nodes` | parent_id + cursor，默认 direct children |
| GET | `/bff/research/trajectories/{id}/nodes/{node}/history` | before_seq/max_messages，安全详情 |
| GET | `/bff/research/trajectories/{id}/events?after_seq=N` | snapshot + SSE replay/gap |
| POST | `/bff/research/trajectories/{id}/nodes/{child}/followups` | continuable exact-parent only |

所有全局 ID 先解析 project_id，再做 project membership 与 `trajectory_summary_read`/`trajectory_detail_read`/`subagent_continue` 能力检查。跨项目和隐藏节点统一 404。BFF 不透明转发 DSH raw event 属于实现错误。

Standalone 当前页面使用同源 v1 adapter：`GET /v1/projects/{project}/trajectory`、`GET /v1/projects/{project}/trajectory-lanes`、`GET /v1/projects/{project}/topology`、`POST /v1/projects/{project}/topology/children`，以及 `/v1/topology/{child}*`。这些入口必须先用 standalone operator session 做 project membership 检查，再由 BFF 服务端注入可信 `x-principal-id` 转发给 Kernel；浏览器发送的同名 header 必须忽略。不得只给 child/global 或 SSE 路由注入 identity 而遗漏项目级 JSON 读取，否则页面会把 Kernel 的 `422 principal_required` 表现成桥接错误。普通 JSON 读取、分页读取和 SSE 必须采用同一 principal/membership 契约。

## 8. 存储与验收边界

独立投影表为 `trajectory_roots`、`trajectory_nodes`、`trajectory_events`、`trajectory_cursors`、`trajectory_redactions`；它们可以由 Outbox/Session replay 重建，不得反向成为 Project 状态权威。canonical raw detail 只存加密/CAS reference 与 TTL，不存浏览器可直接读取的任意 JSON。

验收必须覆盖 exact-parent 授权、one-shot 只读、history 不激活 Agent、orphan/cycle/fork、终态单调、token 不双计、SSE replay/gap/revoke、脱敏/TTL、10k 节点虚拟化、键盘/ARIA、zh/en parity，以及 Session/Research 权威标签。实现状态见 hardening-v0.2-status.md。
