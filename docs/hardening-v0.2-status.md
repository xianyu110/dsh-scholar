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
| GOV-01 | 认证 Human Principal durable | 已实现未验收 | HTTP gate decision 路由 fail-closed(principal 必填,裸 actor→422);**本地 Principal resolver 已实现**:standalone BFF 从 bearer 凭据派生 DURABLE 会话身份(session.json,0600,确定性 sha256,重启稳定),所有转发请求带 x-principal-session,kernel decision 路由绑定该 session_id→决策重读完整保留 principal/tenant/auth_method/session;gate 决策经 BFF 正确解析 gate 所属项目做成员/角色检查(修复 gate id 被误当 project id 的 404 bug)。证据:tests/security/run-standalone-http-tests.sh 152/152(GOV-01 组:决策 200、session_id 持久化、session.json 0600、转发与文件一致)、run-gate-tests.sh 15/15;外部 IdP 可替换本 resolver,接入后即达已验收 |
| GOV-02 | Gate target freeze 与原子 Decision | 已实现未验收 | 五类 Gate（scope/idea/contract/budget/release）独立流程+映射；gate-state-cannot-transition（Gate 控制状态经 transitions 422）；concurrent-decision CAS 竞争 409 gate_already_decided 恰好一次；budget-gate-resume 仅接受 payload 声明的 resume_to；human-principal-durable 重读含 principal/tenant/auth_method/session。证据：tests/security/run-gate-tests.sh 13/13（含并发决策、principal 重读、budget resume）、tests/unit/governance.test.ts 扩展；尚未绑定 CI job 报告，待验收 |
| API-01 | v2 + BFF AuthZ | 已实现未验收 | v2(handleV2):x-principal-id membership 404 + x-principal-role 角色能力(viewer/auditor 只读,researcher 禁治理写 transitions/gates/decisions/budget/approve/accept,非法 role→403 role_required);BFF 从自身 membership 解析角色并注入头(客户端值永不信任),BFF 层同策略纵深(403 role forbidden 稳定文案);CSRF 会话 token(/api 写强制,Origin 第二层)。证据:tests/security/run-standalone-http-tests.sh 147/147(角色矩阵、非成员 404、BFF 注入断言)、tests/unit/kernel.test.ts v2 角色用例;完整 /bff/research 面仍待验收 |
| EVID-01 | accepted Evidence only from 受控 Worker/Verifier | 已实现未验收 | 状态机 draft_unverified→verified→accepted 已实现：public 路由只创建 draft/legacy（伪造 provenance=verified/accepted→422）；POST /v1/projects/{id}/evidence/verified 要求 x-service-principal: analysis-worker（否则 403）；POST /v1/projects/{id}/evidence/{eid}/accept 要求 x-service-principal: verifier|auditor（否则 403），重验 RunManifest（verifyRunManifest）、Contract（approved）、RunSet（succeeded+metrics_artifact）、Analysis Artifact（artifact_refs 属本项目），记录 acceptance{accepted_by,accepted_at,request_id} 并 emit evidence.accepted outbox；跨项目 accept→422 evidence_foreign；verifyClaim 只接受 provenance=accepted（draft/legacy/verified 一律 inconclusive）。证据：tests/security/run-evidence-tests.sh 12/12、run-lower-is-better-tests.sh 5/5、demo-full-flow 15/15（verified→accept→verify 全链）、单元测试新增 acceptEvidence 用例；尚未绑定 CI job 报告，待验收 |
| STAT-01 | 单一正式分析实现 | 已实现未验收 | resamples 固定 10,000(ANALYSIS_RESAMPLES,内核不再传 1000,artifact n_resamples=10000);minimum_n 由绑定 contract stop_conditions.min_completed_seeds 驱动,调用者降低→422 minimum_n_too_low(§12);canonical output key 顺序核对(worker 测试);golden vector 与字节一致性(STAT-01b)、MetricsFileV1、lower-is-better、Analysis→accepted Evidence 链均已实现。证据:pnpm test 316/316(含 STAT-01 新用例)、run-analysis-consistency-tests.sh 25/25;尚未绑定 CI job 报告,待验收 |
| STAT-01a | lower-is-better claim direction（acceptance-tests.md §6） | 已实现未验收 | research-schemas：ExperimentContract.metrics 新增 `direction`（'higher_is_better'\|'lower_is_better'，默认 higher，experiment.ts:30-31）；EvidenceItem.result 新增 `direction`（evidence.ts:26-29）；kernel computeAnalysis 从绑定 contract 解析方向传给 analysis worker（kernel.ts:2160-2171，worker 本就支持）；verifyClaim 按方向解释 effect 符号：lower 时负 effect+CI<0→supported、正 effect→contradicted（kernel.ts:1983-2006）。证据：tests/security/run-lower-is-better-tests.sh 3/3，不再 SKIP，已默认启用并接入聚合器（run-all-v2-blocking-tests.sh SCRIPTS）；尚未绑定 CI job 报告，待验收 |
| STAT-01b | 确定性 + golden vector + Analysis/图表/稿件数字一致（§6、§12） | 已实现未验收 | tests/fixtures/analysis-v1.json golden vector 已生成（固定输入+canonical 输出）；analysis-worker.test.ts 断言相同输入双次运行输出逐字节一致且与 golden vector 一致；新增 tests/unit/analysis-determinism.test.ts（≥5 组输入矩阵）；新增 tests/security/run-analysis-consistency-tests.sh 25/25：真实 docker 跑 baseline+formal 配对作业→analysis 两次调用 artifact 内容逐字节相同、analysis artifact 与 chart SVG 与 manuscript 的 mean/effect/CI 数字完全一致；已接入聚合器（CI=1 下 12/12 PASS）。尚未绑定 CI job 报告，待验收 |
| RUN-01 | 正式 Docker/快照/fencing/Manifest | 已实现未验收 | secure kind 拒 subprocess、approved Contract 绑定、严格 lease fencing、MetricsFileV1、data_artifact_ids 同项目+hash 校验、Run attempt(runs 表)、快照资源上限、**必签 Manifest 默认开启**(kernel requireSignedManifest 默认 true;runner 总是注册临时 Ed25519 密钥并签名;未签名 manifest→422 manifest_signature_required;单元测试显式 opt-out 只测无关路径)全部实现。证据:run-manifest-tests.sh 8/8(缺 artifact ref 用例已签名)、golden-v2/clean-room/release-bundle/demo 在默认签名下全绿;尚未绑定 CI job 报告,待验收 |
| RUN-01a | secure 作业 Contract 绑定（P0，acceptance-tests.md §4 前段） | 已实现未验收 | kernel submitJob 对 baseline/pilot/formal/reproduce 强制：contract_id 缺失→422 contract_required；getContract 失败→422 contract_unknown；跨项目→422 contract_foreign；status!=='approved' 或缺 approval.gate_decision_id→422 contract_not_approved（kernel.ts:1303-1323）。server.ts 新增内部批准路由 POST /v1/projects/{id}/contracts/{cid}/approve（actor 必填，server.ts:386-394），供 evals/orchestrator 用；交互路径走 Contract Gate 决策（GOV-02 原子冻结，approveContract 幂等，kernel.ts:992-1004）。证据：pnpm test 224/224（本会话运行，18 文件全过）；新增 tests/security/run-formal-binding-tests.sh 覆盖，后续轮次校准 |
| RUN-01b | 全字段 lease fencing（P0，acceptance-tests.md §4 末段） | 已实现未验收 | kernel heartbeatJob/completeJob 对 leased/running 作业：缺 generation/token→409 lease_stale；提供时精确匹配；无 owner-only 兼容放行（kernel.ts:1413-1432、1478-1485）。runner 侧所有 completeJob/heartbeat 调用点补齐 fencing 字段（workers/runner-gateway/src/index.ts:664-665、801、1028-1041；bin/runner.ts:133、157-158）。证据：tests/unit/kernel.test.ts §12.6 用例（519-595：stale token 409、缺字段 fail-closed）；tests/security/run-manifest-tests.sh 8/8（stale generation/token→409 lease_stale、当前 token→200，run-manifest-tests.sh:108-142）；专项 tests/security/run-fencing-tests.sh 12/12（heartbeat/terminal/complete 缺字段、旧/未来 generation、错 token 均 409 lease_stale；terminal frame 缺 lease_generation 已 fail-closed，内核不再默认放行） |
| RUN-01c | MetricsFileV1 强制（§4：formal/baseline/pilot/reproduce 成功必须存在 output_contract.metrics 指定路径的 MetricsFileV1） | 已实现未验收 | runner（workers/runner-gateway）对 secure 作业：缺 output_contract.metrics→code_error 失败；缺文件/非 MetricsFileV1（schema_version=1+非空 metrics）/run_id 不匹配/contract_id 不匹配/seed 缺失或非有限数/NaN/Infinity/重复 metric/非 Contract metric→不得 succeeded；secure 作业禁用 stdout fallback（index.ts:908-1011）。kernel submitJob 注入 payload.contract_metrics（contract primary+secondary，kernel.ts:1322、1330）；runner 注入容器环境 DSH_RUN_ID/DSH_CONTRACT_ID/DSH_SEED（index.ts:741-743）。证据（本会话运行）：golden-v2 29/29、clean-room 9/9、release-bundle eval 21/21 + release-bundle-tests 8/8、demo-full 15/15、demo-standalone 15/15，所有 secure 作业真实写 MetricsFileV1 文件；尚未绑定 CI job 报告，待验收 |
| RUN-02 | 固定容器安全基线（images.lock digest 强制） | 已实现未验收 | Docker flags 基本具备；configs/runner-profiles/images.lock.json 已提交（schema_version=1，node_fixture=node@sha256:c610fcdf…，texlive=texlive/texlive@sha256:8957c916…）。kernel submitJob 对 secure 作业强制：baseline/pilot/formal/reproduce 缺 digest→422 image_digest_required；tag（node:22-alpine）、latest、锁外 digest→422 image_digest_untrusted；latex-compile 缺 digest 由内核注入锁内 texlive 条目，显式提供时也必须与锁完全一致（packages/research-kernel/src/images-lock.ts validateImageDigest；DSH_IMAGES_LOCK 可覆盖 lock 路径）。单元测试新增 4 个 digest P0 用例，pnpm test 228/228。所有 eval/security 脚本已改用锁内 digest。尚未绑定 CI job 报告，待验收 |
| TERM-01 | 实时有序可恢复 Terminal | 已实现未验收 | reconnect-after-seq（按 seq 续传无重复无缺失）、retention-gap（淘汰 seq 返回 gap+dropped bytes）、overflow truncated+log Artifact 可下载、exit-replay（exit_code/signal/timed_out/cancelled 可读）、log-authz（跨项目 404）、cancel-timeout-distinct。证据：tests/security/run-terminal-tests.sh 11/11、tests/unit/terminal.test.ts；UI 侧 DOM 有界/ANSI 消毒/backpressure 属浏览器层，未纳入本行验收 |
| TEX-01 | TeX workspace/editor/version | 已实现未验收 | expected_version 语义修正:0=create-if-absent(UI 新建文件路径),HTTP schema 由 positive 改为 nonnegative;已存在+0→409 冲突;tree/GET 返回 path/kind/media/version(TexFileKind + fileMediaType 派生);保存 expected version→新 revision、并发 409、delete/move 版本校验;compile 冻结 manifest(既有)。证据:tests/unit/tex-workspace.test.ts + tex-build.test.ts 12/12、curl 集成(0→200、重复→409、tree 含字段);dirty 判断/窄屏布局属 UI 层待验收 |
| TEX-02 | latex-compile/诊断/PDF | 已实现未验收 | 锁内 texlive digest 强制（缺 digest 内核注入 texlive@sha256:8957c916…）；compile 冻结 manifest；诊断含 file/line 定位（tex-diagnostics.ts）；shell-escape/network 拒绝（docker flags）；build history 可重放。证据：evals/latex-compile-e2e.sh 13/13（含 write18 inert）、tests/unit/tex-kernel.test.ts；实时 Build Terminal/freshness 展示属 UI 层 |
| UI-01 | standalone-only 单一浏览器 UI | 已实现未验收 | 根嵌入面和旧 bridge 已删除；需当前提交的 clean package、真实 404、无 host/slot/dshClient 负向 CI 证据 |
| UI-02 | 全页面 zh/en i18n | 已实现未验收 | localeParityReport/assertLocaleParity(zh/en key 精确一致,dev warning + build/CI 硬失败);i18n-static-chrome 静态扫描测试(tests/unit/i18n-chrome.test.ts 3/3:扫描 client 源码硬编码中文与 chrome 位置英文字面量,命中即 fail,已修真实硬编码;zh/en key 集合一致断言);全部命名空间双语;根 pnpm test 已覆盖。证据:pnpm test 316/316;浏览器级 a11y/键盘/响应式仍待 Playwright 类 UI 验收 |
| UI-03 | standalone locale/theme adapter | 已实现未验收 | 解锁页(首屏+token gate)双语:BOOTSTRAP_HTML 内联 zh/en 字典 + data-i18n 键 + html lang 按 persisted dsh.locale→navigator.languages→zh;invalid-token 文案双语且键存在于 zh/en 字典(packaging.test 断言 data-i18n 键与字典一致性);locale/theme 持久化与 adapter 既有。证据:packaging.test.ts 新增解锁页双语用例(10/10)、首页 curl 含 data-i18n 键;首屏闪英文仍可能有残余,待 UI 验收 |
| UI-04 | browser client strict typecheck/模块边界 | 已实现未验收 | client/index.ts 由 ~8400 行拆分为 1070 行装配入口 + 模块(api/state/ui/types/sidebar/chat/terminal + panels/(phase/gates/runs/artifacts/evidence/budget/manuscript) + modals/(commands/detail/project/search/settings)),模块边界按职责;根 package.json "test" 现在包含 pnpm --filter @dsh-scholar/research-ui typecheck(tsc --noEmit strict,不再只靠 tsdown 转译)。证据:research-ui typecheck/build 全绿、pnpm test 304/304、standalone 新 client.js 正常服务;尚未绑定 CI job 报告,待验收 |
| ART-01 | binary/SSE 真流式 | 已实现未验收 | binary round-trip(media type/ETag/bytes)已有;SSE 真流式验收:tests/security/run-sse-tests.sh 23/23——text/event-stream 真实 body、连接后 live tail、after_seq 续传无重复无缺失、跨项目 404(kernel 与 BFF 双面)、BFF 无 token/wrong token 401、非成员在首字节前 404;撤权(revoke-on-disconnect)与背压源码未实现,已注明未覆盖 |
| ART-02 | media type/Range/hash | 已实现未验收 | media type、ETag/Range 基础存在；需 project-scoped v2/BFF、hash 重验和当前 CI 证据 |
| STORE-01 | 显式迁移与 schema parity | 已实现未验收 | SCHEMA_VERSION 6→7,迁移 0008_outbox_envelope:events 表增 outbox 列(event_seq/event_version/aggregate_*/request_id/session_id/attempts/last_error/next_attempt_at/dead_lettered_at)+聚合内唯一索引、新增 runs 表(job attempt 行,§3.1 parity)、session_links 增 principal/tenant/issuer;幂等且兼容旧库。证据:tests/unit/migrations.test.ts 全绿(schema 升级后列存在、旧行回填 event_seq);尚未绑定 CI job 报告,待验收 |
| STORE-02 | durable CodeSnapshot | 已实现未验收 | 快照资源上限:SNAPSHOT_MAX_FILES=10000/MAX_FILE_BYTES=64MiB(stat 后先拒再读)/MAX_TOTAL_BYTES=512MiB,超限 422 snapshot_too_large;宿主绝对路径不再写入 archive/metadata(root 占位符);path/traversal/symlink 逃逸保护保留;data_artifact_ids 同项目+hash 可重验(RUN-01 补充:缺失 422 data_artifact_missing、跨项目 422 data_artifact_foreign)。证据:tests/unit/kernel.test.ts 新用例(上限、root 不含绝对路径、data refs 三态);尚未绑定 CI job 报告,待验收 |
| EVENT-01 | 事务 Outbox | 已实现未验收 | events 写入带 event_seq(max+1 单写事务,聚合内单调)+event_version=1+aggregate 身份+request/session 跟踪+attempts/dead-letter 字段;emit 在调用方事务内复用同一事务(node:sqlite 无嵌套 BEGIN 处理);已淘汰 seq 回填。证据:tests/unit/kernel.test.ts 连续 emit 断言 event_seq 单调递增、字段存在;尚未绑定 CI job 报告,待验收 |
| DSH-01 | DSH Agent tools/commands/lifecycle | 已实现未验收 | canonical 工具名+deprecation 别名、/research 子命令真实 handler、skill 包根解析+确定性选择、npm pack assets、headless 可用(既有);新增:未知/未注册 Agent 默认 role=none,研究写工具全部 deny(ACL 测试断言);插件 dispose 清理(sidecar.stop/cache)测试。证据:tests/security/run-dsh-plugin-tests.sh 41/41(含 unknown-agent deny 与 disposer 用例);隔离 DSH host fixture 全链仍待 CI-01 |
| SIDE-01 | sidecar identity/ownership | 已实现未验收 | kernel 支持 --endpoint-file(port 0 时上报实际端口);sidecar(插件+standalone)复用前校验 0600 runtime/endpoint.json 的 protocol/schema/database/dataDir,缺失→sidecar_identity_unknown、不匹配→sidecar_identity_mismatch,均拒绝复用且绝不 kill 非本实例进程;spawn 后写自身 endpoint.json,stop 时按 pid 清理。证据:tests/unit/sidecar.test.ts 8/8(同 dataDir 复用、跨 dataDir 拒绝且原 kernel 存活、port=0 实际端口、无文件拒绝);运行中 standalone 的 endpoint.json 已生效(0600);尚未绑定 CI job 报告,待验收 |
| SKILL-01 | Skills 安装发现与确定性选择 | 已实现未验收 | provider 从发布包根解析四组 skill（research-core + 2 domain + venue），npm pack 断言 assets 在包内；domain/venue 按 Brief 确定性选择（skills.ts selectSkillPacks）；证据：run-dsh-plugin-tests.sh 36/36；clean install hash 一致性仍待 DSH fixture 验收 |
| PACK-01 | clean remote install | 已实现未验收 | 7 包 tarball 完整;clean consumer install 用 file: 覆盖 + overrides,断言 node_modules 是真实文件非符号链接、无原 checkout/../test-lzszq 路径、@deepseek-ai/* 宿主 peer optional 且无 registry 环境不强制安装;skills frontmatter 校验。证据:tests/unit/packaging.test.ts 10/10;真实 registry 发布仍待(环境无 registry,以 tarball+overrides 等价验收) |
| SELFMOD-01 | dev-only Cordis self tools | 已实现未验收 | production 静态否定(tarball/lib/src 无 cordis self 工具字符串、依赖图无 dsh-tool-cordis、verify-docs fail-closed)+ **真实 DSH host fixture 动态验收**:隔离 DSH_HOME 下 --profile web --dump-config 生产 0 引用、叠加 dev overlay patch 后 tool-cordis 出现在组合配置树(2 引用)、无 opt-in env 时 start-selfmod-dev.sh 拒绝启动。证据:tests/security/run-selfmod-tests.sh 19/19(含 host fixture 组,已接入聚合器);cordis_inspect 六类信息的会话级 inspect 仍属 harness 深层交互,记录为后续 |
| REL-01 | 自包含 Release Bundle + bundle-only clean-room | 已实现未验收 | build-bundle.sh 在 manifest 增加 runtime 段（node 版本、kernel_bin/runner_bin sha256、images.lock 的 node_fixture/texlive digest）；reproduce.sh 把 bundle 复制到空目录执行、拒绝指向原 checkout 的 KERNEL_BIN/RUNNER_BIN（external checkout access prohibited）、node 版本不匹配→fail、作业重放强制使用锁内 digest；reproducibility-report.json 增加 bundle_manifest_sha256、runtime_verified、images_used、compared{manifest_hash,metrics,analysis,run_manifest,tex}，任一 false→status=fail。证据：tests/security/run-release-bundle-tests.sh 16/16（含 checkout 拒绝用例与 report 新字段断言）、run-release-eval.sh 21/21（reproduce 段 pass）；尚未绑定 CI job 报告，待验收 |
| CI-01 | 完整阻断 CI | 已实现未验收(本地网关) | 用户决策不用 GitHub Actions;新增 scripts/ci-gate.sh 本地 CI 网关(一条命令:pnpm test+verify-docs+CI=true 聚合器+plugin typecheck,exit 非零即阻断,--skip-security 可选并注明降级);根 package.json test:ci。证据:bash -n 通过、各步骤单独全绿;DSH host fixture(SELFMOD 动态 overlay、Agent 全链)仍待外部 host 环境 |
| DOC-01 | Markdown 是生成权威 | 已实现未验收 | 本次校准后文档集一致:verify-docs.mjs 对 16 篇文档的结构/链接/contract 片段/删除面/SELFMOD 违规 fail-closed;--diff-check 覆盖全实现面并要求 ledger 同步移动;矩阵/acceptance/USAGE 无自相矛盾(校准完成)。证据:node scripts/verify-docs.mjs 与 --diff-check origin/main 通过;持续语义一致性由 ci-gate 的 verify-docs 步骤强制,待长期观察 |
| DOC-02 | change-aware docs sync | 已实现未验收 | --diff-check 覆盖扩展到根 src/、configs/、migrations/、scripts/(除自身)、tests/(unit+security)、docs/、evals/;改动范围必须伴随 ledger 移动;base ref 不可达保持 fail-closed。证据:node scripts/verify-docs.mjs --diff-check origin/main 通过(本会话全量改动已同步);待长期语义一致性持续验证 |
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
