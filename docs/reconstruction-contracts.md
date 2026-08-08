# 可生成契约、固定参数与宿主 ABI

> 规范性文档。本文件消除其他文档中的示意值。生成器应把这里的类型转成 Zod、JSON Schema/OpenAPI 和 TypeScript；三者必须由同一源生成。

## 1. 版本与 ABI

规范版本 2.2，Kernel protocol v2，初始数据库 schema v2。

DSH 兼容基线：

| 项 | 固定值 |
|---|---|
| repository | DeepSeek Harness / @deepseek-ai/dsh-root |
| local verified commit | 895a2f84133204c92ad3d62297fbb63af182b94f |
| root version | 0.0.1 |
| cordis peer | >=4.0.0-rc.7 |
| schemastery peer | >=3.18.0 |
| required host modules | @deepseek-ai/dsh-tools、@deepseek-ai/dsh-commands、@deepseek-ai/dsh-skill-local |
| optional dev module | @deepseek-ai/dsh-tool-cordis |

构建仓库必须生成 packages/dsh-host-compat：只暴露本项目使用的 Context、Tool、Command 和 Session 类型。该模块不暴露 HttpServer、Slot、LocaleFace 或 ThemeFace。contract test 同时对本地固定 commit 的真实包和最小 fake host 运行。升级 DSH commit 时先更新本文件和兼容测试。

## 2. 固定 ID 与 canonical JSON

- 业务 ID：prefix + base32(lowercase, no padding) 的 128-bit crypto random；测试注入 deterministic ID source。
- event_id 和 request_id 同规则；不得使用时间戳作为唯一性来源。
- canonical JSON：UTF-8、对象 key 递归字典序、数组保持顺序、无额外空白、有限 JSON number；签名、hash、RNG seed 均使用同一编码。
- Hash：SHA-256(canonical bytes)，wire 为 sha256:<64 lower hex>。

## 3. 固定资源上限

| 参数 | desktop 默认 | 最大可配 |
|---|---:|---:|
| JSON body | 16 MiB | 32 MiB |
| inline HTTP upload | 32 MiB | fixed |
| staged Artifact total | 512 MiB | 10 GiB（cluster） |
| staged upload chunk | 8 MiB | 32 MiB |
| snapshot files | 20,000 | 100,000 |
| snapshot single file | 64 MiB | 2 GiB |
| snapshot total | 2 GiB | 100 GiB |
| Terminal hot retained bytes/run | 8 MiB | 64 MiB |
| Terminal rendered lines | 10,000 | 50,000 |
| final log bytes/run | 64 MiB | 1 GiB |
| SSE connections/user | 4 | 16 |
| SSE connections/project | 16 | 128 |
| TeX files | 2,000 | 10,000 |
| TeX single text file | 8 MiB | 32 MiB |
| TeX total workspace | 512 MiB | 2 GiB |
| page limit default/max | 50 / 200 | fixed |
| connector query limit | 20 | 100 |

超限使用明确 413/422，不做隐式截断；Terminal retention 是唯一允许的有标记截断。

## 4. 完整状态转换矩阵

Gate type 有五种；Gate 控制的目标状态有四个。Budget Gate 不进入新“批准状态”，它从 BLOCKED_GATE 恢复到记录的 resume_to。

| From | To | 触发者 | 前置/副作用 |
|---|---|---|---|
| DRAFT | SCOPED | Scope Gate transaction | approved human decision |
| DRAFT | STOPPED/FAILED | PI/Kernel policy | reason required |
| SCOPED | SURVEYING | Orchestrator/Director | corpus action created |
| SURVEYING | IDEATING | Orchestrator | frozen corpus exists |
| SURVEYING | STOPPED/FAILED | PI/Policy | reason |
| IDEATING | IDEA_APPROVED | Idea Gate transaction | target Idea version frozen |
| IDEA_APPROVED | BASELINE_REPRO | Orchestrator | snapshot action created |
| BASELINE_REPRO | CONTRACT_PENDING | Orchestrator | baseline succeeded within tolerance |
| BASELINE_REPRO | IDEATING/FAILED/STOPPED | PI/Policy | refine/failure reason |
| CONTRACT_PENDING | CONTRACT_APPROVED | Contract Gate transaction | target Contract frozen |
| CONTRACT_PENDING | IDEATING/STOPPED | revised/rejected workflow | new Idea or stop |
| CONTRACT_APPROVED | EXPERIMENTING | Orchestrator | formal actions created |
| EXPERIMENTING | EVIDENCE_READY | Orchestrator | minimum runs and accepted Evidence |
| EXPERIMENTING | IDEA_APPROVED/STOPPED/FAILED | PI/Policy | refine/stop/fatal |
| EVIDENCE_READY | WRITING | Orchestrator/Writer | TexDocument created |
| WRITING | REVIEWING | Orchestrator/Writer | latest TeX build succeeded |
| REVIEWING | WRITING | Reviewer | major revision |
| REVIEWING | RELEASE_READY | Orchestrator | review and clean-room pass |
| RELEASE_READY | RELEASED | Release Gate transaction | human approval |
| RELEASE_READY | WRITING/ARCHIVED | PI | revision or private archive |
| any non-ARCHIVED | ARCHIVED | PI | no running jobs; otherwise 409 |
| ARCHIVED | previous_status | PI | stored pre_archive_status, no stale Gate |
| any active | BLOCKED_GATE | Kernel policy transaction | budget/data/security Gate + resume_to |
| BLOCKED_GATE | resume_to | Budget/policy Gate transaction | resume_to must equal saved allowed state |
| terminal status | none | none | RELEASED/STOPPED/FAILED remain read-only except archive |

通用 transition 只允许表中触发者含 Orchestrator/Director/Writer 的非 Gate 行。PI stop/archive 走专用 BFF route；Policy block 走内部事务。

Gate Decision 效果：

| Gate | approved | rejected | revised |
|---|---|---|---|
| scope | DRAFT→SCOPED，冻结 Brief revision | DRAFT→STOPPED | 保持 DRAFT；旧 Gate 终态；保存新 Brief 后显式创建新 Gate |
| idea | IDEATING→IDEA_APPROVED，冻结 Idea version | 保持 IDEATING，target Idea 标 rejected | 保持 IDEATING；产生新 Idea version 后创建新 Gate |
| contract | CONTRACT_PENDING→CONTRACT_APPROVED，冻结 Contract | 保持 CONTRACT_PENDING，target 标 rejected | 保持 CONTRACT_PENDING；新 Contract version 后创建新 Gate |
| budget | BLOCKED_GATE→saved resume_to，并更新 limits/reservation | 保持 BLOCKED_GATE | 保持 BLOCKED_GATE；新预算提案创建新 Gate |
| release | RELEASE_READY→RELEASED | 保持 RELEASE_READY/private | RELEASE_READY→WRITING，创建 revision action |

每次 Decision 都使旧 Gate 终态并写 gate.decided；revised 不原地重开 Gate。只有 approved 进入四个 Gate 控制状态或预算 resume。

## 5. Wire 基础类型

~~~typescript
type ProjectMode = 'gate-only' | 'full-auto'
type GateType = 'scope'|'idea'|'contract'|'budget'|'release'
type GateDecision = 'approved'|'rejected'|'revised'
type JobStatus = 'queued'|'running'|'succeeded'|'failed'|'cancelled'|'retryable'
type JobKind = 'echo'|'smoke'|'baseline'|'pilot'|'formal'|'analysis'|'reproduce'|'latex-compile'|'clean-room'
type EvidenceProvenance = 'draft_unverified'|'legacy_unverified'|'verified'|'accepted'|'rejected'
type MemberRole = 'pi'|'researcher'|'operator'|'auditor'|'viewer'

interface Principal {
  principal_id: string
  tenant_id: string
  auth_method: 'dsh-session'|'standalone-local'|'sso'|'service-mtls'
  session_id?: string
  service_id?: string
}

interface PageRequest { cursor?: string; limit?: number }
interface Page<T> { items: T[]; next_cursor: string | null }
interface ErrorEnvelope {
  ok: false
  error: { code: string; message: string; request_id: string; retryable: boolean; details?: Record<string, unknown> }
}
interface JobExecutionLimits {
  timeout_seconds:number
  cpu:number
  memory_bytes:number
  pids:number
  max_log_bytes:number
  log_overflow_action:'terminate'|'drop'
}
~~~

Zod 对象默认 strict。metadata、payload、details 是唯一允许 passthrough JSON 的位置，且有 256 KiB 编码上限。

full-auto 只接受 fixture_id 非空且已登记的 FixtureProfile。FixtureProfile 固定 code/data/image/expected outputs、禁止 secret/private data/external release，并强制 automatic_release=false。Project create 和 Job submit 都校验 fixture_id；fixture Job 不得引用 profile 之外的 Artifact。

HealthResponse：

~~~typescript
interface HealthResponse {
  ok:true
  instance_id:string
  protocol_version:'v2'
  schema_version:2
  database_id:string
  capabilities:{
    terminal_stream:true
    tex_workspace:true
    latex_compile:true
    signed_manifest:true
    clean_room:true
    locales:['zh','en']
    locale_contract_revision:1
  }
  time:string
}
~~~

Sidecar 只复用 protocol_version、schema_version、database_id 和预期配置都匹配的 instance。runtime/endpoint.json 原子写为 {protocol_version:'v2',instance_id,host,port,unix_socket:null|string,database_id,token_file,started_at}，权限 0600；client 先读该文件再 health。port=0 只以此文件中的实际 port 为准，10 秒未出现或 health 不匹配即启动失败。

## 6. 分页、ETag 与幂等

- 列表稳定排序：created_at DESC、ID DESC；特殊列表可声明 updated_at DESC，但必须写在 route schema。
- cursor 是 base64url(canonical JSON {v:1, sort_time, id, filter_hash})；filter_hash 与当前 query 不同返回 invalid_cursor。
- 分页不保证数据库快照隔离，但稳定 keyset 保证不重复；新插入可能出现在下一次从头刷新。
- ETag：双引号包围资源 version/hash，例如 "tex:doc_x:path:7:sha256..."。
- 修改优先使用 body expected_version；If-Match 可携带同一 ETag，两者同时存在必须一致。
- Idempotency-Key 长度 1–200，同一 project/key 且 request hash 相同返回原响应；hash 不同返回 409 idempotency_conflict。

## 7. AuthZ 能力矩阵

| 能力 | pi | researcher | operator | auditor | viewer |
|---|---|---|---|---|---|
| project_read | yes | yes | yes | yes | yes |
| member_manage | yes | no | no | no | no |
| gate_decide | yes | no | no | no | no |
| job_submit | yes | yes | yes | no | no |
| job_cancel | yes | own | yes | no | no |
| job_log_read | yes | yes | yes | yes | no |
| document_write | yes | yes | no | no | no |
| evidence_note | yes | yes | no | no | no |
| evidence_review | yes | no | no | yes | no |
| audit_read | yes | no | no | yes | no |
| release_decide | yes | no | no | no | no |

Project creator 成为 pi。成员管理：GET/POST/PATCH/DELETE /bff/research/projects/{id}/members；最后一个 pi 不能删除或降级。standalone local identity 仅在 loopback 映射为单一 pi。

Route policy：所有 /v2/projects/{id} GET 需要 project_read；project mutation 需要 pi 或文档明确能力；Job submit/cancel/log 使用 job_submit/job_cancel/job_log_read；Document read/write/build 使用 project_read/document_write/job_submit；Gate Decision 使用 gate_decide；Release Decision 使用 release_decide；成员 route 使用 member_manage。全局 ID route 先解析其 project_id，再执行相同能力检查，不因知道 ID 绕过。/internal/v2 只接受对应 service identity：Runner 只能 claim/heartbeat/frames/artifact stage/complete，Analysis Worker 只能写 verified Evidence，Verifier 只能把验证通过的 Evidence 转 accepted，并持久化 service Principal/request_id；Human Auditor 只能提交 evidence review request。

## 8. BFF base path

客户端逻辑路由统一写 /v2 或 /bff/research。运行形态改写：

| 形态 | 浏览器 base | 转发 |
|---|---|---|
| standalone | 空字符串 | 同源直接提供 /v2 和 /bff/research |
| internal worker | http://127.0.0.1:<kernel> | 直接 /internal/v2；浏览器不可达 |

`/research-api` 和 `/research-ui-api` 是已删除的 DSH 嵌入面，必须返回 404。目标客户端只使用 standalone 同源逻辑路由。

## 9. Internal Artifact staging

Runner/Worker 使用服务身份和 lease token：

1. POST /internal/v2/jobs/{job}/artifact-stages
   请求 kind、media_type、file_name、expected_size、expected_sha256、lease generation/token；响应 stage_id、upload_url、expires_at。
2. PUT /internal/v2/artifact-stages/{stage}/content
   原始 bytes，支持 Content-Range；每块和总字节有限制。
3. POST /internal/v2/artifact-stages/{stage}/finalize
   服务端复算 hash/size，事务创建 ProjectArtifact；响应 ArtifactRecord。
4. DELETE /internal/v2/artifact-stages/{stage}
   abort 幂等。

Stage state 为 open、finalized、aborted、expired。upload_url 是同一 internal origin 的相对路径，必须继续携带 Runner service auth 和 lease token，不是公开 pre-signed URL。Content-Range 使用 RFC 9110 inclusive bytes start-end/total；chunk 必须从当前 committed offset 开始。完全相同 offset/hash 的重传返回当前 offset，重叠内容不同或 gap 返回 409 upload_offset_conflict；同一 Stage 只允许一个写者。finalize 在 bytes=expected_size 时可调用，重复 finalize 返回同一 Artifact；abort 重复 204，finalized 后 abort 409。Stage 绑定 project/job/run/generation，过期或旧 lease 409，TTL 默认 1h。未 finalize Blob 在 24h 后 GC。complete 只接受同 Job 已 finalize Artifact。

## 10. Terminal frame wire schema

~~~typescript
type TerminalFrame =
 | {kind:'chunk'; job_id:string; run_id:string; seq:number; stream_seq:number; channel:'stdout'|'stderr'; text:string; byte_offset:number; byte_length:number; lease_generation:number; time:string}
 | {kind:'gap'; job_id:string; run_id:string; seq:number; requested_after:number; retained_from_seq:number; dropped_bytes:number; lease_generation:number; time:string}
 | {kind:'exit'; job_id:string; run_id:string; seq:number; exit_code:number|null; signal:string|null; cancelled:boolean; timed_out:boolean; truncated:boolean; total_bytes:number; dropped_bytes:number; lease_generation:number; time:string}
~~~

POST terminal-frames 接受 {frames: TerminalFrame[]}，1–256 个，总 JSON <= 1 MiB。SSE data 使用完全相同对象。订阅要求 job_log_read。

## 11. TeX 文件操作

- POST /v2/documents/{id}/files：multipart 或 JSON text；path、kind、expected document revision。
- POST /v2/documents/{id}/moves：{from_path,to_path,expected_source_version,expected_document_revision}，单事务插入新 path revision 和旧 path tombstone。
- POST /v2/documents/{id}/assets：multipart binary，要求 document_write，单文件/总量按固定上限。
- PUT/DELETE：document_write；Build：document_read + job_submit。
- 响应统一返回 document_revision、file、active_manifest_id=null（表示需重新 snapshot）。

~~~typescript
type TexFileKind = 'tex'|'bib'|'sty'|'cls'|'image'|'generated'|'other'
interface TexFileRef { path:string; kind:TexFileKind; media_type:string; size_bytes:number; version:number; sha256:string; deleted:false }
interface TexMutationResult { document_id:string; document_revision:number; file:TexFileRef; active_manifest_id:null; etag:string }
interface CreateTexFileInput { path:string; kind:TexFileKind; media_type:'text/x-tex'|'text/x-bibtex'|'text/plain'; content_utf8:string; expected_document_revision:number }
interface SaveTexFileInput { content_utf8:string; expected_version:number; expected_document_revision:number }
interface DeleteTexFileInput { expected_version:number; expected_document_revision:number }
interface MoveTexFileInput { from_path:string; to_path:string; expected_source_version:number; expected_document_revision:number }
type TexEngine = 'pdflatex'
type BibliographyEngine = 'bibtex'|'biber'|'none'
interface TexBuildInput { expected_document_revision:number; root_file:string; engine:TexEngine; bibliography:BibliographyEngine; max_passes:2|3|4; idempotency_key:string }
interface TexDiagnostic { severity:'error'|'warning'|'info'; file:string|null; line:number|null; column:number|null; code:'latex_error'|'undefined_citation'|'missing_file'|'overfull_box'|'shell_escape_denied'|'raw'; message:string; raw:string; pass:number }
interface TexBuildView { build_id:string; document_id:string; input_manifest_id:string; job_id:string; status:JobStatus; engine:TexEngine; bibliography:BibliographyEngine; passes:number; diagnostics:TexDiagnostic[]; pdf_artifact_id:string|null; log_artifact_id:string|null; aux_artifact_ids:string[]; fresh:boolean; started_at:string|null; finished_at:string|null }
~~~

POST files 使用 application/json 的 CreateTexFileInput；PUT/DELETE/moves 使用对应 JSON。POST assets 使用 multipart 字段 path、kind=image|other、expected_document_revision、file，单文件 <=32 MiB。冲突 Error details 固定为 {expected_version,current_version,current_sha256,current_etag}。path 校验失败 invalid_path；不支持媒体 unsupported_media_type；Build root 不存在 tex_root_not_found。Diagnostic message 是安全摘要，raw 是受长度限制的原始一行并只以 text node 显示。

## 12. Analysis 固定算法

Canonical wire 类型：

~~~typescript
interface MetricSpec { name:string; direction:'higher_is_better'|'lower_is_better'; aggregation:'mean'; unit?:string }
interface MetricsFileV1 { schema_version:1; run_id:string; contract_id:string; seed:number; metrics:Array<{name:string; value:number; unit?:string}> }
interface PerRunMetric { run_id:string; seed:number; metric_value:number; code_snapshot_sha256:string; data_hash:string }
interface RunSet {
  run_set_id:string; contract_id:string; method:'baseline'|'treatment'; metric:MetricSpec; runs:PerRunMetric[];
  validation:{seeds_unique:true; min_completed_met:true; same_code_snapshot:true; same_data_hash:true}
}
interface AnalysisPlan {
  analysis_plan_id:string; contract_id:string; metric:MetricSpec; paired_by:'seed';
  baseline_run_set_id:string; treatment_run_set_id:string;
  method:{estimator:'paired_mean_difference'; interval:'bootstrap_95'; resamples:10000};
  multiple_testing:'holm'; minimum_n:number
}
interface PairedAnalysisResult {
  metric:string; direction:'higher_is_better'|'lower_is_better'; baseline_mean:number; treatment_mean:number;
  paired_mean_difference:number; effect_size:number; ci_low:number; ci_high:number; n_pairs:number;
  raw_p_value:number; adjusted_p_value:number; direction_ok:boolean
}
interface AnalysisEvidenceDraft { contract_id:string; analysis_plan_id:string; run_set_ids:[string,string]; artifact_refs:string[]; result:PairedAnalysisResult; provenance_status:'draft_unverified'; generated_by:'analysis-worker'; worker_image_digest:string; generated_at:string }
interface AnalysisOutput { schema_version:1; plan_id:string; result:PairedAnalysisResult; evidence_draft:AnalysisEvidenceDraft }
~~~

MetricsFile 每个 metric name 唯一，value 必须 finite；RunSet 按 seed 升序 canonicalize。PairedAnalysisResult 和 JSON key 顺序严格按接口声明顺序；AnalysisOutput 顺序为 schema_version、plan_id、result、evidence_draft。NaN/Infinity/missing/duplicate 全部拒绝。零差值的 direction_ok=false，raw p=1；Holm ties 按 metric name 升序，adjusted p 单调 step-down 并 cap 1。

AnalysisPlan.minimum_n 必须等于 Contract stop_conditions.min_completed_seeds，不能由调用者降低。Primary 和每个 Secondary metric 各生成独立 AnalysisPlan/AnalysisOutput，之后的多重检验步骤读取同一 Contract version 下全部结果；不得把不同 metric 塞入一个 Result。

- primary estimator：按 Seed 配对的 treatment - baseline；lower_is_better 只影响 direction_ok，不反转保存的原始差值。
- n_pairs >= contract.stop_conditions.min_completed_seeds；重复/missing/non-finite 直接 validation error。
- baseline_mean/treatment_mean/difference 使用 IEEE-754 double，结果 JSON 数值在序列化前保留 12 个有效小数、round-half-to-even；-0 序列化为 0。
- bootstrap resamples 默认且生产固定 10,000；每次对 n 对 difference 有放回抽样并取 mean。
- RNG seed：FNV-1a 32-bit(UTF-8 canonical JSON of plan + ordered run IDs + metric values)，PRNG 为 mulberry32。
- 95% percentile CI：排序 bootstrap means，low index=floor(0.025*(B-1))，high index=ceil(0.975*(B-1))。
- 双侧 p 值：令 B=10000，pLow=(1+count(boot<=0))/(B+1)，pHigh=(1+count(boot>=0))/(B+1)，raw_p=min(1,2*min(pLow,pHigh))；多指标按 metric name 排序后 Holm step-down。
- effect_size 字段为 paired_mean_difference；未来标准化 effect 需新 schema version。
- contract.tolerances 为 metric name -> {absolute?: number, relative?: number}；至少一个非负值。Baseline 和 clean-room pass 取 max(absolute, abs(expected)*relative)。
- 输出 key 顺序固定，时间由调用者提供；golden vector 存 tests/fixtures/analysis-v1.json。

## 13. Runner profile 与镜像锁

生成 configs/runner-profiles/images.lock.json，内容由显式 bootstrap 命令解析一次并提交：

~~~json
{
  "schema_version": 1,
  "node_fixture": "node@sha256:<resolved node:22-alpine digest>",
  "texlive": "<approved TeX Live image>@sha256:<digest>"
}
~~~

缺 digest 时 build 可以生成 lock proposal，但 formal/CI 必须 fail。desktop profile：1 CPU、1 GiB memory、256 pids、/tmp 64 MiB、默认 timeout 60s；latex profile：2 CPU、2 GiB、512 pids、timeout 300s；GPU 合同显式覆盖但仍固定 digest。

Golden fixture 由 evals/golden-path-v2/fixture-repo 和公开小数据组成；规范生成器必须保留 deterministic metrics fixture、3 个 Seed、expected analysis vector 和 TeX fixture。若仓库没有这些文件，acceptance preflight 失败，不得自动下载未知代码。

## 14. Connector 固定接口

~~~typescript
interface SearchOptions { limit: number; from_year?: number; to_year?: number; timeout_ms: number }
interface SourceStatus { source:'openalex'|'crossref'|'arxiv'; status:'ok'|'failed'; error_code?:string; retryable?:boolean }
interface SearchResult { papers:Paper[]; queries:QueryRecord[]; citation_edges:CitationEdge[]; dedup_removed:number; source_status:SourceStatus[] }
~~~

默认 limit 20、timeout 20s、每来源最多 2 次重试（429/5xx/network，指数退避 + jitter），非 retryable 4xx 不重试。单次研究快照只取每源第一页，下一版本才能改变分页策略；这保证 fixture 可复现。parser_version 进入 cache key 和 QueryRecord。

## 15. Orchestrator 运行契约

CLI 参数：--kernel、--token-file、--db、--poll-ms=5000、--owner、--lease-seconds=60、--once、--dry-run。一个 Project Phase Controller 通过 orchestrator_leases(project_id,owner,generation,expires_at) 选主；实验 Job 仍可并行。

Action 包含 action_id、project_id、phase、type、idempotency_key、status、attempt/max_attempts、depends_on、input_refs、output_refs、lease、error、created/updated。执行前 running+lease 事务提交；外部写用 action key；恢复先查询 Kernel projection，对已存在输出标 done，否则 retry。永久 validation/policy 错误 blocked，环境错误有界 retry。

## 16. Outbox envelope

所有事件：{event_id,event_seq,event_version:1,project_id,kind,aggregate_type,aggregate_id,aggregate_revision,source,request_id,session_id?,payload,created_at}。SQLite 单写事务分配 event_seq=max+1，PostgreSQL 使用 sequence；同 aggregate revision 以 event_seq 排序，跨 aggregate 不保证业务因果。消费者以 event_id 去重，失败记录 attempts/last_error/next_attempt_at；超过 20 次设置 dead_lettered_at 并进入 dead-letter projection，但不删除原事件。

## 17. 工具 Schema 生成规则

每个 DSH Tool 直接映射一个 v2 client method。工具 parameters 从相应 Zod input 自动导出 JSON Schema，移除 Human-only、internal、principal 和 provenance override 字段；output 从响应 Schema 导出。tool-schema snapshot 测试覆盖所有注册名。

兼容当前用户面采用名称 claim_verify、analysis_build、release_bundle；目标别名 claim_verify_request、analysis_request、release_bundle_request 可以新增一版 deprecation adapter，但文档、UI 和工具目录必须选择一组 canonical 名并保持一致。v2 canonical 选择后者，旧名保留一版并返回 deprecation metadata。

Canonical Tool registry：

| Tool | Client method / action |
|---|---|
| research_project | action=create/list/get/projection；映射 projects create/list/get/projection |
| research_phase | project transition；to enum 排除 Gate 控制状态 |
| research_gate_request | action=create/list；gate-requests/gates |
| research_budget | action=read/record；budget projection/usage request |
| research_status | project projection |
| literature_search | Connector search，不写 Kernel |
| paper_resolve | Connector resolve |
| corpus_snapshot | Connector search + create corpus snapshot |
| passage_lookup | frozen corpus passage read |
| research_panel | DSH subagents panel，输出仅 draft |
| idea_create / idea_compare / novelty_audit | Idea create/list comparison/novelty route |
| workspace_snapshot | code snapshot create；workspace 必须预登记 |
| patch_apply | registered workspace patch action |
| baseline_prepare / test_run | Job submit with constrained kind |
| baseline_verify | analysis request against Contract tolerance |
| experiment_register | Contract draft create |
| experiment_submit / experiment_status / experiment_cancel | Job create/get/cancel request |
| evidence_note_create | public draft_unverified note route |
| claim_create | Claim draft create |
| claim_verify_request | Claim verification request |
| analysis_request | Analysis Job request |
| manuscript_build | manuscript draft / TexDocument create |
| manuscript_review | manuscript review projection |
| release_bundle_request | release bundle request |

Tool input 不接受 principal、verified/accepted provenance、internal token、host path 或 arbitrary URL。project_id 省略时只允许从当前 Principal session link 唯一解析，否则 project_required。Tool output 为 {ok:true,...route response fields}，错误通过 DSH tool failure 携带稳定 code，不把 ErrorEnvelope 当成功值。

## 18. 可观测性

结构化日志 JSON 字段：time、level、module、instance_id、request_id、project_id?、job_id?、event、duration_ms?、error_code?；不记录 secret/完整 payload。指标至少有 request latency/error、outbox backlog、queued/running jobs、lease expiry、terminal dropped bytes/connections、CAS bytes/orphans、TeX build duration/failure、connector source failure、budget usage。桌面默认只暴露 loopback /internal/metrics；团队 adapter 接 OpenTelemetry。
