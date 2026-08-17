# HTTP、流式事件与错误契约

> 规范性文档。目标接口版本为 v2。新 UI 只能调用 BFF；v1 仅作为迁移 adapter，不得承载新能力。

## 1. 通用协议

- Kernel 默认监听 127.0.0.1，可选 Unix socket；不得直接暴露公网。
- JSON 请求 Content-Type 为 application/json，默认上限 16 MiB；Artifact upload 可单独配置至 32 MiB。
- 成功 JSON 直接返回资源或明确结果对象，不再使用仅有 message 的响应。
- 所有 mutation 接受 X-Request-Id；创建类请求接受 Idempotency-Key。
- BFF 从登录会话解析 Principal，忽略浏览器提交的 actor 或 principal 字段。
- Kernel 内部调用使用短期 Bearer 或 mTLS/Unix identity；Token 使用恒定时间比较。
- `/internal/*` 的 service-token 判定基于解析后的 route class，不基于可被 `%xx` 或重复斜杠改变的原始 pathname；非规范路径不能绕过 service gate。
- 列表统一接受 cursor、limit，limit 默认 50、最大 200；响应为 items、next_cursor。
- 所有 project-scoped 路由先执行 membership/AuthZ，再查资源；跨项目不存在与无权限都返回 404，避免枚举。

## 2. 错误格式

~~~json
{
  "ok": false,
  "error": {
    "code": "revision_conflict",
    "message": "Project revision changed",
    "request_id": "req_xxx",
    "retryable": false,
    "details": {"expected": 3, "actual": 4}
  }
}
~~~

| HTTP | code 示例 | 语义 |
|---:|---|---|
| 400 | invalid_json、invalid_path | 协议无法解析 |
| 401 | unauthorized | 缺失或无效身份 |
| 403 | forbidden、csrf_rejected | 身份有效但不允许 |
| 404 | project_not_found、resource_not_found | 资源不可见或不存在 |
| 409 | revision_conflict、gate_already_decided、lease_stale、document_version_conflict、project_not_archived | 并发或状态冲突 |
| 413 | payload_too_large | 请求或上传超过上限 |
| 422 | validation_error、invalid_transition、container_execution_required | 可解析但违反契约 |
| 429 | rate_limited | 超过限流 |
| 500 | internal_error | 脱敏内部失败 |
| 502 | kernel_unreachable、connector_unavailable | 依赖不可用 |

稳定补充 code：invalid_cursor(400,false)、unsupported_media_type(415,false)、idempotency_conflict(409,false)、upload_offset_conflict(409,true)、artifact_stage_expired(409,false)、document_version_conflict(409,true)、tex_root_not_found(422,false)、lease_conflict/lease_stale(409,true)、job_finished(409,false)、manifest_invalid/signature_invalid(422,false)、project_required(422,false)、fixture_required(422,false)、fixture_image_mismatch(422,false)、fixture_artifact_outside_profile(422,false)、fixture_code_mismatch(422,false)、jobs_running(409,false)、project_not_archived(409,false)、project_delete_confirmation_invalid(422,false)、domain_unsupported(422,false)、idea_corpus_unknown(422,false)、idea_corpus_foreign(422,false)、passage_content_hash_required(422,false)。括号第二项是 retryable；未登记 code 默认 retryable=false。

Zod 错误 details 只返回字段路径和安全消息。上游 5xx、文件系统绝对路径、SQL、环境变量和 Token 不得传到浏览器。

> 错误面形状（如实记录）：**BFF 原生错误**按本节约定 envelope（`ok:false` + `error:{code,message}`，code 取自下表/稳定补充码）；**kernel 代理错误**由 BFF 原样透传 kernel 的 wire envelope（`{error:{code,message,request_id,retryable}}`，reconstruction-contracts.md §error envelope），BFF 不改写上游 body——两种形状客户端均已解析稳定 `error.code`。

## 3. Health 与能力发现

### GET /v2/health

返回 ok、instance_id、protocol_version、schema_version、database_id、capabilities、time。method 和路径必须精确匹配；错误百分号路径返回 400，不能使进程异常。

capabilities 至少包含 terminal_stream、interactive_terminal、workspace_files、tex_workspace、latex_compile、latex_live_preview、remote_runner、config_registry、research_onboarding、trajectory、subagent_topology、signed_manifest、clean_room 和 locales。

## 4. Project 接口

| 方法 | 路径 | 请求/结果 |
|---|---|---|
| POST | /v2/projects | 最小请求 `{name}`；Idempotency-Key + Human Principal；事务返回 DRAFT/collecting project、creator PI membership、budget、active Init Intake；不创建 Gate |
| GET | /v2/projects | 授权项目分页列表 |
| GET | /v2/projects/{id} | Project |
| PATCH | /v2/projects/{id} | name 或允许的配置 + expected_revision |
| POST | /v2/projects/{id}/archive | expected_revision |
| POST | /v2/projects/{id}/unarchive | expected_revision |
| DELETE | /v2/projects/{id} | PI-only；`{expected_revision, confirm_name, reason}`；返回 DeletionReceipt |
| POST | /bff/research/projects/{id}/stop | PI；expected_revision、reason |
| POST | /bff/research/projects/{id}/fail | PI/Policy；expected_revision、reason、failure_class |
| POST | /bff/research/projects/{id}/refine | PI；expected_revision、target phase、reason |
| GET | /v2/projects/{id}/projection | Project、pending gates、jobs、budget、counts、`next_actions`(legacy string[])+ `next_actions_v2`(NextAction[])、capabilities |
| POST | /v2/projects/{id}/transitions | to、expected_revision、reason；Gate 状态永远 422 |
| POST | /v2/projects/{id}/session-links | 只绑定调用 Principal 当前 session_id；客户端不能提交任意会话 |
| GET | /v2/session-links/current | 从调用 Principal 当前 session 返回 project_id |
| GET | /v2/projects/{id}/grill | 当前单个问题、revision、Brief draft、材料候选和 next action |
| POST | /v2/projects/{id}/grill/answers | 每次仅一个 `{question_code,question_revision,value}`，Human assertion |
| POST | /v2/projects/{id}/grill/confirm | PI-only；expected project/intake revisions；写 Brief 并创建唯一 Scope Gate |
| POST | `/bff/research/projects/{id}/chat/turns` | project-scoped 自然语言 turn；读取权威 projection，返回 assistant text、intent/effect、canonical operation/confirmation 状态与最新 `next_actions_v2`；不能直接决定 Human Gate |

Projection 是 UI 摘要，不承载完整日志、Artifact 字节、TeX 内容或大型 Evidence。

Standalone 当前使用两个同源、Bearer + CSRF 保护的本地 BFF route。`POST /api/chat/turn` 接收 `{project_id,text,locale,history}`；BFF 先做 membership 并重读 project projection，再把 allowlist 后的 project context 和最多 12 条有界 history 发给 DSH 插件的 private loopback model bridge。开放对话的模型输出是纯文本流，插件负责封装为 strict `{operation:"conversation",assistant_text}` reply；不得要求模型把自然语言包装成 JSON，也不从模型文本解析或自动执行 mutation/suggested command。该 route 零 Kernel mutation；bridge metadata/credential 必须是共享数据目录中的 `0600` 普通文件，origin 只能是 loopback HTTP，浏览器永远拿不到 endpoint/token。桥接或模型不可用返回稳定 `503 model_unavailable`，客户端退回确定性阶段引导。

`POST /api/chat/ideas` 接收 `{project_id,text,count,locale}`，其中 `count` 为 1–5。BFF 必须重新核对 project membership/写角色、`idea_generate/state=ready/required=true/required_by=agent`、project revision 与最新非空 frozen Corpus Snapshot；随后要求 model bridge 返回数量精确的严格 `IdeaDraft[]`。草稿不得携带 id、project、status、version、timestamp 或 provenance；重复标题、schema 不完整、引用不在该 frozen corpus 的 paper id、模型失败、revision 冲突均不得部分写入。成功后只调用下述 Kernel batch route；它不选择 winner、不批准 Idea Gate。

`POST /api/chat/ideas/select` 接收 `{project_id,idea_id}`，只允许当前项目 PI/operator。BFF 重读 projection 与 IdeaCard 后，用候选 title/hypothesis/exact_delta 派生最多 3 个有界 counter-search query，并调用 Scholar connectors；connector 整体失败时返回 `502 connector_unavailable` 且零写。BFF 将 queries、结果、去重 overlap paper ids、风险和 `audited_at` 发送给 `POST /v2/projects/{project_id}/idea-gate`。Kernel 以 expected project revision + expected idea version 单事务校验 selected proposed idea、同项目 frozen corpus 和唯一 pending Idea Gate，保存 NoveltyAudit、推进 `SURVEYING→IDEATING`、创建 payload `{idea_id}` 的 pending Gate；任一冲突全部回滚。正常流程禁止 payload-less Idea Gate；该 route 不批准 Gate。

### 4.1 DSH plugin internal create/link 与 topology bridge

- `POST /internal/dsh-sessions/{session_id}/projects`：同时要求普通 Kernel bearer、共享 internal service token、仅注入 DSH plugin/kernel 的独立且非空 `x-dsh-plugin-token`，并固定 `x-service-principal: dsh-plugin`；配置缺失、空白、空 header、自报 principal 或被 Runner 持有的共享 service token 均不能单独满足该 route。请求还要求 `Idempotency-Key` 和严格 body `{name}`；session id 使用同一安全 opaque-id 语法。服务端只从 path session 派生 creator Principal，body/client 不能提供或覆盖 Principal/session。internal request hash 必须是以专用 DSH plugin token 为密钥、覆盖固定 route namespace/session/name 的 `HMAC-SHA256`；public v2 name-only adapter 可继续忽略 legacy 额外字段，但公开请求无法构造相同的凭证绑定 hash，任一方向的同 key 跨 route 碰撞都必须 409。创建事务内先核对 idempotency ledger 与原始 `session_links` 行，再原子创建 name-only `DRAFT/collecting` Project、active Init Intake、Budget、PI membership 和 exact session link，返回 `{project,intake,budget,membership,link}`。同 key+同 session/name 重放仅在 project.session、原始 link 和派生 PI membership 全部一致时返回同一资源；不同 hash 或不完整旧状态 409。`x-idempotency-replay-only: 1` 只允许读取同 key 的已提交回执，key 不存在时 404 且绝不创建，供 transport 在 fetch、响应头或成功响应体读取/解析阶段失败、超时或 abort 后对账；客户端超时和 caller abort 必须覆盖完整响应体消费过程。任何既有 session link（包括已删除 Project 的墓碑 link、悬空 link）、并发创建或 relink 竞争均稳定 409 且零新项目，绝不使用 upsert 改绑；public v2 create 不能接受任意 DSH session id。
- `GET /internal/dsh-sessions/{session_id}/project-options`：使用与 create 相同的 Kernel bearer、service token、非空 DSH plugin token 和固定 principal gate；session id 使用同一安全语法。响应只列出由专用 plugin token 派生的稳定操作员具有 membership 的未删除 Project 摘要，可包含 `ARCHIVED` 供 UI 解释但不得扩大绑定能力；不得返回其他 Principal 项目、成员表或 secret。
- `POST /internal/dsh-sessions/{session_id}/project-link`：使用相同四重 gate，严格 body 只有 `{project_id}`。事务内要求项目存在、稳定操作员具有 membership 且项目非 `ARCHIVED`；不存在 link 时 exclusive insert，已是同 pair 时幂等返回，任何不同 link、墓碑/悬空 link 或竞争写稳定 409，绝不 update/upsert 改绑。

- `POST /internal/projects/{project_id}/topology/children`：只接受 service token 与 `x-service-principal: dsh-plugin`；body 的 `session_id` 必须已精确链接 path project，且 `parent_id === session_id`。既有 `child_id` 若属于其他 project/parent 返回 409，终态 re-register 不复活；
- `PATCH /internal/topology/{child_id}/state`：同样要求 service token/service principal，body `session_id` 必须仍等于 child 的 parent 且链接 child project；terminal state 单调，同状态重放幂等，其他 terminal transition 返回 409；
- 百分号编码的 `internal`、重复斜杠或其他非规范等价路径必须与 canonical route 使用相同 service-token gate，不能退化为仅信任可伪造 header；
- public `/v1/.../topology` 仍使用 Human principal + membership 契约，不能用 internal bridge 替代浏览器授权。

Chat turn 请求最小为 `{session_id, turn_id, text}`，`turn_id` 在 project + session 内幂等；path project 是唯一 scope，body 中任何 project/principal/role 均忽略或拒绝。分派顺序为 direct slash、active Grill answer、natural intent。响应为 `{assistant_text, intent:{code,confidence,effect,canonical_command?}, execution:{status:'answered'|'executed'|'confirmation_required'|'blocked',refs:[]}, next_actions_v2}`。没有模型 adapter 时允许返回 phase-aware deterministic answer，但不得把 prose 交给 slash parser。BFF 必须在执行任何 connector/Job/write 前重新校验 membership、role、NextAction/revision 与 idempotency；Human-only intent 始终 `confirmation_required` 并导航专用 Human BFF 页面。

DSH Connection 的 `/dsh-scholar-view` 使用 `trusted-host` authority 且只暴露 `session-workspace`、`session-bind`、`session-create`；loopback-only `/dsh-scholar` 单独承载 settings snapshot/mutation 与显式 Token Clipboard，两个 handler 必须拒绝对方的 endpoint，不能仅靠客户端隐藏。View 请求和响应必须严格拒绝额外字段，不能携带 provider/model/principal/credential、原始日志、prompt 或 transcript；浏览器只提交当前 Host 给出的 session id、显式选择的 project id 或用户输入的 project name。

`DELETE /v2/projects/{id}` 是 Human-only governance 写面，Agent tool/command 不暴露。仅当项目为 `ARCHIVED`、无 active Job 且 revision/精确名称确认匹配时成功；成功后普通 GET/list/projection 和任何项目写入均返回/表现为 404，并保留 tombstone、成员、Decision、Outbox 与受 retention 管理的证据引用。相同 `X-Request-Id` 重放返回同一 `{project_id, deleted_at, deleted_by, revision, request_id}`。迁移期 `/v1/projects/{id}` DELETE 是同一 Kernel 方法的 adapter，不得拥有不同权限或物理清理语义。

成员接口为 GET/POST/PATCH/DELETE /bff/research/projects/{id}/members；角色和最后一个 PI 约束见 reconstruction-contracts.md。standalone 解锁、SSO、DSH Agent session 关联和 service identity 的 Principal 解析也以该文档为准。

POST /v2/projects 的 Idempotency scope 是 tenant_id + principal_id + route + key；同请求 hash 重放返回同一 project/intake/budget/membership，hash 不同 409。Grill confirm 另以 project_id + intake revision + request key 幂等；同一项目最多一个 pending Scope Gate。其余 project mutation 使用 project_id + route + key；Gate Decision 和 cancel 的业务对象本身也提供终态幂等。

## 5. Gate 与身份

### Agent/模块接口

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | /v2/projects/{id}/gate-requests | 创建 pending Gate，不能含 Decision |
| GET | /v2/projects/{id}/gates | 过滤 status/type |
| GET | /v2/projects/{id}/decisions | 审计分页 |

### Human BFF 接口

POST /bff/research/gates/{gate_id}/decision

请求只有 decision、reason、diff、resume_to、expected_project_revision。BFF 注入 Principal 和 request_id；Kernel 在单事务完成目标冻结、Decision、Gate、Project 与 Outbox。Agent Tool 和 DSH command 中不存在此路由的调用器。

浏览器不得直接调用 legacy `POST /v1/gates/{gate_id}/decisions` 并自报 `actor`。迁移期间若 standalone 内部仍把 Human BFF 映射到该 Kernel v1 路由，BFF 必须在转发 body 中写入服务端解析的完整 `principal`；仅注入身份 header 不满足 GOV-01。BFF 保留 Kernel 的稳定 error code，UI 对 `principal_required`、role/member 拒绝、already-decided/state conflict、validation 与 network 分别呈现，不得统一折叠为 bridge failure。Human Gate BFF 自身的鉴权、CSRF、路径、成员/角色、body 校验失败与 Kernel 转发失败也必须统一返回 `error:{code,message,request_id}`；`request_id` 在进入该路由时由服务端生成，不能只在成功完成 Gate/project 预检后才生成。

## 6. Corpus、Idea 与 Contract

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | /v2/projects/{id}/corpus-snapshots | 冻结结构化 Snapshot |
| GET | /v2/projects/{id}/corpus-snapshots | 分页列表 |
| GET | /v2/corpus-snapshots/{id} | 完整快照或分页子资源 |
| POST | /v2/projects/{id}/ideas | Idea Draft |
| POST | /v1/projects/{id}/ideas/batch | standalone Chat canonical idea write；`{expected_project_revision,corpus_snapshot_id,ideas[1..5]}`，要求 SURVEYING + 同项目 frozen corpus，整批事务提交并由 Kernel 附加 identity/provenance |
| GET | /v2/projects/{id}/ideas | 列表 |
| GET | /v2/ideas/{id} | IdeaCard |
| POST | /v2/ideas/{id}/novelty-audits | 查询集与结果，产生新 Idea version |
| POST | /v2/projects/{id}/contracts | Contract Draft |
| GET | /v2/projects/{id}/contracts | 列表 |
| GET | /v2/contracts/{id}/versions/{version} | 指定不可变版本 |

Contract approval 只能由 Gate 事务发生，没有独立 approve 路由。

## 7. Artifact 与 Snapshot

### POST /v2/projects/{id}/artifacts

浏览器/用户上传只接受 <=32 MiB multipart/form-data；更大输入和研究包必须通过 `/v2/intakes` 的受控 staged upload，不能使用 Runner internal stage。服务端计算 SHA-256，不信任客户端 hash。请求 metadata 包含 kind、media_type、file_name 和 provenance。

### POST /v1/projects/{id}/uploads（UPLOAD-01 服务端/BFF 层，已实现）

当前提交实现为 **kernel 原生 multipart 端点 + standalone BFF 原样透传**（v2 artifacts 上传面由 `/v2/intakes` 的 intake staged upload 承接，属 ONBOARD-01，未实现）。standalone 同源直接暴露同一路径（`/v1/projects/{id}/uploads`），multipart 请求经 BFF 以原始字节与原 `multipart/form-data; boundary=…` Content-Type 转发，CSRF/Origin、bearer 与 project membership/role 检查与其它 `/v1` 写完全一致。

请求为 `multipart/form-data`，字段：

| 字段 | 必填 | 说明 |
|---|---|---|
| `kind` | 是 | 固定枚举：code/pdf/data/log/model/chart/paper/analysis/manifest/bundle/tex-source/bib/compile-log/compile-aux（v2 形状：TeX 构建产物用 tex-source/bib/compile-log/compile-aux 而非泛型 log/data）；非法 → 422 `invalid_kind` |
| `file` | 是 | 唯一文件 part（`filename=` 必填）；缺失 → 422 `missing_file`，多于一个文件 part → 422 `multiple_files` |
| `file_name` | 否 | 登记到 ArtifactRecord 的下载名；缺省用 file part 的 filename。必须是单段 basename |
| `media_type` | 否 | RFC 2046；缺省 pdf→`application/pdf`，其余 `application/octet-stream` |

约束与语义：

- **大小**：单文件 ≤ 32 MiB（`ResearchKernel.UPLOAD_MAX_FILE_BYTES`，可覆写）；请求体上限 = 32 MiB + 1 MiB multipart envelope 余量。超限 → 413 `payload_too_large`（流式读取中途即拒，不完整缓冲），错误消息含具体 limit 与实测字节数；
- **hash 绑定**：sha256 由服务端对实际收到的字节计算（stage 时计算、finalize 时复算并核对），客户端无法声明 hash；artifact_id=`sha256:<hex>` 与 CAS blob 一一对应；
- **路径与响应头安全**：`file_name` 拒绝绝对路径（POSIX 与 Windows 盘符）、`..`/`.` 段（两种分隔符）、NUL、C0/DEL 控制字符、路径分隔符和超过 255 UTF-8 bytes 的名称 → 422 `invalid_file_name`；下载响应使用安全 ASCII `filename` + RFC 5987 `filename*`，不得把原始名称直接拼入响应头。重复规范化路径与越界 symlink 属于研究包 archive 语义，由 code-snapshot walk（snapshotCodeArchive/unpackCodeSnapshot）在 archive 面强制；
- **staged → finalize 原子**：先写会话 id 命名的 staged 文件（CAS root 下 `staged-uploads/stage_<id>.part` + `.json` 元数据），finalize 时复算 hash、原子 rename 进 CAS blob 槽并插入 artifact 行；任何失败回滚 staged 文件，绝不留下半成品 artifact 行；
- **幂等**：同 project + sha256 + file_name 重传返回**原 artifact**（HTTP 200，响应体 `reused: true`；新建为 201 `reused: false`），不重复写 blob、不重复插行；同 project 不同 file_name 的同 blob 也返回既有记录（与 `POST /v1/artifacts` 语义一致，首登记名生效）；
- **恢复/GC**：过期 staged 文件由 `kernel.cleanupStagedUploads(maxAgeMs)` 清理（默认 TTL 24h，`ResearchKernel.STAGED_UPLOAD_TTL_MS`），grace-period 模型同 CAS 孤儿 GC；已 finalize 的 blob 永不被该 GC 触碰；
- **协议错误**：非 multipart Content-Type → 415 `unsupported_media_type`；boundary 缺失/畸形或 body 解析失败 → 400 `invalid_multipart`；未知 project → 404 `project_not_found`。

响应体为 ArtifactRecord（同 `POST /v1/artifacts`）附加 `reused: boolean`。浏览器拖拽上传 UI、intake quarantine/scan UI 属浏览器层，待 Playwright 类环境验收（见 hardening-v0.2-status.md §3 UPLOAD-01 行）。

### GET /bff/research/projects/{project_id}/artifacts/{artifact_id}

返回字节流，保留 Content-Type、Content-Length、Content-Disposition、ETag、Accept-Ranges 与 Content-Range。支持单 Range；合法范围返回 206，越界、反向、零长度 suffix 和空文件范围返回 416 + `Content-Range: bytes */N`，不得钳制为其他字节段。HTML、SVG、XML 等主动文档媒体类型强制 `attachment`；仅 PDF 与安全栅格图允许 `inline`。artifact_id 不能脱离 project_id 读取；不提供模糊的全局 artifact GET。

### POST /v1/projects/{id}/code-snapshots（P0-4 SNAPSHOT-01/API-01）

> v2 契约演进目标：POST /v2/projects/{id}/code-snapshots 与 /v2/projects/{id}/tex-snapshots 接受已登记 workspace/document、排除规则与 expected revision。当前实现（v1）已满足本行第一项：**不能接受 Runner 将读取的任意宿主绝对路径**——归档根由服务端从批准的项目 workspace 解析。

请求为 JSON（strict schema——任何未知字段 422 `validation_error`，旧 `{path: <host 绝对路径>}` 形状**已废弃并直接拒绝**，不做静默重解释）：

| 字段 | 必填 | 说明 |
|---|---|---|
| `workspace_id` | 是 | 该项目已登记的磁盘 workspace（`POST /v1/projects/{id}/workspaces` 创建，kind=code/scratch）；跨项目或未知 → 404 `workspace_not_found`（与缺失不可区分，无跨项目枚举） |
| `root_relative_path` | 否 | 相对 workspace 根的 POSIX 路径，缺省/`''` = 整个 workspace；拒绝绝对路径、`..`/`.` 段、NUL、盘符、反斜杠与空段 → 422 `invalid_path`（复用 `normalizeWorkspacePath`）；尾斜杠裁剪后接受 |
| `description` | 否 | 归档描述 |

语义与约束：

- **根解析**：服务端从批准的项目 workspace 解析实际根（`dataDir/workspaces/{project_id}/{workspace_id}/`），并对解析结果做 realpath 容器校验——workspace 目录或子根被 symlink 替换指向 workspaces 区外 → 422 `snapshot_path_escape`；
- **walk 安全**：拒绝任何逃逸出归档根的 symlink（422 `snapshot_path_escape`，根内 symlink 跟随）；`.git`/`node_modules`/`.research-cas` 目录排除；
- **资源上限**：`SNAPSHOT_MAX_FILES`/`SNAPSHOT_MAX_FILE_BYTES`/`SNAPSHOT_MAX_TOTAL_BYTES` 保留（单文件超限在 stat 即拒、累计超限提前失败，均 422 `snapshot_too_large`）；
- **secret 文件不可快照**：匹配已知 secret 模式（`.env`/`.env.*`、`*_token`/`*-token`/`*.secret`/`*.password`/`*.credential*`、`*.key`/`*.pem`、`id_rsa`/`id_ecdsa`/`id_ed25519`/`id_dsa`、`.aws/credentials`、`service-token`/`kernel-token`、`.npmrc`/`.pypirc`/`.netrc`/`.htpasswd`）的文件**拒绝整个快照**并列出全部文件名（422 `snapshot_secret_file`）——fail closed，CAS/Artifact/manifest 零写；
- **溯源与泄漏**：响应 201 为 CodeSnapshot（`snapshot_id`、`archive_artifact_id`、`manifest_artifact_id`、`files`、`total_bytes`、`sha256`…），`path`/archive/manifest `root` 恒为显示占位符 `~`；宿主路径零泄漏；registry `code_snapshots.source_json` 记录 `workspace_id` + `root_relative_path` 溯源。

Runner/Worker 输出不能走浏览器上传。内部 artifact stage、分块上传、finalize 和 abort 的精确四步接口见 reconstruction-contracts.md；finalize 后才能把 Artifact ref 交给 complete。

## 8. Job 与 Runner 内部接口

| 方法 | 路径 | 调用者 | 说明 |
|---|---|---|---|
| POST | /v2/projects/{id}/jobs | Agent/Operator | 校验 JobSpec 和 Idempotency-Key |
| GET | /v2/projects/{id}/jobs | UI/Agent | 分页筛选 |
| GET | /v2/jobs/{id} | 授权用户 | 任务、lease 摘要、Manifest |
| POST | /bff/research/jobs/{id}/cancel | 人类 | reason；幂等取消 |
| POST | /internal/v2/jobs/claim | Runner | owner、limit、lease_ttl；返回 fenced jobs |
| POST | /internal/v2/jobs/{id}/heartbeat | Runner | owner、generation、token |
| POST | /internal/v2/jobs/{id}/terminal-frames | Runner | {frames:[TerminalFrame]}，1–256 个且 <=1 MiB |
| POST | /internal/v2/jobs/{id}/complete | Runner | signed RunManifest 与 Artifact refs |
| POST | /internal/v2/jobs/{id}/cancelled | Runner | 进程已停止的确认 |
| POST | /internal/v2/runner-keys | Runner admin | Ed25519 public key 注册和轮换 |
| POST | /internal/v2/recover/leases | Orchestrator | 过期 lease 恢复 |

internal 请求使用 Runner service bearer/mTLS，再叠加 Job owner、generation 和 token。complete 必须校验 Manifest signature、Job/Project/Contract、快照、镜像、Artifact 所有权。任何失败都不得部分写入 succeeded。精确 wire 类型和算法见 reconstruction-contracts.md。

## 9. Terminal SSE

### GET /bff/research/jobs/{job_id}/terminal?after_seq=N&channel=all

响应 Content-Type 为 text/event-stream，Cache-Control 为 no-store，禁用代理缓冲。BFF 在连接前同时检查 project membership 和 job_log_read；连接建立后身份失效或权限撤销时关闭。

事件类型：

~~~text
event: subscribed
data: {"run_id":"run_x","last_seq":41,"retained_from_seq":1}

event: chunk
data: {"kind":"chunk","job_id":"job_x","run_id":"run_x","seq":42,"stream_seq":21,"channel":"stdout","text":"...","byte_offset":8192,"byte_length":128,"lease_generation":3,"time":"..."}

event: gap
data: {"kind":"gap","job_id":"job_x","run_id":"run_x","seq":43,"requested_after":10,"retained_from_seq":30,"dropped_bytes":2048,"lease_generation":3,"time":"..."}

event: exit
data: {"kind":"exit","job_id":"job_x","run_id":"run_x","seq":99,"exit_code":0,"signal":null,"cancelled":false,"timed_out":false,"truncated":false,"total_bytes":16384,"dropped_bytes":0,"lease_generation":3,"time":"..."}
~~~

规则：

- seq 在单次 run 内连续；客户端按 seq 去重，高序号覆盖低序号投影；
- after_seq 缺省时返回保留窗口快照后继续实时流；
- requested seq 已淘汰时必须先发 gap，不能假装完整；
- stdout/stderr 分开持久，channel=all 按全局 seq 合并；
- 服务端有界队列，背压导致删除时持久化 dropped_bytes 并发 gap；
- SSE 心跳使用注释帧，不能伪造 terminal heartbeat；
- exit 是权威终态并永久可重放；最终日志 Artifact 可另行下载。

## 10. Analysis、Evidence 与 Claim

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | /v2/projects/{id}/analysis-requests | 创建 analysis Job，不直接返回正式结果 |
| GET | /v2/projects/{id}/evidence | 分页 |
| POST | /v2/projects/{id}/evidence-notes | 只创建 draft_unverified |
| POST | /internal/v2/projects/{id}/evidence | Analysis Worker 服务身份写 verified |
| POST | /internal/v2/evidence/{id}/accept | Verifier/Auditor 状态转换 |
| POST | /v2/projects/{id}/claims | Claim Draft |
| POST | /v2/claims/{id}/verification-requests | 触发确定性校验 |
| GET | /v2/projects/{id}/claims | 分页和状态过滤 |

公开 HTTP payload 不能自行提交 provenance_status=verified 或 accepted。Claim 验证只读取 accepted Evidence。

## 11. Manuscript 与 TeX Workspace

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | /v2/projects/{id}/documents | 从稿件模板或现有稿件创建 TexDocument |
| GET | /v2/projects/{id}/documents | 文档列表 |
| GET | /v2/documents/{id}/tree | 文件树和每个 version/hash |
| GET | /v2/documents/{id}/files/{path} | text 或 binary；返回 ETag/version |
| PUT | /v2/documents/{id}/files/{path} | content、expected_version；原子保存 |
| POST | /v2/documents/{id}/files | 新建文件，create-if-absent |
| DELETE | /v2/documents/{id}/files/{path} | expected_version；生成 tombstone revision |
| POST | /v2/documents/{id}/moves | from_path、to_path、source/file version；原子 rename |
| POST | /v2/documents/{id}/assets | multipart binary asset upload |
| GET | /v2/documents/{id}/history | 文件和 workspace revision |
| POST | /v2/documents/{id}/snapshots | 冻结当前 manifest（含可物化字节，TEX-01） |
| GET | /v2/documents/{id}/snapshot-files | 冻结 revision 的单文件字节；?revision=&path=（当前实现 /v1/documents/{id}/snapshot-files，TEX-01 构建输入） |
| POST | /v2/documents/{id}/builds | 冻结 manifest 并创建 latex-compile Job（权威 Compile） |
| GET | /v2/documents/{id}/builds | 构建历史（仅权威 build；每条带 preview=false 与 stale 字段） |
| GET | /v2/builds/{id} | 状态、diagnostics、Artifact refs、freshness、preview/stale/superseded 字段 |
| POST | /v1/documents/{id}/preview-builds | 保存成功后调用：server 端 debounce（默认 800ms，body debounce_ms 可配置）创建 preview build（TEX-03，§12.1） |
| GET | /v1/documents/{id}/preview-builds | preview 投影：`{ pending, builds }`（pending=待处理 debounce，builds 每条 preview=true + stale + superseded_by/at） |
| GET | /v1/projects/{id}/manuscript-drafts | 只读打开（P0-3 TEX-01）：返回现有 workspace `{document_id, revision, files, created, regenerated}`；无内容时 404 `manuscript_not_found`，绝不建行/写字节 |
| POST | /v1/projects/{id}/manuscript-drafts | 创建/确保（P0-3）：默认只在首次创建时生成（文档已有文件即原样返回 created=false，不重写字节、revision 不变）；body `regenerate: true` 显式重写且生成前把当前内容冻结为历史 revision（旧字节 `GET snapshot-files?revision=&path=` 可回退）。目标 v2 面同语义（当前实现 /v1，与 snapshot-files 同款注记） |
| GET | /v2/projects/{id}/manuscript-review | 确定性检查 |

path 使用编码后的根相对 POSIX 路径，逐段 decode 后校验。保存冲突返回 409 document_version_conflict，不自动 last-write-wins。文本默认 UTF-8，保留原换行风格或在 metadata 中明确规范化。

文件读需要 document_read，保存/新建/删除/move/asset 需要 document_write，Build 需要 document_read + job_submit。精确 ETag、move 和 multipart 上限见 reconstruction-contracts.md。

Build 请求：

~~~json
{
  "expected_document_revision": 7,
  "root_file": "paper.tex",
  "engine": "pdflatex",
  "bibliography": "bibtex",
  "max_passes": 4,
  "idempotency_key": "latex:doc_x:rev7:pdflatex"
}
~~~

Build 提交（POST builds）在冻结与提交两处执行 document-revision CAS：expected_document_revision 过期或提交时 document revision 已前进 → 409 document_version_conflict，不创建 Job、不创建 build 行（保存冲突立即终止编译）。201 响应为 `{ build, job }`，其中 build.job_id、build.revision（输入 revision）与 job 供 UI 接入同一 Job 的 live Terminal（SSE GET /v1/jobs/{job_id}/terminal）与 stale PDF 判定（build.revision < document.revision）。

构建字节是冻结 revision 的可物化字节（TEX-01）：POST snapshots / POST builds 冻结时把每文件 content+hash 存入 snapshot store；Runner 通过 GET snapshot-files?revision=&path= 取该 revision 的字节并逐文件校验 manifest hash，绝不后取当前文件。snapshot-files 对未知 revision/path 返回 404、参数缺失/非法返回 422；Runner 对不可读或 hash 不匹配一律硬失败，不降级为当前文件。

构建日志通过同一 Terminal SSE 读取。Build 完成返回结构化 diagnostics、PDF、完整 log、aux/bbl/blg/fls 和输入 manifest。Artifact PDF 必须为 application/pdf。

### 11.1 实时 Preview（TEX-03）

保存事务成功后调用 `POST /v1/documents/{id}/preview-builds`（body 可选 `debounce_ms`/`root_file`/`engine`，engine 必须在固定白名单内否则 422 engine_invalid），返回 `{ pending: { document_id, revision, root_file, engine, debounce_ms, requested_at } }`。Kernel 持有 debounce 定时器（默认 800ms，KernelOptions.previewDebounceMs 或请求体可配置）并写持久化 `tex_preview_pending`；到期后冻结**当前** revision、复用 latex-compile runner 路径（同一固定 texlive image/禁网/no-shell-escape）提交 `payload.preview=true` 的作业并创建 `preview=true` 的 tex_builds 行。preview build 状态机：queued→running（claim 时同步）→succeeded/failed，或 queued→cancelled、running→superseded（新 revision preview 或权威 Compile 到达时，带 superseded_by/superseded_at，job 尽力取消）；终态不被改写。preview 不产 accepted Evidence、不参与权威 manifest 链；活跃权威 latex-compile（queued/running）存在时 preview flush 跳过。每条 build 记录（GET builds、GET builds/{id}、GET preview-builds）携带 `preview`、`stale`（build.revision < document.revision）与 `superseded_by`/`superseded_at`；GET preview-builds 的 `pending` 字段让 UI 重连/内核重启后可恢复 debounce 状态。显式 POST builds（权威 Compile）冻结自身 manifest 并 supersede 该 document 全部非终态 preview。

## 12. Release

POST /v2/projects/{id}/release-bundle-requests 创建 bundle/clean-room Job；GET /v2/projects/{id}/release-bundles 读取状态和私有下载；POST /bff/research/gates/{release_gate}/decision 才能决定 release。系统不提供自动提交外部平台的接口。

## 13. BFF 规则

- standalone 使用同源 Cookie/SSO，或使用 0600 文件生成的本地 bearer 解锁，并映射为本地 Human Principal；mutation 强制 Origin 和 CSRF token；
- DSH Session 只用于 Agent tool/command 的会话关联，不作为浏览器 Human Principal；
- BFF route 是 target-aware adapter，不能做无身份透明转发；
- 二进制和 SSE 必须真正流式传输，不能先调用 text() 或完整缓冲；
- 默认每 IP 60 请求每分钟，Terminal 长连接单独限制每用户和项目连接数；
- 浏览器永远看不到 Kernel 内部 Token。

standalone 同源直接暴露 `/v1`、`/v2`（当前 BFF 面；v2 = BFF adapter surface）并代理 kernel；`/bff/research/*` 为 v2 目标路径前缀（§16/§19/§20 中标注"剩余项"的写面落地时使用），当前未注册字面路由。`/research-api` 与 `/research-ui-api` 不存在，不得作为兼容别名恢复。

## 14. v1 兼容

迁移期间允许单独的 v1 adapter 支持现有只读投影和 Artifact 下载。新 UI、Terminal、TeX、Human Principal、accepted Evidence 与 Release 必须只走 v2。v1 write 默认关闭，任何开启都只能用于 fixture profile 并带明显审计标记。

## 15. Locale 与错误文案

zh/en 字典随 dsh-research-ui client bundle 发布，不由 Kernel 动态返回。health.capabilities.locales 返回 ['zh','en'] 和 locale_contract_revision。Kernel/BFF 返回稳定 error.code 和不含 secret 的英文诊断 message；UI 可翻译已知 code 的 chrome，但 details、论文、Terminal 和 TeX raw message 保持原文。Accept-Language 不得改变业务计算、hash、排序或持久化内容。

## 16. Research Onboarding、Upload 与 Grill Me

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/v2/intakes` | Human/Agent request；begin，Idempotency-Key |
| GET | `/v2/intakes` | 当前 Principal 的可见 Intake 分页 |
| GET | `/v2/intakes/{id}` | 状态、upload/scan、questions、proposal、安全 refs |
| POST | `/v2/intakes/{id}/artifact-stages` | 创建 intake-scoped staged upload |
| GET | `/v2/intakes/{id}/artifact-stages` | 列出开放/完成 stage、committed offset、expiry 与文件队列状态 |
| PUT | `/v2/intake-artifact-stages/{stage}/content` | Content-Range 分块/幂等重传 |
| POST | `/v2/intake-artifact-stages/{stage}/finalize` | 复算 hash/size，进入 scanning |
| DELETE | `/v2/intake-artifact-stages/{stage}` | abort，幂等 |
| POST | `/v2/intakes/{id}/scan` | 启动/重用静态扫描结果 |
| POST | `/v2/intakes/{id}/grill-answers` | 每次一个 Human assertion + question revision；返回 next question |
| POST | `/v2/intakes/{id}/ocr-requests` | 显式 provider/model ID 的异步 OCR；Idempotency-Key |
| GET | `/v2/intakes/{id}/ocr-requests/{request}` | OCR 状态、安全错误、结果 refs 与来源/confidence |
| POST | `/v2/intakes/{id}/proposals` | 生成确定性阶段/映射 proposal |
| POST | `/bff/research/intakes/{id}/accept` | PI Human adoption；expected proposal/target revision |
| POST | `/bff/research/intakes/{id}/reject` | Human reject/cleanup request |

`accept` 只存在于 BFF Human 面；Agent tool schema 不生成该方法。scan/parser/LLM 永远不能直接 mutation Project。单文件 Artifact 上传与 research package intake 是两个明确入口，UI 不得把 internal Runner stage 暴露给用户。状态、映射、错误和幂等见 research-onboarding.md。

兼容基线仍包括 v1 项目域 begin/list/resume、≤32 MiB multipart、scan/questions/answers/propose/adopt/reject。v2 name-only Grill 与批量分块 stage 已实现；Provider Registry、MinerU 配置与项目 binding 使用当前 v1 adapter。上表 OCR request 是目标契约，当前未注册 route/worker/provenance，状态必须是“未实现”，不能仅记为真实服务 `NOT_RUN_MANUAL_PENDING`。

## 17. 通用 Workspace 与 Upload

| 方法 | 路径 | 说明 |
|---|---|---|
| POST/GET | `/v2/projects/{id}/workspaces` | 创建/列出 code、manuscript、scratch workspace |
| GET | `/v2/workspaces/{id}/tree` | 当前 revision 文件树 |
| GET/PUT/DELETE | `/v2/workspaces/{id}/files/{path}` | bytes/text 读取；版本化写/删 |
| POST | `/v2/workspaces/{id}/files` | create-if-absent text |
| POST | `/v2/workspaces/{id}/assets` | multipart binary upload <=32 MiB |
| POST | `/v2/workspaces/{id}/moves` | 原子 move/rename |
| GET | `/v2/workspaces/{id}/history` | 文件/workspace revision |
| POST | `/v2/workspaces/{id}/search` | 有界全文/路径搜索 |
| GET | `/bff/research/workspaces/{id}/events?after_seq=N` | watch subscribed/change/gap |
| POST | `/v2/workspaces/{id}/snapshots` | 冻结 archive + manifest |

所有 path、ETag、Revision 和 multipart 行为以 reconstruction-contracts.md 为准。TeX Document route 是绑定 manuscript workspace subtree 的领域 facade，不能维护第二套文件存储。

迁移期 v1 generic Workspace 路径 `/v1/projects/{project}/workspaces/{workspace}/nodes?path=...` 与 v2 files 路径必须投影相同 authority。对于 `ws_doc_*` manuscript facade，list/tree/read/readVersion/write/move/delete/search/watch 均转到 TeX store；tree 返回节点后，同一节点 read 不得因 generic store 无 workspace row 返回 404。wire node 大小字段统一为 `size`，客户端对缺失/非有限值显示 `0 B`。

**search 参数契约（POST `/v1/projects/{id}/workspaces/{wid}/search`，commit 98243ff）**：同一端点双模式，strict body——
- 路径搜索（legacy，不变）：`{prefix?, glob?}`（至少其一，AND；`*` 不跨 `/`）；响应 `{info, nodes}`；
- 内容搜索：`{q, mode?: 'content', case_sensitive?: boolean}`（`q` 出现或 `mode='content'` 即内容模式；`mode` 缺省时 `q` 出现即为内容）。响应 `{info, hits: [{path, match_count, matches: [{line, snippet}]}], truncated}`——`line` 为 1-based 行号，`snippet` 为所在行（超 240 字符以 `…` 居中截断），`match_count` 为该文件真实匹配总数，`matches` 最多返回前 20 个，`truncated` 表示 50 文件上限截断。语义：只扫文本节点（`binary=0` 且 media 文本类，NUL magic 硬跳过）；>512 KiB 文件整文件跳过（绝不部分扫描）；大小写不敏感默认；非法 UTF-8 字节按替换符容错（不抛错）。参数校验：空/纯空白 `q` → 422 `invalid_query`；`q` 与 `prefix`/`glob` 混用或 `mode='path'` 携带 `q` → 422 `invalid_search_params`。**无全文索引**——线性扫描，大数据集性能受限（如实记录，索引属后续增强）；并发搜索有简单槽位上限（超限 429 `search_busy`）。内容搜索与路径搜索同受 workspace 钉定与隔离语义约束（跨项目 404、隔离 503）。

**崩溃恢复语义（WORK-01 §5 P2，hardening §5 行，storage-migrations.md §10.1）**：kernel 启动与按需 `scanWorkspaceIntegrity()` 恢复扫描会把磁盘字节与 `workspace_nodes`/`workspace_ops` 收敛——可证修复（rename-before-row 前滚、CAS/历史恢复、孤儿回滚等）静默完成；不可证修复把 workspace 标记隔离，此后该 workspace 的全部路由（tree/nodes/assets/moves/history/search/events/snapshots/blob）返回 **503 `workspace_inconsistent`**，直到字节恢复后下一次扫描干净收敛自动解除。

## 18. Interactive Terminal

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/POST | `/bff/research/projects/{id}/pty-sessions` | 按 context 列出/open；workspace/profile/target/preset/cwd/size/config revision；server-derived session binding |
| GET | `/bff/research/pty-sessions/{id}` | state 和权限摘要 |
| GET | `/bff/research/pty-sessions/{id}/events?after_seq=N` | SSE fallback：data/gap/state/exit |
| GET | `/bff/research/pty-sessions/{id}/socket` | authenticated WebSocket 双向 attach |
| POST | `/bff/research/pty-sessions/{id}/input` | SSE fallback input bytes + client_seq |
| POST | `/bff/research/pty-sessions/{id}/resize` | cols/rows + client_seq |
| POST | `/bff/research/pty-sessions/{id}/signals` | allowlisted INT/TERM/KILL |
| DELETE | `/bff/research/pty-sessions/{id}` | close，幂等 |

open/list 接受 context_kind 与可验证 context ref，但 BFF/Kernel 必须从当前 Operator/Research/Chat/Subagent 地址解析 project/owner/parent，不能信任任意客户端 child/session ID。attach/detach/input/resize/signal/control 与 SSE subscribed/frame/state 均携带 generation；stale generation、lease expired 或 context 越权 fail closed。一个 context 可有多个 PTY，list 返回可恢复标签集合与 active_hint。

Run Terminal `/jobs/{id}/terminal` 保持只读且永远不接受 input。PTY 每个 control 操作执行 Project AuthZ、terminal_write、generation/client_seq 和 target policy；revoke 关闭连接。浏览器不能提交 SSH endpoint/credential、Docker socket、host path 或任意 argv。

## 19. Runner Target、Profile 与 Config

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/runner-targets`、`/bff/research/runner-targets` | 可见 target kind/health/capability/config hash 与 SecretRef availability，不返回 endpoint/credential 值 |
| POST `/v1/runner-targets`；PATCH `/v1/runner-targets/{id}` | PI/Operator 登记、drain、disable；BFF 与 Kernel 都从权威项目成员表实时求得 PI/Operator，忽略调用方自报 role，不能把任意登录 principal 升格；生产 Kernel 同时要求 service token；revision CAS；`remote-ssh` 必须提供 endpoint/credential/known_hosts 三个 SecretRef |
| PATCH | `/v2/projects/{id}/execution` | PI/Operator 以 `{expected_revision, runner_target_id}` CAS 保存项目默认 Target；服务端按 Target kind 同步兼容的内置 RunnerProfile，未知/禁用/排空目标拒绝 |
| GET/POST/PATCH | `/bff/research/runner-profiles` | profile、资源/网络/image policy；revision CAS |
| GET | `/bff/research/config/schema` | canonical schema/UI metadata |
| GET | `/bff/research/config/effective` | scope filters + value/source/revision/hash |
| PATCH | `/bff/research/config/{scope}/{scope_id}` | expected revision；secret 只接受 SecretRef |
| POST | `/bff/research/config/{scope}/{scope_id}/reset` | reset field/section to inherited default |
| GET | `/bff/research/config/revisions/{id}` | redacted provenance/audit |
| GET/POST | `/bff/research/model-providers` | global Provider 列表/创建；PI/Operator；SecretRef metadata only |
| PATCH | `/bff/research/model-providers/{id}` | revision CAS；编辑、启停、能力/模型目录；不接受 secret value |
| GET/PATCH | `/bff/research/projects/{id}/model-bindings` | 项目只选择 purpose/provider_id/model_id；revision CAS |

当前兼容面使用 `/v1/providers*` 与 `/v1/projects/{id}/model-binding`。OCR-CONFIG-01 的首个内置 descriptor 为 `provider_id=mineru`、`kind=mineru`、默认 `base_url=https://mineru.net/api/v4`，模型目录固定为 `flash/pipeline/vlm`；credential 可省略（MinerU Flash）或为严格 SecretRef（精准模式），任何明文 token/value/password 继续拒绝。此处只定义 Provider/Binding 配置面；`/v2/intakes/{id}/ocr-requests` 在 worker 与 provenance 未落地前仍是目标路由，不得从配置成功推断 OCR 已执行。

Remote Agent internal 面提供 enroll/heartbeat/capability/claim/CAS fetch/stage/complete；全部使用 mTLS service identity 与 ExecutionPlan signature。任何 target/profile/config 修改只影响新动作，不能改变运行中 Job/PTY/Build 的 pinned hash。

Experiment/Job/Reproduction public body 只接受 `runner_profile_id` 与 `runner_target_id`。Settings 当前项目选择器写 `/v2/projects/{id}/execution` 作为默认值；Chat `/run` 与 `/reproduce` JSON 中的 `runner_target_id` 作为 Job 顶层字段发送，优先级为 Job > Project。Target Registry 的 local-docker/remote-ssh endpoint、known-hosts、SSH/mTLS credential 由 Settings + SecretRef 管理；提交时固定 profile/target/environment revision/hash。claim 可由服务端 `runner_target_kinds` 过滤，runner/adapter 仍须执行前二次校验；offline/draining/capability mismatch 返回 blocked/retryable，不做 implicit local fallback。

## 19.1 论文复现

| 方法 | 路径 | 说明 |
|---|---|---|
| POST/GET | `/v2/projects/{project}/reproduction-specs` | 创建/分页列出 PaperReproductionSpec；Idempotency-Key |
| GET/PATCH | `/v2/projects/{project}/reproduction-specs/{spec}` | projection/revision CAS 更新 |
| POST | `/v2/projects/{project}/reproduction-specs/{spec}/attempts` | 固定 Contract/Code/Data/Environment 并提交 attempt |
| GET | `/v2/projects/{project}/reproduction-attempts/{attempt}` | attempt、Job/Run、pins、NextAction |
| POST | `/internal/reproduction-attempts/{attempt}/reports` | verifier service identity 写不可变报告 |
| GET | `/v2/projects/{project}/reproduction-reports/{report}` | 安全报告 metadata/Artifact refs |

精确 schema、metric/table/figure/PDF 比较和错误语义见 `reproduction-contracts.md`。Chat `/reproduce` 是这些接口的 adapter，不直接构造 Evidence/Report。

## 20. Trajectory 与 Subagent Topology

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/bff/research/projects/{project}/trajectories` | Research/Session roots，cursor/source/status |
| GET | `/bff/research/trajectories/{id}/nodes` | parent_id 的 direct children，懒加载 |
| GET | `/bff/research/trajectories/{id}/nodes/{node}/history` | message-aligned 安全 history；不激活 Agent |
| GET | `/bff/research/trajectories/{id}/events?after_seq=N` | subscribed/event/gap SSE |
| POST | `/bff/research/trajectories/{id}/nodes/{child}/followups` | exact parent + continuable + capability |

每个全局 trajectory/node ID 先解析 project，再做 summary/detail/continue AuthZ。history 默认 safe summary；raw tool args/results/prompt/env 不得透明透传。地址、事件、token/duration、retention 和 DSH 移植边界见 trajectory-subagents.md。

Standalone v1 adapter 兼容面（当前 Scholar UI 使用）包括 `/v1/projects/{project}/trajectory`、`/trajectory-lanes`、`/topology`、`/topology/children` 与 `/v1/topology/{child}*`。BFF 必须对上述全部路由执行成员预检，并从服务端 operator session 注入 `x-principal-id`；客户端同名 header 不可信、不得透传。Kernel 继续 fail-closed：缺 principal=`422 principal_required`，非成员/未知 project 或 child=`404`。轮询 JSON 与 SSE 的身份转发不得分叉。

## 21. NextAction 兼容

`GET /v1/projects/{id}/projection`（v2 同路由）返回双字段（GUIDE-01）：`next_actions: string[]`（legacy，由 `next_actions_v2` 中非 done 动作的 label 稳定派生，终态为空数组——旧 UI/API 消费端不受破坏）与 `next_actions_v2: NextAction[]`（权威结构化投影，wire 字段见 reconstruction-contracts.md §24 / domain-model.md §14）。

NextAction 由 Kernel 从 project status、pending gates、jobs、budget、contracts、ideas、evidence、claims 确定性生成（`nextActionProjection` 纯函数，无 DB、无副作用、不抛错）。状态、reason、required 缺口、revision、capability 和 target route 都由 Kernel 产生；UI 只负责翻译 label、解析白名单交互与路由，不能直接执行未声明 mutation。未知/未来状态退化 `code='unknown'` 的只读动作（state=blocked、required=['state_mapping']），UI 不得为 unknown 构造 mutation。`required` 是前置条件，`required_by` 才是执行者。Intake/Grill 阶段动作在 ONBOARD-01 落地后由同一投影扩展。

Contract 批准后的 baseline handoff 使用专用 `POST /v1/projects/{id}/baseline-runs`，不允许浏览器用“先 POST Job、再 POST transition”的两步写法。请求严格为 `{expected_revision,idempotency_key,contract_id,code_snapshot_id,command:string[],runner_target_id?,image_digest?,output_contract?}`；`command` 至少一个非空 argv，CodeSnapshot 必须属于 path project，Contract 必须已由 Human Gate 冻结且属于同项目。Kernel 以项目默认 Runner/Profile/target 为基础解析环境；显式 override 仍走同一 registered target 与 digest pin 校验。成功 `201` 返回 `{project,job}`，Job 为 queued 且 Project 为 `BASELINE_REPRO`；任何失败零半写。相同 project + idempotency key + 相同请求可重放，异请求必须 409。

`GET /v1/projects/{id}/code-snapshots` 只列出该项目的不可变快照摘要，供运行准备任务选择；不得返回宿主绝对路径或跨项目记录。`POST .../code-snapshots` 仍是从批准 Workspace 冻结实际内容的唯一创建路径。

当 projection 为 `CONTRACT_APPROVED`、baseline Jobs 为空时，`next_actions_v2` 必须包含 `baseline_reproduce`，并通过 `required` 精确报告 `baseline_command`、`code_snapshot`、`runner_environment` 缺口。Runs UI 将其显示为 projected preparation task，但 `jobs.length` 与各 Job filter count 保持 0；不得用假 queued Job 填充列表。

合同阶段使用 `POST /api/chat/contracts/draft {project_id}`。BFF 仅在 Kernel projection 声明 `contract_register/ready/required=true` 时读取唯一 approved IdeaCard，从其 MVE 生成严格 ExperimentContract 输入，再调用 PI/operator-only `POST /v2/projects/{project_id}/contract-gate`；Kernel 输入钉定 expected_project_revision、idea_id、expected_idea_version 和 contract body，在单事务校验 Idea Gate 结果、登记 draft Contract、`IDEA_APPROVED→CONTRACT_PENDING`（若已在 CONTRACT_PENDING 则保持）、创建唯一 payload-bound pending Contract Gate。响应返回 contract/project/gate；跨项目、无 approved idea、已有 pending Contract Gate、revision 冲突或 schema 错误均零部分写。浏览器不得自行串联 register/transition/create-gate 三个写请求。

`survey_run` 固定 `route='chat'`、`required_by='agent'`。Overview CTA 打开当前 project-scoped Chat 并预填 `/survey <Brief.problem>`（Brief problem 为空时预填 `/survey `），等待用户确认发送；不得跳转空 Runs、不得自动发起 connector 请求。`POST /api/chat/survey` 成功写入 SCOPED 项目的 Corpus Snapshot 时，同一 Kernel 事务完成 `SCOPED→SURVEYING`，响应后 projection 必须给出 `idea_generate`；citation edges 必须随 snapshot 保存，connector 每源结果必须聚合为权威 `source_status`（任一来源失败=`pending`，全部成功=`complete`），部分失败不得伪装成 complete。

## 22. SSE 实时流端点（增量流替代轮询）

三个 v1 stream 端点与 §9 Terminal SSE 同模式（Content-Type `text/event-stream`、`Cache-Control: no-store`、`x-accel-buffering: no`、连接前完成鉴权——错误以 JSON 返回、绝不半开 SSE；`after_seq`/`after_revision` 重放、live 尾随、命名 `heartbeat` 事件（服务端周期发送，`data: {"time": …}`，客户端不得伪造/依赖其语义）。服务端以 ~200ms 轮询**既有轮询数据源**（pty frames store / workspace op-ledger listSince / trajectory outbox 投影）并推送增量——stream 与 poll 读同一份数据，永不漂移。轮询端点全部保留（向后兼容），客户端自行选择流或轮询。

### GET /v1/pty/sessions/{id}/frames/stream?after_seq=N

PTY-01 帧流（对应轮询 `GET /v1/pty/sessions/{id}/frames?after_seq=`）。鉴权与轮询 frames 完全一致（fail-closed）：缺 `x-principal-id` → 422 `principal_required`、非 owner → 403 `pty_principal_mismatch`、未知会话 → 404 `pty_session_not_found`、`after_seq` 非法 → 422 `pty_after_seq_invalid`；可选 `x-pty-lease` 出现即必须有效（错误 → 403 `lease_invalid`）。事件：

~~~text
event: subscribed
data: {"session_id":"pty_x","last_seq":41,"retained_from_seq":1}

event: frame
data: {"session_id":"pty_x","seq":42,"type":"output","payload":{"text":"…","byte_length":128,"channel":"stdout"},"time":"…"}

event: gap
data: {"session_id":"pty_x","seq":5,"gap_from_seq":5,"gap_to_seq":40,"dropped_bytes":2048,"dropped_frames":36,"retained_from_seq":41,"time":"…"}

event: exit
data: {"session_id":"pty_x","seq":99,"exit_code":0,"signal":null,"time":"…"}

event: heartbeat
data: {"time":"…"}
~~~

规则：`seq` 为会话内单调 server_seq，客户端按 seq 去重；`gap.seq` 取首个被淘汰序号（与 Terminal SSE 约定一致），游标推进到 retained 窗口；`exit` 是权威终态并结束该连接（可经 `after_seq` 重放续接）；心跳为命名事件（服务端周期发送）。

### GET /v1/projects/{id}/workspaces/{wid}/watch/stream?after_revision=N

WORK-01 workspace 变更流（对应轮询 `GET …/workspaces/{wid}/nodes?after_revision=` watch feed）。鉴权同 project-scoped 读（fail-closed）：缺 `x-principal-id` → 422 `principal_required`、非成员 → 404 `project_not_found`、`after_revision` 非法 → 422 `invalid_revision`；workspace 钉定路径项目（跨项目 → 404 `workspace_not_found`）。事件：

~~~text
event: subscribed
data: {"workspace_id":"ws_x","project_id":"rsp_x","revision":7,"after_revision":0}

event: change
data: {"workspace_id":"ws_x","revision":7,"node":{"path":"src/a.ts","kind":"file","version":2,"etag":"…","hash":"…","size":…,…}}

event: delete
data: {"workspace_id":"ws_x","revision":7,"path":"src/old.ts"}

event: heartbeat
data: {"time":"…"}
~~~

规则：`change` 携带该路径**当前**节点（与 listSince 投影一致——中间 revision 收敛为最新状态），`delete` 为 tombstone；每批推送后游标前进到 workspace 当前 `revision`，重连以 `after_revision` 续传无重复。文本节点不随事件携带 content（节点字节另经 `GET …/nodes?path=` 读取）。流无自然终态（open-ended），断开由客户端按 `after_revision` 重连。

### GET /v1/projects/{id}/trajectory/stream?after_seq=N&after_event_id=…&lane=research|session

TRAJ-01 trajectory 增量流（对应轮询 `GET …/trajectory`，同一 keyset 投影——redaction 由投影保证，raw payload 永不出现）。鉴权同 trajectory 轮询（fail-closed）：缺 `x-principal-id` → 422 `principal_required`、非成员 → 404 `project_not_found`。`lane` 过滤 research/session 双泳道（缺省 = 双泳道合并）。事件：

~~~text
event: subscribed
data: {"project_id":"rsp_x","lane":"research","after_seq":11,"after_event_id":"evt_…"}

event: entry
data: {"entry_id":"evt_…","event_seq":12,"event_version":1,"project_id":"rsp_x","aggregate_type":"project","aggregate_id":"rsp_x","kind":"job.submitted","lane":"research","source":"kernel-outbox","occurred_at":"…","session_id":null,"summary":"…","status":"running"}

event: heartbeat
data: {"time":"…"}
~~~

规则：keyset 与轮询页完全一致——`(after_seq, after_event_id)` 以 (event_seq, event_id) 排序，相等 seq 跨 bucket 由 event_id 续传；**精确续传必须同时携带 after_event_id**（最后一条 entry 的 `entry_id`，subscribed 事件回显当前游标）；仅带 `after_seq` 时与轮询语义相同（同 seq 平局条目会重放，客户端按 `entry_id` 幂等去重，绝不漏数据）。`summary` 为白名单 redacted 投影。流无自然终态，断开按 keyset 重连。

### BFF 透传

standalone BFF 对三个 stream 路由与 Terminal SSE 同等处理：bearer 401、CSRF GET 豁免、project/global-id 路由在**首字节前**完成 membership（非成员/未知 → 404 JSON，零 SSE 字节）、`x-service-token` 注入同现有、`x-principal-id` 注入（pty 流走 `/v1/pty/sessions` 既有规则；watch/trajectory 流由 BFF 对 `…/watch/stream` 与 `…/trajectory/stream` 注入 server-derived 身份）；`proxy_buffering off` 由 nginx 层处理（响应头含 `x-accel-buffering: no`）。

## 23. DSH 原生 Scholar 对话与阶段投影

### Agent Tool `dsh_scholar`

输入为 `{text: string, project_name?: string, project_id?: string, locale?: "zh"|"en"}`，`text` 去首尾空白后 1–4000 字符。调用上下文必须提供 DSH agent/session id；该 id 必须匹配 `^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$`，ResearchClient 将其 `encodeURIComponent` 后作为一个 path segment 发送。未提供 `project_id` 时只按该 session link 解析项目，提供时必须与 link 精确一致。`project_name` 必须等于确定性创建语法从本次原文命令后缀解析出的完整 1–120 字符名称（可去掉一对包裹引号），不能只是其中子串；它不能由模型补写、改写或从历史消息推断。输出为：

~~~json
{
  "linked": true,
  "session_id": "session_abc123",
  "assistant_text": "…",
  "intent": {"kind": "status", "confidence": "deterministic"},
  "execution": {"status": "read_only", "operation": "research_status", "suggested_command": null},
  "project": {"project_id": "rsp_…", "name": "…", "status": "SCOPED", "revision": 2, "brief_status": "confirmed"},
  "stages": [
    {"id":"init","state":"done"},{"id":"survey","state":"current"},{"id":"idea","state":"upcoming"},
    {"id":"reproduce","state":"upcoming"},{"id":"contract","state":"upcoming"},{"id":"experiment","state":"upcoming"},
    {"id":"evidence","state":"upcoming"},{"id":"writing","state":"upcoming"},{"id":"review","state":"upcoming"},
    {"id":"release","state":"upcoming"}
  ],
  "next_action": {"code":"survey_run","label":"Run survey","reason":"corpus required","route":"chat","state":"ready","blocking":false,"required_by":"agent","required":true,"revision":2},
  "summary": {"pending_gates":0,"jobs":{"total":0,"queued":0,"running":0,"succeeded":0,"failed":0},"counts":{}}
}
~~~

`assistant_text` 按 `locale` 或 CJK 输入检测选择 zh/en；wire enum/id、Kernel 提供的 NextAction label/reason 不翻译，浏览器阶段 label/state 由 UI 字典本地化。未关联时，只有整句锚定的肯定创建指令且 `project_name` 等于确定性语法解析出的完整名称才执行 `project_create`；名称子串、疑问句、否定/取消/避免语义、主题讨论、仅模型填入名称或名称不一致全部零写。肯定创建但缺名称时返回 `execution.status="needs_project"` 并用自然语言追问名称，不强制用户先输入 slash；普通未关联对话仍可建议 `/new <项目名>`。工具是 unknown role 可调用的唯一公共 façade，不改变其他 ACL。其余自动执行集合固定为权威 ready `survey_run`，且要求本次文本含锚定的正向开始/继续/执行动作。检索后重新读取并核验相同 project、revision、session link 与 `survey_run/ready/agent`，Corpus Snapshot 请求携带 `expected_revision` 和 `expected_session_id`，Kernel 在同一事务内核对 revision 与 session→project 绑定；调用 mutation 前检查取消，mutation 开始后进入不可回滚 commit boundary。创建 POST 若在提交后断线、超时或收到 AbortSignal，adapter 必须用同一幂等 key、相同 request hash 和无 caller signal 的 replay-only 请求读取已提交回执；不存在回执时保持原错误与零写，只有回执及权威 link/投影全部一致才返回 executed，绝不能把恰好同名的其他 link 当作本次成功，也不能重建第二个项目。非输入类 Kernel/网络错误统一为稳定 `dsh_scholar is temporarily unavailable`，不得暴露 endpoint/path/upstream message。其他 mutation 返回 `suggested`/`blocked`/`needs_human`，Human-only 永远不执行。

### Connection RPC `/dsh-scholar-view`: session workspace

`session-workspace` 请求严格为 `{session_id}`。未关联返回 `{session_id, projection:{linked:false,session_id,stages:[…]}, available_projects:[…]}`；已关联返回相同 root、`projection:{linked:true,…}` 与空 `available_projects`。Host 在列表/projection 读取后再次核对 link，不一致则重试后 unavailable。`session-bind` 请求严格为 `{session_id,project_id}`，调用 internal link route 后返回已关联 workspace；`session-create` 请求严格为 `{session_id,project_name}`，使用确定性 idempotency key 调用 internal name-only create+link 后返回 workspace，transport 丢失只允许 replay-only 对账。客户端必须精确校验 root/project option/projection/stage/NextAction/summary/jobs，不允许额外字段；响应 session 精确相等、十阶段固定顺序、完整 NextAction/jobs 结构，动态 counts 全为非负有限整数。session 切换的 AbortSignal 必须传到底层 fetch，旧读取和 mutation 被取消且 UI busy 复位。
