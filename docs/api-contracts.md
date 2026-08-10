# HTTP、流式事件与错误契约

> 规范性文档。目标接口版本为 v2。新 UI 只能调用 BFF；v1 仅作为迁移 adapter，不得承载新能力。

## 1. 通用协议

- Kernel 默认监听 127.0.0.1，可选 Unix socket；不得直接暴露公网。
- JSON 请求 Content-Type 为 application/json，默认上限 16 MiB；Artifact upload 可单独配置至 32 MiB。
- 成功 JSON 直接返回资源或明确结果对象，不再使用仅有 message 的响应。
- 所有 mutation 接受 X-Request-Id；创建类请求接受 Idempotency-Key。
- BFF 从登录会话解析 Principal，忽略浏览器提交的 actor 或 principal 字段。
- Kernel 内部调用使用短期 Bearer 或 mTLS/Unix identity；Token 使用恒定时间比较。
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
| 409 | revision_conflict、gate_already_decided、lease_stale、document_version_conflict | 并发或状态冲突 |
| 413 | payload_too_large | 请求或上传超过上限 |
| 422 | validation_error、invalid_transition、container_execution_required | 可解析但违反契约 |
| 429 | rate_limited | 超过限流 |
| 500 | internal_error | 脱敏内部失败 |
| 502 | kernel_unreachable、connector_unavailable | 依赖不可用 |

稳定补充 code：invalid_cursor(400,false)、unsupported_media_type(415,false)、idempotency_conflict(409,false)、upload_offset_conflict(409,true)、artifact_stage_expired(409,false)、document_version_conflict(409,true)、tex_root_not_found(422,false)、lease_conflict/lease_stale(409,true)、job_finished(409,false)、manifest_invalid/signature_invalid(422,false)、project_required(422,false)。括号第二项是 retryable；未登记 code 默认 retryable=false。

Zod 错误 details 只返回字段路径和安全消息。上游 5xx、文件系统绝对路径、SQL、环境变量和 Token 不得传到浏览器。

## 3. Health 与能力发现

### GET /v2/health

返回 ok、instance_id、protocol_version、schema_version、database_id、capabilities、time。method 和路径必须精确匹配；错误百分号路径返回 400，不能使进程异常。

capabilities 至少包含 terminal_stream、interactive_terminal、workspace_files、tex_workspace、latex_compile、latex_live_preview、remote_runner、config_registry、research_onboarding、trajectory、subagent_topology、signed_manifest、clean_room 和 locales。

## 4. Project 接口

| 方法 | 路径 | 请求/结果 |
|---|---|---|
| POST | /v2/projects | ResearchProject create input；Idempotency-Key 必填；事务返回 project、creator PI membership、budget、initial Scope Gate |
| GET | /v2/projects | 授权项目分页列表 |
| GET | /v2/projects/{id} | Project |
| PATCH | /v2/projects/{id} | name 或允许的配置 + expected_revision |
| POST | /v2/projects/{id}/archive | expected_revision |
| POST | /v2/projects/{id}/unarchive | expected_revision |
| POST | /bff/research/projects/{id}/stop | PI；expected_revision、reason |
| POST | /bff/research/projects/{id}/fail | PI/Policy；expected_revision、reason、failure_class |
| POST | /bff/research/projects/{id}/refine | PI；expected_revision、target phase、reason |
| GET | /v2/projects/{id}/projection | Project、pending gates、jobs、budget、counts、结构化 next_actions、capabilities |
| POST | /v2/projects/{id}/transitions | to、expected_revision、reason；Gate 状态永远 422 |
| POST | /v2/projects/{id}/session-links | 只绑定调用 Principal 当前 session_id；客户端不能提交任意会话 |
| GET | /v2/session-links/current | 从调用 Principal 当前 session 返回 project_id |

Projection 是 UI 摘要，不承载完整日志、Artifact 字节、TeX 内容或大型 Evidence。

成员接口为 GET/POST/PATCH/DELETE /bff/research/projects/{id}/members；角色和最后一个 PI 约束见 reconstruction-contracts.md。standalone 解锁、SSO、DSH Agent session 关联和 service identity 的 Principal 解析也以该文档为准。

POST /v2/projects 的 Idempotency scope 是 tenant_id + principal_id + route + key；同请求 hash 重放返回同一 project/gate/budget/membership，hash 不同 409。其余 project mutation 使用 project_id + route + key；Gate Decision 和 cancel 的业务对象本身也提供终态幂等。

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

## 6. Corpus、Idea 与 Contract

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | /v2/projects/{id}/corpus-snapshots | 冻结结构化 Snapshot |
| GET | /v2/projects/{id}/corpus-snapshots | 分页列表 |
| GET | /v2/corpus-snapshots/{id} | 完整快照或分页子资源 |
| POST | /v2/projects/{id}/ideas | Idea Draft |
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

### GET /bff/research/projects/{project_id}/artifacts/{artifact_id}

返回字节流，保留 Content-Type、Content-Length、Content-Disposition、ETag。支持 Range。artifact_id 不能脱离 project_id 读取；不提供模糊的全局 artifact GET。

### Snapshot

POST /v2/projects/{id}/code-snapshots 和 POST /v2/projects/{id}/tex-snapshots 接受已登记 workspace/document、排除规则和 expected revision；不能接受 Runner 将读取的任意宿主绝对路径。响应包含 snapshot、archive_artifact、manifest_artifact、file_count、size 和 sha256。

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
| POST | /v2/documents/{id}/builds | 冻结 manifest 并创建 latex-compile Job |
| GET | /v2/documents/{id}/builds | 构建历史 |
| GET | /v2/builds/{id} | 状态、diagnostics、Artifact refs、freshness |
| POST | /v2/projects/{id}/manuscript-drafts | 从 Ledger 生成新的 TeX workspace revision |
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

构建日志通过同一 Terminal SSE 读取。Build 完成返回结构化 diagnostics、PDF、完整 log、aux/bbl/blg/fls 和输入 manifest。Artifact PDF 必须为 application/pdf。

## 12. Release

POST /v2/projects/{id}/release-bundle-requests 创建 bundle/clean-room Job；GET /v2/projects/{id}/release-bundles 读取状态和私有下载；POST /bff/research/gates/{release_gate}/decision 才能决定 release。系统不提供自动提交外部平台的接口。

## 13. BFF 规则

- standalone 使用同源 Cookie/SSO，或使用 0600 文件生成的本地 bearer 解锁，并映射为本地 Human Principal；mutation 强制 Origin 和 CSRF token；
- DSH Session 只用于 Agent tool/command 的会话关联，不作为浏览器 Human Principal；
- BFF route 是 target-aware adapter，不能做无身份透明转发；
- 二进制和 SSE 必须真正流式传输，不能先调用 text() 或完整缓冲；
- 默认每 IP 60 请求每分钟，Terminal 长连接单独限制每用户和项目连接数；
- 浏览器永远看不到 Kernel 内部 Token。

standalone 同源直接暴露 `/v2` 和 `/bff/research`。`/research-api` 与 `/research-ui-api` 不存在，不得作为兼容别名恢复。

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
| PUT | `/v2/intake-artifact-stages/{stage}/content` | Content-Range 分块/幂等重传 |
| POST | `/v2/intake-artifact-stages/{stage}/finalize` | 复算 hash/size，进入 scanning |
| DELETE | `/v2/intake-artifact-stages/{stage}` | abort，幂等 |
| POST | `/v2/intakes/{id}/scan` | 启动/重用静态扫描结果 |
| POST | `/v2/intakes/{id}/grill-answers` | Human assertion + question revision |
| POST | `/v2/intakes/{id}/proposals` | 生成确定性阶段/映射 proposal |
| POST | `/bff/research/intakes/{id}/accept` | PI Human adoption；expected proposal/target revision |
| POST | `/bff/research/intakes/{id}/reject` | Human reject/cleanup request |

`accept` 只存在于 BFF Human 面；Agent tool schema 不生成该方法。scan/parser/LLM 永远不能直接 mutation Project。单文件 Artifact 上传与 research package intake 是两个明确入口，UI 不得把 internal Runner stage 暴露给用户。状态、映射、错误和幂等见 research-onboarding.md。

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

## 18. Interactive Terminal

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/bff/research/projects/{id}/pty-sessions` | open；workspace/profile/preset/cwd/size/config revision |
| GET | `/bff/research/pty-sessions/{id}` | state 和权限摘要 |
| GET | `/bff/research/pty-sessions/{id}/events?after_seq=N` | SSE fallback：data/gap/state/exit |
| GET | `/bff/research/pty-sessions/{id}/socket` | authenticated WebSocket 双向 attach |
| POST | `/bff/research/pty-sessions/{id}/input` | SSE fallback input bytes + client_seq |
| POST | `/bff/research/pty-sessions/{id}/resize` | cols/rows + client_seq |
| POST | `/bff/research/pty-sessions/{id}/signals` | allowlisted INT/TERM/KILL |
| DELETE | `/bff/research/pty-sessions/{id}` | close，幂等 |

Run Terminal `/jobs/{id}/terminal` 保持只读且永远不接受 input。PTY 每个 control 操作执行 Project AuthZ、terminal_write、generation/client_seq 和 target policy；revoke 关闭连接。浏览器不能提交 SSH endpoint/credential、Docker socket、host path 或任意 argv。

## 19. Runner Target、Profile 与 Config

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/bff/research/runner-targets` | 可见 target health/capability，不返回 endpoint secret |
| POST/PATCH | `/bff/research/runner-targets` | PI/Operator 登记、drain、disable；revision CAS |
| GET/POST/PATCH | `/bff/research/runner-profiles` | profile、资源/网络/image policy；revision CAS |
| GET | `/bff/research/config/schema` | canonical schema/UI metadata |
| GET | `/bff/research/config/effective` | scope filters + value/source/revision/hash |
| PATCH | `/bff/research/config/{scope}/{scope_id}` | expected revision；secret 只接受 SecretRef |
| POST | `/bff/research/config/{scope}/{scope_id}/reset` | reset field/section to inherited default |
| GET | `/bff/research/config/revisions/{id}` | redacted provenance/audit |

Remote Agent internal 面提供 enroll/heartbeat/capability/claim/CAS fetch/stage/complete；全部使用 mTLS service identity 与 ExecutionPlan signature。任何 target/profile/config 修改只影响新动作，不能改变运行中 Job/PTY/Build 的 pinned hash。

## 20. Trajectory 与 Subagent Topology

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/bff/research/projects/{project}/trajectories` | Research/Session roots，cursor/source/status |
| GET | `/bff/research/trajectories/{id}/nodes` | parent_id 的 direct children，懒加载 |
| GET | `/bff/research/trajectories/{id}/nodes/{node}/history` | message-aligned 安全 history；不激活 Agent |
| GET | `/bff/research/trajectories/{id}/events?after_seq=N` | subscribed/event/gap SSE |
| POST | `/bff/research/trajectories/{id}/nodes/{child}/followups` | exact parent + continuable + capability |

每个全局 trajectory/node ID 先解析 project，再做 summary/detail/continue AuthZ。history 默认 safe summary；raw tool args/results/prompt/env 不得透明透传。地址、事件、token/duration、retention 和 DSH 移植边界见 trajectory-subagents.md。

## 21. NextAction 兼容

v2 Project/Intake projection 返回 reconstruction-contracts.md 的 `NextAction[]`。迁移期读取旧 `string[]` 时 BFF 只包装为 `legacy_unknown` + raw，不为其生成 mutation CTA。状态、reason、required revision、capability 和 target route 都由 Kernel 产生；UI 只负责翻译 label_key 与路由。
