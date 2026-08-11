# 既有研究接入、Init 与 Grill Me 规范

> 规范性文档。目标是让用户从任意研究阶段安全接入已有材料，而不是伪造一条从 DRAFT 开始的历史。任何实现不得把上传内容、用户陈述或模型判断直接升级为 Gate Decision、Run、TerminalLog、verified/accepted Evidence 或 supported Claim。

## 1. 产品入口

未选择项目时，首屏只提供三个主入口：

1. **Init**：从研究问题开始，填写最少 Brief 后创建 DRAFT 项目与 Scope Gate；
2. **Resume**：恢复平台内最近项目，回到其最后路由和权威 `next_actions`；
3. **Upload / Continue existing research**：上传在其他地方完成的论文、TeX、代码、数据、日志或结果，通过 Grill Me 识别完成阶段和缺口，Human 确认后创建或合并项目。

Chat 命令是高级入口，不得取代三入口首屏。Init 默认使用 gate-only、本机 Docker、默认预算和安全策略；高级项只显示“当前默认”摘要与 Settings 链接。

## 2. ResearchOnboarding Module

ResearchOnboarding 是深 Module。其公开 Interface 只有：

~~~typescript
interface ResearchOnboarding {
  begin(input: BeginIntake, principal: Principal): Promise<IntakeSession>
  stage(input: StageUpload, principal: Principal): Promise<IntakeArtifact>
  scan(intakeId: string, principal: Principal): Promise<IntakeProjection>
  grill(input: GrillAnswerBatch, principal: Principal): Promise<IntakeProjection>
  propose(intakeId: string, principal: Principal): Promise<PhaseProposal>
  accept(input: AcceptProposal, principal: Principal): Promise<AdoptionReceipt>
  resume(intakeId: string, principal: Principal): Promise<IntakeProjection>
  reject(intakeId: string, principal: Principal): Promise<void>
}
~~~

内部吞并 Blob staging、archive scanner、静态 parser、问题策略、阶段映射和事务物化；BFF、CLI 与 DSH Agent 复用同一契约。浏览器、CLI、DSH tool 和 parser Adapter 都不能绕过 Kernel 或直接写数据库。

### 2.1 权威边界

- `accept` 之前只能写 Intake 表和隔离临时 CAS，不能创建/修改 Project、Gate、ProjectArtifact、Workspace、Job、Run、TerminalLog、Evidence 或 Claim；
- DSH Agent 可 begin、stage、scan、grill、propose、status，但不存在 accept、adopt 或 Gate Decision tool；
- 只有 BFF 解析出的 Human PI Principal 可以 accept；
- accept 是“采用材料和生成待办”的事务，不是任何 Gate Decision；
- accept 后若需修改采用结果，创建新 Intake/Proposal，不原地篡改 AdoptionReceipt。

## 3. 状态机与对象

~~~text
draft → uploading → scanning → needs_input ↔ grilling
                                ↓
                         proposal_ready → awaiting_human → accepting → accepted
                                                            ↘ failed
任何非 accepted 状态还可进入 rejected 或 expired
~~~

核心对象：

- `IntakeSession`：intake_id、owner Principal、target_project_id 可选、status、revision、source_label、expires_at；
- `IntakeArtifact`：blob hash、media/magic、size、upload state、scan state、quarantine、parser version；
- `Observation`：source blob、locator、detector/version、value、warnings、`trust=observed_unverified`；
- `GrillQuestion`：稳定 code、required、reason、depends_on、question_revision、answer；
- `PhaseProposal`：observed_phase、safe_project_status、confidence、unresolved gaps、suggested mappings、required Gates、next actions、revision；
- `ImportMapping`：source observation/artifact 到 Artifact、Workspace、CodeSnapshot、ImportedRunObservation 或 draft Evidence 的显式映射；
- `AdoptionReceipt`：adoption_id、proposal revision、target project revision、created object refs、pending Gate refs、request/idempotency hash。

所有对象都有 created_at/updated_at 和 project/tenant ownership；自由 metadata 不能替代不可变 provenance 字段。

## 4. Upload 与扫描

### 4.1 上传协议

- 单文件不超过 32 MiB 可走浏览器 multipart；研究包或更大文件走 intake staged upload，支持分块、offset/hash 重试、pause/resume/finalize/abort；
- 默认上限：单个 intake 10 GiB、100,000 entries、解压后 100 GiB、嵌套 archive 深度 2；instance Config 可收紧，不能超过 reconstruction-contracts.md 的最大值；
- stage 绑定 intake、Principal 和过期时间；相同 offset/hash 重传幂等，gap 或不同内容冲突返回 409；
- finalize 服务端复算 SHA-256 和 size，扫描完成前不能预览或采用；
- Upload UI 显示 hashing、uploading、scanning、needs-input、quarantined、ready、failed，并可恢复。

### 4.2 不可信内容

扫描必须验证 MIME 与 magic、归一化根相对路径，拒绝绝对路径、`..`、NUL、设备、FIFO、越界 symlink、重复大小写冲突、zip/tar bomb。Parser 在无网络、无执行权限、只读输入、受限 CPU/内存/时间的 sandbox 中运行；TeX、脚本、notebook、HTML、SVG 和 ANSI 均不能自动执行。不可信 HTML/SVG 只允许安全文本或光栅预览。

> 实现注记（commit 待定，主代理统一提交）：受控 archive 解包扫描已实现（archive-scan.ts，node 内置 zlib gunzip/inflateRawSync（`maxOutputLength` 有界）+ 手写最小 ZIP（EOCD + central directory）/TAR（ustar + GNU longname/longlink + pax）只读解析，不 shell 出系统 unzip/tar、不执行内容）：scanIntake 对 clean 的 .zip/.tar/.tar.gz/.tgz（扩展名 + magic）逐条目应用与 workspace 相同的路径安全规则（复用 normalizeWorkspacePath：绝对/`..`/NUL/盘符/反斜杠拒绝；重复规范化与大小写冲突拒绝；symlink/hardlink/设备/FIFO 条目拒绝——失败即 quarantine，fail closed），并强制条目数（≤1000）、总解压字节（≤512MiB）、单文件（≤64MiB）、压缩比（>100x）上限（`ResearchKernel.ARCHIVE_MAX_*` 静态可覆写）。解包结果以"展开视图"进入 scan_result.archive_extract（status=ok + entries 路径/大小）与 scan_summary（extracted_entries/extracted_bytes）；**只写 intake 隔离区**（intake 表 + intake-staged，pre-accept 零权威写不变），adopt 物化时按条目重读 staged 字节。bz2/xz/7z 与单文件 gzip（如 data.csv.gz）无解包器 → 记录 status=unsupported（不 quarantine，仍可按代码 Artifact 采用）；zip64 单条目与未知压缩方法 → 拒绝（unsupported_format/unsupported_compression，环境上限内实际不可达）。

Secret detector 命中时默认 quarantine 并要求用户删除、替换或建立服务端 `SecretRef`；secret value 不进入模型 prompt、浏览器响应、日志、配置、Manifest 或 Bundle。

## 5. Grill Me

Grill Me 是确定性缺口收集器，不是让 LLM 自由判断研究已完成程度。

- 问题由版本化 taxonomy + detectors 生成，LLM 只能翻译或改写语气；
- taxonomy 至少覆盖 owner/scope/license、TeX root/engine、代码 commit/lock/image、数据版本/split/preprocess、seed、指标方向/口径、Run ID/签名 Manifest、统计/CI/n、privacy/secret/network、target venue；
- answer 必须记录 Human Principal、时间和 question_revision，provenance 为 `human_assertion`；
- 必答项未回答时保持 `needs_input`；`unknown` 和部分答案必须保留 unresolved gap 并降低 confidence；
- 用户陈述不能升级为 verified Evidence 或证明历史 Gate 已通过。

## 6. 阶段提案与安全采用

`observed_phase` 可为 brief、survey、idea、baseline、contract、experiment、evidence、writing、review、release。它只是提案 metadata。`safe_project_status` 只能通过 Kernel 当前状态机与 Gate 事务生成。

| observed_phase | 默认安全落点与必需动作 |
|---|---|
| brief | DRAFT；创建 Scope Gate |
| survey | 无可验证 Scope Decision 时仍为 DRAFT；采用 Corpus 草稿并创建 Scope Gate |
| idea | IDEATING 之前的可达安全状态；创建 Idea Gate，不能伪造 IDEA_APPROVED |
| baseline | BASELINE_REPRO 前置状态；要求 clean baseline verification |
| contract | CONTRACT_PENDING；创建 Contract Gate，不能伪造 CONTRACT_APPROVED |
| experiment/evidence | EXPERIMENTING 前置状态；导入结果保持 unverified，要求 clean run/reanalysis |
| writing | WRITING 前置状态；导入 TeX，PDF 立即标 stale 并要求本地 build |
| review | REVIEWING 前置状态；要求 review/clean-room gaps |
| release | RELEASE_READY 前置状态；创建 Release Gate，不能伪造 RELEASED |

目标项目合并时，Proposal 固定 target project revision；accept 时 revision 不同返回 409 `project_revision_conflict` 并要求重新 propose。不得静默覆盖已存在 path、Artifact role、Contract 或 Evidence；每个冲突必须由 Human 选择 keep/current/import/rename。

### 6.1 文件与事实映射

| 输入 | 采用结果 |
|---|---|
| PDF/DOCX/论文 | paper/pdf Artifact；引用与文本保持 untrusted observation |
| TeX 目录 | 版本化 Workspace/TexFileRevision；上传 PDF stale，必须重编 |
| Git bundle/代码目录 | 经路径扫描的 CodeSnapshot archive + manifest |
| 数据 | data Artifact + manifest/license/lineage |
| stdout/stderr/日志 | log Artifact + ImportedRunObservation，绝不创建 TerminalLog |
| metrics/results | data/analysis Artifact + `legacy_unverified` 或 draft Evidence |
| 图表 | chart Artifact，不能反推正式数值 |
| lockfile/image/env 描述 | manifest metadata；credential 替换为 SecretRef |

没有由本 Kernel 接受的签名 RunManifest 时，不得合成 RunSet、accepted Evidence 或 supported Claim。

> 实现注记（commit 待定，主代理统一提交）：TeX/CodeSnapshot 采用物化已实现——adopt 单事务（权威导入：CAS 提升 + Artifact 行 + pending Gate + draft Evidence + AdoptionReceipt）**成功后**（绝不回滚 adopt）执行尽力增强物化：TeX 文件/展开条目 → 项目 TeX workspace document（tex-workspace `ensureDocument`/`writeFile`，document_id 生成规则为 tex-workspace 的 `doc_<uuid12>`、每项目一个文档复用、首写文件 version=1，路径冲突 → gap `tex_path_conflict`，不静默覆盖）；代码文件/展开条目 → 项目 `code` workspace（workspace-store `write`/`writeBinary`，expected version=0 create-if-absent，冲突 → gap；workspace 名 `intake-<intake 后缀>`），代码物化后经 `snapshotCodeArchive` 的 workspace 语义生成可选 CodeSnapshot（`receipt.code_snapshot_refs`，失败仅审计）；物化结果写入 `AdoptionReceipt.import_mappings`（每映射：source 文件名/条目 → 目标 workspace path 或 document_id + status `materialized|gap` + reason；archive 内非 TeX/代码条目 → gap `entry_type_not_materialized`，留在被采用归档 Artifact 内）。语义：**adopt 是权威导入，物化是尽力增强**——任何物化失败（含超上限条目）只记 gap，adopt 保持成功；崩溃窗口（adopt 已提交、物化未完成）下 receipt 无 import_mappings，幂等重放返回已存 Receipt，不重作物化。

## 7. Adoption 事务、恢复与 GC

accept 必须在一个 Kernel 事务中校验 Human Principal、最新 proposal、target revision、Blob scan、mapping ownership 和 required questions，然后写入 AdoptionReceipt、Project/ProjectArtifact/Workspace 映射、待处理 Gate/Action 与 Outbox。失败全部回滚。相同 scope + Idempotency-Key + request hash 返回同一 Receipt；不同 hash 返回 409。

> 物化边界（commit 待定）：§6.1 的 TeX/CodeSnapshot 物化**在事务提交后**执行（见 §6.1 注记），不属于本事务的原子范围——事务内的 Workspace 映射指权威 Artifact/采纳对象，workspace 物化是事务后的尽力增强，失败记 gap/审计且不回滚 adopt（崩溃恢复按 adoption_id 重驱仍只保证事务内对象不部分采用）。

崩溃后按 adoption_id 重驱，不得出现部分采用。未采用临时 Blob 默认 24 小时 GC，Intake 默认 7 天过期；quarantine、expiry、purge 都写审计。已采用 Artifact 进入正常 retention，不受 intake GC 影响。

## 8. NextAction

项目和 Intake 都输出结构化引导：

~~~typescript
interface NextAction {
  id: string
  code: string
  label_key: string
  state: 'available'|'running'|'waiting-gate'|'waiting-external'|'blocked'|'failed'|'completed'
  target_route: string
  blocking: boolean
  reason: string
  refs: Array<{kind:string; id:string}>
  required: 'human'|'agent'|'runner'
  required_revision: number
  capability?: string
  raw?: string
}
~~~

NextAction 只能由 Kernel 投影、pending Gates、unresolved gaps 和运行状态确定性生成。UI 只对白名单 code 启用 CTA；未知 action 保留 raw 并退化为“查看总览”，不能猜测或直接推进状态。

## 9. 错误、i18n 与验收边界

稳定错误码至少包含：`intake_not_found`、`intake_state_conflict`、`intake_expired`、`upload_hash_mismatch`、`upload_offset_conflict`、`archive_limit_exceeded`、`artifact_quarantined`、`scan_timeout`、`question_required`、`proposal_stale`、`acceptance_required`、`phase_unadoptable`、`project_revision_conflict`、`cross_project_reference`。

问题 label、状态、CTA 与错误 chrome 必须 zh/en key parity；上传文件名、论文/代码/TeX 内容和原始 parser message 保持原文。详细自动验收见 acceptance-tests.md；未通过前 hardening 状态只能是“未实现”或“部分”。
