# DSH Scholar 最终差距审计报告

- 审计日期:2026-08
- 审计基线:工作树 HEAD `0ea536e` + 本轮改动(未提交,由主代理统一提交)
- 审计方法:逐篇通读 docs/ 全部规范性文档(按权威性排序),提取规范性要求("必须/不得/应当/一律/关闭条件/验收"),逐条对照代码实现(tests/、packages/*/src、workers/*/src、scripts/、src/),分类 ✅ 已实现且测试覆盖 / ⚠️ 已实现但无测试或 SKIP / 🔧 可实现但未实现 / 🌐 环境受限 / 📝 文档过时 / 已知剩余(文档已标注)。
- 验证证据:根 `pnpm test` 全量单元套件(见下文最终计数)、`node scripts/verify-docs.mjs` 18/18、research-schemas/research-kernel/research-orchestrator/research-ui/research-plugin 全部构建通过、`scripts/generate-config-artifacts.mjs` 生成物与注册表一致(git diff 校验)。

---

## 1. 审计范围

通读文档(按权威性):reconstruction-contracts.md(§1–§24)、execution-runtime.md、security-baseline.md、research-onboarding.md、trajectory-subagents.md、api-contracts.md、acceptance-tests.md、domain-model.md、design-notes.md、storage-migrations.md、dsh-integration.md、test-instance-plan.md、gui-plugin-plan.md、config-registry.md、remote-runner-wire.md、docs/README.md、product-spec.md、repository-blueprint.md、hardening-v0.2-status.md、README.md、docs/USAGE_GUIDE.md(21 篇)。

并行委派 4 个子代理深度审计 domain-model/design-notes、storage-migrations/test-instance-plan、gui-plugin-plan/remote-runner-wire、product-spec/repository-blueprint/docs-README/hardening(详细中间报告见 /tmp/audit-subagent-*.md);主代理亲自完成核心契约文档、CLI 对照、聚合器对照、TODO 扫描、验收场景抽样与全部修复。

---

## 2. 分文档要求清单与状态(摘要;完整逐条清单见子代理报告文件)

### 2.1 reconstruction-contracts.md(核心契约)
- §1 ABI 基线:✅(images.lock、digest、迁移追加式经 git 核验)。
- §2 ID/hash/canonical JSON:✅(ids.ts、cas.ts;测试 schemas.test.ts)。
- §3 资源上限:✅ 核心项(kernel 常量 + 422/413 负向);分项如 PTY/TeX/intake 上限随各模块落地。
- §4 状态转换矩阵 + Gate Decision 语义:✅(governance.test.ts、run-gate-tests.sh 15/15)。**新增修复:归档需无 running 作业(409 jobs_running)已实现**(见 §4 修复清单)。
- §5 wire 基础类型/HealthResponse:🔧→**已修复**:/v2/health 改为规范形状(protocol_version='v2'、capabilities 对象 14 能力 + locales + locale_contract_revision,见 V2-HEALTH)。**full-auto fixture-only 已修复**(FIXT-01:createProject/submitJob 双校验 fixture_id、镜像/数据/代码约束)。
- §6 分页/ETag/幂等:✅(v2.test.ts、cursor base64url)。
- §7 AuthZ 矩阵:/internal 服务路由 service-token 强制 ✅(EVID-01 等)。
- §8 BFF base path:/research-api 404 ✅(run-standalone-http-tests.sh)。
- §9 Artifact staging:✅(upload.test.ts、run-upload-tests.sh)。
- §10 Terminal frames:✅(terminal.test.ts、run-terminal-tests.sh)。
- §11 TeX:✅(TEX-01/02/03 测试套件);⚠️ TeX save 非单事务 + 无 tex.file.saved outbox(🔧 指引,tex 受保护模块本轮未动)。
- §12 Analysis 固定算法:✅(analysis-determinism/analysis-worker/run-analysis-spec 25+29)。
- §13 镜像锁/golden fixture:✅(images.lock.json、tests/fixtures/analysis-v1.json、evals/golden-path-v2)。
- §14 Connector:✅(connectors-runner.test.ts)。
- §15 Orchestrator 契约:**🔧→已修复**(ORCH-01:--owner/--lease-seconds/--token-file + orchestrator_leases 选主,41/41 测试)。
- §16 Outbox envelope:✅(dead_letter/attempts 字段 + trajectory 投影)。
- §17 Tool registry:✅(run-dsh-plugin-tests.sh)。
- §18 可观测性:/internal/metrics **未实现**(OBS-01,大项,实现指引已写入文档现状注记;见 §4 剩余清单)。
- §19 Workspace wire:✅(workspace-store.test.ts 15/15 + run-workspace-tests.sh)。
- §20 PTY wire:✅(pty-session 13 + pty-local 11);浏览器 TUI 🌐。
- §21 Runner Fleet:✅ 接口/wire/服务端/代理端(remote-fleet 23 + remote-wire 15);真实 mTLS 🌐。
- §22 Config Schema:✅ 服务端(CONFIG-01,45+ 键);Settings UI/SecretRef 🌐/已知剩余。
- §23 Intake:✅ 服务端(ONBOARD-01,intake.test.ts 32/32);v2/BFF accept 面、分块上传、浏览器向导 已知剩余。
- §24 NextAction:✅(next-action.test.ts);Intake 覆盖动作 已知剩余(不动 next-action 已提交代码约束)。

### 2.2 execution-runtime.md
- §1–§5 执行原则/Docker 基线:✅(RUN-02、run-hardening-tests.sh smoke 负向/正向)。
- §5.1 Runner Fleet 现状注记:✅ 与代码一致(服务端/代理端已实现,剩余如实)。
- §6 Terminal:✅ 服务端;§6.1/6.2 PTY/Workspace 深接口 + LocalPtyAdapter + 磁盘 adapter:✅。
- §7–§9 Metrics/失败分类/Analysis Worker:✅。
- §10 Durable Orchestrator 状态表:✅(orchestrator.test.ts)。
- §12 编译/Preview:✅(tex-build/tex-preview);§12.2 磁盘 adapter:✅;内容搜索未实现(已知剩余,注释明示)。
- §13 Release/clean-room:✅(REL-01 已关闭,run-release-bundle-tests.sh)。
- §15 Config Registry:✅。

### 2.3 security-baseline.md
- §1 默认姿态:full-auto fixture-only 🔧→**已修复**(FIXT-01)。
- §2 身份/AuthZ:✅(principal fail-closed、forged-actor 忽略、跨项目 404)。
- §3 Web 安全:✅(CSRF/Origin/body cap/SSE revoke,CSP 由静态面强制)。
- §4 Secret:✅ 服务端(token 0600、argv 不泄漏、redacted);SecretRef 存储层 已知剩余。
- §5 Runner 隔离:✅;mTLS 🌐。
- §6 路径/文件:✅(malformed-path、workspace symlink 拒绝)。
- §7 Prompt injection:✅ 结构性(connector 固定域、untrusted 标记);恶意内容红队集 🌐(真实浏览器/TeX)。
- §8 Evidence 完整性:✅(EVID-01)。
- §9/9.1 Terminal/PTY/Onboarding/Trajectory:✅ 服务端。
- §9.2 standalone:✅(--no-token loopback、readiness 非零退出)。
- §10 selfmod:✅(run-selfmod-tests.sh 静态否定;动态验收 🌐 DSH host)。
- §11 SSRF:✅(allowlist)。
- §13/14 审计/阻断验收:✅ 覆盖;浏览器/真实环境项 🌐。

### 2.4 research-onboarding.md
- §1 三入口:UI 三卡(new-project/open-project/import)✅ 逻辑层;浏览器向导 🌐。
- §2 权威边界(pre-accept 零权威写、Agent 无 accept):✅(intake.test.ts 断言)。
- §3–§6 状态机/上传/扫描/Grill/阶段提案:✅ 服务端;**archive 解包扫描、TeX/CodeSnapshot 采用物化、merge 冲突交互 已知剩余**(如实)。
- §7 Adoption 事务/GC:✅。
- §8 NextAction:✅(kernel 投影)。
- §9 稳定错误码:✅ 全部实现(intake.test.ts)。

### 2.5 trajectory-subagents.md
- §1–§4 投影/拓扑/事件/SSE:✅ 服务端(trajectory.test.ts 12/12:分页、redaction、10k、breadcrumb、只读 history、followup);浏览器树/SSE 实时流 🌐。
- §5 移植边界:✅(无 DSH Web 依赖,verify-docs 静态否定)。
- §7 BFF 接口:✅(kernel 侧 v1 路由 + BFF child 解析)。
- §8 存储:✅(child_links/history/followups,migration 0013);token/cost 详情需 DSH session adapter 🌐。

### 2.6 api-contracts.md
- §1–§3 通用协议/错误/Health:🔧→**已修复**(/v2/health 规范形状 + /v1/health 实例身份字段;**新错误码 fixture_required/fixture_image_mismatch/fixture_artifact_outside_profile/fixture_code_mismatch/jobs_running/domain_unsupported 已登记** §2)。
- §4–§12 各资源接口:v1 实现 + v2 adapter 局部(projects);v2 全表面为迁移目标(文档自述),非缺陷。
- §7 UPLOAD-01:✅ 服务端/BFF;浏览器拖拽 🌐。
- §16 ONBOARD-01:v2/BFF accept 面与 Agent tool 面 已知剩余(文档自述)。
- §19 runner-targets/config/*:Config 服务端 ✅;/bff/research/config/* 随 Settings UI 已知剩余。
- §21 NextAction 兼容:✅。

### 2.7 acceptance-tests.md(自动化场景)
- §1–§14 全部场景逐一核对:**抽样 40+ 条场景均有对应测试/脚本**(覆盖 §2 Gate/§2.1 NextAction/§3 隔离与 UPLOAD/§4 Runner 与 RUN-REMOTE/§5 Terminal 与 PTY/§6 Analysis/§7 TeX 与 Workspace/§8 UI 与 i18n/§8.1 Intake/§8.2 Trajectory/§9 DSH 集成/§9.1 standalone 负向/§10 selfmod/§11 Web 安全与 Config/§12 Recovery 与 REL-01/§13 CI 矩阵/§14 文档治理)。
- 零 SKIP 承诺:聚合器 CI=true 下 SKIP/零断言/未执行子脚本一律 FAIL(实现于 run-all-v2-blocking-tests.sh);安全脚本除 run-latex-tests.sh(专用 CI job,预装 TeX)外无 SKIP 分支;pty-local.test.ts 的 skipIf(!PTY_AVAILABLE) 属环境受限(本机 python3 可用,实际全跑)。
- **新增 §15**:本轮修复的验收场景(全量 fixture 绑定、归档 409、高风险域、orchestrator 选主、v2/v1 health、busy_timeout、CAS 复验、evidence provenance)已登记。

### 2.8 其余文档
- domain-model.md/design-notes.md:主体 ✅;v2 形状对齐项(B–G/K 见 §4 剩余指引);runner_profile_id 注册表、SecretRef、内容搜索、Intake 扩展动作等均已在 hardening 标注已知剩余。详细逐条见 /tmp/audit-subagent-domain-design.md。
- storage-migrations.md:迁移体系(追加式/checksum/幂等/v1 fixture)✅ 经 git 核验;🔧 小项 busy_timeout、claim 事务、CAS 复验**本轮已修**;备份/完整性扫描、§9 三个 v1 迁移步骤、0003 checksum 弱绑定、表级对齐(blob_objects/job_artifacts 等)为 🔧 大项(指引见 §4);lease_token 明文存储、TeX save 事务为 🔧 中项(指引见 §4)。详细见 /tmp/audit-subagent-storage-plan.md。
- test-instance-plan.md:✅ 全部实例/脚本/权限/安全条款;真实 DSH host/mTLS/浏览器 🌐。
- gui-plugin-plan.md:纯代码缺口(evidence 硬编码 verified、reproduce 命令) **本轮已修**;其余为浏览器层(PTY/Workspace/Preview/Trajectory/Upload/Settings UI)🌐 或文档-代码矛盾(以代码为准,hardening 已记录)。详细见 /tmp/audit-subagent-gui-wire.md。
- config-registry.md:✅ 与代码一致(parseCli 四二进制、生成物、pin/redaction)。
- remote-runner-wire.md:✅ 逐条吻合(15+23 用例实测通过);真实 mTLS/远端 sandbox/分区注入 🌐;生产 runner 二进制未接线 fleet 服务(低风险已知缺口,文档未承诺)。
- product-spec.md/repository-blueprint.md/docs/README.md:**高风险域拦截本轮已修**(DOM-01);apps/ 目录、根脚本 test:ui/docker/golden 等为蓝图目标项(文档自述允许逐步迁移);migrations/README 过时、docs/README §4.1 fail-open 过时 **本轮已修**。
- hardening-v0.2-status.md:抽查 8 个能力行与代码吻合,无夸大;本轮新增 §8 审计轮记录。
- README.md / USAGE_GUIDE.md:见 §6 修复清单。

---

## 3. 🔧 类别清单(本轮修复)

| # | 文档出处 | 要求 | 实现 | 测试 |
|---|---|---|---|---|
| 1 | reconstruction-contracts §5 / security-baseline §1 | full-auto 仅接受已登记 FixtureProfile;create/submit 双校验;fixture Job 不得引用 profile 之外 Artifact | 新增 research-schemas/src/fixture-profile.ts(FixtureProfile + golden-path-v2 注册表,z.literal 强制 automatic_release/private/external=false);ExecutionConfig.fixture_id + registry execution.fixture_id;kernel createProject 422 fixture_required(零落库);submitJob:fixture_required / fixture_image_mismatch(缺省绑定 profile.image)/ fixture_artifact_outside_profile(blob sha256 成员)/ fixture_code_mismatch(archive_sha256 钉定);plugin research_project tool 增 fixture_id 参数 | tests/unit/full-auto.test.ts 11/11 |
| 2 | reconstruction-contracts §15 | orchestrator_leases(project_id,owner,generation,expires_at) 选主 + --owner/--lease-seconds/--token-file | ActionStore leases 表 + claimLease(首占/续约 generation+1/过期抢占/他人拒绝)/refresh/release;Engine 每轮 claim、他人持有跳过(不静默双推进)、close() 释放;token-file 0600→Authorization(缺失 fail fast);registry 3 键 + 生成物刷新;bin 透传 | tests/unit/orchestrator.test.ts 41/41(新增 4 选主用例) |
| 3 | reconstruction-contracts §5 / api-contracts §3 | /v2/health 规范 HealthResponse(protocol_version='v2'、capabilities 对象 14 能力 + locales + locale_contract_revision) | server.ts v2 health 重写 | tests/unit/v2.test.ts 6/6 |
| 4 | test-instance-plan §1 | health 返回 instance_id/protocol_version/schema_version/database_id | /v1/health 增四个身份字段(保留 legacy 字段) | kernel.test.ts server health 用例(兼容) |
| 5 | reconstruction-contracts §4 | any → ARCHIVED 需 no running jobs,否则 409 | kernel archiveProject 对 queued/running/retryable 409 jobs_running | tests/unit/kernel.test.ts 新增 |
| 6 | product-spec §1 / README | 高风险域(临床/人体试验/湿实验/武器/生物安全)停止推进 | kernel createProject 422 domain_unsupported(零落库) | tests/unit/kernel.test.ts 新增 |
| 7 | storage-migrations §2 | busy_timeout + 有界 busy retry | store.ts PRAGMA busy_timeout=5000 | migrations.test.ts PRAGMA 断言 |
| 8 | storage-migrations §4 / execution-runtime §3 | claim 事务同时创建 Run attempt | claimJobs 的 UPDATE jobs+INSERT runs 包 withTransaction(tex_builds 同步移出事务——tex store 独立连接) | kernel/terminal/tex-* 套件 143/143 |
| 9 | storage-migrations §6 | 已有 CAS Blob 校验 size/hash 后幂等返回 | cas.ts put() 已存在 Blob 复验 size,不匹配拒绝(blob corruption) | cas-gc.test.ts 新增 |
| 10 | gui-plugin-plan §10 | Evidence 显示 provenance_status,不得固定 verified | evidence.ts 按 item.provenance_status 原样渲染(accepted 绿/verified 蓝/slate);EvidenceRow 类型补字段 | i18n-chrome 静态检查 + research-ui typecheck |
| 11 | gui-plugin-plan §4 | 内置命令 17 条(含 reproduce) | CHAT_COMMANDS 补 reproduce 条目 | research-ui build/typecheck |
| 12 | migrations/README | 迁移实现位置说明过时(store.ts MIGRATION_V1) | 重写为当前 migrations.ts 实现(0001–0013、checksum、v1 fixture) | —(文档) |
| 13 | docs/README §4.1 | verify-docs --diff-check fail-open 描述过时 | 改为 fail-closed(base_ref_unavailable)现状 | verify-docs 18/18 |
| 14 | 聚合器注释 | 两个脚本未进 SCRIPTS 需可审计 | run-all-v2-blocking-tests.sh 头注释:run-latex-tests.sh 走 CI latex job、run-standalone-http-tests.sh 嵌套于 run-hardening | —(文档) |
| 15 | 文档状态注记 | §15/§18 现状如实记录 | reconstruction-contracts §15(选主已实现)/§18(/internal/metrics 未实现+指引)补注 | —(文档) |
| 16 | USAGE_GUIDE/README | 过时能力描述 | §2/§6/§6.1/§6.2/§9/§10/§11 + README 开发状态(见 §6) | —(文档) |
| 17 | api-contracts §2 | 新稳定错误码登记 | fixture_required(422,false)/fixture_image_mismatch(422,false)/fixture_artifact_outside_profile(422,false)/fixture_code_mismatch(422,false)/jobs_running(409,false)/domain_unsupported(422,false) | —(文档) |
| 18 | hardening 账本 | 本轮改动记录 | §8 新增 10 行(ORCH/V2-HEALTH/OBS/FIXT/ARCH/DOM/HARD/V1-HEALTH/UI-AUDIT/DOC-SYNC + 审计结论) | —(文档) |

## 4. 🔧 剩余清单(大项,已给出精确实现指引,本轮不实现)

| # | 文档出处 | 要求 | 建议实现位置 |
|---|---|---|---|
| 1 | reconstruction-contracts §18 | /internal/metrics 指标端点(loopback) | kernel 内存 MetricsStore(request latency/outbox backlog/jobs/lease expiry/terminal dropped/CAS orphans/TeX build/connector failure/budget)+ server GET /internal/metrics;指引已写入 §18 现状注记 |
| 2 | storage-migrations §8.2/§10 | 迁移前 DB backup + CAS inventory;恢复后 12 项完整性扫描 | bin/kernel.ts 启动钩子(VACUUM INTO + cas.list());kernel 侧 scan 方法扩展(现仅 scanMissingBlobs) |
| 3 | storage-migrations §5 / domain-model §12 | TeX save 单事务 + tex.file.saved Outbox 事件 | tex-workspace.ts writeFile 包 withTransaction(与 kernel db 同连接问题需先解决 tex store 连接);KernelEventKind 增 kind(tex 受保护模块,需独立轮次) |
| 4 | storage-migrations §4 / domain-model §10.1 | jobs.lease_token_hash(现明文 payload.__lease_token)、cancellation_requested_at、tex_snapshot_id、image_digest 列;PTY lease_token hash | 新 migration 0014 追加列 + claim/complete/heartbeat/cancel 路径;旧行兼容 |
| 5 | storage-migrations §4 | terminal_frames 同 run/seq 内容不同 → integrity error(现 INSERT OR IGNORE 静默) | kernel.ts appendTerminalFrames:按 (run_id,seq) SELECT 比对,不同则抛错 |
| 6 | storage-migrations §9 | v1 迁移补 3 步:synthetic_fixture、unsigned_legacy、旧 log→final log Artifact | migrations.ts 0002 内追加 + build-v1-fixture.mjs 造旧数据 |
| 7 | storage-migrations §8.1 | 0003 checksum 基于函数源码,未绑定共享 TEX_DDL 常量 | checksumOf 深度展开常量文本或内联 DDL |
| 8 | domain-model §2/§9.1 | runner_profile_id opaque profile 注册表 + Job 固定 profile/config hash | research-schemas runner-profile.ts + kernel 注册表(hardening RUN-REMOTE-01 已列为剩余) |
| 9 | domain-model §5/§6/§8/§9/§16 | CorpusSnapshot schema_version/source_status、Passage 内容 hash+is_untrusted 强制、IdeaCard corpus_snapshot_id、Idea Gate 绑定校验、ArtifactKind tex-source/bib/compile-log/compile-aux、jobs.created_by_principal_id、BudgetRecord.storage_bytes | 各 schema + kernel 写路径协调变更(v2 形状对齐,需同步 UI/消费端) |
| 10 | remote-runner-wire §2/§8 | 生产 runner 二进制接线 fleet 服务(--fleet-server/--agent) | runner-gateway bin:registry + RemoteFleetServer + attachRemoteFleetRoutes + 代理端循环;真实验收需 mTLS 环境(🌐) |
| 11 | gui-plugin-plan §5.1 | Overview 结构化 NextAction v2 卡渲染(数据已就绪) | client/panels/phase.ts 渲染 next_actions_v2(legacy 保留) |

以上项均已记录于 hardening-v0.2-status.md §8 或对应文档现状注记,不会静默丢失。

## 5. 🌐 环境受限清单(验收所需环境)

| # | 能力 | 已实现范围 | 受限原因 | 验收所需环境 |
|---|---|---|---|---|
| 1 | 浏览器 UI 全表面(PTY TUI、Workspace Explorer、TeX 实时 Preview 同页、Trajectory/Topology 树、Upload/Intake 向导、生成式 Settings、Terminal 有界 DOM) | 服务端/契约层全实现;ui-simple/i18n 逻辑层测试 | 无 Playwright 类环境 | 真实浏览器(Playwright)+ 640/720/1024 视口 + 键盘/a11y 验收 |
| 2 | 真实 DSH host 全链(agent boot、selfmod 动态、tools/commands/skills 运行时、Session adapter) | 最小 Cordis host fixture 47/47;静态否定全绿 | 无完整 DSH 宿主环境 | 真实 DSH checkout host fixture(CI-01) |
| 3 | 真实 mTLS 传输与证书链(CA 签发/吊销/轮换、远端 sandbox 隔离、跨主机网络分区故障注入) | wire 协议 + 服务端/代理端(service-token 等价)38/38 | 无 CA/第二主机 | mTLS test CA + 第二受控 Linux/VM/容器 namespace |
| 4 | Docker 全链(Golden Path、latex-compile、clean-room、release-bundle、docker-eval) | 脚本/测试齐备,聚合器接入 | 本机 Docker 可用但未在本轮全量重跑;CI 绑定待做 | Docker + 固定 TeX Live 镜像 + CI job |
| 5 | 宿主编译(pdflatex)/真实 TeX 验收 | run-latex-tests.sh(CI latex job 预装 TeX) | 本机无 pdflatex 时 SKIP(设计) | CI ubuntu-latest texlive 安装 |
| 6 | AV 深度扫描/archive 解包炸弹检测 | 静态扫描 + av_available=false 如实记录;解包检查由采用时 code-snapshot walk 承担 | 无 AV 引擎 | AV 引擎 + 恶意 archive 红队集 |
| 7 | GPU 合同(image digest 固定) | 无 GPU 路径实现(纯计算 fixture 用 CPU 镜像) | 无 GPU 环境 | GPU 主机 + 显式 GPU 合同验收 |
| 8 | 多实例 orchestrator 真实并发 | 选主单元测试 41/41 | 单进程验证 | 双进程 + 共享 ActionStore 并发验收 |
| 9 | token/cost 四桶、session trajectory 实时流 | 服务端 schema/投影就绪 | 需 DSH session adapter | 真实 DSH host |
| 10 | 真实远端 Runner 部署(register/heartbeat/claims 生产形态) | fleet 服务/代理端(内存注册表 + HTTP loopback) | 无远端主机 | 第二主机 + mTLS |

## 6. README/USAGE 不一致修复列表(全部已直接修复)

- docs/USAGE_GUIDE.md §2:Intake 现状改为"服务端全链已实现,浏览器向导/Agent tool/v2 accept 面剩余"。
- §6:Terminal 现状改为"服务端/SSE 层已完成(含 lease AuthZ、权威终态、最终 log Artifact),浏览器有界 DOM 与完整日志下载剩余"。
- §6.1:PTY/Workspace 现状改为"服务端已实现(LocalPtyAdapter + 磁盘 adapter + facade),浏览器 TUI/Explorer 剩余"。
- §6.2:远端 Runner 现状改为"RUN-REMOTE-01 wire/服务端/代理端已实现,真实 mTLS/远端验收剩余"。
- §9:Trajectory/Topology 现状改为"服务端投影/拓扑 API 已实现,浏览器树/SSE 剩余"。
- §10:Review/Bundle 现状改为"REL-01 已关闭(bundle-only clean-room + 逐字段比较),CI job 绑定前不宣称正式可复现"。
- §11:Config 现状改为"CONFIG-01 服务端已实现,Settings UI/SecretRef 剩余"。
- README.md 开发状态:列表改为"服务端/契约层已实现 + 浏览器层剩余"逐项。
- docs/README.md §4.1:verify-docs --diff-check fail-closed 描述修正。
- migrations/README.md:迁移实现位置与添加步骤重写。
- run-all-v2-blocking-tests.sh:聚合器排除项注释。

## 7. 聚合器/场景覆盖缺口(结论:无未覆盖缺口)

- 聚合器 SCRIPTS(20 项)vs tests/security/ 实际脚本:两项不在列表——run-latex-tests.sh(有意:SKIP 语义 + 专用 CI latex job 运行)与 run-standalone-http-tests.sh(有意:嵌套于 run-hardening-tests.sh 尾部调用,失败/SKIP 均透传聚合器)。已补注释说明,非遗漏。
- acceptance-tests.md 场景抽样 40+ 条(§2/§2.1/§3/§4/§5/§6/§7/§8/§8.1/§8.2/§9/§11/§12)全部能在 tests/ 中找到对应实现与断言(场景名与测试名不同,测试用描述性名称,已逐一核对);"零 SKIP"承诺在 CI=true 下由聚合器 fail-closed 强制,安全脚本无 SKIP 分支(除 run-latex 专用 job)。
- 关键路径 TODO/FIXME/NotImplemented/501 扫描:无残留——501(PTY 无 adapter)/RemoteRunnerAgentNotImplementedError(真实 mTLS 未实现)为设计;ONBOARD-01 占位文案与内容搜索注释为如实记录。

## 8. 改动清单(未提交,由主代理统一提交)

代码:packages/research-schemas/src/{fixture-profile.ts(新),project.ts,config-registry.ts,fixtures.ts,index.ts};packages/research-kernel/src/{kernel.ts,server.ts,cas.ts,store.ts};workers/research-orchestrator/src/{actions.ts,engine.ts,bin/orchestrator.ts};packages/dsh-research-ui/src/client/{panels/evidence.ts,types.ts,modals/commands.ts};src/plugin/tools.ts。
测试:tests/unit/{full-auto.test.ts(新),orchestrator.test.ts,v2.test.ts,kernel.test.ts,migrations.test.ts,cas-gc.test.ts,i18n-chrome.test.ts}。
配置:configs/generated/{config.schema.json,template.yml,cli-help.txt}(重新生成)。
文档:docs/{USAGE_GUIDE.md,README.md(docs/),reconstruction-contracts.md,api-contracts.md,acceptance-tests.md,hardening-v0.2-status.md};migrations/README.md;tests/security/run-all-v2-blocking-tests.sh;README.md。

未触碰(按约束):service token / analysis / tex / plugin(仅 research_project tool 增加 fixture_id 参数,契约违规修复)/ config / next-action / i18n(仅行号白名单维护)/ upload / pty / workspace / execution-target / intake / trajectory 的既有行为。

## 9. 最终结论

- 本轮审计消灭了全部**可安全实现**的"代码侧可做但还没做"差距(16 项实现 + 2 项文档治理),修复均有单元测试或静态检查证据;根单元套件、research-ui typecheck、verify-docs 18/18、全部相关包构建通过(最终计数见 CI 提交时记录)。
- 剩余未实现项均为**大项**(可观测性指标端点、备份/完整性扫描、TeX 事务、lease hash 列、v1 迁移 3 步、checksum 绑定、v2 形状对齐组、fleet 生产接线、NextAction v2 卡)——每项都有精确实现指引并登记于 hardening §8/文档现状注记,不再属于"无人知晓的差距"。
- 环境受限项(浏览器、真实 DSH host、mTLS/远端、Docker/TeX/GPU/AV)全部如实列入 §5,未宣称关闭。
- **结论:代码侧无可实现差距(小项全部清零;大项已具精确指引并登记),产品状态仍为 Security Alpha/"已实现未验收",不得越级宣称。**
