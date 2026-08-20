# DSH Scholar 方法论与知识层吸收决策记录

> **文档状态：`DECIDED`**
>
> **实现授权：`PHASED_IMPLEMENTATION_AUTHORIZED`**
>
> **规范性：非规范性研究与决策依据；规范契约见 [methodology-knowledge-layer.md](methodology-knowledge-layer.md)**
>
> **约束：本文保留来源证据、候选分析、许可风险和取舍理由；实现只能遵循规范文档及既有 Kernel/Gate/Runner/Evidence 安全边界。**
> **供应链边界：三仓统一 `METHOD_ONLY`；任何复制、vendor 或远程 Pack source 仍未获授权。**

> **2026-08-20 实现审计：** 本文后续 Phase 是决策时的分期计划，不是完成声明。当前已实现 strict Schema、纯 Module、`AssuranceStore` / `MethodologyStore`、migration 0028、typed HTTP/Client（含可重建 Research Graph）、standalone 与 DSH compact projection、七个 exact-session DSH methodology tools、Direction 的 revision + durable Decision→专用 Gate→strict proposal/synthesis/direction payload + Human PI/operator verified receipt、formal/confirmatory Job 的持久 Protocol pre-write admission，以及真实 local Runner completion→execution-only observation→授权 scientific classification→deterministic synthesis request 的 durable loop；当前真实表为 `assurance_events`、`methodology_project_events`、`methodology_registry_events`，Graph 不另建权威表，Runner observation/request 复用既有 append-only outbox 而不新增表。Assurance raw Audit POST 已关闭，semantic identity 由 durable child topology 派生；Knowledge Activation 的 session/phase/capability authority 由 Kernel 派生。compact Assurance 已复用 verifier 解析当前可用 input hashes，Writing stale 已绑定 live TeX 与 Claim–Evidence hash。真实 reviewer/model、生产 Docker/SSH/GPU 科学分类/NegativeFinding、Human Direction workflow UI、pack payload 注入/撤销、自动 Release 和真实浏览器/ARIA/TeX 仍未闭环；八个无 runtime consumer 的 `methodology.*` / `knowledge_registry.*` 配置键已明确删除并延后，而非 schema-live。状态以规范与 hardening 矩阵为准。

## 1. 研究范围与固定快照

本轮继续研究以下三个仓库，并把可复用内容重述成适合 DSH Scholar 的候选方法论与知识层。为避免上游变化造成结论漂移，所有判断固定在以下 commit：

| 来源 | 固定 commit | 本轮主要读取面 | 在本草案中的角色 |
|---|---|---|---|
| ARIS / Auto-claude-code-research-in-sleep | [`f4f20f90ead9cb8d68e830ee5b006121adc41f80`](https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep/commit/f4f20f90ead9cb8d68e830ee5b006121adc41f80) | Assurance Contract、Reviewer Independence、Result-to-Claim、论文改进循环 | 审查语义、独立评审、输入新鲜度与“执行不等于验收” |
| Research-Paper-Writing-Skills | [`77e7c2c1ba06f7d71844873147665437a03aac1b`](https://github.com/Master-cai/Research-Paper-Writing-Skills/commit/77e7c2c1ba06f7d71844873147665437a03aac1b) | 分章节写作、reverse outline、Method triad、实验与 reviewer checklist | 写作知识层与章节级激活方式 |
| AI-Research-SKILLs | [`773a52944ba4747a18bd4ae9ade53fff041adcbc`](https://github.com/Orchestra-Research/AI-Research-SKILLs/commit/773a52944ba4747a18bd4ae9ade53fff041adcbc) | two-loop autoresearch、protocol-before-run、ARA compiler、rigor reviewer | 研究循环、知识图、来源显式性、广域 Skill 目录 |

本草案同时对照 DSH Scholar 当前的 `domain-model.md`、`subagent-stage-execution.md`、`trajectory-subagents.md`、`execution-runtime.md`、`product-spec.md`、`acceptance-tests.md`，以及 Kernel、NextAction、Runner、Evidence、TeX、Topology 相关代码。本文不会修改或替代这些规范。

## 2. 一句话结论

建议把三个仓库的价值吸收到一个**受 Kernel 治理、按阶段激活、可审计且默认只产出候选结果的方法论与知识层**中：

- ARIS 提供“怎样审、何时算审过”的语言；
- AI-Research-SKILLs 提供“怎样循环研究、怎样组织研究知识”的语言；
- Research-Paper-Writing-Skills 提供“怎样分章节计划、写作和反向检查”的语言；
- DSH Scholar 继续唯一负责权限、状态、Gate、执行、证据、文件、恢复、预算与审计。

不建议把任何一个外部仓库直接安装成第二套编排器，也不建议把外部 Markdown、YAML、Git history、Agent 自述或审查分数升级成权威研究事实。

## 3. 定位差异

ARIS 自身把产品描述为“methodology, not a platform”，它依赖可移植 Skill、文件和外部模型组织研究流程，[定位证据见固定 README](https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep/blob/f4f20f90ead9cb8d68e830ee5b006121adc41f80/README.md#L1-L14)。它的优势是审查契约和研究工作流，而不是事务性 Kernel。

Research-Paper-Writing-Skills 只提供一个写作 Skill 和按章节加载的 references，目标是论文结构、段落流、claim-evidence 对齐与 reviewer-facing 表达，[核心工作流见固定 SKILL](https://github.com/Master-cai/Research-Paper-Writing-Skills/blob/77e7c2c1ba06f7d71844873147665437a03aac1b/research-paper-writing/SKILL.md#L12-L48)。它没有实验运行、Evidence Ledger、Gate、项目恢复或权限模型。

AI-Research-SKILLs 的 Autoresearch 把自己定位为研究项目经理，路由到大量领域 Skill；核心是 bootstrap、inner loop、outer loop 和 finalize，[两层循环见固定 SKILL](https://github.com/Orchestra-Research/AI-Research-SKILLs/blob/773a52944ba4747a18bd4ae9ade53fff041adcbc/0-autoresearch-skill/SKILL.md#L60-L83)。它覆盖广，但状态主要由工作区文件和 Agent 协议维护。

DSH Scholar 的目标层次不同：它已有 Project 状态机、Human Gate、结构化 NextAction、Runner/Job/Run、Evidence/Claim、Workspace/Terminal、TeX、Trajectory/Topology、权限和持久化恢复。因此，外部材料只能进入以下两个非权威上层：

1. **Methodology Layer（方法论层）**：定义研究活动的推荐顺序、审查规则、反思节奏和写作检查；只有 Scholar 自己转写、评审并测试过的内容，才可成为可信 `Instruction Pack`；
2. **Knowledge Layer（知识层）**：提供按领域/阶段选择的背景知识、检查表、模板和只读推理辅助；第三方原文始终是 `External Knowledge Pack`，按不可信资料检索，绝不直接成为模型 instructions。

权威边界仍属于 Kernel 领域对象和确定性服务。

## 4. 吸收原则

### 4.1 语义吸收，不做目录搬运

优先吸收抽象方法、对象关系和验收不变量；不直接复制上游提示词、示例段落、脚本、目录布局或固定模型名称。每个被采纳的方法都应重新表达为 Scholar 自己的 typed contract、测试和 UI。

### 4.2 Kernel 仍是唯一权威

- Skill 输出默认是 `proposal | observation | draft | review_finding | diagnostic`；
- Project phase、Gate、Decision、Job、Run、accepted Evidence、supported Claim、canonical TeX 和 Release 只能通过现有 Kernel/权威服务写入；
- Markdown/HTML/YAML 只能作为导出、解释或人机可读投影，不得成为恢复研究状态的唯一来源。

### 4.3 先确定性检查，再语义审查

哈希、Schema、引用存在性、编译、测试、Artifact 归属和输入新鲜度由确定性程序完成；Claim 是否被证据实质支持、论证是否连贯等才交给语义 reviewer。ARIS 的 Result-to-Claim 也明确区分“数字确实存在”和“数字是否支持结论”，[见固定实现说明](https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep/blob/f4f20f90ead9cb8d68e830ee5b006121adc41f80/skills/result-to-claim/SKILL.md#L31-L89)。

### 4.4 执行者不能给自己发最终通行证

Reviewer 必须从原始 Artifact 或受控、不可变快照独立读取，不接受执行者预先总结和带倾向的说明；ARIS 对这一点给出了明确协议，[见 Reviewer Independence](https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep/blob/f4f20f90ead9cb8d68e830ee5b006121adc41f80/skills/shared-references/reviewer-independence.md#L1-L69)。语义 reviewer 的输出仍不能替代 Human Release Gate 或 Evidence auditor。

### 4.5 显式来源与不确定性

任何 synthesis/graph 节点必须标记 `explicit`（直接来自权威记录/来源）或 `inferred`（重建、解释、假设），不能把推断伪装成历史事实。ARA 对 exploration graph 的这一要求值得吸收，[见固定 compiler](https://github.com/Orchestra-Research/AI-Research-SKILLs/blob/773a52944ba4747a18bd4ae9ade53fff041adcbc/22-agent-native-research-artifact/compiler/SKILL.md#L91-L165)。

### 4.6 按需激活、最小上下文

知识不是越多越好。写 Introduction 时不加载全部训练、部署和 Method 指南；做远程 Runner 诊断时不加载论文结论模板。Research-Paper-Writing-Skills 明确要求只加载当前章节指南，[见固定 SKILL](https://github.com/Master-cai/Research-Paper-Writing-Skills/blob/77e7c2c1ba06f7d71844873147665437a03aac1b/research-paper-writing/SKILL.md#L43-L77)。

### 4.7 任何自治都受已批准边界约束

自动继续只允许发生在已批准 Contract、预算、Runner allowlist、网络策略、项目 revision 和明确 NextAction 内。Scope、Idea、Contract、Budget、Release 的 Human Gate 不因引入外部方法论而弱化。

## 5. 统一术语（候选，不是现有 Schema）

为避免外部仓库各自术语与 Scholar 当前对象混淆，后续若获批，建议统一使用下表：

| 候选术语 | 定义 | 不等于 |
|---|---|---|
| Instruction Pack | Scholar 自有或独立转写、评审和测试过的可信方法指令 | 第三方原文、可任意执行工具的 Agent |
| External Knowledge Pack | 面向特定领域或章节的不可信只读知识与模板 | system instructions、权威研究数据或项目状态 |
| Skill Package Manifest | 可版本化、可扫描、可评测、可固定的 Pack 描述记录 | 直接复制到全局目录的 `SKILL.md` |
| Skill Pin | 项目对 package、内容 hash 和依赖闭包的不可变选择 | 自动跟随上游更新的 semver 范围 |
| Skill Activation | 在特定 project/phase/action/revision 上固定一次 Pack 使用 | 永久全局启用 |
| Skill Evaluation | 对确切 package hash 的路径、许可、语义、权限和宿主兼容性判定 | 发布者自报的 trusted 标记 |
| Capability Envelope | manifest 请求、evaluation 授权、Principal ACL、NextAction 和项目策略的交集 | Pack 自己声明什么就获得什么 |
| Method Provenance | `native | adapted | third-party` 及固定 repo/commit/path/attribution | “参考过某项目”的无定位说明 |
| Knowledge Freshness | 技术知识对应的上游版本、核验日期和 stale/unknown 状态 | 项目 Artifact 的 hash freshness |
| Protocol Revision | 运行前冻结的假设、预测、变量、指标、停止条件和环境绑定 | 运行后的分析总结 |
| Inner Loop Cycle | 在批准边界内完成 Protocol → Run → Measure → Record 的一次闭环 | Project phase 本身 |
| Research Synthesis | 对一组 accepted/verified facts、negative findings 和 open gaps 的结构化综合 | Manuscript prose 或 Agent 总结 |
| Direction Proposal | `deepen | broaden | pivot | conclude | pause` 的有依据方向候选 | 现有 Gate `Decision`、自动修改 Scope 或 Contract |
| Direction Adoption | Human 或确定性 policy 对某个 Direction Proposal 的可审计采纳记录 | 绕过 Scope/Idea/Contract/Budget Gate 的通行证 |
| Assurance Audit | 针对固定输入快照产生结构化 verdict 的审查活动 | Runner Job 是否 exit 0 |
| Assurance Acceptance | 对该审查结论的独立性、新鲜度、完整性和适用级别的认可 | 审查 verdict 本身 |
| Review Finding | reviewer 产生的可定位、带 severity 的问题 | Gate Decision |
| Reviewer Panel | 多个职责隔离的只读审查角色及 fan-in 结果 | 多数投票自动批准 |
| Reverse Outline | 从现有章节提取 thesis、段落角色和证据映射的诊断投影 | 自动重写 canonical TeX |
| Method Triad | 每个方法模块的 motivation、design、technical advantage 三元说明 | 三段固定文案模板 |
| Research Graph | typed Claim/Experiment/Evidence/Decision/Trace 的关联投影 | 任意 LLM 生成的 YAML 真相源 |

其中 `accepted Evidence`、`supported Claim`、`Decision`、`NextAction`、`Job/Run` 等现有术语保持原义，不能被上表新术语覆盖。

## 6. Assurance：执行、结论与接受必须分轴

### 6.1 问题

当前最容易产生误导的表达是“审查完成”“实验成功”“论文通过”。它们可能分别只表示进程退出、模型给出 PASS，或者有人真正接受了结论。ARIS 的 Assurance Contract 把成本/深度与审查严格度分开，并要求 mandatory audit 总是产生可验证 verdict；静默跳过与 `NOT_APPLICABLE` 不同，[见固定 contract](https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep/blob/f4f20f90ead9cb8d68e830ee5b006121adc41f80/skills/shared-references/assurance-contract.md#L1-L56)。

### 6.2 候选三轴

| 轴 | 回答的问题 | 候选值 | 权威来源 |
|---|---|---|---|
| `execution_status` | 审查任务有没有正常执行？ | `queued | running | succeeded | failed | cancelled | timed_out` | Job/Run 或受控 subagent lifecycle |
| `verdict` | 审查对内容得出什么结论？ | `PASS | WARN | FAIL | NOT_APPLICABLE | BLOCKED | ERROR` | Audit Artifact |
| `acceptance_status` | 该 verdict 是否完整、独立、当前且可用于目标 assurance level？ | `pending | provisional | accepted | rejected | stale` | 确定性 verifier + 指定 reviewer/auditor；Release 仍需 Human Gate |

重要不变量：

- `execution_status=succeeded` 只说明审查程序结束，不代表 `verdict=PASS`；
- `verdict=PASS` 不代表 `acceptance_status=accepted`；同一执行者自审、缺模型 pin 或缺 trace 时最多 provisional；
- 输入 hash 变化后，旧 verdict 保留但 `acceptance_status=stale`；不能原地改写历史；
- `NOT_APPLICABLE` 必须有“检查过且检测器为否”的 Artifact；没有 Artifact 叫 missing，不叫 skip；
- `BLOCKED` 表示本应审但缺前置，不得降级为 `NOT_APPLICABLE`；
- semantic reviewer 的 `accepted` 只表示该 audit 可纳入 assurance 聚合，不表示 Evidence 已 accepted，也不表示 Release 已批准。

ARIS 给出的六种 verdict、输入 hash、trace、review independence 和 stale verifier 结构可作为语义参考，[见固定 contract 的 Artifact/Verifier 段落](https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep/blob/f4f20f90ead9cb8d68e830ee5b006121adc41f80/skills/shared-references/assurance-contract.md#L57-L168)。

### 6.3 候选 `AssuranceAudit` 形状

以下只是讨论用伪 Schema：

```yaml
audit_id: audit_xxx
project_id: rsp_xxx
audit_kind: claim-evidence | citation | reproducibility | writing | statistics | license | release-integrity
target_refs:
  - {kind: manuscript, id: manuscript_xxx, revision: 4}
assurance_level: draft | submission
execution:
  status: succeeded
  run_ref: run_xxx
verdict: WARN
reason_code: missing_failure_boundary
findings_artifact_id: artifact_xxx
input_pins:
  - {ref: artifact_xxx, sha256: "sha256:..."}
review:
  executor_model_pin: provider/model/revision-or-null
  reviewer_model_pin: provider/model/revision-or-null
  independence: deterministic | same-model | same-family | cross-family | human
  topology_node_id: node_xxx
acceptance_status: provisional
created_at: timestamp
supersedes: null
```

候选 verifier 应只做确定性聚合：Schema、必要 Artifact、hash freshness、trace、模型/策略 pin、mandatory audit coverage、verdict 集合和阻断规则。它不自行判断论文创新性，也不替代 Human Gate。

### 6.4 Reviewer independence

候选规则：

1. reviewer 读取固定 Artifact/Snapshot refs，不读取执行者的结论性摘要；
2. reviewer prompt 只带角色、任务、venue/contract 约束和 opaque refs；
3. 新一轮独立评分使用新 reviewer node；修复验证可以引用 reviewer 自己此前提出的 finding，但不能让执行者替 reviewer 宣布已解决；
4. reviewer provider/model/reasoning policy、输入 hash、输出 hash和 Topology node 必须留痕；
5. 同模型/同 family 审查允许用于快速反馈，但不能伪装为独立 accepted assurance；
6. 多 reviewer 的一致票不能替代确定性检查或 Human Gate。

ARIS 也把新鲜 reviewer 与上下文偏置作为核心防线，[见固定论文改进循环](https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep/blob/f4f20f90ead9cb8d68e830ee5b006121adc41f80/skills/auto-paper-improvement-loop/SKILL.md#L1-L70)。Scholar 应吸收不变量，而不是硬编码其模型名、轮数或工具调用。

## 7. 双循环研究方法

### 7.1 Inner Loop

AI-Research-SKILLs 的 inner loop 是“选择假设 → 实验 → 测量 → 记录 → 学习”，outer loop 则周期性综合模式并调整方向，[原始 two-loop 描述](https://github.com/Orchestra-Research/AI-Research-SKILLs/blob/773a52944ba4747a18bd4ae9ade53fff041adcbc/0-autoresearch-skill/SKILL.md#L60-L83)。在 Scholar 中，建议把 inner loop 重述为：

```text
Select testable Claim/Hypothesis
  → freeze Protocol Revision
  → Kernel admission + Runner Job
  → signed RunManifest + Artifacts
  → Analysis Worker measurement
  → Evidence verification
  → update Claim relation / record Negative Finding
```

它不是新 Project phase，而是在 `BASELINE_REPRO`、`EXPERIMENTING`、`EVIDENCE_READY` 之间可重复发生的结构化 cycle。每一步仍由当前权限、Contract、NextAction、预算和 revision 控制。

### 7.2 Outer Loop

候选 outer loop 读取自上次 synthesis checkpoint 以来的：

- confirmatory/exploratory runs；
- positive、negative、mixed、inconclusive findings；
- contradicted/inconclusive Claims；
- failed infrastructure attempts（单列，不能当 negative scientific finding）；
- 新文献与 Corpus revision；
- 预算、时间、复现性和 unresolved reviewer findings。

然后生成 `ResearchSynthesis` 草案，并给出一个 `DirectionProposal` 候选：

| 候选方向 | 含义 | 默认治理 |
|---|---|---|
| `deepen` | 在当前假设/方法内补 seed、ablation、stress test 或 mechanism | 若不改变 approved Contract，可产生受限 Agent/Runner NextAction |
| `broaden` | 扩展数据、场景、baseline 或相邻假设 | 视 Contract 变化创建新版本并重新 Gate |
| `pivot` | 研究问题、核心假设或方法方向发生实质变化 | 必须回到相应 Scope/Idea/Contract Gate；绝不自动推进 |
| `conclude` | 证据足够或达到停止条件，进入写作/收尾 | 仍由确定性 readiness + NextAction 决定 |
| `pause` | 数据、预算、伦理、安全或基础设施阻断 | 进入明确 blocking/diagnostic，不伪造进展 |

AI-Research-SKILLs 强调研究非线性、遇到意外结果要回到文献/构思，[见固定 Autoresearch](https://github.com/Orchestra-Research/AI-Research-SKILLs/blob/773a52944ba4747a18bd4ae9ade53fff041adcbc/0-autoresearch-skill/SKILL.md#L84-L123)。Scholar 可吸收这种节奏，但 trigger 不能只靠模型主观判断；候选 trigger 应包含 `N valid cycles`、明确停滞、重大反例、Contract stopping condition、预算阈值或 Human request。

### 7.3 Research Synthesis 不是自由文本总结

候选 `ResearchSynthesis` 至少包含：

```yaml
synthesis_id: synth_xxx
project_id: rsp_xxx
window:
  from_event_seq: 120
  to_event_seq: 247
inputs:
  accepted_evidence_refs: []
  verified_evidence_refs: []
  run_refs: []
  corpus_snapshot_refs: []
findings:
  supported: []
  contradicted: []
  negative: []
  inconclusive: []
  infrastructure_failures: []
patterns: []          # inferred，必须带 source refs
open_questions: []
constraints_learned: []
direction_proposal: deepen | broaden | pivot | conclude | pause
confidence: low | medium | high
generated_by: human | deterministic | agent | panel
input_hash: "sha256:..."
status: draft | reviewed | adopted | stale
```

只有 `adopted` 的 synthesis 可以参与正式 NextAction 推导；adoption 是否需要 Human、auditor 或确定性规则，属于待决策项。任何底层输入变化使旧 synthesis 变 stale，但不删除历史。

## 8. Protocol-before-run 与结果分类

### 8.1 先协议、后运行

AI-Research-SKILLs 明确要求在运行前写明 change、prediction、why，并用先于结果的提交形成时间证据，[见固定 inner loop](https://github.com/Orchestra-Research/AI-Research-SKILLs/blob/773a52944ba4747a18bd4ae9ade53fff041adcbc/0-autoresearch-skill/SKILL.md#L124-L150)。Scholar 不应照搬 Git commit 作为权威锁，而应复用/扩展 approved ExperimentContract、CodeSnapshot、data hash、metric、seed、Runner profile 和 ExecutionPlan。

候选 Protocol Revision 最小内容：

- research question / target Claim；
- `intent: confirmatory | exploratory`；
- manipulated/controlled/measured variables；
- directional or null prediction；
- primary metric、baseline、comparison、analysis plan；
- dataset/split/preprocessing、seed、environment pins；
- sanity checks、stopping conditions、failure criteria；
- allowed deviations 与 deviation handling；
- frozen timestamp、revision、canonical hash 和 author Principal。

Kernel 只允许 Job 引用在 Job 创建前已冻结的 Protocol Revision。运行后不能回填预测、改 intent 或把偶然发现伪装成 preregistered confirmatory result；任何变化创建新 revision/Contract，并按现有 Gate 规则处理。

### 8.2 两个正交分类轴

`confirmatory/exploratory` 是**研究意图**；`positive/negative/mixed/inconclusive` 是**观察结果**。两者必须正交：

| intent | outcome | 示例解释 |
|---|---|---|
| confirmatory | positive | 预注册预测在有效协议下得到支持 |
| confirmatory | negative | 有效测试未支持/反驳预测；这是有价值的科学结果 |
| exploratory | positive | 发现候选模式；不能自动升级为 confirmed Claim |
| exploratory | negative | 搜索空间的一部分被排除，记录边界与下一步 |
| 任意 | inconclusive | 样本、统计功效、完整性或混杂不足，不能得出方向性结论 |

还必须分离第三个轴 `run_validity: valid | invalid | infrastructure_failed | integrity_blocked`。例如 OOM、SSH 断线、代码崩溃不是“negative scientific result”；数据泄漏、错误 split 也不能变成有效反例。

### 8.3 Negative Finding

AI-Research-SKILLs 明确把 negative result 当作进展，并要求记录它排除了什么、提示了什么，[见固定 inner loop](https://github.com/Orchestra-Research/AI-Research-SKILLs/blob/773a52944ba4747a18bd4ae9ade53fff041adcbc/0-autoresearch-skill/SKILL.md#L124-L150)。候选 `NegativeFinding` 应绑定：

- Protocol/Contract/RunSet/Analysis/Evidence refs；
- 被反驳或未支持的精确 Claim scope；
- validity/integrity checks；
- ruled-out region、known confounds、generalization boundary；
- 是否需要 replication；
- `explicit` observation 与 `inferred` lesson 分离。

只有 valid run + 合法 analysis + 对应 Evidence 才能形成可采用 negative finding。它可以使 Claim `contradicted` 或 `inconclusive`，但不能由模型直接把 Claim 改成该状态。

### 8.4 已实现的 completion→classification 边界

当前 Kernel 不把 Job terminal 状态自动解释为 scientific outcome。completion 与 Run 终态更新在同一事务追加 execution-only `RunOutcomeObservation`，精确固定 run/attempt/lease generation/manifest/Protocol/intent；pending observation 只投影 `run_outcome_classify`。有项目写权限的 Human/Agent 只能提交 outcome、validity 与分析/Evidence refs，execution facts 由 Kernel 反查，分类 principal 写入审计事件。stale attempt、重放、崩溃与基础设施失败均 fail closed；infrastructure failure 不产生 NegativeFinding，exploratory positive 只产生 hypothesis proposal。

分类、classified outbox 和确定性 outer-loop trigger 原子提交。trigger 命中只追加 `SynthesisRecordRequest` 并投影 `synthesis_record`，不生成 synthesis 正文、不改变 phase/Gate/Release。file-backed reopen 从既有 outbox 与 methodology stream 恢复；full-auto 对科学分类保持 unsupported/park。真实本机 Docker formal positive fixture 已验证 observation/classification/replay；远端 SSH/GPU、生产 Docker 与生产科学判读仍是人工验收边界。

## 9. Research Graph 与 ARA 方法吸收

### 9.1 候选图层

ARA Compiler 把论文、代码、日志、配置和笔记重组为 Claim、Experiment、Evidence、Physical layer 和 exploration graph，并要求部分输入缺失时显式标 gap，[输入策略见固定 compiler](https://github.com/Orchestra-Research/AI-Research-SKILLs/blob/773a52944ba4747a18bd4ae9ade53fff041adcbc/22-agent-native-research-artifact/compiler/SKILL.md#L1-L90)。Scholar 可吸收“跨来源编译”和“图关系”，但图必须是 typed Kernel 对象的投影：

```text
ResearchQuestion
  ├─ motivates → Hypothesis / IdeaCard
  ├─ bounded_by → ExperimentContract / ProtocolRevision
  ├─ tested_by → Job / RunSet / Experiment
  ├─ produces → Artifact / Evidence
  ├─ supports | contradicts | is_inconclusive_for → Claim
  ├─ leads_to → DirectionProposal / DirectionAdoption
  └─ narrated_by → ManuscriptSection / ParagraphRole
```

可另投影 Literature/ExternalClaim、Heuristic、Constraint、DeadEnd、ReviewFinding，但每个节点都必须有稳定 ID、project scope、source refs、provenance 和 revision。

### 9.2 explicit 与 inferred

- `explicit`：来自 Kernel 事件、signed RunManifest、accepted/verified Evidence、冻结 Corpus Passage、Human Decision 或可定位 Artifact；
- `inferred`：Agent/reviewer 对机制、模式、因果或历史路径的重建；
- `inferred` 节点永远不能单独支持 Claim；必须通过 review/adoption，并保留推断模型、输入 hash 和时间；
- Session Topology 只证明“某个 Agent 活动发生过”，不证明其研究结论为真；
- Research Trajectory 与 Session Trajectory 保持现有 authoritative/observational 双泳道，不合并账本。

ARA 对 Claim 的 direct evidence basis 与 higher-level interpretation 也做了分离，[见固定 compiler](https://github.com/Orchestra-Research/AI-Research-SKILLs/blob/773a52944ba4747a18bd4ae9ade53fff041adcbc/22-agent-native-research-artifact/compiler/SKILL.md#L91-L165)。这个分离应映射到 Evidence refs 与 synthesis/inference，而不是新增一个可绕过 Evidence 的 Claim 字段。

### 9.3 导入/接续研究

对于用户上传论文、代码、日志、笔记、旧 TeX 或外部 ARA，候选流程是：

1. Intake 扫描、OCR/解析、隔离和来源记录；
2. ARA-like compiler 只生成 `ImportProposal`：候选 Claim、Experiment、Evidence refs、environment、dead ends、gaps 和关系；
3. 确定性校验路径、hash、schema、project scope 和可验证 source span；
4. UI 展示 proposed graph 与未解析 gap；
5. Human adoption 走现有 Intake/Gate 边界；
6. 外部结果默认 `legacy_unverified`，绝不直接成为 accepted Evidence/supported Claim；
7. adoption receipt 记录每个 source → Scholar object 的映射。

## 10. 写作知识层

### 10.1 Section Guide 按需激活

候选首批 section kinds：

- Abstract；
- Introduction；
- Related Work；
- Method；
- Experiments；
- Limitations / Ethics；
- Conclusion；
- Appendix / Reproducibility；
- Reviewer response / Rebuttal（后续独立决策）。

每个 Section Guide 只提供：目标、常见结构、必要 inputs、禁止的无证据表达、检查表、输出 Schema 和适用 venue profile。它不能携带项目外的论文正文，也不能替代 Evidence Ledger。

Research-Paper-Writing-Skills 的整体流程是先澄清 story、分章节写、逐段一个 message、写后 reverse outline，再做 claim-evidence 和 adversarial review，[见固定 SKILL](https://github.com/Master-cai/Research-Paper-Writing-Skills/blob/77e7c2c1ba06f7d71844873147665437a03aac1b/research-paper-writing/SKILL.md#L12-L42)。建议吸收流程，不照抄文本模板。

### 10.2 Reverse Outline

候选 `ReverseOutline` 从某个冻结 TeX document revision 产生：

```yaml
document_id: doc_xxx
document_revision: 12
section_ref: sec_method
section_thesis: "..."
paragraphs:
  - paragraph_ref: p_01
    role: motivation
    topic_sentence_span: {file: sections/method.tex, start_line: 8, end_line: 8}
    message: "..."
    claim_refs: [claim_xxx]
    evidence_refs: [evidence_xxx]
    relation_to_thesis: supports | refines | contrasts | orphan
issues: []
input_hash: "sha256:..."
status: diagnostic
```

它只是一份诊断 Artifact。用户选择修复后才生成 TeX patch；保存仍走 Workspace/TeX revision CAS，编译仍走固定 TeX image。

原仓库要求将 section thesis、每段 topic sentence、证据/解释逐项映射，并删除或修改无法映射的段落，[见固定 reverse-outline 说明](https://github.com/Master-cai/Research-Paper-Writing-Skills/blob/77e7c2c1ba06f7d71844873147665437a03aac1b/research-paper-writing/SKILL.md#L32-L42)。Scholar 可把它结构化并绑定真实 Claim/Evidence refs。

### 10.3 Method Triad

每个方法模块建议形成三元计划：

1. `motivation`：它解决哪个明确问题，问题证据是什么；
2. `design`：输入、结构、处理步骤、输出和实现约束；
3. `technical_advantage`：相对替代方案为什么可能更好，以及用什么可测量行为验证。

该方法来自固定 Method Guide 的“Motivation / Module Design / Technical Advantages”，[见一手指南](https://github.com/Master-cai/Research-Paper-Writing-Skills/blob/77e7c2c1ba06f7d71844873147665437a03aac1b/research-paper-writing/references/method.md#L1-L70)。在 Scholar 中，`technical_advantage` 不允许只写修辞；它应尽量引用 Claim、Protocol 或 Evidence gap。写作期发现缺实验时，应创建 `MissingExperimentRequest` 草案/NextAction 候选，而不是编造支持。

### 10.4 实验章节的三问

写作知识层可把实验章节检查归纳为：

- 是否在公平协议下优于强 baseline？
- 哪个模块/设计造成差异，ablation 是否充分？
- 在更难、分布外或压力场景下边界是什么？

这三问及 failure mode 要求来自固定 Experiments Guide，[见一手指南](https://github.com/Master-cai/Research-Paper-Writing-Skills/blob/77e7c2c1ba06f7d71844873147665437a03aac1b/research-paper-writing/references/experiments.md#L1-L55)。在 Scholar 中，每个回答必须能回到 Contract/Run/Evidence；不能仅凭写作 reviewer 认定完整。

### 10.5 Reviewer Panel

候选 panel 角色：

| 角色 | 只读输入 | 允许输出 | 禁止 |
|---|---|---|---|
| Story/Flow Reviewer | TeX snapshot、ReverseOutline | flow/structure findings | 写 canonical TeX、批准 Release |
| Claim-Evidence Auditor | Claim、Evidence、TeX spans、analysis artifacts | unsupported/overclaim findings | 接受 Evidence |
| Citation/Provenance Auditor | Bib、Corpus Passage、citation spans | missing/mismatched citation findings | 从记忆生成 BibTeX |
| Statistics Reviewer | Contract、RunSet、analysis artifact | power/CI/multiple-testing findings | 重算后直接覆盖权威 analysis |
| Reproducibility Reviewer | snapshots、manifest、environment、clean-room report | reproducibility findings | 在宿主任意执行命令 |
| Method/Rigor Reviewer | Contract、protocol、negative findings、synthesis | scope/falsifiability/method findings | 修改 Scope/Contract |
| Venue/Layout Reviewer | compiled PDF、venue constraints | layout/limit/accessibility findings | 把视觉分数当科学验收 |
| License/AI-usage Reviewer | source/asset/license/usage manifests | compliance findings | 自动声明法律结论 |

AI-Research-SKILLs 的 rigor reviewer 把 evidence relevance、falsifiability、scope calibration、argument coherence、exploration integrity、methodological rigor 分成六维，[见固定 reviewer](https://github.com/Orchestra-Research/AI-Research-SKILLs/blob/773a52944ba4747a18bd4ae9ade53fff041adcbc/22-agent-native-research-artifact/rigor-reviewer/SKILL.md#L31-L82)。Research-Paper-Writing-Skills 还列出 contribution、clarity、empirical strength、evaluation completeness 和 method soundness，[见固定 paper review](https://github.com/Master-cai/Research-Paper-Writing-Skills/blob/77e7c2c1ba06f7d71844873147665437a03aac1b/research-paper-writing/references/paper-review.md#L1-L60)。候选 panel 可综合维度，但必须去重并输出统一 Finding Schema。

### 10.6 有界改进循环

候选写作循环是 `review → user/agent selects findings → patch proposal → CAS save → TeX compile → freshness check → fresh review`。必须满足：

- 最大轮数/预算明确；
- 每轮钉定 TeX revision、PDF artifact、guide version、review policy 与模型；
- reviewer 不读取执行者“我们已经修了什么”的有利叙述；
- 没有新的 TeX/PDF hash 就不重复花费做相同 review；
- 编译成功不代表内容 accepted；
- 达到轮数不是 submission-ready；未解决 blocking findings 继续显示。

## 11. 版本化 Skill Registry 与激活

### 11.1 为什么不能直接复制/软链

外部 Skill 可能包含任意 shell、网络、文件修改、递归加载和过时依赖。AI-Research-SKILLs 的价值在广度，但“安装全部”不等于对每个项目都安全或相关。DSH 的 SkillFilesystem 把本地 Skill 正文作为可信 instructions；Scholar 自有 `research-core` 已把本提案采纳的 Protocol、两层循环、Knowledge/Writing 与 Assurance 规则独立内化，且与其他内置目录一样由插件[全局挂载](../src/plugin/index.ts)。[选择逻辑](../src/plugin/skills.ts)只决定推荐名称，仍没有 Kernel 级 project pin、阶段 activation 或 capability envelope；因此该内化不能被解释为第三方 Pack 已注册/激活，第三方正文也不能直接复制或软链进当前 SkillFilesystem。

候选 Registry 必须把内容分为两条互不自动升级的通道：

| 通道 | 内容来源 | 注入方式 | V1 权限 |
|---|---|---|---|
| `Instruction Pack` | Scholar 原生内容，或只吸收方法后由 Scholar 独立重写、评审和测试的内容 | 可作为受控 instructions，且仅在固定 project/phase/action 激活 | 只读固定输入并产生 typed proposal/finding；无 shell、network、Secret、Runner、Gate 或直接写入 |
| `External Knowledge Pack` | 第三方原文、技术手册、示例、论文与上游 Skill | 只能作为不可信引用材料按需检索，正文不得进入 system/developer instructions | 只读引用；不能请求工具、改变权限、触发 mutation 或覆盖 Scholar policy |

V1 不运行“第三方 Skill Agent”。搜索、Workspace patch、Runner Job、Gate、Evidence 和 TeX 保存仍由现有 Scholar Tool/Kernel/NextAction 接口完成；Pack 只生成符合 Schema 的 proposal，再由相应权威路径决定是否采纳。

### 11.2 候选 `SkillPackageManifest`

```yaml
schema_version: 1
name: scholar.paper.reverse-outline
version: 1.0.0
kind: instruction | knowledge
source:
  mode: native | adapted | third-party
  repository: https://example.invalid/repo
  commit: full-40-char-sha
  path: path/to/skill
payload_sha256: "sha256:..." # manifest 之外的规范化文件树
license:
  spdx: MIT
  evidence_sha256: "sha256:..."
  attribution_refs: []
knowledge_freshness: # kind=knowledge 时必填
  upstream_version: "v1.2.3-or-date"
  verified_at: timestamp
  status: current | stale | unknown
compatibility:
  scholar_protocol: v2
  schema_min: 24
  stages: [WRITING, REVIEWING]
  next_action_codes: [manuscript_write, reviewer_run]
inputs:
  schema_id: scholar.reverse-outline.input.v1
  max_bytes: 262144
outputs:
  schema_id: scholar.reverse-outline.findings.v1
  authority: diagnostic
capabilities:
  project_read: [brief, accepted-evidence, manuscript-snapshot]
  proposal_types: [manuscript-patch, review-findings]
  tools: []
  network: none
  secrets: []
  side_effect: proposal-only
runtime:
  provider_policy_ref: provider_policy_xxx
  timeout_ms: 180000
  max_output_bytes: 131072
governance:
  default_enabled: false
  human_activation_required: true
  gate_decision_capability: false
  accepted_evidence_capability: false
tests:
  fixture_refs: []
  last_verified_at: null
status: quarantined | evaluating | approved | restricted | rejected | revoked
```

约束：manifest 使用 strict Schema，未知字段拒绝；Registry 另算 `manifest_sha256` 和 bundle CAS hash；依赖必须固定 exact version + manifest hash，不做 semver 自动求解；同一 name/version 不同 hash 视为供应链 equivocation 并拒绝。V1 的 `side_effect` 只允许 `none | proposal-only`，`tools` 与 `secrets` 必须为空，network 只能是 `none` 或 Scholar 内置且由平台执行的 connector capability。

### 11.3 候选激活流程

```text
fetch exact commit
  → verify hash/license/attribution
  → static scan + content classification
  → quarantine
  → operator evaluates and registers exact manifest/payload/bundle hashes
  → disabled by default
  → PI creates exact project Skill Pin
  → project/phase recommendation
  → Human or deterministic-safe activation receipt
  → freeze activation pins
  → execute with least privilege
  → schema/redaction/freshness validation
  → store draft/finding + topology/audit
```

激活必须绑定 project、session、phase、NextAction revision、Skill version/hash、完整依赖闭包 hash、model/provider/config pin、预算与 capability envelope。有效权限是 `manifest request ∩ evaluation grant ∩ Principal ACL ∩ current NextAction ∩ project policy`。任一输入、project revision 或 stage 变化会使迟到结果变 stale。上游更新生成 side-by-side 新 version；现有项目不自动换 pin。撤销后禁止新激活并在下一个 action boundary 停止，历史 Pin、Activation、Artifact 与 Release attribution 仍可审计。

### 11.4 候选持久对象与信任状态

最小对象不是“安装目录”，而是四个不可混淆的 Kernel 记录：

- `SkillPackageManifest`：来源、许可、内容 hash、兼容性、请求能力与 I/O Schema；
- `SkillEvaluation`：针对确切 manifest/payload hash 的路径安全、许可、语义策略、能力和 DSH/Scholar 兼容性 verdict；
- `SkillPin`：某 project 固定 package、bundle CAS 与排序后的 dependency closure hash；
- `SkillActivation`：一次 project/stage/action/revision 上的确切使用及输入/输出 refs、effective capabilities 和状态。

候选信任状态机是 `IMPORTED → QUARANTINED → EVALUATING → APPROVED | RESTRICTED | REJECTED`，其中 `APPROVED/RESTRICTED → REVOKED`。`RESTRICTED` 只能通过显式 project Pin 进入带 `untrusted-reference` 标记的 External Knowledge retrieval，绝不能注入 instructions；只有 Scholar-owned/adapted 且通过评测的 `APPROVED` package 可成为 `Instruction Pack`。`QUARANTINED/EVALUATING/REJECTED/REVOKED` 一律不可激活或检索；恢复被撤销内容必须发布新 package/version 并重新评测。

### 11.5 知识路由

候选路由顺序：

1. 读取权威 Project phase 和唯一主 NextAction；
2. 根据用户目标识别 activity/section/domain，不靠 Skill 自己抢占；
3. 从已注册且项目允许的 manifests 中过滤；
4. 选择最少 Pack，展示为何建议、需要什么权限和成本；
5. 对 Instruction Pack 只注入选中 Pack 的必要 reference；对 External Knowledge Pack 只检索最小片段并保留 untrusted/source 标记；
6. 输出仍经过统一 schema、provenance、redaction 和 fan-in。

## 12. 与现有 Scholar 能力的映射

| 外部方法/候选能力 | 现有 Scholar 对应面 | 候选吸收方式 | 不允许的替代 |
|---|---|---|---|
| Assurance audit | Job/Run、Artifact、Gate、Evidence | 新的审查 Artifact/聚合投影，绑定输入 hash | 用 Job `succeeded` 冒充审查 PASS |
| Independent reviewer | stage subagent + Topology | read-only reviewer node、fresh context、model pins | reviewer 直接批准 Gate/Evidence |
| Inner loop | Contract、NextAction、Runner、Analysis、Evidence | Protocol-bound cycle 投影 | `/loop` 或对话历史充当编排器 |
| Outer loop | Outbox、Evidence、Claim、NextAction | ResearchSynthesis + DirectionProposal/Adoption | 模型直接改 Project phase/Scope |
| Protocol-before-run | ExperimentContract、ExecutionPlan、Snapshot | 冻结 Protocol Revision/hash，Job admission 检查 | 运行后回填预测或改 confirmatory 标签 |
| Negative finding | RunSet、Analysis、Evidence、Claim history | 结构化 NegativeFinding/relations | 把 OOM/崩溃记成科学反例 |
| ARA cognitive layer | Corpus、IdeaCard、Claim、Evidence | typed graph projection + ImportProposal | 外部 Markdown/YAML 成为权威 DB |
| ARA physical layer | Workspace、CodeSnapshot、RunnerProfile、Artifact | 复用真实 snapshots/manifests | Agent 自报环境/结果 |
| ARA exploration graph | Research Trajectory + Session Topology | explicit/inferred typed nodes；双泳道 | Session activity 被当成研究事实 |
| Section guides | TeX Workbench、Chat、Writing subagent | 按 section/revision 激活 Scholar Instruction Pack，外部例证仅作 Knowledge retrieval | 一次加载全部知识和样例 |
| Reverse outline | TeX snapshot、Claim/Evidence refs | 只读 diagnostic Artifact + 可选 patch | 自动覆盖 canonical TeX |
| Method triad | IdeaCard、Contract、Manuscript section | 写作计划绑定问题、设计与可测优势 | 无证据的宣传性 advantage |
| Reviewer panel | Stage-aware panel、Topology | 专责 fan-out + typed findings + bounded fan-in | 投票即自动 Release |
| Skill catalog | 当前内置 Skills/config | 版本化 Registry/activation | 全局 copy/symlink 未审查 Skills |
| Research Wiki/findings | Kernel projections、Artifacts、Overview | 由权威对象生成可读 synthesis/report | `findings.md` 单独决定恢复状态 |
| Research continuation | Intake、Grill、Project、workspace | 导入 proposal + adoption receipt | 新项目重头开始或静默覆盖旧数据 |

## 13. 候选配置面（明确延后、无当前注册键）

下面用于讨论未来在真实 runtime consumer、持久化和 source parity 同时存在时，Settings 与 Config Registry 可以暴露什么；它不是当前合法配置。此前八个无 consumer 的占位键已经删除，复制到配置文件必须被现有严格 Schema 以 unknown key 拒绝，Settings/schema/effective config 也不得显示这些候选项。

```yaml
methodology:
  enabled: false
  research_loops:
    enabled: false
    synthesis_trigger:
      valid_cycles: 5
      on_stall: true
      on_contract_stop_condition: true
    allowed_direction_proposals: [deepen, broaden, pivot, conclude, pause]
    auto_adopt_direction: false
  protocol:
    required_before_secure_run: true
    require_intent_label: true
    allow_post_run_relabel: false
  assurance:
    level: draft
    always_emit_mandatory_audits: true
    stale_on_input_hash_change: true
    semantic_acceptance_requires: cross-family-or-human
  writing:
    section_guides_enabled: false
    reverse_outline_enabled: false
    reviewer_panel_enabled: false
    max_revision_rounds: 2
knowledge_registry:
  enabled: false
  allow_remote_sources: false
  require_full_commit_pin: true
  require_content_hash: true
  require_license_record: true
  default_activation: disabled
  max_active_packs_per_action: 3
  network_default: none
  secret_default: deny
```

配置设计原则：

- instance/team policy 可收紧，项目不能放宽；
- remote source 下载与 Pack 执行分离；下载不等于激活；
- Secret 只通过 SecretRef/最小 scope，Skill manifest 和 UI 永不显示 value；
- running Job/reviewer 固定 config revision/hash；配置变化只影响新 attempt；
- Settings 默认折叠到 Agent/Methodology/Knowledge Registry，业务页不常驻堆放配置；
- 所有字段必须生成 zh/en label、description、error 和 ARIA。

## 14. UI 投影草案

### 14.1 Overview

新增能力若获批，Overview 可渐进披露以下卡片：

- **当前研究节奏**：Inner Loop 第几次有效 cycle、上次 synthesis 时间、是否达到 outer-loop trigger；
- **当前理解**：supported/contradicted/negative/inconclusive 数量和最重要 open gap；
- **方向建议**：deepen/broaden/pivot/conclude/pause，显示依据、影响对象和是否需要 Human Gate；
- **Assurance**：draft/submission level、mandatory audits、fresh/provisional/stale/blocking 数量；
- **知识包**：本阶段建议的 Pack、来源/version、权限、成本和“启用”动作。

这些卡片只能消费 Kernel/BFF 投影，不在浏览器推断阶段或 acceptance。

### 14.2 Runs / Evidence

- Runs 详情显示 Protocol intent、revision/hash、prediction、deviations、run validity；
- Evidence 图以 Claim → Protocol/Run → Evidence → Manuscript span 展示；
- negative 与 infrastructure failure 使用不同状态/颜色/图例，且不只靠颜色；
- explicit/inferred 节点有文字 badge，悬浮/键盘 inspector 显示来源；
- stale synthesis/audit 不消失，明确说明哪个输入已改变和应重跑什么。

### 14.3 Manuscript

- 左侧仍是文件/章节；可选“写作计划”展示 section guide、ReverseOutline 和 Method Triad；
- reviewer findings 按角色/severity/target span 聚合，可逐项生成 patch proposal；
- PDF 与 TeX revision 固定；旧审查在编辑后立即标 stale；
- 缺 Evidence 的 Claim 只能弱化、删除或创建 MissingExperimentRequest，不能一键“补证据文案”；
- Compile、Assurance 和 Release 三个状态独立展示。

### 14.4 Trajectory / Topology

- Reviewer Instruction Pack execution 与 External Knowledge retrieval 复用现有 Topology node，但明确区分 `instruction` 与 `untrusted-reference`；
- node 显示 pack/version、role、input hash、model/provider pin、execution status、verdict 和 acceptance status；
- Research lane 展示 adopted synthesis/direction/audit 事件；Session lane 展示 Agent 活动；
- fan-out 数量只用于观察，不反向改变 phase/NextAction。

### 14.5 DSH 本体内的 Scholar 摘要

DSH 对话内只投影当前项目、phase、NextAction、loop/synthesis/assurance 摘要和打开完整 Scholar 的入口；不嵌入整个 Scholar 工作台。未绑定项目时仍先选择/创建并绑定项目。自然对话可解释“为什么建议下一步”和生成可编辑 slash command，但 Human Gate、adoption、release decision 不能自动执行。

## 15. 安全、许可与供应链边界

### 15.1 外部内容是不可信输入

论文、仓库、Skill Markdown、README、Notebook、日志和网页都可能含 prompt injection 或破坏性命令。它们必须经过 Intake/quarantine、大小/类型限制、路径安全、内容扫描和 tool capability 隔离。External Knowledge Pack 文本不能覆盖 system/Kernel policy。

### 15.2 Skill 供应链

- 只接受完整 40 字符 commit + content hash；不在运行时拉取 floating branch/tag；
- 保存 repo/path/license/attribution 和扫描报告；
- 禁止安装脚本任意写全局 Agent 目录；
- 禁止 manifest 声明未登记工具、任意 Bash、宿主路径或 Secret；
- 上游更新先进入新 candidate version，跑 compatibility/security/behavior fixtures 后再允许激活；
- 被撤销 version 立即禁止新调用，历史记录仍可读取；
- Pack 输出先通过 schema、大小限制、redaction、project scope 和 freshness fence。

### 15.3 许可与归属

本节是工程与供应链风险判断，不是法律意见。方法语义的独立实现已获分阶段授权；复制、vendor、远程 Pack source 与第三方内容再发布仍保持 `NOT_AUTHORIZED`。“仓库根许可证可读”不能替代逐文件归属、第三方来源和商标审查。

#### 15.3.1 固定快照与共同判断

三个固定仓库的根 `LICENSE` 文件都声明 MIT：

- [ARIS 固定 LICENSE](https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep/blob/f4f20f90ead9cb8d68e830ee5b006121adc41f80/LICENSE#L1-L21)
- [Research-Paper-Writing-Skills 固定 LICENSE](https://github.com/Master-cai/Research-Paper-Writing-Skills/blob/77e7c2c1ba06f7d71844873147665437a03aac1b/LICENSE#L1-L21)
- [AI-Research-SKILLs 固定 LICENSE](https://github.com/Orchestra-Research/AI-Research-SKILLs/blob/773a52944ba4747a18bd4ae9ade53fff041adcbc/LICENSE#L1-L21)

MIT 允许使用、复制、修改、合并、发布、分发、再许可和销售，但要求在软件的全部副本或实质部分中保留原 copyright notice 与 permission notice。它不要求把 DSH Scholar 改成 MIT，也不要求公开 Scholar 源码；Scholar 根仓库可继续使用 BSD-3-Clause，但每个实际复制进来的 MIT 组件仍必须保留自己的 MIT notice，不能只用 Scholar 的 BSD 文本覆盖。对修改过的第三方文件标记本项目改动、保留原作者和固定来源虽不是 MIT 文本的显式“修改声明”条款，仍应作为供应链硬要求。

仅在文档中提及仓库、链接固定 commit 并说明其影响，通常不等于复制或重新分发软件；仍应做正常学术/工程署名。只吸收抽象流程、系统或方法，并用 Scholar 自己的领域对象、文字、代码和测试独立实现，是当前推荐边界。美国版权局也明确区分“不保护思想、过程、系统、操作方法”与“可以保护其具体文字、图表和代码表达”，[见 Circular 33](https://www.copyright.gov/circs/circ33.pdf)；其他司法辖区和具体相似度判断可能不同，因此不能用“思想不受保护”给逐句翻译、近似改写或复制 schema/提示词自动免责。

MIT 文本没有明示商标许可，也不像 Apache-2.0 那样写出独立的明示 patent grant。工程上应避免使用仓库名称、组织名、Logo 或 badge 暗示官方合作/认证；若复制的实现涉及已知专利、品牌或训练/数据权利，仅通过 MIT copyright notice 不能关闭这些问题，应另行审查。

许可证文件仍不能替代逐文件来源核验。Research-Paper-Writing-Skills 明确说明大部分方法知识来自 Prof. Peng Sida 的公开学习笔记，[见固定 README attribution](https://github.com/Master-cai/Research-Paper-Writing-Skills/blob/77e7c2c1ba06f7d71844873147665437a03aac1b/README.md#L1-L15)；AI-Research-SKILLs 则包含官方会议模板、框架文档衍生内容和具有独立许可头的第三方文件。三仓库共同采用以下分级，任何“尚未核验”都不得解释为“默认允许”：

| 分级 | 判定 | 当前允许的处理 |
|---|---|---|
| `METHOD_ONLY` | 只吸收抽象方法、流程或事实，不复制表达、代码、模板或品牌资产 | 记录来源后独立重写；仍不构成实现授权 |
| `REFERENCE_ONLY` | 仅作为带引用的外部资料检索，不重新分发，也不能成为 Agent 指令 | 作为 `untrusted-reference` 隔离读取 |
| `VENDOR_CLEAR` | 单个文件的权利人、许可证、来源和义务均清晰且与目标发布兼容 | 固定 commit/hash、保留声明并经审批后才可 vendor |
| `MIXED_REVIEW` | 根许可证与文件元数据不一致，或含第三方内容、模板、示例、衍生文档 | 隔离；建立逐文件 manifest/SBOM 并完成人工归属复核 |
| `UPSTREAM_AMBIGUOUS` | 当前仓库声明许可，但承认核心表达来自未明确再许可的上游 | 只允许 `METHOD_ONLY`；任何上游表达按 `BLOCKED` 处理，直到权利人明确授权 |
| `BLOCKED` | 无许可证、all rights reserved、禁止修改、所需源文件缺失、义务不可满足或品牌资产权利不明 | 不复制、不打包；改用官方链接、运行时受控获取或用户自行提供 |

#### 15.3.2 ARIS 专项核查

截至 2026-08-20，ARIS 默认分支 `main` 的最新提交仍为固定快照 [`f4f20f90ead9cb8d68e830ee5b006121adc41f80`](https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep/commit/f4f20f90ead9cb8d68e830ee5b006121adc41f80)。根 MIT 清晰，但仓库包含多条文件级来源链，因此整仓只能判为 `MIXED_REVIEW`：

| 核查面 | 固定快照证据 | 结论与约束 |
|---|---|---|
| 根许可 | [`LICENSE`](https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep/blob/f4f20f90ead9cb8d68e830ee5b006121adc41f80/LICENSE#L1-L21) 为 MIT，版权主体为 wanshuiyin | ARIS 原创文件可按 MIT 处理，但必须保留原 notice；根许可不覆盖文件内声明的其他来源 |
| Posterly 派生内容 | [`paper-poster-html/NOTICE.md`](https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep/blob/f4f20f90ead9cb8d68e830ee5b006121adc41f80/skills/paper-poster-html/NOTICE.md#L1-L31) 列出原样复制/改编的 posterly 脚本、模块与模板，并附 [`posterly-MIT.txt`](https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep/blob/f4f20f90ead9cb8d68e830ee5b006121adc41f80/skills/paper-poster-html/LICENSES/posterly-MIT.txt) | 若复制这些路径，必须同时保留 posterly 的版权、MIT 与 NOTICE，不能只保留 ARIS MIT |
| 其他开源改编 | [`proof-orchestrator/NOTICE.md`](https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep/blob/f4f20f90ead9cb8d68e830ee5b006121adc41f80/skills/proof-orchestrator/NOTICE.md#L1-L24) 记录 EtaSkill/MPL-2.0 来源及贡献者再许可声明；[`threat_scan.py`](https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep/blob/f4f20f90ead9cb8d68e830ee5b006121adc41f80/tools/threat_scan.py#L14-L21) 记录 NousResearch/hermes-agent MIT 来源 | 抽取单个文件会丢失仓库外或相邻 NOTICE；必须回到真正上游核实权利人与完整许可，不能只信 Skill frontmatter |
| Apache-2.0 改编 | [`compute-env-contract.md`](https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep/blob/f4f20f90ead9cb8d68e830ee5b006121adc41f80/skills/shared-references/compute-env-contract.md#L1-L9) 声明改编自 Apache-2.0 的 Anthropic Claude Science 内容 | 若复制表达或代码，需按真正上游 Apache-2.0 的版权、许可、修改说明和可能的 NOTICE 义务处理；ARIS 根 MIT 不能消除这些义务 |
| 论文模板 | [`IEEEtran.cls`](https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep/blob/f4f20f90ead9cb8d68e830ee5b006121adc41f80/skills/paper-write/templates/IEEEtran.cls#L50-L60) 使用 LPPL 1.3 并对修改/命名有要求 | 会议模板逐文件回到官方来源核验；当前不 vendor |
| 写作 overlay | [`paper-plan`](https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep/blob/f4f20f90ead9cb8d68e830ee5b006121adc41f80/skills/paper-plan/SKILL.md#L377-L379) 与 [`paper-write`](https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep/blob/f4f20f90ead9cb8d68e830ee5b006121adc41f80/skills/paper-write/SKILL.md#L602-L604) 自述受 Master-cai、Orchestra 等项目启发/改编 | 来源 commit、逐段归属和许可不完整；写作相关内容只允许 `METHOD_ONLY`，不能经 ARIS 根 MIT 间接清洗上游表达 |

ARIS 当前允许 `METHOD_ONLY`，以及在不重新分发正文时的 `REFERENCE_ONLY`；不整体 vendor，不复制 posterly、Hermes/Nous、Anthropic、EtaSkill、论文模板或写作 overlay 文件。若以后选择单个文件，必须建立真正上游的 license/NOTICE/修改记录和固定 hash。

#### 15.3.3 Research-Paper-Writing-Skills 专项核查

截至 2026-08-20，该仓库 `main` 的最新提交仍为固定快照 [`77e7c2c1ba06f7d71844873147665437a03aac1b`](https://github.com/Master-cai/Research-Paper-Writing-Skills/commit/77e7c2c1ba06f7d71844873147665437a03aac1b)。其根 MIT 只足以说明 Master-cai 对自己有权许可的原创整理/表达所作声明，不能证明全部上游内容已获得 MIT 再许可：

| 核查面 | 固定快照证据 | 结论与约束 |
|---|---|---|
| 根许可 | [`LICENSE`](https://github.com/Master-cai/Research-Paper-Writing-Skills/blob/77e7c2c1ba06f7d71844873147665437a03aac1b/LICENSE#L1-L21) 为 MIT，版权主体为 Master-cai | 直接复制其明确原创文件仍要保留 MIT；但必须先确认该文件不含无权再许可的上游表达 |
| 核心知识归属 | README 明确说“大部分写作知识与方法论”来自 Prof. Peng Sida 的公开笔记，作者贡献主要是组织、结构化改编和 Skill 打包，[见 attribution](https://github.com/Master-cai/Research-Paper-Writing-Skills/blob/77e7c2c1ba06f7d71844873147665437a03aac1b/README.md#L5-L11) | 不能假设根 MIT 自动覆盖彭思达笔记的具体表达 |
| 真正上游许可 | 彭思达 [`learning_research`](https://github.com/pengsida/learning_research/tree/6fdbcdfe24167feb7164d5625a477c75bd118040) 没有 LICENSE；README 只要求转载注明出处，[见 Citation](https://github.com/pengsida/learning_research/blob/6fdbcdfe24167feb7164d5625a477c75bd118040/README.md#L44-L48) | 公开可读、可 fork 或写“开源”不等于获得修改、商业使用、再许可和 BSD/MIT 分发权；GitHub 也说明无许可证时默认版权法适用，[见官方说明](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository) |
| PDF 转写 | [`does-my-writing-flow-source.md`](https://github.com/Master-cai/Research-Paper-Writing-Skills/blob/77e7c2c1ba06f7d71844873147665437a03aac1b/research-paper-writing/references/does-my-writing-flow-source.md#L1-L45) 自称从第三方 PDF 提取并仅轻度排版 | 未见对应再分发许可；该文件保持 `BLOCKED`，不内置、不作为 few-shot |
| 论文原文示例 | [`template-b.md`](https://github.com/Master-cai/Research-Paper-Writing-Skills/blob/77e7c2c1ba06f7d71844873147665437a03aac1b/research-paper-writing/references/examples/abstract/template-b.md#L3-L33)、[`example-of-the-three-elements.md`](https://github.com/Master-cai/Research-Paper-Writing-Skills/blob/77e7c2c1ba06f7d71844873147665437a03aac1b/research-paper-writing/references/examples/method/example-of-the-three-elements.md#L18-L66) 等含论文摘要或较长正文，部分只有 `[n]` 编号而无完整 provenance | 开放访问不等于允许把论文表达重新打包；examples 子树当前 `BLOCKED`，只使用 Scholar 自建合成示例或用户拥有的项目材料 |

该仓库统一采用 `adoption_mode=conceptual_rewrite`、`license_status=upstream_ambiguous`、`vendored_content=none`、`example_policy=synthetic_or_project_owned_only`。可以引用仓库、Master-cai 与彭思达笔记并固定 commit；不能复制 Skill 正文、章节指南、模板、PDF 转写、论文段落或 examples，除非逐项取得清晰的原始权利人许可。

#### 15.3.4 AI-Research-SKILLs 专项核查

截至 2026-08-20，AI-Research-SKILLs 默认分支 `main` 的最新提交仍为固定快照 [`773a52944ba4747a18bd4ae9ade53fff041adcbc`](https://github.com/Orchestra-Research/AI-Research-SKILLs/commit/773a52944ba4747a18bd4ae9ade53fff041adcbc)，本轮结论不存在“固定 SHA 已落后当前默认分支”的漂移问题。但其仓库级结论只能是 `MIXED_REVIEW`，不能按根 MIT 整仓判为 `VENDOR_CLEAR`：

| 核查面 | 固定快照证据 | 结论与约束 |
|---|---|---|
| 根许可与 npm 元数据 | 根 [`LICENSE`](https://github.com/Orchestra-Research/AI-Research-SKILLs/blob/773a52944ba4747a18bd4ae9ade53fff041adcbc/LICENSE#L1-L21) 为 MIT，版权主体写作 “Claude AI Research Skills Contributors”；根 [`package.json`](https://github.com/Orchestra-Research/AI-Research-SKILLs/blob/773a52944ba4747a18bd4ae9ade53fff041adcbc/package.json#L1-L22) 却声明 ISC 且 `author` 为空；发布子包 [`packages/ai-research-skills/package.json`](https://github.com/Orchestra-Research/AI-Research-SKILLs/blob/773a52944ba4747a18bd4ae9ade53fff041adcbc/packages/ai-research-skills/package.json#L1-L48) 又声明 Orchestra Research / MIT；[`CITATION.cff`](https://github.com/Orchestra-Research/AI-Research-SKILLs/blob/773a52944ba4747a18bd4ae9ade53fff041adcbc/CITATION.cff#L1-L16) 也标 MIT | 这是范围和归属元数据不一致，不应自行选择最宽松解释；需上游澄清根包与发布包各自适用许可和版权主体 |
| Skill 与文档来源 | 论文写作 Skill 自称 Orchestra Research / MIT，但同时说明其方法结合多位研究者理念和会议模板，[见 Skill 头部](https://github.com/Orchestra-Research/AI-Research-SKILLs/blob/773a52944ba4747a18bd4ae9ade53fff041adcbc/20-ml-paper-writing/ml-paper-writing/SKILL.md#L1-L15)；README 说明 reference 由官方文档、GitHub issue/release 等来源生成，[见来源说明](https://github.com/Orchestra-Research/AI-Research-SKILLs/blob/773a52944ba4747a18bd4ae9ade53fff041adcbc/README.md#L337-L367)，并致谢 Claude Code、自动文档抓取工具和开源社区，[见 acknowledgements](https://github.com/Orchestra-Research/AI-Research-SKILLs/blob/773a52944ba4747a18bd4ae9ade53fff041adcbc/README.md#L480-L489) | Skill frontmatter 的 MIT 是作者自述，不能自动覆盖其引用、抓取或嵌入的第三方文字与示例；复制前需做表达级来源核查，默认只取 `METHOD_ONLY` |
| 上游自己的许可警告 | README 明确说仓库为 MIT，但各 Skill 引用的库可能采用不同许可证，用户应逐项检查，[见 License 段](https://github.com/Orchestra-Research/AI-Research-SKILLs/blob/773a52944ba4747a18bd4ae9ade53fff041adcbc/README.md#L448-L452) | 不能用根 MIT 对整个 Skill、reference、代码示例或模板做 blanket relicensing |
| LaTeX/BibTeX 第三方文件 | COLM 模板内 [`natbib.sty`](https://github.com/Orchestra-Research/AI-Research-SKILLs/blob/773a52944ba4747a18bd4ae9ade53fff041adcbc/20-ml-paper-writing/ml-paper-writing/templates/colm2025/natbib.sty#L1-L27) 声明 LPPL 且写明分发需带原始 `natbib.dtx`；ICML 模板内 [`fancyhdr.sty`](https://github.com/Orchestra-Research/AI-Research-SKILLs/blob/773a52944ba4747a18bd4ae9ade53fff041adcbc/20-ml-paper-writing/ml-paper-writing/templates/icml2026/fancyhdr.sty#L1-L27) 采用 LPPL 1.3+；ACL 的 [`acl_natbib.bst`](https://github.com/Orchestra-Research/AI-Research-SKILLs/blob/773a52944ba4747a18bd4ae9ade53fff041adcbc/20-ml-paper-writing/ml-paper-writing/templates/acl/acl_natbib.bst#L1-L34) 另有原作者、修改者和 LPPL 声明 | 均是独立许可材料；若义务、对应源码和 notices 未逐项满足，至少为 `MIXED_REVIEW`，不能跟随根 MIT 打包 |
| 会议模板限制 | AAAI 样式文件写明不得为 AAAI 使用而修改，并标注 AAAI copyright / all rights reserved，[见 `aaai2026.sty`](https://github.com/Orchestra-Research/AI-Research-SKILLs/blob/773a52944ba4747a18bd4ae9ade53fff041adcbc/20-ml-paper-writing/ml-paper-writing/templates/aaai2026/aaai2026.sty#L18-L50)；其 README 又说明模板来自官方材料并经 Cursor 改进、合并，[见模板说明](https://github.com/Orchestra-Research/AI-Research-SKILLs/blob/773a52944ba4747a18bd4ae9ade53fff041adcbc/20-ml-paper-writing/ml-paper-writing/templates/aaai2026/README.md#L1-L35)；ACL README 也提醒作者不得修改官方样式，[见 ACL 说明](https://github.com/Orchestra-Research/AI-Research-SKILLs/blob/773a52944ba4747a18bd4ae9ade53fff041adcbc/20-ml-paper-writing/ml-paper-writing/templates/acl/README.md#L1-L34) | `aaai2026.sty` 当前按 `BLOCKED` 处理；其他会议模板必须回到官方来源逐项核验，优先不 vendor |
| 无明确文件级许可的模板 | NeurIPS 样式头说明经过重写并列出作者但未在该头部给出许可，[见 `neurips.sty`](https://github.com/Orchestra-Research/AI-Research-SKILLs/blob/773a52944ba4747a18bd4ae9ade53fff041adcbc/20-ml-paper-writing/ml-paper-writing/templates/neurips2025/neurips.sty#L1-L21)；OSDI 样式称来源于官方模板却又是 simplified version，[见 `usenix-2020-09.sty`](https://github.com/Orchestra-Research/AI-Research-SKILLs/blob/773a52944ba4747a18bd4ae9ade53fff041adcbc/20-ml-paper-writing/systems-paper-writing/templates/osdi2026/usenix-2020-09.sty#L1-L12) | 在上游许可链、修改权和再分发权明确前为 `MIXED_REVIEW` 或 `BLOCKED`，不能因位于 MIT 仓库内而推定可复制 |

AI-Research-SKILLs 当前只建议吸收方法语义并独立重写，不复制其完整 Skill 文本、reference、脚本、会议模板、示例库、论文段落、图表或 BibTeX。若以后用户明确授权实施，也只能按文件选择性审查，不能 vendor 整仓或整套 Skill pack。

#### 15.3.5 品牌、框架引用与 vendor 义务

- Claude/Anthropic、NVIDIA、Hugging Face、Meta、会议名称及其产品名只能作为必要的事实性、指称性引用；MIT/ISC 等版权许可不授予商标、Logo、认证或合作背书权。不得复制 Logo、badge、品牌视觉资产，也不得让 Scholar UI/README 暗示官方隶属或认证。
- 来自框架官方文档、issue、release、示例或自动抓取的内容按原始来源许可判断，而不是按 AI-Research-SKILLs 根许可判断；External Knowledge 层只保留出处、固定版本和检索证据，不把原文提升为内部指令。
- 每个拟 vendor 文件必须先产生 `repo/path/commit/content-hash/original-author/license/source/obligations/notice/review-verdict` 清单；MIT/ISC 文件保留完整 copyright 与 permission notice，LPPL 或其他许可按其修改、命名、源码伴随和分发条件执行。
- 第三方依赖或资产若被重新分发，发布物必须生成并校验 SBOM/`THIRD_PARTY_NOTICES`；仓库内没有统一 NOTICE 不能视为“没有第三方义务”。无法证明来源或满足义务时回退到官方链接、受控获取或用户提供，而不是增加兼容 fallback。
- 会议模板默认不进入 Scholar 仓库；由用户从官方渠道上传，或在明确授权、固定版本、校验哈希和逐文件许可通过后获取。任何 `all rights reserved`、禁止修改、无许可或要求源文件但无法满足的材料保持 `BLOCKED`。

#### 15.3.6 三仓库当前审计状态

| 仓库 | 当前许可/归属状态 | 本轮边界 |
|---|---|---|
| ARIS | `MIXED_REVIEW` | 根 MIT，但含 posterly/Nous/Anthropic/EtaSkill/LPPL 模板和写作 overlay 来源链；当前只允许 `METHOD_ONLY` / `REFERENCE_ONLY` |
| Research-Paper-Writing-Skills | `MIXED_REVIEW / UPSTREAM_AMBIGUOUS`；PDF 转写与 examples 含 `BLOCKED` 候选 | 上游笔记无明确许可，部分文件是第三方表达；只允许 `METHOD_ONLY`，示例必须自建或项目所有 |
| AI-Research-SKILLs | `MIXED_REVIEW`；模板子树含 `BLOCKED` 候选 | 当前仅 `METHOD_ONLY` / `REFERENCE_ONLY`；禁止整仓或整包 vendor |

因此，在三仓库逐文件许可链都完成前，当前统一决策是：只吸收通用方法思想并独立重写，不复制示例库、论文段落、图表、BibTeX、大段提示词、第三方模板或品牌资产。所有 vendor 决定须经过明确用户授权和法律/归属复核。

### 15.4 数据与模型边界

- reviewer/Pack 只能读取明确 allowlist 的 project-scoped Artifact/Snapshot；
- 私有数据不得因“跨模型独立审查”自动上传到外部 provider；provider eligibility 必须受项目 data policy 控制；
- prompt、trace、Topology、Bundle 不记录 Secret、SSH endpoint/key、Authorization、完整 cwd/宿主路径；
- 语义 reviewer 不执行代码；需要重跑时创建受 Runner 治理的 Job；
- model/provider unavailable 时返回 `BLOCKED/ERROR`，不得静默换模型并继续声称独立审查。

## 16. 明确不吸收

以下内容即使上游可用，也不应进入 Scholar 设计：

1. “不要请求许可、永远继续”的无限自治；AI-Research-SKILLs 的原始 Autoresearch 有这一指令，[见固定原文](https://github.com/Orchestra-Research/AI-Research-SKILLs/blob/773a52944ba4747a18bd4ae9ade53fff041adcbc/0-autoresearch-skill/SKILL.md#L10-L31)。
2. 固定时间 `/loop`、cron/heartbeat 重新提示 Agent 充当持久编排器。
3. 让 Markdown、YAML、Git commit、对话历史或 research wiki 成为权威状态。
4. 让执行者自审、自修后自行判定 submission-ready；禁止 self-acquittal。
5. 把多个 reviewer 的平均分或多数票直接变成 accepted Evidence/Release Decision。
6. 把 `execution succeeded`、TeX 编译成功或 Runner exit 0 表述为科学验收成功。
7. 把基础设施失败、代码 bug、OOM 或断线记作 negative scientific finding。
8. 运行后修改预测、主指标或 intent，并把结果追认成 confirmatory。
9. 全量安装/全局软链几十个外部 Skill，或运行时拉取未经固定的 HEAD。
10. 外部 Skill 自带的任意 Bash、破坏性 Git、SSH、Docker flags、Secret 读取或宿主路径访问。
11. 硬编码 ARIS/Orchestra 的具体模型、review round、目录结构、CLI 或供应商名称。
12. 从模型记忆生成 BibTeX、DOI、实验数字、引用定位或环境事实。
13. 原样复制 Writing Skills 的示例段落、论文表达、图表或上游笔记内容。
14. 用 ARA “Seal”命名暗示已经做了代码执行、外部来源复核或确定性科学验证；其 Level 2 reviewer 明确只读 Artifact、不执行代码也不查外部来源，[见固定边界](https://github.com/Orchestra-Research/AI-Research-SKILLs/blob/773a52944ba4747a18bd4ae9ade53fff041adcbc/22-agent-native-research-artifact/rigor-reviewer/SKILL.md#L1-L30)。
15. 为兼容外部仓库另建第二套 Project、Gate、Runner、Evidence、TeX 或 Topology 模型。

## 17. 已采纳决策清单

用户已授权“整合需要执行的并开始执行”，因此 D01–D20 采用下表选择。规范语义已拆入 `methodology-knowledge-layer.md`；本表保留决策理由，不替代规范。

| ID | 决策问题 | 可选方向 | 采纳选择 | 原阻断影响 |
|---|---|---|---|---|
| D01 | 是否认可“Kernel 运行时 + Methodology/Knowledge 非权威层”的总架构？ | 认可 / 调整 / 拒绝 | 认可 | 不能继续定义 Registry/loop 对象 |
| D02 | Assurance 是否采用 execution/verdict/acceptance 三轴？ | 三轴 / 两轴 / 保持现状 | 三轴 | “完成/通过”继续有歧义 |
| D03 | verdict 是否采用六值集合？ | 六值 / 自定义集合 | 六值并增加 stale 为 acceptance 状态 | verifier 与 UI 无法定稿 |
| D04 | submission assurance 是否要求 independent reviewer？ | cross-family-or-human / same-family 可 accepted / 仅 Human | cross-family-or-human，受数据策略限制 | 无法确定 provisional→accepted |
| D05 | Protocol Revision 是否成为 secure Run admission 必需对象？ | 必需 / 仅 confirmatory 必需 / 可选 | 正式/confirmatory 必需 | protocol-before-run 无确定性约束 |
| D06 | confirmatory/exploratory 和 outcome 是否采用正交双轴？ | 采用 / 简化 | 采用，并加 run validity 第三轴 | negative finding 容易误分类 |
| D07 | outer loop 的 trigger 是确定性阈值还是 Agent 自主？ | 阈值+事件 / Agent / Human-only | 阈值+事件，Human 可随时触发 | synthesis 调度无法验收 |
| D08 | DirectionProposal 的 adoption 权限？ | Human / verifier+policy / Agent | pivot/broaden Human；deepen/conclude 由规则+现有 Gate 约束 | NextAction 映射无法确定 |
| D09 | 是否引入 ResearchSynthesis typed object？ | 引入 / 只做 Artifact | 引入 typed header + Artifact body | Outer loop 可能退化成自由文本 |
| D10 | Research Graph 是独立存储还是可重建投影？ | 投影 / 独立权威图 | 优先可重建投影，必要关系落 typed edges | 存储/API 设计无法开始 |
| D11 | ARA-like 导入是否只产 ImportProposal？ | proposal+adoption / 直接导入 | proposal+Human adoption | 外部研究接续的信任边界不明 |
| D12 | 首批写作能力范围？ | section guides / reverse outline / method triad / reviewer panel 的子集 | 先 reverse outline + claim-evidence；再 triad/panel | 无法安排分期 |
| D13 | Reviewer Panel 首批角色？ | story、claim、citation、statistics、reproducibility、rigor、venue、license 中选择 | claim/citation/statistics/reproducibility 四个 | fan-out schema/预算不明 |
| D14 | 是否建立版本化 Skill Registry，并强制 Instruction/External Knowledge 双通道？ | 双通道 Registry / 只维护内置 Pack / 直接用 DSH Skills | 先本地双通道 Registry，再考虑外部 source | 外部知识无法安全扩展，第三方正文可能被误当 trusted instructions |
| D15 | 外部 Pack 激活权限？ | Operator 注册+Project Human 激活 / 自动 / 内置免审 | Operator 注册，项目显式激活；内置也记录版本 | authority receipt 不明 |
| D16 | 是否允许远程 Pack source？ | 永不 / Operator-only / 项目可配 | 首版不允许；后续 Operator-only | 供应链范围不明 |
| D17 | 是否采用候选配置命名空间？ | 采用 / 重命名 / 合并到 subagents | 独立 methodology + knowledge_registry | Config/UI 无稳定归属 |
| D18 | UI 首批投影放在哪里？ | Overview/Evidence/Manuscript/Topology 组合 | Overview 摘要 + Manuscript reverse outline + Topology audit | 前端验收面无法收敛 |
| D19 | 三个外部仓库的具体内容是否允许 vendor？ | 仅思想重写 / 逐文件 vendor 并保留全部义务 / 不使用 | 当前统一 `METHOD_ONLY`；只有单文件达到 `VENDOR_CLEAR` 且另行批准才例外 | 许可、NOTICE、模板和上游归属风险无法关闭 |
| D20 | 是否为本提案进入下一阶段授权？ | 只继续研究 / 先写规范 / 开始实现 | 分阶段开始实现；每阶段文档先行、失败测试先行 | 未授权时必须保持未实现 |

## 18. 已采纳验收场景来源

### 18.1 Assurance

- `METH-A01`：Audit Job exit 0、verdict FAIL；UI/API 必须显示 execution succeeded + verdict FAIL，不能显示“通过”。
- `METH-A02`：mandatory audit 检测器为否；仍生成 `NOT_APPLICABLE` Artifact。缺 Artifact 的相同输入必须是 missing/blocking，不能显示 N/A。
- `METH-A03`：TeX/Evidence 输入任一 hash 改变；旧 audit 变 stale，历史保留，submission assurance 被阻断。
- `METH-A04`：same-family reviewer PASS；若 policy 要求 cross-family-or-human，acceptance 只能 provisional。
- `METH-A05`：review provider 不可用；返回 ERROR/BLOCKED，不能静默换 provider 或沿用旧 PASS。
- `METH-A06`：语义 reviewer PASS，但 Human Release Gate 未批准；项目不能 RELEASED。

### 18.2 Protocol 与研究循环

- `METH-L01`：secure/confirmatory Job 没有冻结 Protocol Revision；Kernel admission 零 Job/Run，返回稳定缺口。
- `METH-L02`：Run 已创建后尝试修改 prediction/primary metric/intent；旧 protocol 不变，新 revision 需要现有 Contract/Gate 规则。
- `METH-L03`：confirmatory valid run 得到 negative outcome；记录负结果并可影响 Claim，但 Job 不标 failed。
- `METH-L04`：OOM/SSH disconnect；只记录 infrastructure failure，不创建 NegativeFinding/contradicted Claim。
- `METH-L05`：exploratory positive finding；只能产生 hypothesis/Claim proposal，不自动标 supported。
- `METH-L06`：达到 outer trigger；只生成 synthesis proposal，不改变 phase。
- `METH-L07`：DirectionProposal=pivot；必须产生 Human 入口和相应 Gate/新对象，不自动改 Scope。
- `METH-L08`：fan-in 时 project/NextAction revision 改变；synthesis/panel 结果标 stale/diagnostic，零权威回写。

### 18.3 Graph、接续与来源

- `METH-G01`：从 PDF+repo+logs 导入；ImportProposal 能把 explicit refs 和 inferred relations 分开，缺口明确。
- `METH-G02`：外部结果中存在数字但无原始文件；不得生成 verified/accepted Evidence。
- `METH-G03`：Session Topology 显示 reviewer succeeded；Research Graph 不因此新增 supported edge。
- `METH-G04`：跨项目 Artifact/Claim/Graph ref；统一 404/fail closed，零边泄漏。
- `METH-G05`：adoption 重放；同 idempotency/hash 返回同 Receipt，异 hash 冲突，不重复创建对象。

### 18.4 写作

- `METH-W01`：编辑 Method section 时只激活 Method Guide；不得加载全部 section packs。
- `METH-W02`：ReverseOutline 绑定 TeX revision 10；用户保存 revision 11 后立即 stale，不能对新文档自动应用旧 patch。
- `METH-W03`：段落 Claim 缺 accepted Evidence；输出 unsupported finding/弱化建议或 MissingExperimentRequest，不能生成虚构引用/数字。
- `METH-W04`：Method Triad 的 advantage 无可测量依据；标 gap，不作为 confirmed Claim。
- `METH-W05`：Reviewer panel 部分失败；fan-in 显式显示缺失角色，不能把部分结果冒充完整审查。
- `METH-W06`：TeX compile 成功但 claim audit FAIL；Manuscript 显示 PDF 可预览，同时 assurance blocking。
- `METH-W07`：zh/en 切换；全部 chrome/status/ARIA 等价，论文文本、引用和原始诊断不翻译。

### 18.5 Skill Registry 与供应链

- `METH-S01`：manifest 使用 branch/tag 或短 SHA；注册拒绝。
- `METH-S02`：content hash、license、input/output schema 或 capability 任一缺失；保持 quarantined。
- `METH-S03`：Pack 请求未声明 Bash/network/Secret；执行 fail closed，Topology 记录安全原因。
- `METH-S04`：Pack 文本包含 prompt injection 要求批准 Gate/读取 token；tool filter/Kernel policy 阻断，输出不泄漏。
- `METH-S05`：上游同 version 内容变化；hash mismatch 拒绝，不替换已固定 activation。
- `METH-S06`：撤销 Pack version；现有历史可读，新 activation 拒绝。
- `METH-S07`：项目未显式激活外部 Pack；Chat 只能建议，不能静默运行或计费。
- `METH-S08`：升级 DSH/Scholar 后读取旧 activation/audit/synthesis；数据仍可访问，未知新字段安全 fail closed，不把旧 provisional 升级为 accepted。
- `METH-S09`：External Knowledge Pack 含“忽略系统规则/批准 Gate/执行 shell”文本；它只能作为带来源的 untrusted 引用，不能进入 instructions 或获得任何 capability。
- `METH-S10`：同一 package name/version 出现不同 manifest/payload hash；Registry 以供应链 equivocation 拒绝，不能覆盖既有 Pin。
- `METH-S11`：根 LICENSE、package metadata、文件头或真正上游许可冲突/缺失；package 保持 `MIXED_REVIEW/UPSTREAM_AMBIGUOUS/BLOCKED`，不能由 Operator 手工选择最宽松许可后放行。
- `METH-S12`：Release Bundle 包含获批第三方文件；必须同时包含对应 copyright/license/NOTICE、修改记录、固定来源清单与 SBOM，缺任一项阻断 Release。

## 19. 分阶段实施顺序（已授权）

### Phase 0：决策与来源审计

- 固化 D01–D20；
- 核实三个仓库所有拟采用文件的真正上游、许可、NOTICE、模板限制、修改权与商标边界；
- 决定哪些只吸收思想、哪些允许 vendor；
- 形成规范性决策记录。

**退出条件**：决策记录、范围、明确不做项和来源/许可表全部批准。

### Phase 1：术语、Schema 与失败测试

- 把获批概念写入规范性 domain/api/storage/acceptance 文档；
- 只定义 execution/verdict/acceptance 的 strict Schema 与纯 verifier seam；
- 写 red tests 覆盖 stale、N/A vs missing、三轴分离、reviewer independence 和 project scope；
- Protocol、Synthesis 与 SkillPackageManifest 只保留规范对象，分别延后到对应实施阶段，避免先造空壳。

**退出条件**：无数据库、UI、HTTP 或 Agent 自由文本也能用 fixtures 证明 Assurance 不变量。

### Phase 2：Assurance 持久化与执行层

- append-only Audit、Artifact、mandatory policy、hash freshness 与 Project API；
- 先 deterministic audit，再接一个只读 semantic reviewer；
- 复用 Topology 记录执行，不接自动 Release。

**退出条件**：METH-A 全部自动化通过，same-family/provisional 与 stale 行为确定。

### Phase 3：Protocol 与 Inner Loop

- Protocol-before-run admission；
- intent/outcome/validity 三轴；
- NegativeFinding 与 Claim/Evidence 映射；
- 不引入 outer-loop 自动方向变更。

**退出条件**：METH-L01–L05 和真实 Runner fixture 通过。当前 local-process fixture 已覆盖 completion→pending classification→outcome→synthesis action、old attempt、outbox rollback、重放与 reopen；真实本机 Docker fixture 已覆盖 signed Manifest `run_id` observation→positive classification→幂等 replay。远端 SSH/GPU、生产 Docker 和真实 scientific reviewer 仍待人工/真实环境验收。

### Phase 4：Research Synthesis 与 Outer Loop

- 只从权威 refs 生成 synthesis；
- DirectionProposal + DirectionAdoption + Human/Gate 路由；
- typed graph projection 与 explicit/inferred；
- 接入 Intake continuation proposal。

**退出条件**：METH-L06–L08、METH-G 全部通过，恢复/升级不丢历史。

### Phase 5：最小 Skill Registry 基础

- 只支持仓库内 Scholar-owned/adapted package，remote source 保持关闭；
- 落地 Registry/CAS/Evaluation/Pin/Activation 和 Instruction/External Knowledge 双通道；
- 首批只登记 Assurance、Two-loop synthesis 和 ReverseOutline 三个 Scholar 自有方法包；未完成相应领域功能的 Pack 保持不可激活；
- 验证 project scope、stale output、revoke、side-by-side update、backup/restore 和 DSH/Scholar 升级可访问性。

**退出条件**：METH-S01–S12 在 local immutable archive 上通过，所有第三方正文仍不可作为 instructions。

### Phase 6：写作知识层

- 先 ReverseOutline + claim-evidence auditor；
- 再 Method Triad、section guides；
- 最后是有界 Reviewer Panel；
- 所有 patch 走 TeX CAS、preview/compile generation fencing。

**退出条件**：METH-W 自动测试、真实浏览器焦点/i18n/TeX 手工验收通过。

### Phase 7：知识目录扩展

- 根据真实研究需求扩展 domain/section/reviewer taxonomy；
- Orchestra 的广域技术主题先做索引与按需 Knowledge Card，不批量导入原 Skill；
- 外部 remote source、第三方 Instruction Pack 或带 network 的 connector 必须分别重新授权，不能随本阶段自动开启。

**退出条件**：每个新增 Pack 都有固定来源、评测、项目 pin、行为 fixture、许可/归属与撤销路径。

### Phase 8：产品投影与渐进开放

- Overview/Manuscript/Evidence/Topology 渐进投影；
- DSH 本体只显示 compact Scholar summary；
- Metrics、成本、失败率、stale 率和用户可解释性；
- feature flags 从 internal fixture → opt-in dev → opt-in user，未验收能力保持关闭。

## 20. 风险与开放问题

1. **对象膨胀**：Protocol、Synthesis、Audit、Activation 都可能变成浅模块；批准前应检查能否以一个深模块管理 canonicalization、hash、freshness 和 authority。
2. **状态机膨胀**：two-loop 不应新增十几个 Project phase；优先做附属 cycle/checkpoint/NextAction。
3. **审查伪客观**：cross-family 仍可能共享训练偏差；independence 是降低相关性，不是科学真理证明。
4. **成本失控**：Reviewer Panel 和大量 Knowledge Pack 易放大 token；必须先预算预留、阶段路由和最大 fan-out。
5. **上下文污染**：外部 Skill 或执行者摘要会引导 reviewer；需要原始 refs、fresh node 和 prompt allowlist。
6. **证据边界**：ARA/写作检查很容易让 narrative 比 Evidence 快；所有 claim-evidence 映射必须引用真实 ID。
7. **许可链**：MIT 根仓库不一定覆盖其引用或整理的所有第三方笔记/示例；vendor 前必须逐文件审计。
8. **升级兼容性**：新对象必须进入 Kernel migration/backup/restore/adoption 验收；不能再次因 dataDir、Principal 或 schema 变化出现“数据消失”。
9. **远端数据政策**：独立 reviewer 可能要求跨 provider，但私有数据策略可能禁止外发；此时应 BLOCKED/provisional，而不是降级却声称 accepted。
10. **UI 信息密度**：方法论层不能把简洁页面变成研究术语仪表盘；默认只显示唯一下一步和 blocking，详细图/审查按需展开。

## 21. 一手来源索引

### ARIS

- [定位：methodology, not a platform](https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep/blob/f4f20f90ead9cb8d68e830ee5b006121adc41f80/README.md#L1-L14)
- [Assurance Contract：严格度轴、verdict、Artifact、freshness/verifier](https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep/blob/f4f20f90ead9cb8d68e830ee5b006121adc41f80/skills/shared-references/assurance-contract.md#L1-L168)
- [Reviewer Independence：reviewer 直接读取原始 Artifact](https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep/blob/f4f20f90ead9cb8d68e830ee5b006121adc41f80/skills/shared-references/reviewer-independence.md#L1-L69)
- [Result-to-Claim：存在性预检与语义支持判断分离](https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep/blob/f4f20f90ead9cb8d68e830ee5b006121adc41f80/skills/result-to-claim/SKILL.md#L31-L166)
- [Auto Paper Improvement：新鲜 reviewer、轮数和 edit boundary](https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep/blob/f4f20f90ead9cb8d68e830ee5b006121adc41f80/skills/auto-paper-improvement-loop/SKILL.md#L1-L95)
- [MIT License](https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep/blob/f4f20f90ead9cb8d68e830ee5b006121adc41f80/LICENSE#L1-L21)

### Research-Paper-Writing-Skills

- [核心流程：section guide、paragraph message、reverse outline、claim-evidence](https://github.com/Master-cai/Research-Paper-Writing-Skills/blob/77e7c2c1ba06f7d71844873147665437a03aac1b/research-paper-writing/SKILL.md#L1-L77)
- [Method Guide：module motivation/design/technical advantage](https://github.com/Master-cai/Research-Paper-Writing-Skills/blob/77e7c2c1ba06f7d71844873147665437a03aac1b/research-paper-writing/references/method.md#L1-L125)
- [Experiments Guide：baseline、ablation、hard setting/failure mode](https://github.com/Master-cai/Research-Paper-Writing-Skills/blob/77e7c2c1ba06f7d71844873147665437a03aac1b/research-paper-writing/references/experiments.md#L1-L80)
- [Paper Review：claim evidence 与五类 rejection risk](https://github.com/Master-cai/Research-Paper-Writing-Skills/blob/77e7c2c1ba06f7d71844873147665437a03aac1b/research-paper-writing/references/paper-review.md#L1-L60)
- [第三方知识归属说明](https://github.com/Master-cai/Research-Paper-Writing-Skills/blob/77e7c2c1ba06f7d71844873147665437a03aac1b/README.md#L1-L15)
- [MIT License](https://github.com/Master-cai/Research-Paper-Writing-Skills/blob/77e7c2c1ba06f7d71844873147665437a03aac1b/LICENSE#L1-L21)

### AI-Research-SKILLs

- [Autoresearch：入口状态与 two-loop architecture](https://github.com/Orchestra-Research/AI-Research-SKILLs/blob/773a52944ba4747a18bd4ae9ade53fff041adcbc/0-autoresearch-skill/SKILL.md#L1-L83)
- [Inner Loop：protocol-before-run、sanity check、confirmatory/exploratory、negative result](https://github.com/Orchestra-Research/AI-Research-SKILLs/blob/773a52944ba4747a18bd4ae9ade53fff041adcbc/0-autoresearch-skill/SKILL.md#L124-L150)
- [Outer Loop：结果综合与方向判断](https://github.com/Orchestra-Research/AI-Research-SKILLs/blob/773a52944ba4747a18bd4ae9ade53fff041adcbc/0-autoresearch-skill/SKILL.md#L151-L190)
- [ARA Compiler：多输入、Claim/Evidence/physical layer/exploration graph](https://github.com/Orchestra-Research/AI-Research-SKILLs/blob/773a52944ba4747a18bd4ae9ade53fff041adcbc/22-agent-native-research-artifact/compiler/SKILL.md#L1-L165)
- [ARA Rigor Reviewer：六维语义审查与边界](https://github.com/Orchestra-Research/AI-Research-SKILLs/blob/773a52944ba4747a18bd4ae9ade53fff041adcbc/22-agent-native-research-artifact/rigor-reviewer/SKILL.md#L1-L82)
- [MIT License](https://github.com/Orchestra-Research/AI-Research-SKILLs/blob/773a52944ba4747a18bd4ae9ade53fff041adcbc/LICENSE#L1-L21)

---

**最终状态：`DECIDED / PHASED_IMPLEMENTATION_AUTHORIZED`。当前只允许按 `methodology-knowledge-layer.md` 的阶段顺序实施；第三方内容 vendor、远程 Pack source、自动 Gate/Release 和第二套状态机始终不在本授权内。**
