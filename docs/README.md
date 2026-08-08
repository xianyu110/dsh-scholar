# DSH Scholar 重建规范

> 规范版本：2.2
> 更新日期：2026-08-09
> 目标成熟度：Security Alpha，默认 gate-only
> 用途：仅依赖本目录 Markdown，即可重新实现、测试和部署 DSH Scholar。

## 1. 文档契约

本目录描述的是目标系统，不是对当前源码的逐行注释。生成或重构项目时，按以下优先级处理冲突：

1. 本文件中的全局规则；
2. product-spec.md、design-notes.md 和 domain-model.md 中的产品、架构与不变量；
3. api-contracts.md、execution-runtime.md、gui-plugin-plan.md、dsh-integration.md、storage-migrations.md 和 security-baseline.md 中的模块接口；
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
| 4 | reconstruction-contracts.md | 固定 ABI、wire 类型、算法、limits 和可生成参数 |
| 5 | storage-migrations.md | 如何持久化、迁移和恢复 |
| 6 | api-contracts.md | HTTP、流式事件和错误接口是什么 |
| 7 | dsh-integration.md | 如何作为 DSH Agent 插件、工具、命令与 Skill 运行，以及如何连接独立 UI |
| 8 | execution-runtime.md | Job、Runner、分析、编排和复现如何工作 |
| 9 | gui-plugin-plan.md | Web UI、实时终端、TeX 编辑与 PDF 预览如何工作 |
| 10 | security-baseline.md | 权限、隔离、Secret、Web 与供应链的硬要求 |
| 11 | repository-blueprint.md | 文件树、包、依赖、构建顺序和实现责任 |
| 12 | acceptance-tests.md | 如何证明生成结果符合规范 |
| 13 | test-instance-plan.md | 如何启动开发、测试和独立实例 |
| 14 | USAGE_GUIDE.md | 用户如何完成端到端研究 |
| 15 | hardening-v0.2-status.md | 当前仓库与目标规范还有哪些差距 |

## 4. 生成约束

从本规范生成项目时必须满足：

- 使用 TypeScript、Node.js、pnpm workspace、ESM 和严格类型检查；
- 权威输入模型使用 Zod；HTTP 适配和 Kernel 写入各校验一次；
- Research Kernel 是唯一业务写入权威，浏览器、插件、Runner 和 Worker 都不能直接写数据库；
- SQLite 为桌面默认实现，Artifact 内容使用 SHA-256 CAS；
- 所有正式计算从不可变代码/数据快照物化，不能挂载 Agent 当前工作目录；
- baseline、pilot、formal、reproduce、latex-compile 必须在受限容器中执行；
- 浏览器 UI 只支持独立模式，由独立 HTTP host 和同源 BFF 提供；不得发布 `dshClient`、DSH Web slot、`/research-api` 或 `/research-ui-api` 嵌入面；
- DSH Adapter 只保留 Agent tools、commands、subagents、Skills、Session 和 headless 能力，不托管浏览器 UI；
- Runs 必须显示实时终端；Manuscript 必须提供 TeX 文件树、编辑、编译日志、诊断和 PDF 预览；
- 所有列表、流式日志和 Artifact 读取都执行 Project AuthZ；
- Human Gate 使用认证 Principal，Agent 接口中不存在 Gate Decision；
- 所有验收测试必须从公开接口验证行为，不能越过模块接口检查内部实现。

## 4.1 需求与修复的文档先行规则

任何新增需求、缺陷、修复建议、架构取舍或验收变化都必须内化到本目录，不能只存在于对话、Issue、提交信息或源码中。一次变更只有同时完成下列事项才算完成：

1. 更新负责该行为的规范文档；
2. 若接口或数据变化，同步 domain-model.md、api-contracts.md 和 storage-migrations.md；
3. 若页面变化，同步 gui-plugin-plan.md、i18n 资源要求与 USAGE_GUIDE.md；
4. 增加或修改 acceptance-tests.md 中的验收场景；
5. 在 hardening-v0.2-status.md 记录当前实现与目标的状态；
6. 实现、测试、文档在同一个变更集内保持一致。

当前 `scripts/verify-docs.mjs` 自动检查文档结构、链接、关键契约片段和旧嵌入面否定断言；它尚未根据 git diff 自动判断每个源码行为变更是否同步了规范、验收与 hardening。该 change-aware gate 记在 hardening 的 DOC-02，在实现前由主代理/评审按上述六项逐项确认，不能把 verifier 通过等同于 docs-first 完成。

代码与 Markdown 冲突时，不得静默选择代码现状；必须先确认目标并修正文档或实现。只改代码不更新规范、只记录修复建议不落入规范，均视为未完成。

开发默认积极使用 subagent 提升并行度和减少主线程上下文污染。跨目录检索、独立核验、测试日志分析和文件边界互不重叠的实现应并发派发；任务必须自包含并声明范围与输出证据。基础架构文档、即将修改的确切代码、方案取舍、合并复核和最终验收由主代理亲自完成。多个 subagent 修改代码时必须声明文件所有权，禁止回滚或覆盖其他任务的改动。

## 5. 核心不可绕过规则

1. Gate 真实：系统有 scope/idea/contract/budget/release 五种 Gate；SCOPED、IDEA_APPROVED、CONTRACT_APPROVED、RELEASED 四个 Gate 控制状态只能由 Human Gate 事务进入，Budget Gate 负责从 BLOCKED_GATE 恢复。
2. Contract 真实：正式 Job 必须绑定已批准且冻结的 ExperimentContract 版本。
3. Run 真实：除 echo 外，成功必须来自真实执行；正式指标只读固定输出文件。
4. Evidence 真实：accepted Evidence 只能由受控 Analysis Worker 根据签名 RunManifest 生成。
5. 文件真实：代码、数据、TeX 和编译输入都是不可变 CAS 快照，保存有版本冲突保护。
6. 终端真实：UI 展示 Runner 原始 stdout/stderr 的有序、可恢复、可截断流，不能伪造本地流式动画代替执行输出。
7. 发布真实：Release Bundle 必须自包含并通过 clean-room 验证，公开发布仍需 Human Release Gate。

## 6. 文档自包含范围

桌面 DSH_Scholar_v2.0.md、原 docs、当前 dsh-scholar 源码和本机 DSH 主仓库均已用于本次重构。新实现不应依赖这些外部材料。若实现发现规范缺少必要决策，应先补文档和验收场景，再写代码。

## 7. 重建完成定义

只有在以下命令全部通过、独立 UI 可完成 Golden Path、且 hardening-v0.2-status.md 中没有 P0 差距时，才算从文档成功重建：

~~~bash
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test
pnpm test:security
pnpm test:all
~~~

对外仍应标记 Security Alpha，直到真实外部项目、多人身份、长期运行和 clean-room 复现得到持续验证。
