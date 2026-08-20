# DSH Scholar 方法论与知识层规范

> 规范状态：已采纳，分阶段实施中
>
> 决策日期：2026-08-20
>
> 决策依据：[methodology-knowledge-layer-proposal.md](methodology-knowledge-layer-proposal.md)
> 当前实现范围：strict Schema、四个纯 Module、append-only SQLite Store、migration `0028_methodology_knowledge_layer`、typed HTTP/Client（含 Research Graph）、standalone compact projection与 DSH exact-session compact summary/工具均已落地；当前真实表为 `assurance_events`、`methodology_project_events`、`methodology_registry_events`，Research Graph 是由这些 typed records 重建的只读投影而非第四张权威表。`runWritingAssurance(...)` 已提供显式 producer dispatch、immutable findings Artifact 与 StageSubagent semantic seam，其中 `claim-evidence` 只有在权威 Claim 集为空时才产生 hash-bound `NOT_APPLICABLE`；未运行 producer 仍是 missing。`ResearchKernel.submitJob(...)` 已对 formal/confirmatory 请求读取持久 Protocol 并调用 evaluator；Runner terminal completion 会在同一事务/outbox 追加 exact attempt/lease/manifest/Protocol 的 execution-only 未分类观察，随后由有权限的 Human/Agent 显式记录 scientific outcome/validity；真实本机 Docker formal positive fixture 已验证 exact `run_manifest.run_id` observation、scientific-only classification 与 replay。Direction adoption route 也已复用 evaluator、当前 Project/NextAction revision，并从 durable approved Decision→专用 `direction` Gate→strict proposal/synthesis/direction payload 与 Human PI/operator membership 解析 verified receipt。生产 Host/model、远端 SSH/GPU、生产 Docker 场景与浏览器人工验收仍未闭环；第三方 vendor、remote Pack source、自动 Release 始终未授权。

> 模块化约束：有状态协调集中在 `methodology-coordinator.ts` 的 Knowledge/Synthesis/Writing 三个深 Coordinator，`ResearchKernel` 只提供稳定 façade 与窄 ports。Synthesis 只能复用 `run-outcome-lifecycle`/`synthesis-admission`，full-auto 只能复用 `full-auto.ts`；任何 adapter 都不得重写 scientific classification、Gate authority 或 semantic reviewer independence。失败必须保留既有事务与零写语义，且不改变 HTTP/Client public wire。

## 1. 目标与权威边界

方法论与知识层帮助用户更严谨地计划、执行、审查和写作，但不建立第二套科研操作系统。Research Kernel 继续唯一负责 Project phase、Gate、Decision、Job、Run、accepted Evidence、supported Claim、canonical TeX、Release、权限、预算和审计。

外部方法只能产生 `proposal | observation | draft | review_finding | diagnostic`。模型文本、第三方 Markdown、Skill 自报结果、Session/Topology 成功状态和审查分数都不能直接推进 Kernel 状态。

本规范吸收以下方法语义，但不复制三个来源仓库的代码、提示词、示例、论文文本、模板、品牌资产或目录结构：

- ARIS：Assurance 三轴、Reviewer Independence、输入新鲜度，以及“执行成功不等于结论通过”；
- AI-Research-SKILLs：Protocol-before-run、受限 inner loop、确定性触发 outer synthesis、explicit/inferred 来源标记；
- Research-Paper-Writing-Skills：章节级最小知识激活、Reverse Outline、Claim–Evidence 检查和 Method Triad。

三个仓库当前统一采用 `METHOD_ONLY`。任何单文件 vendor 都是新的、独立的供应链决策，必须重新核验上游归属、许可、NOTICE、商标、内容哈希和再分发义务；本规范不授予 vendor 权限。

## 2. 已采纳决策

1. 采用 Kernel 权威运行时与非权威 Methodology/Knowledge Layer。
2. Assurance 分为 execution、verdict、acceptance 三轴；`stale` 属于 acceptance，不伪装成 verdict。
3. submission 级语义审查只有 `cross-family` 或 `human` 独立性可以 accepted；`same-model`/`same-family` 最多 provisional。
4. 正式或 confirmatory Run 必须先冻结 Protocol Revision。Run intent、scientific outcome、run validity 三轴正交。
5. Inner loop 只能在已批准 Contract、预算、Runner allowlist、网络策略和 revision 内循环；outer loop 由确定性阈值/事件或 Human 触发。
6. `pivot`、`broaden` 必须由 Human adoption 并复用既有 Gate；`deepen`、`conclude` 也不能绕过现有 Gate 和 NextAction。
7. Research Synthesis 使用 typed header + Artifact body；Research Graph 优先为权威对象的可重建投影，必要关系才保存 typed edge。
8. 外部研究接续只产生 ImportProposal，仍须 Human adoption。
9. 首批写作能力是 Reverse Outline 与 Claim–Evidence 检查；Reviewer Panel 首批角色为 claim、citation、statistics、reproducibility。
10. 建立版本化双通道 Registry：可信、Scholar-owned 的 `Instruction Pack` 与不可信只读 `External Knowledge Pack` 永不混用。
11. Operator 负责注册，项目 Human 显式激活；内置 Pack 同样固定版本与 hash。首版禁止远程 Pack source。
12. 未来若存在真实 runtime consumer，方法论配置归入 `methodology` 与 `knowledge_registry` 命名空间；在 consumer、持久化和来源 parity 完成前不得提前登记占位键。首批 UI 投影为 Overview 摘要、Manuscript Reverse Outline、Topology Audit。

## 3. Assurance 三轴

### 3.1 轴定义

| 轴 | 值 | 语义 |
|---|---|---|
| execution | `queued | running | succeeded | failed | cancelled | timed_out` | 审查活动是否正常执行 |
| verdict | `PASS | WARN | FAIL | NOT_APPLICABLE | BLOCKED | ERROR` | 审查对固定输入得出的结论 |
| acceptance | `pending | provisional | accepted | rejected | stale` | 结论的新鲜度、独立性与接受状态 |

三轴必须分别存储和显示。`execution=succeeded` 与 `verdict=FAIL` 是合法组合；它只能说明失败结论被正常产出。mandatory audit 不适用时必须产生新鲜的 `NOT_APPLICABLE` Audit；缺少 Audit 不能被投影成 N/A。

### 3.2 AssuranceAudit 最小契约

`AssuranceAudit` 必须包含：

- opaque `audit_id`、`project_id`、`audit_kind`；
- 固定的 `target_refs` 与 `input_pins[{ref,sha256}]`；
- `assurance_level=draft|submission`；
- execution status 与可选 run ref；
- verdict、稳定 reason code、不可变 findings Artifact ref；
- reviewer independence 与可选 executor/reviewer/topology pins；
- acceptance status、created_at 与可选 supersedes。

Schema 必须 strict；未知字段、跨项目 Audit、非法 hash 和非法枚举 fail closed。

### 3.3 纯验证模块

Assurance 领域只公开一个纯判定 seam：`verifyAssurance(input) -> report`。它不读数据库、不调用模型、不执行工具、不推进 Project，只根据已解析 Audit、mandatory kinds 和当前 input hash 计算：

- 每个 Audit 的 effective acceptance、blocking 与稳定 reasons；
- mandatory coverage 缺口；
- `overall_assurance=blocked|provisional|accepted`；
- `submission_ready`。

规则：

1. 任一 input pin 缺失或 hash 变化，旧 Audit effective acceptance 为 `stale`；历史 Audit 保留。
2. execution 非 succeeded，或 verdict 为 `FAIL | BLOCKED | ERROR`，required Audit 阻断 submission。
3. `NOT_APPLICABLE` 只有在 Audit 存在且新鲜时满足 coverage。
4. semantic Audit 不能声明 `deterministic` independence；same-model/same-family 最多 provisional。
5. submission ready 要求所有 mandatory Audit 新鲜、完整、无 blocking，且每项 effective acceptance 为 accepted。
6. verifier 的结论不替代 Human Release Gate。

`runWritingAssurance(...)` 的执行请求必须显式选择已注册的 `writing | claim-evidence` producer；不支持的 audit kind 在 strict HTTP/DSH 边界零写拒绝，不能被降级为 N/A。`claim-evidence` producer 以当前 paper/tex-source Artifact hash 和 `claim-evidence:{project_id}` canonical Claim→accepted-Evidence 集合 hash 作为 inputs。集合为空时仍写真实、可恢复的 findings Artifact（producer identity、N/A reason、input pins）和 `execution=succeeded / verdict=NOT_APPLICABLE` Audit；新增 Claim 或改变接受证据后旧 Audit 由 live resolver 判 stale。该执行不创建 Gate/Release，也不改 TeX。

## 4. 已落地的对象与 adapter 边界

以下对象已有 strict Schema 和本地 Module/Store：

- `ProtocolRevision`：运行前冻结 hypothesis、prediction、variables、primary/secondary metrics、stopping conditions、Contract/Code/Data/Environment pins；
- `ResearchSynthesis`：只引用权威 refs，区分 verified facts、negative findings、contradictions、open gaps 与 inferred relations；
- `DirectionProposal` / `DirectionAdoption`：只提出 deepen/broaden/pivot/conclude/pause，采纳不得绕过现有 Gate；
- `KnowledgePackageManifest` / `KnowledgePackageEvaluation` / `KnowledgeActivationRequest`：固定内容 hash、来源、许可、输入输出 Schema、capability envelope 和 project/revision；成功 Activation 由 `MethodologyStore` 保存 resolver 产生的精确 Pin；
- `ReverseOutline` / `ReviewFinding`：绑定 TeX revision，旧 revision 自动 stale，不能直接覆盖 canonical TeX。

内部持久化由调用方提供的同一个 SQLite connection 完成：Assurance 使用独立的 `assurance_events` 项目流；其余项目对象和成功 Activation 共用 `methodology_project_events`；global Package/Evaluation 共用 `methodology_registry_events`。三个表均为 append-only，并由 revision CAS、identity CHECK、strict Zod 读取和 UPDATE/DELETE trigger 保护。

当前 live adapter 包括 §24 的 typed HTTP/Client：项目读取要求 durable membership；普通写入要求 PI/researcher；Audit acceptance、Direction adoption 与 Pack activation 要求 PI；global Registry 要求 durable Operator；缺 principal 稳定返回 422 `principal_required`。`GET /v2/projects/{id}/methodology/graph` 与 typed Client 会从 Protocol、Synthesis、Direction 和 Adoption 重建 explicit/inferred Research Graph，standalone Topology 同步显示节点/边计数，但该图不拥有业务写权限。

standalone 从 `GET /v2/projects/{id}/methodology` 在 Overview、Manuscript、Topology 现有表面显示 zh/en 摘要。compact Assurance 通过 `AssuranceStore.project(...)` 复用权威 verifier，并为当前可解析的 Artifact/TeX/Claim/Evidence/Protocol/Contract/Code/Environment refs 解析 input hashes；缺失 ref 由 verifier 判为 stale/missing。Writing 摘要从 live TeX tree 与当前 accepted Claim–Evidence 关系计算 hash，再复用 `assessWritingMethodology(...)`。DSH 的 Host 原生 Scholar panel 也会为当前 session 精确绑定的项目显示 Protocol、Synthesis、Assurance、Writing、Knowledge 和下一建议。所有这些仍是只读投影，不替代 Human Gate、submission authority 或 canonical TeX mutation。

`submitJob` 对 formal 或 `run_intent=confirmatory` 已要求 exact frozen `protocol_pin`，从 `MethodologyStore` 读取 Protocol，并在任何 Job/Run/outbox 写入前用权威 Contract/Code/Data/Environment/Runner/预算边界调用 `evaluateResearchMethodology(run_admission)`；拒绝路径设计为零写。Direction adoption route 会从 durable PI 派生 Human actor，校验 Proposal 的当前 Project/NextAction revision，并在需要 Gate 时沿 durable Decision 的 `gate_id` 读取同项目专用 `direction` Gate；其 strict payload 必须绑定当前 proposal id、source synthesis id 与 direction，approved Decision principal 必须是项目 Human PI/operator。只有由这些事实构造的 verified receipt 才进入 evaluator；成功只追加 immutable Adoption，不直接修改 Project、Scope 或 Contract。真实 Human Gate workflow UI 仍待验收。

DSH methodology 工具包括 `research_methodology_status`、`research_protocol_record`、`research_synthesis_record`、`research_writing_review_record`、`research_knowledge_activate`、`research_knowledge_deactivate` 与 `research_assurance_run`。它们必须先解析调用 DSH session 的持久项目绑定，不能指定任意项目；Knowledge activate/deactivate 与 Assurance execution 还必须经过 DSH Host confirmation。`skills/research-core/SKILL.md` 已内化 Protocol、两层循环、Knowledge/Writing 和三轴 Assurance 的使用规则，但 Skill 说明本身仍不产生权限或权威事实。

此前提出但没有 runtime consumer 的八个 `methodology.*` / `knowledge_registry.*` 配置键已从 Config Registry 删除；当前必须表现为未注册/unknown，Settings、schema 和 effective config 都不得宣传这些键。只有未来同时实现 consumer、持久化、config pin 与 file/HTTP/UI parity 时，才能作为新的契约重新登记。local-only/remote 禁止由 Package Schema、resolver 与许可政策执行，不依赖一个虚假的 `remote_sources=disabled` 配置键。

当前仍不得把上述实现表述成完整研究循环：deterministic producer/findings Artifact、StageSubagent semantic seam、Scholar-owned native Pack delivery 与 deactivate/revoke suppression 已落地，但生产 Host/model 尚未人工验收；本机 Docker positive fixture 已自动化，远端 SSH/GPU、生产 Docker 科学分类/NegativeFinding 场景、真实 reviewer/model panel、自动 Release、项目激活 UI 和真实浏览器/ARIA/TeX 流程仍未闭环。External Knowledge 只传递不可信 metadata，不能成为 instructions。Kernel 只自动记录 execution facts，绝不把 Job succeeded/failed 猜成科学结论；Graph、Gate-bound adoption、compact freshness、DSH summary/tool 的代码存在也不能冒充这些真实执行或人工验收。

## 5. Protocol-before-run 与两层循环

正式/confirmatory Run admission 必须引用不可变 Protocol Revision。协议创建后，修改 prediction、primary metric、stopping condition 或输入 pins 必须创建新 revision；不能回写旧 revision。

Inner loop 为 Protocol → Run → Measure → Record。它可以并行执行已批准的只读调研、草稿生成与受控实验，但不得委派 Gate、正式 Evidence 接受、canonical TeX 写入或 Release。

Outer loop 只产生 Research Synthesis 和 Direction Proposal。触发条件必须是确定性阈值/事件或 Human 操作；模型不能自行改变 Scope、Contract、预算或 phase。fan-in 时 project/NextAction revision 变化，结果必须 stale/diagnostic，零权威写入。

Runner completion 与科学分类之间必须有一道显式边界：研究类 Job 进入 terminal 状态时，Kernel 在同一 Job/Run/outbox 事务追加 strict `RunOutcomeObservation`，只保存 `run_id + attempt_no + lease_generation + manifest_sha256 + protocol_pin + job_execution + failure_class + intent`，不保存或推断 scientific outcome/validity。`GET /v2/projects/{id}/run-outcome-observations` 只向项目成员返回这些 project-scoped 观察；未分类观察确定性投影为 `run_outcome_classify` NextAction。PI/researcher 权限下的 Human/Agent 可经 `POST .../research-runs` 提交科学字段，Kernel 从观察反查并冻结 execution facts、记录分类 principal，stale attempt/manifest/Protocol 或错误 infrastructure 分类全部零写 fail closed。

分类写入、`research.run.classified` outbox 与确定性 synthesis trigger 在同一事务完成。trigger 命中时只追加 strict `SynthesisRecordRequest` 并投影 `synthesis_record` NextAction，不由 Kernel 生成 synthesis 内容，也不修改 phase、Gate、Claim、Evidence 或 Release。request 固定窗口内完整 source Run 集、Project revision 与 NextAction revision；写入 Synthesis 必须显式回答一个仍 pending 的 request，并逐项匹配 project/window/snapshot/current action/source runs，不能只凭当前 Methodology CAS 写任意或过时内容。infrastructure failure 不创建 `NegativeFinding`；exploratory positive 最多创建 proposal-only hypothesis。重放返回既有 receipt，重启从 append-only observation/request ledger 重建相同 pending action；full-auto 没有科学分类或 synthesis executor，必须 park 而不是自动猜测结论。

`nextActionProjection(...)` 直接读取同一 append-only Methodology stream 的 Synthesis、DirectionProposal 与 DirectionAdoption 作为 fresh overlay，不建立第二套 loop 状态机。Proposal 只有在 project id、source synthesis、双方 project/NextAction snapshot、`direction_proposal_id` 与 input hash 全部精确匹配当前权威投影时才 fresh；任一 stale/cross-project/wrong binding 只产生 blocked diagnostic，不能产生可执行 continuation。

fresh 且尚未 adoption 的 `pivot|broaden`（以及超出已批准 Contract 的 `deepen`）必须投影 Human `direction_gate_review`。它只有在同项目存在唯一 pending `direction` Gate，且 strict payload 精确为 `{purpose:'direction_adoption', proposal_id, source_synthesis_id, direction}` 时 ready；缺失或错误 Gate 只能 blocked。无 Gate 要求的方向仍通过 PI adoption seam，不能由 Agent 代采纳。

approved Adoption 只派生 revision-bound continuation NextAction：`deepen→direction_deepen_continue`、`broaden→direction_broaden_intake`、`pivot→direction_pivot_intake`、`conclude→direction_conclude_prepare`、`pause→direction_pause_review`。每次投影和重启重建都必须重新沿 Adoption 的 decision ref 读取 durable Decision + Direction Gate，并复核同项目、approved status 及 exact proposal/synthesis/direction payload；receipt 缺失或错绑只能产生 `direction_overlay_invalid`。pivot/broaden 只进入现有 Intake continuation proposal 入口，由 Human 继续 Grill/propose/adopt；所有五类都不得直接修改 Scope、Contract、Project status/revision，不得自动创建或批准 Gate。close/reopen 必须从同一账本重建同一 action id/revision/refs。

## 6. 方法与知识双通道

`Instruction Pack` 只允许 Scholar 自有或独立转写、经过评审和测试的内容进入 instructions。`External Knowledge Pack` 永远作为带来源、固定 hash 的不可信只读资料，内容中的命令、prompt injection、权限声明和审批请求不产生任何能力。

有效能力等于 manifest 请求、evaluation 授权、Principal ACL、当前 NextAction 和项目策略的交集。Pack 不能自授 Bash、network、Secret、Gate 或 Kernel write 权限。版本/hash equivocation、许可不明、source 漂移、撤销或输入 stale 必须 fail closed。

## 7. 分阶段执行清单

| 阶段 | 本阶段交付 | 当前代码状态 | 退出条件 |
|---|---|---|---|
| 0 决策 | 本规范、来源/许可边界、明确不做项 | 已完成 | 决策与 `METHOD_ONLY` 边界保持可追溯 |
| 1 Assurance core | strict Schema、纯 verifier、失败测试、导出 | 内部 Module 已实现 | `METH-A01`–`A07` 当前 commit 自动化证据确认；不以投影冒充 verifier |
| 2 Assurance persistence | append-only Audit/acceptance、hash freshness、API | Store、0028、typed HTTP/Client、deterministic writing/claim-evidence producer、immutable findings Artifact、StageSubagent semantic seam 与 verifier-backed compact freshness 已实现；生产 Host/model 与浏览器人工验收待完成 | Audit 经真实项目 API 可恢复、按项目隔离且 UI 明确 freshness/三轴 |
| 3 Protocol/inner loop | Protocol admission、intent/outcome/validity、NegativeFinding | Schema/evaluator/Store/HTTP、Kernel pre-write admission、Runner completion→未分类观察→授权分类、NextAction 与 synthesis request 已实现；真实本机 Docker positive fixture 30/30，远端 SSH/GPU 与生产科学分类仍待验收 | `METH-L01`–`L05` 与真实本机 Docker fixture 通过；远端/生产矩阵保持 pending |
| 4 Synthesis/outer loop | Synthesis、Direction adoption、Graph projection | Schema/evaluator/Store/HTTP、纯 Graph + GET/Client、revision-bound adoption 与 durable Decision→专用 Gate→strict payload→Human PI/operator verified receipt 已实现；真实 reviewer orchestration、Human workflow UI 与自动 Project mutation 未实现/未验收 | `METH-L06`–`L08`、`METH-G*` 通过 |
| 5 Registry | 本地 immutable 双通道 Registry、Pin/Activation | 三份 Scholar-owned native Pack、resolver/Store、Operator/PI HTTP、exact-context Chat/reviewer delivery、DSH deactivate 与 compact 状态已实现；项目激活 UI 和生产 Host 人工验收待完成 | `METH-S*` 通过，External Knowledge/第三方原文仍不能作 instructions |
| 6 Writing | Reverse Outline、Claim–Evidence、首批 Panel | assessor、Store、HTTP 与 live TeX/Claim–Evidence hash-backed compact Manuscript/Topology 摘要已实现；真实 Panel execution、TeX patch 与浏览器流程未实现/未验收 | `METH-W*` 通过且真实浏览器人工验收 |

每阶段都必须先更新 domain/api/storage/acceptance/hardening，再写失败测试和实现。后续阶段不能通过添加兼容 fallback、第二状态机或自由文本字段提前占位。

## 8. 验收入口

本规范的阻断场景使用稳定前缀 `METH-A`、`METH-L`、`METH-G`、`METH-W`、`METH-S`，详见 [acceptance-tests.md](acceptance-tests.md)。Phase 1 至少覆盖：

- Audit 执行成功但 verdict FAIL；
- mandatory Audit 的 N/A 与 missing 区分；
- input hash 改变导致 stale；
- same-family semantic review 只能 provisional；
- cross-family/human accepted 的完整 submission 才 ready；
- verifier 不推进 phase、不创建 Gate、不批准 Release。

当前自动证据文件包括 `assurance.test.ts`、`assurance-store.test.ts`、`research-methodology.test.ts`、`research-graph.test.ts`、`knowledge-registry.test.ts`、`writing-methodology.test.ts`、`methodology-store.test.ts`、`methodology-http.test.ts`、`methodology-kernel-integration.test.ts`、`run-outcome-lifecycle.test.ts`、`research-run-outcome.test.ts`、`tests/security/run-analysis-consistency-tests.sh`、`methodology-tools.test.ts`、`dsh-native-scholar.test.ts`、`config-registry.test.ts` 与 Research UI 的 `methodology-projection.test.ts`。它们分别覆盖 strict/pure/store、Graph、focused HTTP/AuthZ、focused Kernel admission、local-process fault/reopen 与真实本机 Docker observation/classification/replay、exact-session tools、config key absence 与 projection/i18n；不证明真实 reviewer/model、远端 SSH/GPU、生产 Docker scientific classification/NegativeFinding、pack injection/revocation、真实浏览器/ARIA 或 TeX 操作已经完成。本轮 Runner lifecycle focused 证据为 2 files / 4 tests，真实本机 Docker analysis/outcome 专项为 30/30；最终全量结果和计数由主验收统一补录。最终实现状态只以 [hardening-v0.2-status.md](hardening-v0.2-status.md) 为准；人工项目全部保持 `NOT_RUN_MANUAL_PENDING`，见 [manual-acceptance.md](manual-acceptance.md)。

## 9. Phase 8 rollout 与遥测契约

方法论 rollout 不是 Config Registry/Settings 的第二个开关。它是 Kernel 内的 append-only 权威对象，模式只允许 `internal-fixture | opt-in-dev | opt-in-user`，默认 `internal-fixture`。模式描述部署队列和用户选择事实，不授予 Gate、Decision、Release、TeX、Secret、shell 或 network 权限；任何模式仍须通过原有 Project AuthZ、CAS、Human Gate 与 capability intersection。

全局 Operator 可以用 revision CAS 追加新 policy，不能更新或删除旧 policy。每个 Project 创建或 migration 0032 回填时固定当时 policy revision/hash/mode；既有项目只有 PI 显式 re-pin 才采用当前全局 policy。Knowledge Activation 与 Assurance execution 在追加业务事件的同一个 SQLite 事务内写入 exact policy consumption pin；缺 pin、hash 不一致或重启后无法恢复必须 fail closed。Activation、Audit、Project pin 与 policy 历史均不能原地更新。

方法论遥测复用进程内 `MetricsStore`，它不是业务账本。唯一 writer 只接受闭合枚举，覆盖：Assurance execution outcome/duration、reviewer `complete|partial|missing`、Knowledge delivery 的 delivered/suppressed/revoked/deactivated、Synthesis trigger/freshness、Writing patch apply/recovery success/failure。label 只能使用 mode、固定 audit/verdict/status/reason/event/phase；project/session/package 名、路径、hash、prompt、正文、Token、SecretRef 和任意错误文本严禁进入 key 或 label。不同项目、会话或包不得产生新 series。

`GET /v2/projects/{id}/methodology` 只暴露当前 rollout mode、policy revision、project pin revision 和上述 `methodology.*` 的脱敏 aggregate；不返回 policy hash、actor、project/session/package identity、payload 或直方图 buckets。Operator-only 全局 policy API 才返回 immutable hash/actor receipt。没有 file/env/UI rollout source，因此 `methodology.rollout_mode` 必须继续作为 unknown Config key；未来只有在同一变更具备真实 file/HTTP/UI consumer parity 时才能另行登记 Config key。

## 10. Assurance 与 Knowledge authority hardening

Assurance 只允许由已登记 producer 产生权威 Audit。通用 raw `POST assurance-audits` 不存在；public execution 只接受 deterministic `writing|claim-evidence`，semantic execution 仅能从 DSH exact-session internal adapter 进入。semantic receipt 不能决定 Audit 的 acceptance 或 reviewer independence：Kernel 必须把 immutable findings Artifact、当前项目的 durable StageSubagent child、parent action、terminal state与首次 `started` event 中的 provider/model/family/config identity 做同一项目关联，并据此派生 independence。缺 identity、空 reviewers、provider unavailable、错 session/project/action、非 reviewer 或未完成 child 全部在 Artifact/Audit/rollout consumption 之前失败；provider unavailable 只返回 typed execution diagnostic，不能写成权威 BLOCKED Audit。same-model/same-family 最多 provisional，Human acceptance 仍是独立写入，任何执行都不能自动 Gate/Release/TeX。

Knowledge Activation 的外部输入固定为 `KnowledgeActivationIntent`：exact package name/version/manifest+payload hash、显式 Human activation 与 activation/registry/project/NextAction CAS。body 不接受 project、session、phase、principal 或 principal/Project policy/NextAction capability 数组。public BFF session 和 DSH internal path session 都必须先命中 durable session-project link；Kernel 在同一事务重读当前 Project/NextAction、durable PI membership、Scholar 本地 policy、rollout pin 与 capability envelope 后，才构造内部 `KnowledgeActivationRequest`。未链接、跨项目、stale pin、forged authority、revoke/equivocation/license/hash mismatch 都在 append 前失败。DSH 工具不能传 principal，也不能使用全局 Skill mount 冒充项目激活。

自动边界证据位于 `assurance-execution.test.ts`、`assurance-execution-http.test.ts`、`knowledge-activation-authority.test.ts`、`methodology-http.test.ts` 与 `methodology-tools.test.ts`；真实 DSH Host confirmation、真实 provider/model identity 和浏览器 BFF session 注入仍为 `NOT_RUN_MANUAL_PENDING`。
