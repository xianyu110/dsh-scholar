# 当前实现与目标规范差距

> 信息性文档，校准于 2026-08-09，审阅基线 `main@7adc722`。本文件描述当前仓库，不覆盖规范性文档。状态必须由源码、当前提交的自动化验收和 CI 证据共同决定；历史测试计数、旧 README、手工截图和未绑定提交的日志不能继承为当前证据。

## 1. 状态定义与证据规则

状态只允许使用下列值：

| 状态 | 含义 |
|---|---|
| 未实现 | 没有可运行实现，或只有文档/占位代码 |
| 部分 | 已有骨架或局部能力，但存在规范缺口、已知阻断缺陷或关键验收缺失 |
| 已实现未验收 | 代码表面完整，但当前提交尚无全部阻断验收证据 |
| 已验收 | 当前 commit 的全部对应 acceptance 场景在目标 CI 环境通过，且零 SKIP |
| 已关闭 | 经明确决策不再实施；必须记录责任人、日期、边界和重新开启条件 |

“已实现”不等于“已验收”。标记“已验收”时必须同时记录：commit SHA、CI run/job、acceptance 场景或机器可读报告。CI 中出现 SKIP、未执行断言、缺少 Docker/TeX/DSH fixture、缺失 git base ref 或 `continue-on-error`，均不得计入 PASS。状态矩阵与“具体不一致”、USAGE、README 或源码冲突时，自动取较低状态并阻断完成声明。

## 2. 当前可复用基础

| 范围 | 当前可复用实现 |
|---|---|
| Kernel/CAS | TypeScript、node:sqlite、WAL、项目/Gate/Job/Artifact/Evidence/Claim/Budget、SHA-256 CAS |
| HTTP | v1 主接口、局部 v2 adapter、Zod 校验、binary Artifact、Terminal SSE |
| Plugin | Cordis Agent tools/commands/subagents、角色 ACL、四组 Skills、sidecar；无浏览器嵌入面 |
| UI | standalone 原生 DOM Workspace；Chat/Overview/Approvals/Runs/Terminal/Artifacts/Evidence/Manuscript/Budget |
| Runner | Docker/subprocess adapter、快照物化、lease、heartbeat、cancel、Terminal chunk、可选 Ed25519 Manifest |
| Analysis | Metric/RunSet/AnalysisPlan 与 paired bootstrap 基础 |
| Connectors | OpenAlex/Crossref/arXiv、缓存、Unicode 去重、部分失败透明 |
| TeX | 文件树、文本编辑、版本保存、快照、latex-compile、诊断/PDF 基础 |
| Release | 私有 bundle 清单、脚本化 verify/clean-room 基础 |

这些基础不代表符合 v2 规范；以下矩阵是后续执行的约束来源。

## 3. 校准后的目标差距矩阵

| ID | 目标 | 当前状态 | 当前阻断与关闭条件 |
|---|---|---|---|
| GOV-01 | 认证 Human Principal durable | 部分 | Decision 可持久化部分 principal 字段，但浏览器/Kernel 仍可接受未认证或伪造身份；需真实 Principal resolver、tenant/auth_method/session、角色能力和 fail-closed 验收 |
| GOV-02 | Gate target freeze 与原子 Decision | 已实现未验收 | 五类 Gate（scope/idea/contract/budget/release）独立流程+映射；gate-state-cannot-transition（Gate 控制状态经 transitions 422）；concurrent-decision CAS 竞争 409 gate_already_decided 恰好一次；budget-gate-resume 仅接受 payload 声明的 resume_to；human-principal-durable 重读含 principal/tenant/auth_method/session。证据：tests/security/run-gate-tests.sh 13/13（含并发决策、principal 重读、budget resume）、tests/unit/governance.test.ts 扩展；尚未绑定 CI job 报告，待验收 |
| API-01 | v2 + BFF AuthZ | 部分 | 已有局部 v2、membership 和 binary/SSE 代理；缺完整 `/bff/research`、角色能力、CSRF、service identity，缺 Principal 时可绕过 membership |
| EVID-01 | accepted Evidence only from 受控 Worker/Verifier | 已实现未验收 | 状态机 draft_unverified→verified→accepted 已实现：public 路由只创建 draft/legacy（伪造 provenance=verified/accepted→422）；POST /v1/projects/{id}/evidence/verified 要求 x-service-principal: analysis-worker（否则 403）；POST /v1/projects/{id}/evidence/{eid}/accept 要求 x-service-principal: verifier|auditor（否则 403），重验 RunManifest（verifyRunManifest）、Contract（approved）、RunSet（succeeded+metrics_artifact）、Analysis Artifact（artifact_refs 属本项目），记录 acceptance{accepted_by,accepted_at,request_id} 并 emit evidence.accepted outbox；跨项目 accept→422 evidence_foreign；verifyClaim 只接受 provenance=accepted（draft/legacy/verified 一律 inconclusive）。证据：tests/security/run-evidence-tests.sh 12/12、run-lower-is-better-tests.sh 5/5、demo-full-flow 15/15（verified→accept→verify 全链）、单元测试新增 acceptEvidence 用例；尚未绑定 CI job 报告，待验收 |
| STAT-01 | 单一正式分析实现 | 部分 | paired analysis 基础存在；formal metrics identity（MetricsFileV1 强制见 RUN-01c）、lower-is-better（STAT-01a）、Analysis→accepted Evidence 链（EVID-01）已实现；确定性已由 golden vector 与字节一致性覆盖（见 STAT-01b）；仍缺 minimum_n 与固定 10,000 resamples 的完整验收、canonical output 全量核对 |
| STAT-01a | lower-is-better claim direction（acceptance-tests.md §6） | 已实现未验收 | research-schemas：ExperimentContract.metrics 新增 `direction`（'higher_is_better'\|'lower_is_better'，默认 higher，experiment.ts:30-31）；EvidenceItem.result 新增 `direction`（evidence.ts:26-29）；kernel computeAnalysis 从绑定 contract 解析方向传给 analysis worker（kernel.ts:2160-2171，worker 本就支持）；verifyClaim 按方向解释 effect 符号：lower 时负 effect+CI<0→supported、正 effect→contradicted（kernel.ts:1983-2006）。证据：tests/security/run-lower-is-better-tests.sh 3/3，不再 SKIP，已默认启用并接入聚合器（run-all-v2-blocking-tests.sh SCRIPTS）；尚未绑定 CI job 报告，待验收 |
| STAT-01b | 确定性 + golden vector + Analysis/图表/稿件数字一致（§6、§12） | 已实现未验收 | tests/fixtures/analysis-v1.json golden vector 已生成（固定输入+canonical 输出）；analysis-worker.test.ts 断言相同输入双次运行输出逐字节一致且与 golden vector 一致；新增 tests/unit/analysis-determinism.test.ts（≥5 组输入矩阵）；新增 tests/security/run-analysis-consistency-tests.sh 25/25：真实 docker 跑 baseline+formal 配对作业→analysis 两次调用 artifact 内容逐字节相同、analysis artifact 与 chart SVG 与 manuscript 的 mean/effect/CI 数字完全一致；已接入聚合器（CI=1 下 12/12 PASS）。尚未绑定 CI job 报告，待验收 |
| RUN-01 | 正式 Docker/快照/fencing/Manifest | 部分 | secure kind 拒 subprocess、approved Contract 绑定、严格 lease fencing、MetricsFileV1 已实现（见 RUN-01a/b/c）；仍缺 Run attempt 验收、默认必签 Manifest（当前为项目/kernel opt-in require_signed_manifest，非默认强制）、同项目 data refs 校验与物化 |
| RUN-01a | secure 作业 Contract 绑定（P0，acceptance-tests.md §4 前段） | 已实现未验收 | kernel submitJob 对 baseline/pilot/formal/reproduce 强制：contract_id 缺失→422 contract_required；getContract 失败→422 contract_unknown；跨项目→422 contract_foreign；status!=='approved' 或缺 approval.gate_decision_id→422 contract_not_approved（kernel.ts:1303-1323）。server.ts 新增内部批准路由 POST /v1/projects/{id}/contracts/{cid}/approve（actor 必填，server.ts:386-394），供 evals/orchestrator 用；交互路径走 Contract Gate 决策（GOV-02 原子冻结，approveContract 幂等，kernel.ts:992-1004）。证据：pnpm test 224/224（本会话运行，18 文件全过）；新增 tests/security/run-formal-binding-tests.sh 覆盖，后续轮次校准 |
| RUN-01b | 全字段 lease fencing（P0，acceptance-tests.md §4 末段） | 已实现未验收 | kernel heartbeatJob/completeJob 对 leased/running 作业：缺 generation/token→409 lease_stale；提供时精确匹配；无 owner-only 兼容放行（kernel.ts:1413-1432、1478-1485）。runner 侧所有 completeJob/heartbeat 调用点补齐 fencing 字段（workers/runner-gateway/src/index.ts:664-665、801、1028-1041；bin/runner.ts:133、157-158）。证据：tests/unit/kernel.test.ts §12.6 用例（519-595：stale token 409、缺字段 fail-closed）；tests/security/run-manifest-tests.sh 8/8（stale generation/token→409 lease_stale、当前 token→200，run-manifest-tests.sh:108-142）；专项 tests/security/run-fencing-tests.sh 12/12（heartbeat/terminal/complete 缺字段、旧/未来 generation、错 token 均 409 lease_stale；terminal frame 缺 lease_generation 已 fail-closed，内核不再默认放行） |
| RUN-01c | MetricsFileV1 强制（§4：formal/baseline/pilot/reproduce 成功必须存在 output_contract.metrics 指定路径的 MetricsFileV1） | 已实现未验收 | runner（workers/runner-gateway）对 secure 作业：缺 output_contract.metrics→code_error 失败；缺文件/非 MetricsFileV1（schema_version=1+非空 metrics）/run_id 不匹配/contract_id 不匹配/seed 缺失或非有限数/NaN/Infinity/重复 metric/非 Contract metric→不得 succeeded；secure 作业禁用 stdout fallback（index.ts:908-1011）。kernel submitJob 注入 payload.contract_metrics（contract primary+secondary，kernel.ts:1322、1330）；runner 注入容器环境 DSH_RUN_ID/DSH_CONTRACT_ID/DSH_SEED（index.ts:741-743）。证据（本会话运行）：golden-v2 29/29、clean-room 9/9、release-bundle eval 21/21 + release-bundle-tests 8/8、demo-full 15/15、demo-standalone 15/15，所有 secure 作业真实写 MetricsFileV1 文件；尚未绑定 CI job 报告，待验收 |
| RUN-02 | 固定容器安全基线（images.lock digest 强制） | 已实现未验收 | Docker flags 基本具备；configs/runner-profiles/images.lock.json 已提交（schema_version=1，node_fixture=node@sha256:c610fcdf…，texlive=texlive/texlive@sha256:8957c916…）。kernel submitJob 对 secure 作业强制：baseline/pilot/formal/reproduce 缺 digest→422 image_digest_required；tag（node:22-alpine）、latest、锁外 digest→422 image_digest_untrusted；latex-compile 缺 digest 由内核注入锁内 texlive 条目，显式提供时也必须与锁完全一致（packages/research-kernel/src/images-lock.ts validateImageDigest；DSH_IMAGES_LOCK 可覆盖 lock 路径）。单元测试新增 4 个 digest P0 用例，pnpm test 228/228。所有 eval/security 脚本已改用锁内 digest。尚未绑定 CI job 报告，待验收 |
| TERM-01 | 实时有序可恢复 Terminal | 已实现未验收 | reconnect-after-seq（按 seq 续传无重复无缺失）、retention-gap（淘汰 seq 返回 gap+dropped bytes）、overflow truncated+log Artifact 可下载、exit-replay（exit_code/signal/timed_out/cancelled 可读）、log-authz（跨项目 404）、cancel-timeout-distinct。证据：tests/security/run-terminal-tests.sh 11/11、tests/unit/terminal.test.ts；UI 侧 DOM 有界/ANSI 消毒/backpressure 属浏览器层，未纳入本行验收 |
| TEX-01 | TeX workspace/editor/version | 部分 | 文件树、编辑器、CAS 保存和冲突基础存在；新建文件 `expected_version:0` 被后端拒绝，dirty 判断可能丢失清空编辑，缺 typed assets/move/history/窄屏布局 |
| TEX-02 | latex-compile/诊断/PDF | 已实现未验收 | 锁内 texlive digest 强制（缺 digest 内核注入 texlive@sha256:8957c916…）；compile 冻结 manifest；诊断含 file/line 定位（tex-diagnostics.ts）；shell-escape/network 拒绝（docker flags）；build history 可重放。证据：evals/latex-compile-e2e.sh 13/13（含 write18 inert）、tests/unit/tex-kernel.test.ts；实时 Build Terminal/freshness 展示属 UI 层 |
| UI-01 | standalone-only 单一浏览器 UI | 已实现未验收 | 根嵌入面和旧 bridge 已删除；需当前提交的 clean package、真实 404、无 host/slot/dshClient 负向 CI 证据 |
| UI-02 | 全页面 zh/en i18n | 部分 | localeParityReport/assertLocaleParity 已实现（zh/en key 精确一致，开发模式 warning、build/CI 硬失败）；全部 locale 命名空间补齐大量硬编码 chrome 文案（+730 键）；模型选择器等新 chrome 已双语；静态硬编码扫描测试仍缺（未在 CI 内运行 research-ui 包测试） |
| UI-03 | standalone locale/theme adapter | 部分 | locale/theme 本地持久化基础存在；首屏可能闪英文、invalid-token 仍英文、Reset preferences 与 locale 语义未完整验收 |
| UI-04 | browser client strict typecheck/模块边界 | 部分 | UI 包声明 client typecheck，但根 CI 未调用；`client/index.ts` 超过 8,000 行，违反 7,000 行上限与目标页面边界 |
| ART-01 | binary/SSE 真流式 | 部分 | binary round-trip 基础通过；SSE 真实 body、replay、撤权、背压和跨项目 AuthZ 未由端到端测试覆盖 |
| ART-02 | media type/Range/hash | 已实现未验收 | media type、ETag/Range 基础存在；需 project-scoped v2/BFF、hash 重验和当前 CI 证据 |
| STORE-01 | 显式迁移与 schema parity | 部分 | 有 migration ledger 与后续迁移；当前 schema/version/table 与规范 v2 DDL、runs/outbox/dead-letter/Principal/AuthZ 仍不一致 |
| STORE-02 | durable CodeSnapshot | 部分 | archive/manifest/CAS 记录存在；v1 仍接受宿主绝对路径、泄露 root/source，缺文件数/单文件/总量上限与数据快照模型 |
| EVENT-01 | 事务 Outbox | 部分 | events 基础存在；缺 canonical event_seq/version/aggregate/request/attempt/dead-letter envelope 与完整消费者恢复 |
| DSH-01 | DSH Agent tools/commands/lifecycle | 部分 | canonical 工具名（claim_verify_request/analysis_request/release_bundle_request，旧名返回 deprecation metadata）、/research help/list/status/gates/jobs/claims 真实 handler、技能包从包根解析+确定性 domain/venue 选择、npm pack 含 skill assets、headless 可用已实现（src/plugin/skills.ts + commands.ts + tools.ts；tests/security/run-dsh-plugin-tests.sh 36/36）；仍缺无 Agent ID ACL 放行与 register disposer 的隔离 DSH fixture 验收 |
| SIDE-01 | sidecar identity/ownership | 部分 | 可启动和停止自有 sidecar；只凭 health/端口复用，缺 endpoint.json、port=0 实际端口、protocol/schema/database/dataDir/config 身份校验 |
| SKILL-01 | Skills 安装发现与确定性选择 | 已实现未验收 | provider 从发布包根解析四组 skill（research-core + 2 domain + venue），npm pack 断言 assets 在包内；domain/venue 按 Brief 确定性选择（skills.ts selectSkillPacks）；证据：run-dsh-plugin-tests.sh 36/36；clean install hash 一致性仍待 DSH fixture 验收 |
| PACK-01 | clean remote install | 部分 | 可打包基础存在；根构建依赖外部 `../test-lzszq` 和本地 DSH SDK，clean host/registry 安装未验收 |
| SELFMOD-01 | dev-only Cordis self tools | 部分 | production 静态否定和显式 overlay 基础存在；inspect/mount/unmount、冲突/HMR/shutdown、shared/headless/unattended guard 未在隔离 DSH fixture 验收 |
| SEC-UI-01 | standalone token/Origin/CSRF/AuthZ | 部分 | token/loopback/Origin 有自动化基础；无 CSRF token、日志 secret 扫描、真实 Principal fail-closed、survey membership 与撤权 SSE 验收 |
| REL-01 | 自包含 Release Bundle + bundle-only clean-room | 已实现未验收 | build-bundle.sh 在 manifest 增加 runtime 段（node 版本、kernel_bin/runner_bin sha256、images.lock 的 node_fixture/texlive digest）；reproduce.sh 把 bundle 复制到空目录执行、拒绝指向原 checkout 的 KERNEL_BIN/RUNNER_BIN（external checkout access prohibited）、node 版本不匹配→fail、作业重放强制使用锁内 digest；reproducibility-report.json 增加 bundle_manifest_sha256、runtime_verified、images_used、compared{manifest_hash,metrics,analysis,run_manifest,tex}，任一 false→status=fail。证据：tests/security/run-release-bundle-tests.sh 16/16（含 checkout 拒绝用例与 report 新字段断言）、run-release-eval.sh 21/21（reproduce 段 pass）；尚未绑定 CI job 报告，待验收 |
| CI-01 | 完整阻断 CI | 部分 | packages/workers、部分 security/Docker/Golden/TeX job 已配置；聚合器已 fail-closed（见 CI-01a）；仍缺 root plugin/full typecheck/UI i18n-a11y/DSH fixture/release 专项 job |
| CI-01a | 聚合器 CI=true 零 SKIP fail-closed | 已实现未验收 | tests/security/run-all-v2-blocking-tests.sh 对 SKIP/0 断言/未执行子脚本：CI=true 或无 --allow-skip 时判 FAIL、不计 PASS 且非零退出（run-all-v2-blocking-tests.sh:46-54）；SCRIPTS 含 7 个脚本。证据（本会话运行）：CI=1 下 7/7 PASS，含新启用的 lower-is-better（3/3）与 malformed-path（4/4），全程无 SKIP；尚未绑定目标 CI job 的机器可读报告，待验收 |
| DOC-01 | Markdown 是生成权威 | 部分 | 文档集与 docs-first 规则存在；hardening/USAGE 曾自相矛盾，需要本次校准后的持续语义检查 |
| DOC-02 | change-aware docs sync | 部分 | `--diff-check` 仅检查 packages/workers src 和 eval shell 是否触达本 ledger；遗漏根 src/configs/migrations/tests/规范/acceptance/USAGE，缺 base ref 时 fail-open |

## 4. 2026-08-09 审阅证据

审阅快照：`main@7adc722`，当时与 `origin/main` 一致且工作区干净。

| 检查 | 结果 | 解释 |
|---|---|---|
| `node scripts/verify-docs.mjs` | 通过，16 documents | 仅证明结构、链接、片段和删除面静态检查，不证明规范语义或实现验收 |
| `node scripts/verify-docs.mjs --diff-check definitely_missing_ref` | 错误地退出 0 | base ref 不存在时吞掉 git 错误，DOC-02 fail-open |
| `bash tests/security/run-standalone-http-tests.sh` | 43/43 | 证明局部 token/Origin/binary/404/membership；SSE 只验 status，未证明 frame/replay/撤权，未覆盖 CSRF token |
| `bash tests/security/run-all-v2-blocking-tests.sh` | 汇总 7 个 PASS | lower-is-better 实际 SKIP exit 0，被聚合器计为 PASS；不能作为零 SKIP 验收 |
| `bash tests/security/run-release-bundle-tests.sh` | 0 passed, 2 failed | analysis 阶段退出，未产生 `BUNDLE_DIR`；REL-01 当前阻断 |
| UI typecheck/full test | 本轮未完整重跑 | 当前审阅 shell 无 `pnpm`；不得继承旧 Playwright/计数为当前证据 |

上表是审阅基线（`main@7adc722`）时点的证据快照，只描述当时观察。基线后本会话的变更与新增证据以 §3 矩阵行（尤其 RUN-01a/b/c、STAT-01a、CI-01a、RUN-02）的“当前阻断与关闭条件”为准；与上表冲突处（如聚合器对 SKIP 的处理、lower-is-better 的启用状态）以后者为准。

## 5. 后续执行硬顺序

以下不是建议顺序，而是关闭状态的依赖顺序。前一批的阻断场景未通过时，不得把后一批宣称为完成或发布就绪：

1. **P0 Governance**：Principal、tenant、membership/role AuthZ、Human Gate、CSRF、service identity；
2. **P0 Formal execution**：approved Contract、immutable snapshot/data、fixed image digest、strict lease/Run/Manifest、MetricsFile；
3. **P0 Evidence/Release**：verified→accepted、Claim only accepted、Analysis provenance、bundle-only clean-room；
4. **P1 Product surfaces**：Terminal 完整日志/cancel、TeX Build Terminal/diagnostics/freshness、全页面 i18n；
5. **P1 DSH/package**：实例闭包/disposer、sidecar handshake、canonical tools/commands、Skill 选择、clean install、自修改隔离验收；
6. **P1 CI/docs**：零 SKIP、root/full/browser/DSH/release jobs、diff base fail-closed、文档语义一致；
7. **Final validation**：当前提交运行全部阻断命令、Golden Path、100 次 recovery、bundle-only clean-room，并绑定机器可读证据。

任一 P0 为“未实现/部分/已实现未验收”，产品只能保持 Security Alpha，不得用于无人值守正式研究或公开发布。

## 6. 文档与状态更新规则

每个实现或修复变更必须在同一变更集内：

1. 更新负责行为的规范；
2. 更新 `acceptance-tests.md` 的自动化场景；
3. 更新本矩阵的“当前阻断与关闭条件”，不能只改状态词；
4. 若用户操作变化，更新 `USAGE_GUIDE.md`；
5. 记录当前 commit/CI/报告证据，或明确写“未验收”；
6. CI 阻断 job 零 SKIP；本地允许的显式 skip 不计入 PASS；
7. README、USAGE、acceptance、repository blueprint 与本文件有矛盾时，合并与完成声明均阻断。

只有对应 acceptance 场景在当前提交和目标 CI 环境全部通过，状态才能从“部分”进入“已实现未验收”，再进入“已验收”。修复代码但未补规范、验收或状态，视为未完成。
