# DSH Scholar 重建规范

> 规范版本：2.5
> 更新日期：2026-08-12
> 目标成熟度：Security Alpha，默认 gate-only
> 用途：仅依赖本目录 Markdown，即可重新实现、测试和部署 DSH Scholar。

UI 品牌硬规则：正式产品名为 `DSH Scholar`，组合字标为 `dsh Scholar`；不得显示旧组合品牌 `dsh Research`。技术名 `Research Kernel` 和 research API 不随品牌重命名。

## 1. 文档契约

本目录描述的是目标系统，不是对当前源码的逐行注释。生成或重构项目时，按以下优先级处理冲突：

1. 本文件中的全局规则；
2. product-spec.md、design-notes.md 和 domain-model.md 中的产品、架构与不变量；
3. research-onboarding.md、init-grill-upload-models.md、reproduction-contracts.md、trajectory-subagents.md、subagent-stage-execution.md、api-contracts.md、execution-runtime.md、gui-plugin-plan.md、dsh-integration.md、storage-migrations.md 和 security-baseline.md 中的模块接口；
4. repository-blueprint.md 与 acceptance-tests.md 中的工程结构和验收规则；
5. test-instance-plan.md 与 USAGE_GUIDE.md 中的运行说明；
6. hardening-v0.2-status.md 中的当前实现差距，仅用于迁移，不能覆盖目标规范；
7. 仓库现有代码、根 README 和历史设计稿，仅作为实现证据。

规范中的“必须”是验收条件，“应”是默认选择，“可以”是可选能力。没有写明的行为不得靠猜测扩张权限，尤其是 Gate、命令执行、Evidence、发布和文件访问。

## 2. 目标系统一句话定义

DSH Scholar 是运行在 DeepSeek Harness 上的可恢复科研工作台：DSH 负责交互和 Agent 编排，Research Kernel 负责权威科研状态，隔离 Runner 负责真实计算，Analysis Worker 负责可信统计，Manuscript Workbench 负责版本化 TeX 写作与编译，所有结论通过 Claim–Evidence 账本追溯。

系统允许模型提出计划、检索论文、生成 Patch、提交实验和撰写草稿；模型不能批准 Human Gate、在宿主执行正式实验、伪造正式 Evidence、覆盖审计历史或自动公开发布。

## 3. 阅读与生成顺序

| 顺序 | 文档 | 生成时回答的问题 |
|---:|---|---|
| 1 | product-spec.md | 为谁构建、做什么、不做什么、完成标准是什么 |
| 2 | design-notes.md | 模块如何划分，权威状态和信任 seam 在哪里 |
| 3 | domain-model.md | 对象、状态机、ID、约束和事件是什么 |
| 4 | research-onboarding.md | 如何从 Init、Upload 和 Grill Me 安全接入任意研究阶段 |
| 5 | init-grill-upload-models.md | name-only Init、Chat 单题 Grill、批量分块上传和 Provider/OCR 如何实现 |
| 6 | reproduction-contracts.md | 论文复现、实验环境、Chat 附件与 session Terminal 如何形成可追溯闭环 |
| 7 | trajectory-subagents.md | 如何移植 Trajectory、展示 subagent 拓扑并进入子会话 |
| 8 | subagent-stage-execution.md | 哪些研究阶段可并行，以及如何安全地 fan-out/fan-in |
| 9 | storage-migrations.md | 如何持久化、迁移和恢复 |
| 10 | api-contracts.md | HTTP、流式事件和错误接口是什么 |
| 11 | dsh-integration.md | 如何作为 DSH Agent 插件、工具、命令与 Skill 运行，以及如何连接独立 UI |
| 12 | execution-runtime.md | Job、Runner、分析、编排和复现如何工作 |
| 13 | gui-plugin-plan.md | Web UI、实时终端、TeX 编辑与 PDF 预览如何工作 |
| 14 | security-baseline.md | 权限、隔离、Secret、Web 与供应链的硬要求 |
| 15 | repository-blueprint.md | 文件树、包、依赖、构建顺序和实现责任 |
| 16 | acceptance-tests.md | 如何证明生成结果符合规范 |
| 17 | manual-acceptance.md | 代码实现完成后如何交给人工在真实环境验收 |
| 18 | test-instance-plan.md | 如何启动开发、测试和独立实例 |
| 19 | USAGE_GUIDE.md | 用户如何完成端到端研究 |
| 20 | hardening-v0.2-status.md | 当前仓库与目标规范还有哪些差距 |

## 4. 生成约束

从本规范生成项目时必须满足：

- 根 `README.md` 只介绍产品定位、使用边界、启动与使用方式，并显著说明产品仍在开发中；不得把实现账本、测试计数、提交记录或长篇能力状态复制进 README，这些内容只进入 hardening、acceptance 和使用指南；

- 使用 TypeScript、Node.js、pnpm workspace、ESM 和严格类型检查；
- 权威输入模型使用 Zod；HTTP 适配和 Kernel 写入各校验一次；
- Research Kernel 是唯一业务写入权威，浏览器、插件、Runner 和 Worker 都不能直接写数据库；
- SQLite 为桌面默认实现，Artifact 内容使用 SHA-256 CAS；
- 所有正式计算从不可变代码/数据快照物化，不能挂载 Agent 当前工作目录；
- baseline、pilot、formal、reproduce、latex-compile 必须在受限容器中执行；
- 完整科研浏览器 UI 只支持独立模式，由独立 HTTP host 和同源 BFF 提供；根插件可以发布只服务 Settings → Plugin config 的窄配置半侧，但不得发布 legacy `dshClient`、科研业务 Web slot、`/research-api` 或 `/research-ui-api` 嵌入面；
- DSH Adapter 保留 Agent tools、commands、subagents、Skills、Session、headless 与插件配置卡能力，不托管科研业务 UI；
- Run Terminal 必须显示可恢复的只读执行账本；Interactive Terminal 必须提供真实 PTY 输入、resize、signal、重连与审计，二者不得混为同一权威语义；
- Interactive Terminal 的浏览器面必须使用真实 xterm-compatible emulator，把键盘/粘贴/IME 输入接到 PTY bytes control，并增量解释 ANSI/VT/TUI 输出；普通文本日志区、未接线的输入 API 或按钮式控制面不得称为 Web Terminal；
- Interactive Terminal 必须绑定权威 Research/Chat/Subagent session，并允许每个 context 有多个 PTY 标签；禁止用 project 级单例把输入发送到错误 session；
- Workspace 必须提供 VS Code 式文件树、标签页、搜索、编辑、版本冲突与二进制预览；Manuscript 必须提供保存后增量 LaTeX 预览、权威编译日志、诊断和 PDF freshness；
- Chat、Overview、Approvals、Runs、Artifacts、Evidence、Budget、Manuscript、Run Terminal、Trajectory、Topology、Workspace、Interactive Terminal 等全部当前业务页面必须可在主区、右侧 Panel Dock 与底部 Panel Dock 间移动；同页只有一个活实例，右/底互换不 remount，主区/Dock 变换的流按游标安全续接；左侧 Project Sidebar 与 Panel Dock 不得混为同一概念；
- Runner 必须通过同一 Execution interface 支持显式本机进程、本机 Docker 与受控远端 SSH Runner；本机进程只用于 trusted dev/smoke，远端机器不能成为业务权威或绕过 Snapshot、lease、Manifest 和 Artifact 契约；
- 实验/复现只选择 opaque runner profile/target ID；远端 SSH/mTLS endpoint 与 credential 只在服务端 Settings/SecretRef，离线或能力不匹配不得静默回退本机；
- 所有可配置行为必须登记到版本化 Config Schema，声明 scope、默认值、约束、来源、secret 属性、热更新/重启规则，并由同一 Schema 生成文件配置、HTTP 校验和 Settings UI；
- 首次进入必须提供 Init、Resume、Upload 三入口；既有研究先进入隔离 Intake，经 Grill Me 和 Human adoption 后才能写入项目，导入历史不得伪造 Gate、Run、TerminalLog 或 accepted Evidence；
- Chat 必须支持自由自然语言、按权威 NextAction 的阶段引导、canonical intent 路由、附件按钮、拖拽和粘贴；开放讨论使用当前 DSH 模型但模型文本不得直接写 Kernel，bridge 不可用时保留确定性引导。`/ideas` 只读，显式“生成 idea”与 `/ideas generate <1-5>` 仅在 ready Agent action + frozen corpus 下以严格草稿、revision CAS 和单事务写入；已有候选后必须显示 Human `idea_select`，通过卡片按钮或 `/ideas select <idea_id>` 执行真实 counter-search，并原子进入 payload-bound pending Idea Gate。slash command 直接使用 `/new`、`/reproduce` 等一级命令，DSH 与 standalone 都不注册旧聚合前缀。Natural turn 不得绕过 Grill、Gate、adoption、release 或凭模型文本猜 mutation；
- Chat 是项目内上下文：session、active id、transcript、草稿、引用、附件、搜索与异步回写必须按 `project_id` 分区；固定全局 storage、跨项目 session 复用或把 A 的延迟结果写入 B 一律视为隔离缺陷；
- Chat 滚动也属于 project/session/surface 上下文：底部跟随新消息，查看历史时刷新/新消息保持锚点并提供 Jump latest，不得反复回顶或抢到底部；
- 论文复现必须持久化 Spec/Attempt/Report，固定 paper/code/data/environment/Contract/RunManifest，并区分 execution 成功与科学比较 pass；
- 使用过程中必须由 Kernel 权威投影提供结构化 NextAction，页面给出一项主要下一步与原因/阻断/目标路由，未知动作只读展示，不能由 LLM 或浏览器猜测推进；
- Trajectory 必须区分 Kernel Research Outbox 与展示性的 DSH Session；subagent 以父子拓扑展示并可进入授权 child 查看，one-shot 只读，continuable follow-up 必须 exact-parent 授权且默认脱敏；
- 阶段 subagent 必须按 subagent-stage-execution.md 的确定性矩阵与准入执行：Survey/Idea/Writing/Review 优先 fan-out，child 只产出草稿/观察/审阅，所有路径 dispose 并回写 observational topology；Human Gate、Runner 正式计算、accepted Evidence、canonical manuscript 和 Release 不得委派；
- 主页面只保留 Start、Overview、Workspace、Runs 和 Manuscript 等高频任务；Approvals、Artifacts、Evidence、Budget、Trajectory/Topology 保持深链可达，所有可调项统一进入默认折叠的 Settings；
- 所有列表、流式日志和 Artifact 读取都执行 Project AuthZ；
- 项目删除只接受已归档项目，由 PI 经精确名称确认创建可审计 tombstone；普通读取立即隐藏，但共享 CAS、Outbox、Decision 和 retention 证据不得被同步物理删除；
- Human Gate 使用认证 Principal，Agent 接口中不存在 Gate Decision；
- DSH 发布兼容性必须用私有 registry 安装的固定真实 `@deepseek-ai/*` 与全新 DSH_HOME 验证；checkout、symlink、fake host 或 file override 不能计 PASS；
- 所有验收测试必须从公开接口验证行为，不能越过模块接口检查内部实现。

## 4.1 需求与修复的文档先行规则

任何新增需求、缺陷、修复建议、架构取舍或验收变化都必须内化到本目录，不能只存在于对话、Issue、提交信息或源码中。一次变更只有同时完成下列事项才算完成：

1. 更新负责该行为的规范文档；
2. 若接口或数据变化，同步 domain-model.md、api-contracts.md 和 storage-migrations.md；
3. 若页面变化，同步 gui-plugin-plan.md、i18n 资源要求与 USAGE_GUIDE.md；
4. 增加或修改 acceptance-tests.md 中的验收场景；
5. 在 hardening-v0.2-status.md 记录当前实现与目标的状态；
6. 实现、测试、文档在同一个变更集内保持一致。

当前 `scripts/verify-docs.mjs` 自动检查文档结构、链接、关键契约片段和旧嵌入面否定断言；`--diff-check` 检查 packages/workers 源码与 eval shell 变更是否触达 hardening ledger，且对缺失/歧义 base ref 已 fail-closed（`base_ref_unavailable` 非零退出，绝不把 changed files 当空集）。它不能证明负责规范、acceptance、USAGE 和状态语义已经同步；主代理/评审仍按上述六项逐项确认；verifier 通过绝不等同于 docs-first 或功能验收完成。

代码与 Markdown 冲突时，不得静默选择代码现状；必须先确认目标并修正文档或实现。只改代码不更新规范、只记录修复建议不落入规范，均视为未完成。

开发默认积极使用 subagent 提升并行度和减少主线程上下文污染。跨目录检索、独立核验、测试日志分析和文件边界互不重叠的实现应并发派发；任务必须自包含并声明范围与输出证据。基础架构文档、即将修改的确切代码、方案取舍、合并复核和最终验收由主代理亲自完成。多个 subagent 修改代码时必须声明文件所有权，禁止回滚或覆盖其他任务的改动。

## 4.2 Review 基线与执行约束

`hardening-v0.2-status.md` 是当前实现账本，状态只允许：未实现、部分、已实现未验收、已验收、已关闭。“已验收”必须绑定当前 commit SHA、`acceptance-tests.md` 场景以及 CI 机器报告或 `manual-acceptance.md` 规定的人工验收记录；历史计数、旧日期日志、无场景/环境/结论的零散截图和本地显式 skip 只能作背景。

后续工作按 hardening 的风险顺序推进：Governance → Formal execution → Evidence/Release → Terminal/TeX/i18n → DSH/package → verification/docs → Final validation。P0 的**代码缺口**优先修复；P0 已完成代码但因真实环境缺失而处于“已实现未验收”时，不阻塞后续代码实现、提交或合并，但继续阻止成熟度升级、发布和真实研究使用。README、USAGE、hardening、acceptance、repository blueprint 或源码对当前能力有矛盾时，自动采用较低状态。

真实 Docker、远端主机、mTLS、浏览器、DSH host、GPU、TeX 完整镜像或 clean-room 环境在开发期间不可用时，允许暂不建立/运行真实环境 CI；它们必须登记为“待人工验收”，不能伪造 PASS。已经运行的 CI 阻断 job 仍必须零 SKIP、实际断言数大于 0，不能以 `SKIP exit 0` 或聚合器 PASS 代替验收。

## 4.3 代码优先、人工后验的两阶段开发规则

开发默认分成两个互不混淆的阶段：

1. **代码实现阶段**：先完成真实生产路径，不以 fake UI、只写接口、`NotImplemented` 或测试专用捷径代替实现；同步类型、Schema、迁移、错误码、i18n、文档、单元/模块契约测试和人工验收步骤。当前机器能运行的 build/typecheck/unit/static checks 必须运行；不可用的真实环境检查登记到 `manual-acceptance.md`。满足这些条件后可标记“已实现未验收”，并继续后续开发、提交和合并；
2. **人工验收阶段**：由人工在真实浏览器、DSH、Docker/TeX、远端机器/mTLS 或其他目标环境按场景执行。记录必须包含 commit、日期、环境、操作者、步骤、期望/实际结果和日志/截图/Artifact 引用；全部阻断场景通过后才可标“已验收”。

人工验收发现的问题仍属于正式需求/修复建议：必须先写回负责规范、`acceptance-tests.md` 和 hardening，再修改代码。CI 可以在环境具备后补建，用于重复验证，但不是代码实现阶段的前置条件。

## 5. 核心不可绕过规则

1. Gate 真实：系统有 scope/idea/contract/budget/release 五种 Gate；SCOPED、IDEA_APPROVED、CONTRACT_APPROVED、RELEASED 四个 Gate 控制状态只能由 Human Gate 事务进入，Budget Gate 负责从 BLOCKED_GATE 恢复。
2. Contract 真实：正式 Job 必须绑定已批准且冻结的 ExperimentContract 版本。
3. Run 真实：除 echo 外，成功必须来自真实执行；正式指标只读固定输出文件。
4. Evidence 真实：accepted Evidence 只能由受控 Analysis Worker 根据签名 RunManifest 生成。
5. 文件真实：代码、数据、TeX 和编译输入都是不可变 CAS 快照，保存有版本冲突保护。
6. 终端真实：Run Terminal 展示 Runner 原始 stdout/stderr 的有序、可恢复、可截断流；Interactive Terminal 使用真实 PTY 双向会话，不能用本地动画或一次性 HTTP 响应伪装。
7. 工作区真实：编辑对象来自版本化 Workspace；保存、搜索、快照、LaTeX preview 与正式 build 共享同一文件/Revision/CAS 契约。
8. 执行目标真实：本机 Docker 与远端 Runner 都执行同一冻结 ExecutionPlan；切换 target 不改变科研语义或放宽安全策略。
9. 配置真实：effective config 可解释、可校验、可审计；secret 只以引用出现，运行中的 Job/PTY/Build 固定创建时的 config hash。
10. 发布真实：Release Bundle 必须自包含并通过 clean-room 验证，公开发布仍需 Human Release Gate。
11. 接入真实：上传、parser observation、Grill answer 与阶段 proposal 都是不可信输入；只有 Human adoption 事务能映射到项目，且仍不能制造历史 Gate/Run/Evidence。
12. 轨迹真实：Kernel Outbox 是业务权威，Session/Agent trajectory 是观察面；subagent 拓扑、消息与 usage 不得反向修改科研状态或泄漏 raw secret/tool payload。

## 6. 文档自包含范围

桌面 DSH_Scholar_v2.0.md、原 docs、当前 dsh-scholar 源码和本机 DSH 主仓库均已用于本次重构。新实现不应依赖这些外部材料。若实现发现规范缺少必要决策，应先补文档和验收场景，再写代码。

## 7. 重建完成定义

只有在以下命令从 clean checkout 全部通过、独立 UI 可完成 Golden Path、bundle-only clean-room 通过、全部阻断 job 零 SKIP，且 hardening-v0.2-status.md 中没有“未实现/部分/已实现未验收”的 P0/P1 条目时，才算从文档成功重建：

~~~bash
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test
pnpm test:security
pnpm test:all
~~~

最终重建完成记录必须附当前 commit，以及覆盖全部阻断场景的 CI 报告或结构化人工验收记录；凡已运行 CI 必须 skip_count=0，并保留 Golden/recovery/clean-room 报告。缺少任一最终证据时只能标“已实现未验收”。

对外仍应标记 Security Alpha，直到真实外部项目、多人身份、长期运行和 clean-room 复现得到持续验证。
