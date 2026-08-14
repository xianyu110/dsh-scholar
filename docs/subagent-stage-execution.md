# 阶段感知 Subagent 执行规范

> 规范版本：1.0  
> 更新日期：2026-08-15  
> 状态：部分实现、未完成验收。当前已实现 Survey/Idea/Evidence/Writing/Review 的确定性 policy、基础阶段准入、one-shot lifecycle、内部 topology 回写、结构化 draft 聚合、进程内并发/幂等与 fan-in revision 检查；十阶段覆盖、可信 Human confirmation receipt、原子预算预留/四桶对账、持久化幂等恢复、完整 provenance 与真实 DSH/browser 验收仍未完成。

本文规定 DSH Scholar 如何在不改变 Research Kernel 权威边界的前提下，按研究阶段启动 DSH subagent 加速读取、检索、审阅和草稿生产。实现完成前，产品不得宣称已经支持自动阶段并行。

## 1. 权威边界

阶段 subagent 是观察性计算单元，不是第二套研究编排器：

- Research Kernel 的 Project、NextAction、Gate、ExperimentContract、Job、Evidence、Claim、Manuscript 与 Release 状态仍是唯一权威；
- DSH Session/child topology 只记录执行过程、摘要、状态和安全引用，不能推进研究阶段；
- child 只能返回 observation、proposal、draft、review_finding 或 diagnostic；这些输出未经确定性校验、权威服务或 Human Gate 接受前没有正式效力；
- 浏览器首版只能查看 topology、history 和安全摘要，不能直接 spawn、stop 或 cancel child；启动动作来自 exact live parent Agent 的显式用户请求或已授权的阶段动作；
- 正式实验由 Runner Job 执行，可信统计由 Analysis Worker 生成，accepted Evidence 由 verifier/auditor 服务产生，不能以 child 输出替代。

## 2. 阶段并行矩阵

| 阶段 | 并行价值 | 适合交给 subagent 的任务 | 允许输出 | 必须保持串行或权威的边界 |
|---|---|---|---|---|
| Init | 中 | 多附件分类、OCR/解析结果检查、资料摘要、缺口提取 | observation、Grill 问题候选 | 单题 Grill 顺序、Brief 确认、Scope Gate |
| Survey | 高 | 查询分片、来源分片、论文初筛、方法/数据/指标提取、引用核查 | corpus candidate、review finding | 去重、来源策略、CorpusSnapshot 固化 |
| Idea | 高 | 多路线候选、novelty、可行性、成本、风险、可复现性独立审阅 | proposed IdeaCard、review finding | Idea 选择、Idea Gate、状态推进 |
| Reproduce | 高 | 多论文/claim 并行审查，代码、数据、环境、指标映射预检查 | plan fragment、diagnostic | 单个 Attempt 的确认→执行→比较→报告，计划确认 |
| Contract | 中 | 合同候选、指标/seed/预算/统计功效/停止条件审阅 | contract candidate、review finding | Contract 注册、冻结、Contract Gate |
| Experiment | 中 | 实验计划、seed/ablation 矩阵、运行监控、失败归因与诊断 | job proposal、diagnostic | Job admission、快照/合同钉定；真实计算使用 Runner 并行而非 child 宿主执行 |
| Evidence | 高 | 独立 contract×metric 分析、数字/图表/来源复核 | draft analysis、review finding | accepted Evidence、Claim 支撑关系与审计结论 |
| Writing | 高 | 章节草稿、图注、相关工作、限制、引用与数字一致性检查 | manuscript patch、draft | canonical manuscript 合并、版本写入、TeX 编译快照 |
| Review | 高 | claim、数字、引用、license、AI usage、artifact、clean-room 专项审阅 | review finding | 缺陷聚合、release readiness 与最终决策 |
| Release | 中 | manifest、hash、license、引用、artifact 完整性核验 | release finding | Bundle 冻结、Release Gate、发布 |

默认优先落地 Survey、Idea、Writing、Review 四个高收益面板；当前另有 Evidence 的只读诊断 policy。Init、Reproduce、Contract、Experiment、Release 尚未接入，不能由未知 action 猜测启动。Experiment 的计算并行由 Runner 的 seed/ablation Job 完成，subagent 只辅助规划、监控和诊断。

## 3. 阶段准入

每次 fan-out 前必须冻结并校验：

1. project_id、session_id、project revision、主 NextAction.id/revision、phase、pending Gates；
2. CorpusSnapshot、CodeSnapshot、Contract、runner target、provider/model/config revision/hash 等本次任务实际依赖的引用；
3. exact live parent Agent、project membership、Agent role 与 tool capability；
4. 对应 phase/action 已登记到确定性 allowlist，配置已启用且预算、并发和深度仍有余量；
5. 主 NextAction 为 ready，项目不处于 BLOCKED_GATE、relink、归档或 revision 冲突状态；
6. 本次调用来自用户明确要求或由父 Agent 展示并确认的阶段加速动作，不能仅凭模型文本静默扩大执行面。

任何一项不满足都 fail closed，返回结构化阻断原因和下一步，不创建 child、不扣费、不改变 Research 状态。重试使用新的 attempt/node；同一个 idempotency key 与输入 hash 只允许一次预算预留和一次 fan-out。

当前 `research_panel` 不再接受模型自报的 `user_confirmed`；DSH `tools/pre-execute` 必须返回 Host `ask`，无 approval provider 时自动 deny，只有人工批准后才进入 coordinator。该确认尚未形成持久化、session/action/revision 绑定的 receipt，因此 explicit-authority 的 durable provenance 仍未关闭，能力继续默认关闭。每个 child 还必须绑定创建时的 project scope，所有允许工具都拒绝显式跨项目 ID/job ID，不能只在 spawn 与 topology 层校验 session。

## 4. Fan-out / Fan-in 流程

阶段执行采用一个薄的 StageAwareSubagentPlanner / PanelDispatcher，位于 DSH 插件适配层；standalone Research Orchestrator 只维护权威 NextAction 与 Gate，不直接依赖 DSH runtime。

1. 父 Agent 请求阶段面板，Planner 读取最新权威投影并执行 §3 准入；
2. 确定性 policy 把 phase + action 映射为 panel kind、roles、perspectives、model、tool filter、output schema 和限额；
3. 服务端先原子预留预算、fan-out 数与并发槽，再启动 child；
4. 每个 child 使用 DSH 公开 ctx.subagents.start('spawn', request) 一次性运行，默认 maxDepth=1，传入 exact parent、同一 AbortSignal、最小 tool filter 和结构化 output schema；
5. child 启动后立即调用 registerChildLink 写入 observational topology 的 running 节点；
6. 父级以 Promise.allSettled 收集结果；每个路径都在 finally 调用 run.dispose()，并将 terminal state、stop reason、安全摘要、usage/cost 和引用通过 updateChildState 回写；
7. 聚合器进行 schema 校验、脱敏、大小限制、provenance 检查和去重，只保留 draft/observation/finding；
8. fan-in 后重新读取 session link、project revision、NextAction 和 pending Gate；发生变化时结果只进入过期诊断记录，禁止写权威对象；
9. 允许的正式写入必须重新调用对应 Kernel operation，由其执行 CAS、idempotency、权限和领域不变量校验；
10. 预算按实际 usage 对账并释放剩余预留；父子 token/cost 不得重复计数。

DSH stop reason 必须显式映射：completed → succeeded；aborted → cancelled；error|max-tokens|refusal|unknown → failed。未知状态不能猜测为成功。

超时与取消必须以 AbortSignal 优先：signal 已取消时，即使 provider 延迟返回 `completed` 也只能记 `cancelled`。`start()`、`result`、terminal update 与 `dispose()` 都必须有有界等待；非协作 provider 不得永久挂起父 panel，terminal update 卡住也不得阻塞 dispose。结构化输出只有通过 schema、大小和脱敏校验后才可把节点置为 `succeeded`。fan-in 发现 session/revision/action/Gate 变化时不得把旧 structured members 返回给当前 session。

## 5. DSH 公开接口约束

首版只使用 @deepseek-ai/dsh-subagent 暴露的稳定 SubagentRuntime，不依赖 DSH 内部 continuation/lifecycle 类。标准模式为：

~~~typescript
const run = await ctx.subagents.start('spawn', request)
try {
  const result = await run.result
  // validate, redact, hash and aggregate
} finally {
  await run.dispose()
}
~~~

- spawn 是阶段面板默认 provider：上下文新鲜、一次性、容易限制 tools/depth/schema；
- fork 会继承更宽父上下文，首版禁止作为默认值；
- continuable 只在后续为诊断 follow-up 单独设计，并要求 exact live parent、独立 Capability 与审计；
- child approvals 不存在，因此 tool filter 必须排除 Gate、Runner 正式提交、Evidence 接受、Release、Secret 与任意宿主命令工具；
- cancellation 必须贯通父请求的 AbortSignal，dispose 必须幂等且在启动成功后的所有路径执行。

## 6. Topology 与阶段投影

复用现有 child_links、child history、trajectory session lane 与 Topology UI，不新增第二套 subagent 数据模型：

- node 至少显示 stage/action、role/perspective、parent、mode、state、duration、四桶 token、cost、attempt 和安全摘要；
- registerChildLink 与 updateChildState 是 DSH runtime 生命周期到 Scholar 观察性投影的桥；
- 页面可显示每阶段 running/succeeded/failed/cancelled 数量，但数量只能用于可见性和诊断，不能决定 phase 或 NextAction；
- 进入 child、breadcrumb、history 与 follow-up 遵循 trajectory-subagents.md；冷读取不激活 Agent；
- retry 是新 child node，旧节点保持不可变终态；orphan、cycle、断连和未知 stop reason 均 fail-soft 展示、fail-closed 写入。

## 7. 预算、并发与恢复

- fan-out 前原子预留预算；若达到模型、GPU/Runner、项目或全局 hard limit，拒绝新 child，并在需要 Human 决策时创建 Budget Gate；
- 配置 max_concurrency、max_fanout_per_action、max_depth、timeout 和 max output bytes，不能只依赖前端按钮防抖；
- usage 完成后按 provider 返回的四桶 token 与 cost 对账；未知 cost 保持 unknown，不用估算值冒充实账；
- 父请求取消时停止创建新 child，取消运行中 child，等待 terminal state/dispose，并释放未消费预留；
- DSH/网络中断后以 topology + idempotency record 恢复；不能因为 child 状态 unknown 自动重放可能产生费用的任务；
- 部分成功使用 allSettled 返回每个 perspective 的状态；聚合器不得把缺失分片静默当成完整结果。

## 8. 权限、Secret 与 provenance

- prompt、output、summary、history、SSE、日志和 Bundle 都不得包含 service token、SecretRef value、SSH key、endpoint、cookie、Authorization、DSH_HOME、cwd、绝对宿主路径或完整 tool arguments/results；
- child 输入使用字段 allowlist 和 opaque refs，按最小项目、阶段、快照与工具权限裁剪；
- 保存安全输出 hash、输入/策略版本、project/NextAction revision、snapshot/config/model/provider pins、parent/child/attempt ID 和时间；
- Idea panel 的结果只能是 proposed，Writing panel 只能是 draft/patch，Evidence panel 只能是 draft analysis；
- child 不能批准 Gate、创建 accepted Evidence、把 Claim 标为 supported、写 canonical manuscript 数字、提交正式 Runner Job、adopt Intake、删除项目或发布；
- role/membership/relink/revision 在 fan-in 后必须重新校验，防止长任务结果跨项目或跨 session 回写。
- task、completion、perspective 在进入 provider prompt 前同样必须做 secret/path/credential 脱敏；只清理输出不能修复输入泄漏。

## 9. 配置契约

所有行为进入版本化 Config Registry，并由同一 schema 生成配置校验与 Settings UI。最小配置面：

~~~yaml
subagents:
  enabled: false
  provider: spawn
  maxConcurrency: 4
  maxFanoutPerAction: 6
  maxDepth: 1
  timeoutMs: 300000
  maxOutputBytes: 131072
~~~

以上是当前严格 schema；未知字段会被拒绝。`roleModels`、phase policy 覆盖、browser spawn 与 budget reservation 等仍是目标字段，尚不能写入当前配置。默认 fail closed：`enabled=false`，未配置的 phase/action 不启动，深度为 1，tool filter 为空不等于允许所有工具。当前 config hash 只覆盖上述 subagent 配置，尚未完整固定 model/provider/snapshot pins。

## 9.1 合并前安全修复约束（2026-08-15）

- 所有 `/internal/*` 路由必须按解析后的 canonical route 进入 service-token gate；百分号编码或重复斜杠不得绕过鉴权；
- internal topology 注册必须拒绝把既有 child id 从其他 project/parent 重新绑定，终态不得通过 re-register 复活；
- migration `0024_topology_cancelled_state` 必须在已有 child history/followup 的旧库升级时保留三表数据、索引和外键完整性；
- child project scope、timeout/cancel、terminal update/dispose、stale fan-in 与 prompt redaction 的负向自动测试必须通过后才可合并；
- 原子预算预留、durable idempotency 和 Human confirmation receipt 未实现前继续保持“部分”、默认关闭，不得作为生产安全能力宣传。

## 10. 实施顺序

1. **P0 生命周期闭环**：修复现有 research_panel，补 run.dispose()、register/update topology、stop reason、取消、结构化输出和错误回写；
2. **P0 阶段准入**：新增确定性 Planner、revision/NextAction/Gate/session fencing、idempotency、并发与预算预留；
3. **P1 高收益面板**：Survey、Idea、Writing、Review，先产出 draft/finding，再由父 Agent 或权威服务聚合；
4. **P1 领域扩展**：Init、Reproduce、Contract、Evidence、Release；Experiment 明确接 Runner Job fan-out；
5. **P2 可恢复诊断**：在 exact-parent 和 Capability 完成后增加受限 continuable follow-up；
6. **P2 人工验收**：真实 DSH host、模型 provider、取消、预算、断线恢复、Topology 浏览器、i18n/a11y 与 secret redaction。

任何阶段在对应 acceptance 场景通过前只可标记“部分”或“已实现未验收”。
