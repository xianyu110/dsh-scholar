# 存储、事务与迁移规范

> 规范性文档。SQLite 是桌面默认 adapter；表结构可以扩展，但以下不变量不可改变。

## 1. 文件布局

~~~text
$DSH_HOME/research-kernel/
  kernel.db
  cas/
    ab/cd/<sha256>
  locks/
  backups/
  runtime/
    endpoint.json
    token
~~~

standalone 使用自己的 DSH_SCHOLAR_STANDALONE_DATA，不复用生产 DSH_HOME。Token 0600，DB/CAS 不由 Web 静态目录提供。

## 2. SQLite 设置

启动执行 PRAGMA journal_mode=WAL、foreign_keys=ON、busy_timeout。每个业务 mutation 使用显式事务；嵌套操作复用当前事务。写并发通过短事务、Revision CAS 和有界 busy retry 管理，不把长容器运行放在事务中。

meta 保存 schema_version、database_id、created_at、last_migrated_at。代码期望版本与 DB 不一致时必须运行迁移或 loud fail，不能继续带未知 schema 工作。

## 3. 核心表

| 表 | 主键/唯一 | 关键内容 |
|---|---|---|
| projects | project_id | status、revision、brief、constraints、execution、integrity、history |
| project_members | project_id + principal_id | role、tenant、created_at |
| gates | gate_id | project、type、target、payload、status |
| decisions | decision_id；gate_id unique | durable principal、decision、reason、diff、request |
| ideas | idea_id + version | immutable body/status |
| contracts | contract_id + version | immutable body/status/approval |
| corpus_snapshots | snapshot_id | frozen body/source status |
| blob_objects | sha256 | size、storage_uri |
| artifacts | artifact_id | project、blob_sha256、kind、media_type、file_name、metadata |
| code_snapshots | snapshot_id | project、archive/manifest artifact、sha256、source |
| jobs | job_id；project_id + idempotency_key unique | spec、status、lease、attempt、manifest、error |
| job_artifacts | job_id + artifact_id + role | run output ownership |
| runner_keys | key_id | public key、status、validity |
| runs | run_id | job、contract、snapshot、manifest、signature status |
| evidence | evidence_id | project、body、provenance_status |
| claims | claim_id | statement、status、confidence、history |
| budget | project_id | usage counters |
| events | event_id | append-only outbox、delivered_at |
| session_links | session_id | project_id |
| orchestrator_actions | action_id；project + idempotency unique | phase、status、attempt、refs |
| release_bundles | bundle_id | build/clean-room/gate/artifact state |
| terminal_retention | run_id | retained_from_seq、total/dropped bytes、truncated |
| tex_documents / revisions / manifests / builds | 见 §5 | 版本化 TeX 工作区 |

所有项目子表按 project_id 建索引。外键使用 RESTRICT 或明确 tombstone，不用级联删除审计对象。

Project delete 采用 additive tombstone migration，不物理删除 `projects` 行：`deleted_at/deleted_by/deletion_reason/deletion_request_id` 均可空，`deletion_request_id` 对非空值唯一。删除事务仅在 ARCHIVED + revision/确认匹配时填写这些列、递增 revision 并写 `project.deleted` Outbox；正常查询统一加 `deleted_at IS NULL`。成员、Decision、Outbox、Artifact/Workspace/TeX 引用在 retention 期间继续保留。物理 purge 是独立、可恢复的运维流程，必须跨所有 WAL store 完成 quiesce/receipt，且不能直接 unlink CAS；GC 的全局 live ref 集合至少覆盖 Artifact、workspace node/FileRevision 和 released Bundle，最后引用消失且超过 grace/hold 才能删 Blob。

### 3.1 Schema v2 初始 DDL

除 §4 Terminal 与 §5 TeX 表外，初始迁移必须等价于下列 DDL。JSON body 在写入前由 reconstruction-contracts.md 对应 Zod Schema 校验。

> 实际 schema 校准（2026-08-11 复审，如实记录）：**0001 已发布不可改写**（STORE-08），下列 DDL 为目标形态；`packages/research-kernel/src/migrations.ts` 的 `SCHEMA_V2_INITIAL` + 追加迁移是运行时唯一事实。已知命名差异（语义等价）：`projects` 列名为 `brief/constraints/execution/integrity/history`（无 `_json` 后缀；`idempotency_key/request_hash` 由 0007 追加；`deleted_at/deleted_by/deletion_reason/deletion_request_id` 由 0019 追加；`fixture_id`/`pre_archive_status` 未落列——fixture 绑定存于 `execution` JSON，archive 前状态由状态机推导）；`gates` 列名为 `payload`（无 `payload_json`），无 `target_type/target_id/target_version/requested_by_json`，含 `dsh_session_id/dsh_event_id`；`jobs` 的 `(project_id, idempotency_key)` 唯一约束在 0001 内（`idx_jobs_project_idempotency`）；`runs` 的 `snapshot_sha256` 可空（0009）。新增能力表以追加迁移落地：0004 artifact media_type、0005 code_snapshots、0006 project_members、0007 projects 幂等键、0008 outbox envelope、0012 intake、0013 trajectory、0014 lease hash、0016/0017 形状、0018/0019 恢复与墓碑。

~~~sql
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE schema_migrations (
  id TEXT PRIMARY KEY,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  report_json TEXT NOT NULL
);

CREATE TABLE projects (
  project_id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 120),
  workspace TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('gate-only','full-auto')),
  status TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  brief_json TEXT NOT NULL,
  constraints_json TEXT NOT NULL,
  execution_json TEXT NOT NULL,
  integrity_json TEXT NOT NULL,
  session_id TEXT,
  dsh_workspace_id TEXT,
  fixture_id TEXT,
  pre_archive_status TEXT,
  history_json TEXT NOT NULL DEFAULT '[]',
  deleted_at TEXT,
  deleted_by TEXT,
  deletion_reason TEXT,
  deletion_request_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE project_members (
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  principal_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('pi','researcher','operator','auditor','viewer')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(project_id, principal_id)
);

CREATE TABLE gates (
  gate_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  type TEXT NOT NULL CHECK(type IN ('scope','idea','contract','budget','release')),
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  target_type TEXT,
  target_id TEXT,
  target_version INTEGER,
  payload_json TEXT NOT NULL DEFAULT '{}',
  requested_by_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected','revised')),
  created_at TEXT NOT NULL,
  decided_at TEXT
);

CREATE TABLE decisions (
  decision_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  gate_id TEXT NOT NULL UNIQUE REFERENCES gates(gate_id),
  principal_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  auth_method TEXT NOT NULL,
  session_id TEXT,
  decision TEXT NOT NULL CHECK(decision IN ('approved','rejected','revised')),
  reason TEXT NOT NULL DEFAULT '',
  diff TEXT,
  resume_to TEXT,
  request_id TEXT NOT NULL,
  decided_at TEXT NOT NULL
);

CREATE TABLE ideas (
  idea_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version > 0),
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  status TEXT NOT NULL,
  body_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(idea_id, version)
);

CREATE TABLE contracts (
  contract_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version > 0),
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  idea_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('draft','approved','superseded','rejected')),
  body_json TEXT NOT NULL,
  approval_json TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY(contract_id, version)
);

CREATE TABLE corpus_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  schema_version INTEGER NOT NULL,
  body_json TEXT NOT NULL,
  frozen INTEGER NOT NULL CHECK(frozen = 1),
  created_at TEXT NOT NULL
);

CREATE TABLE blob_objects (
  sha256 TEXT PRIMARY KEY,
  size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
  storage_uri TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE artifacts (
  artifact_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  blob_sha256 TEXT NOT NULL REFERENCES blob_objects(sha256),
  kind TEXT NOT NULL,
  media_type TEXT NOT NULL,
  file_name TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE(project_id, artifact_id)
);

CREATE TABLE code_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  archive_artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id),
  manifest_artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id),
  source_json TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  file_count INTEGER NOT NULL,
  size_bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE jobs (
  job_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  contract_id TEXT,
  contract_version INTEGER,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  created_by_principal_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  spec_json TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  lease_owner TEXT,
  lease_expires_at TEXT,
  heartbeat_at TEXT,
  lease_generation INTEGER NOT NULL DEFAULT 0,
  lease_token_hash TEXT,
  code_snapshot_id TEXT REFERENCES code_snapshots(snapshot_id),
  tex_snapshot_id TEXT REFERENCES tex_workspace_manifests(manifest_id),
  image_digest TEXT,
  run_manifest_json TEXT,
  failure_class TEXT,
  error TEXT,
  cancellation_requested_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, idempotency_key),
  CHECK(kind IN ('echo','smoke','baseline','pilot','formal','analysis','reproduce','latex-compile','clean-room')),
  CHECK(status IN ('queued','running','succeeded','failed','cancelled','retryable')),
  CHECK(kind != 'latex-compile' OR tex_snapshot_id IS NOT NULL),
  CHECK(kind NOT IN ('baseline','pilot','formal','reproduce') OR code_snapshot_id IS NOT NULL)
);

CREATE TABLE runner_keys (
  key_id TEXT PRIMARY KEY,
  public_key_pem TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active','revoked')),
  valid_from TEXT NOT NULL,
  valid_until TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE runs (
  run_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  job_id TEXT NOT NULL REFERENCES jobs(job_id),
  attempt_no INTEGER NOT NULL CHECK(attempt_no > 0),
  contract_id TEXT,
  contract_version INTEGER,
  snapshot_sha256 TEXT NOT NULL,
  manifest_json TEXT,
  signature_status TEXT NOT NULL DEFAULT 'pending',
  started_at TEXT NOT NULL,
  finished_at TEXT,
  UNIQUE(job_id, attempt_no)
);

CREATE TABLE evidence (
  evidence_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  body_json TEXT NOT NULL,
  provenance_status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(provenance_status IN ('draft_unverified','legacy_unverified','verified','accepted','rejected'))
);

CREATE TABLE claims (
  claim_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  statement TEXT NOT NULL,
  scope_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL,
  confidence TEXT,
  evidence_ids_json TEXT NOT NULL DEFAULT '[]',
  history_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(status IN ('proposed','supported','contradicted','inconclusive','retracted'))
);

CREATE TABLE budget (
  project_id TEXT PRIMARY KEY REFERENCES projects(project_id),
  limits_json TEXT NOT NULL,
  usage_json TEXT NOT NULL,
  reservations_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);

CREATE TABLE events (
  event_id TEXT PRIMARY KEY,
  event_seq INTEGER NOT NULL UNIQUE,
  event_version INTEGER NOT NULL DEFAULT 1,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  aggregate_revision INTEGER NOT NULL,
  kind TEXT NOT NULL,
  source TEXT NOT NULL,
  request_id TEXT NOT NULL,
  session_id TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  next_attempt_at TEXT,
  dead_lettered_at TEXT
);

CREATE TABLE session_links (
  session_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  principal_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  issuer TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE orchestrator_actions (
  action_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  phase TEXT NOT NULL,
  type TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL,
  depends_on_json TEXT NOT NULL DEFAULT '[]',
  input_refs_json TEXT NOT NULL DEFAULT '[]',
  output_refs_json TEXT NOT NULL DEFAULT '[]',
  lease_json TEXT,
  error_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, idempotency_key)
);

CREATE TABLE release_bundles (
  bundle_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  status TEXT NOT NULL CHECK(status IN ('building','verifying','ready','failed')),
  bundle_artifact_id TEXT,
  clean_room_job_id TEXT REFERENCES jobs(job_id),
  reproducibility_report_artifact_id TEXT,
  release_gate_id TEXT REFERENCES gates(gate_id),
  manifest_sha256 TEXT,
  error_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, bundle_id),
  FOREIGN KEY(project_id, bundle_artifact_id) REFERENCES artifacts(project_id, artifact_id),
  FOREIGN KEY(project_id, reproducibility_report_artifact_id) REFERENCES artifacts(project_id, artifact_id)
);

CREATE TABLE artifact_stages (
  stage_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  job_id TEXT NOT NULL REFERENCES jobs(job_id),
  run_id TEXT,
  lease_generation INTEGER NOT NULL,
  expected_sha256 TEXT NOT NULL,
  expected_size INTEGER NOT NULL,
  temp_uri TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  finalized_artifact_id TEXT REFERENCES artifacts(artifact_id),
  created_at TEXT NOT NULL
);

CREATE INDEX projects_updated ON projects(updated_at DESC, project_id DESC);
CREATE INDEX gates_project_status ON gates(project_id, status, created_at DESC);
CREATE INDEX artifacts_project_created ON artifacts(project_id, created_at DESC);
CREATE INDEX jobs_project_status ON jobs(project_id, status, created_at DESC);
CREATE INDEX evidence_project_created ON evidence(project_id, created_at DESC);
CREATE INDEX claims_project_created ON claims(project_id, created_at DESC);
CREATE INDEX events_delivery ON events(dead_lettered_at, delivered_at, next_attempt_at, event_seq);
~~~

## 4. Job 与 Terminal 表

jobs 必须有 lease_owner、lease_expires_at、heartbeat_at、lease_generation、lease_token_hash、code_snapshot_id、tex_snapshot_id、image_digest、max_attempts、run_manifest 和 cancellation_requested_at。实验使用 code_snapshot_id，latex-compile 使用 tex_snapshot_id；不适用字段为 NULL，CHECK 保证 kind 与 snapshot 类型一致。

~~~sql
CREATE TABLE terminal_frames (
  job_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  stream_seq INTEGER,
  channel TEXT,
  text TEXT,
  byte_offset INTEGER,
  byte_length INTEGER,
  frame_kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  lease_generation INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (run_id, seq),
  FOREIGN KEY (job_id) REFERENCES jobs(job_id),
  FOREIGN KEY (run_id) REFERENCES runs(run_id),
  CHECK (frame_kind IN ('chunk','gap','exit')),
  CHECK (channel IS NULL OR channel IN ('stdout','stderr')),
  CHECK (
    (frame_kind = 'chunk' AND channel IS NOT NULL AND stream_seq IS NOT NULL AND text IS NOT NULL AND byte_offset IS NOT NULL AND byte_length IS NOT NULL)
    OR
    (frame_kind IN ('gap','exit') AND channel IS NULL AND stream_seq IS NULL AND text IS NULL)
  )
);
CREATE INDEX terminal_job_seq ON terminal_frames(job_id, seq);

CREATE TABLE terminal_retention (
  run_id TEXT PRIMARY KEY REFERENCES runs(run_id),
  retained_from_seq INTEGER NOT NULL DEFAULT 1,
  total_bytes INTEGER NOT NULL DEFAULT 0,
  dropped_bytes INTEGER NOT NULL DEFAULT 0,
  truncated INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0,1)),
  updated_at TEXT NOT NULL
);

CREATE TABLE job_artifacts (
  job_id TEXT NOT NULL REFERENCES jobs(job_id),
  artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id),
  role TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(job_id, artifact_id, role)
);
~~~

Run 在 claim 成功事务中以 attempt_no 创建，manifest/finished_at 暂为空；因此首个 chunk 已有可引用 run_id。retry/reclaim 创建新的 Run attempt，旧 attempt 保留 exit/gap 和最终状态。Terminal frame 批量插入使用事务和 INSERT conflict check；相同 run/seq 内容不同是 integrity error。chunk 的 byte_offset/byte_length 以 sanitizer 前的原始流字节计，text 是安全 UTF-8 replacement 后的显示文本；gap/exit 的扩展字段只在 payload_json 与 wire frame 中。retention 清理记录 terminal_retention，至少保留 exit 和 gap 元数据。最终 log Artifact 通过 job_artifacts 关联。

## 5. TeX 文档表

~~~sql
CREATE TABLE tex_documents (
  document_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  root_path TEXT NOT NULL,
  revision INTEGER NOT NULL,
  active_manifest_id TEXT,
  last_build_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(project_id),
  UNIQUE(project_id, document_id)
);

CREATE TABLE tex_file_revisions (
  project_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  path TEXT NOT NULL,
  version INTEGER NOT NULL,
  blob_sha256 TEXT,
  kind TEXT NOT NULL,
  media_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  principal_json TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  PRIMARY KEY(document_id, path, version),
  FOREIGN KEY(project_id, document_id) REFERENCES tex_documents(project_id, document_id),
  FOREIGN KEY(blob_sha256) REFERENCES blob_objects(sha256)
);
CREATE INDEX tex_file_project_path ON tex_file_revisions(project_id, document_id, path, version DESC);

CREATE TABLE tex_workspace_manifests (
  manifest_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  document_revision INTEGER NOT NULL,
  artifact_id TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(document_id, document_revision),
  FOREIGN KEY(project_id, document_id) REFERENCES tex_documents(project_id, document_id),
  FOREIGN KEY(project_id, artifact_id) REFERENCES artifacts(project_id, artifact_id),
  UNIQUE(project_id, manifest_id)
);

CREATE TABLE tex_builds (
  build_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  input_manifest_id TEXT NOT NULL,
  job_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  engine TEXT NOT NULL,
  passes INTEGER NOT NULL DEFAULT 0,
  diagnostics_json TEXT NOT NULL,
  pdf_artifact_id TEXT,
  log_artifact_id TEXT,
  aux_artifact_ids_json TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  FOREIGN KEY(project_id, document_id) REFERENCES tex_documents(project_id, document_id),
  FOREIGN KEY(project_id, input_manifest_id) REFERENCES tex_workspace_manifests(project_id, manifest_id),
  FOREIGN KEY(job_id) REFERENCES jobs(job_id),
  FOREIGN KEY(project_id, pdf_artifact_id) REFERENCES artifacts(project_id, artifact_id),
  FOREIGN KEY(project_id, log_artifact_id) REFERENCES artifacts(project_id, artifact_id)
);
~~~

保存文件在一个事务中校验 expected version、写新 Blob 引用、插入 revision、增加 document revision、生成 tex.file.saved Outbox。Blob 字节先原子落 CAS；若事务失败，孤儿 Blob 可由 GC 处理，不能先覆盖旧文件。

**TEX-SAVE 已落地（审计报告 §4 #3，commit c62b65a）**：`tex-workspace.ts` 的 writeFile/deleteFile/moveFile 现在把「文件行变更 + document revision 递增」包在 tex store 连接自己的单事务里（withTx：BEGIN IMMEDIATE/COMMIT/ROLLBACK；`isTransaction` 守卫使 moveFile→writeFile 嵌套复用同一事务，无嵌套 BEGIN；失败整体回滚，不留半写——文件行与 revision 永不脱节）。保存成功后 kernel 在同一 project aggregate 追加 `tex.file.saved` Outbox 事件（KernelEventKind 新增；payload: project_id/document_id/path/revision + 可选 request_id/session_id；event_seq 单调、aggregate_type='project'、aggregate_revision=保存后 document revision；409 版本冲突不发事件）。**跨连接原子性取舍（§7）**：tex store 是独立 WAL 连接（openTexWorkspace），tex 写与 outbox 追加无法同事务——tex 写先提交、outbox 后写；outbox 追加失败只记录 error（console.error）不阻塞保存（写已提交、客户端已见成功，失败只会导致 409 重试）。验证：tests/unit/tex-workspace.test.ts（单事务失败路径无半写：write/delete/move 三面）、tests/unit/tex-event.test.ts（事件信封/单调 seq/aggregate 身份/revision 正确/409 无事件/outbox 失败不阻塞保存/research lane 投影）。

### 5.1 通用 Workspace 与 PTY

~~~sql
CREATE TABLE workspaces (
  workspace_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, kind TEXT NOT NULL,
  name TEXT NOT NULL, revision INTEGER NOT NULL, active_snapshot_id TEXT,
  config_revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(project_id), UNIQUE(project_id, workspace_id)
);
CREATE TABLE workspace_file_revisions (
  project_id TEXT NOT NULL, workspace_id TEXT NOT NULL, path TEXT NOT NULL, version INTEGER NOT NULL,
  blob_sha256 TEXT, kind TEXT NOT NULL, media_type TEXT NOT NULL, size_bytes INTEGER NOT NULL,
  principal_json TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id,path,version), FOREIGN KEY(project_id,workspace_id) REFERENCES workspaces(project_id,workspace_id),
  FOREIGN KEY(blob_sha256) REFERENCES blob_objects(sha256)
);
CREATE TABLE workspace_events (
  workspace_id TEXT NOT NULL, workspace_seq INTEGER NOT NULL, event_id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL, path TEXT, revision INTEGER NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id,workspace_seq), FOREIGN KEY(workspace_id) REFERENCES workspaces(workspace_id)
);
CREATE TABLE pty_sessions (
  pty_session_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
  principal_id TEXT NOT NULL, runner_profile_id TEXT NOT NULL, target_id TEXT NOT NULL,
  purpose TEXT NOT NULL, cwd TEXT NOT NULL, argv_preset TEXT NOT NULL, cols INTEGER NOT NULL, rows INTEGER NOT NULL,
  status TEXT NOT NULL, generation INTEGER NOT NULL, lease_token_hash TEXT NOT NULL, config_sha256 TEXT NOT NULL,
  retained_from_seq INTEGER NOT NULL, last_event_seq INTEGER NOT NULL, created_at TEXT NOT NULL,
  last_activity_at TEXT NOT NULL, expires_at TEXT NOT NULL, closed_at TEXT,
  FOREIGN KEY(project_id,workspace_id) REFERENCES workspaces(project_id,workspace_id)
);
CREATE TABLE pty_events (
  pty_session_id TEXT NOT NULL, seq INTEGER NOT NULL, frame_kind TEXT NOT NULL,
  client_seq INTEGER, payload_json TEXT NOT NULL, byte_length INTEGER, created_at TEXT NOT NULL,
  PRIMARY KEY(pty_session_id,seq), FOREIGN KEY(pty_session_id) REFERENCES pty_sessions(pty_session_id)
);
~~~

TexDocument 新增 workspace_id，并把 tex_file_revisions 迁入或以 view/facade 指向 workspace_file_revisions；不得长期维护两份 bytes/revision 权威。Tex preview 增加 preview/superseded_by/config_sha256/fresh 字段或独立 `tex_previews` 表。**TEX-03 已落地（migration 0010_preview_builds，SCHEMA_VERSION 9）**：tex_builds 增加 `preview INTEGER NOT NULL DEFAULT 0`、`superseded_by TEXT`、`superseded_at TEXT`（queued→cancelled、running→superseded 状态机；stale 由 build.revision<document.revision 计算，不落库），新增 `tex_preview_pending(document_id PK, revision, root_file, engine, debounce_ms, requested_at)` 持久化 debounce 请求（kernel 重启自动重挂）；迁移幂等（ensureColumn + CREATE IF NOT EXISTS）。

**PTY-01/WORK-01 已落地（migration 0011_pty_workspace，SCHEMA_VERSION 10，幂等）**：`pty_sessions`（principal/project/workspace/profile/target/preset/cwd/config_hash/state/generation/lease_token/lease_expires_at/idle_ttl_s/retention_bytes/retained_from_seq/last_client_seq/last_event_seq/total_bytes/dropped_bytes/adapter_id/close_reason，state CHECK open/attached/detached/closed）、`pty_frames`（pty_session_id+server_seq PK，frame_kind control/output/exit/gap，client_seq 唯一索引为幂等键）、`workspaces`（kind code/manuscript/scratch + revision）、`workspace_nodes`（path/version/binary/media/size_bytes/content/blob_sha256/content_hash，文本内联、二进制引用 artifact CAS）、`workspace_ops`（create/write/delete/move op ledger + workspace_revision）。PTY 帧是审计与有界保留面，**不是** Job log：不进入 jobs/runs/evidence/gates/metrics 任何表。

### 5.2 Runner、Profile 与 Config

`runner_targets(target_id,placement,adapter,labels_json,capabilities_json,health,endpoint_label,service_identity_id,revision,enabled,draining,last_seen_at,created_at,updated_at)`；`runner_profiles(runner_profile_id,target_id,policy_json,config_revision,config_sha256,revision,enabled,draining,created_at,updated_at)`。endpoint_label 只引用服务端 config；证书/credential 不入表明文字段。

`config_documents(config_id,scope,scope_id,schema_version,revision,values_json,created_by_principal_json,created_at,updated_at)` 以 `(scope,scope_id)` 唯一；`config_revisions` 追加保存 redacted diff/hash；`secret_refs` 只保存 scheme/name/version/scope 和 availability metadata，不保存 value。Job/Run/PTY/TexBuild 增加 config_revision/config_sha256 pinned columns。

### 5.3 Intake 与 Adoption

追加式 migration 创建 `intake_sessions`、`intake_artifacts`、`intake_observations`、`intake_questions`、`intake_proposals`、`intake_mappings`、`intake_adoptions`。公共字段必须包含 tenant/owner、revision/status、created/updated/expires；Artifact 绑定 Blob/scan/quarantine；Observation 固定 source locator + detector/parser version + trust；Question answer固定 Human Principal/revision；Proposal 固定 target project/revision；Adoption 以 adoption_id 和 `(target_scope,idempotency_key)` 唯一并保存 request_hash/receipt。

pre-accept 表不能使用 FK 创建 Project/Gate/Job/Run/Evidence 旁路；只有 adoption transaction 写入正常项目表与 mapping refs。temporary Blob 可由 intake_artifacts 引用并按 expiry GC，accepted mapping 转成正式 Artifact/Workspace 引用后才进入正常 retention。

### 5.4 Trajectory projection

`trajectory_roots(trajectory_id,project_id,source,source_ref,status,first_event_seq,last_event_seq,retained_until,created_at,updated_at)`；`trajectory_nodes(node_id,trajectory_id,project_id,parent_node_id,relation,kind,mode,status,label,safe_summary_json,timing_json,tokens_json,cost_json,permissions_json,retention_json,refs_json,created_at,updated_at)`；`trajectory_events(trajectory_id,event_seq,event_id,node_id,parent_node_id,type,source,payload_json,occurred_at)`；`trajectory_cursors(source,source_ref,last_source_seq,updated_at)`；`trajectory_redactions(redaction_id,trajectory_id,node_id,reason,dropped_bytes,principal_json,created_at)`。

`(trajectory_id,event_seq)` 和 event_id 唯一。projection 可从 Kernel Outbox/安全 Session source 重建；不能被 Project transaction 读取为业务权威。raw detail 只保存加密/CAS ref + TTL，有界 preview 存 safe_summary_json。

**TRAJ-01/SUBAGENT-01 standalone 投影已落地（migration 0013_trajectory_topology，SCHEMA_VERSION 12，幂等）**：投影直接读 `events` outbox（不复制业务状态，Kernel Outbox 仍是唯一账本），新增 `idx_events_project_seq(project_id,event_seq,event_id)` 支撑 10k 事件 keyset 分页；拓扑存储 `child_links(child_id PK, project_id FK→projects, parent_id, label, summary, kind CHECK subagent/task, mode CHECK one-shot/continuable/read-only, state CHECK running/inactive/diagnostic/succeeded/failed/redacted/unknown, role, created_at, updated_at, ended_at)`（parent_id 无 FK——parent 可以是未注册的 caller agent session）、`child_history(child_id+seq PK, event_id, event_type, payload, occurred_at)`（append-only 每 child 单调 seq 账本：started/registered/state/followup）、`child_followups(message_id PK, child_id FK→child_links, project_id, request, request_hash, status accepted_read_only, created_at)`（one-shot 只读 followup 收据）。child summary 写入+读取双次 redaction；state 只经 `PATCH /v1/topology/{child_id}/state` 变更且 ended_at 首次终态钉定；re-register 不复活终态。child_links 是投影/审计表，不反向成为 Project 状态权威。

**STORE-06 已落地（migration 0014_lease_token_hash，SCHEMA_VERSION 13，幂等）**：lease token 不再明文落盘——`jobs` 新增 `lease_token_hash TEXT`（sha256(token)，NULL 仅存在于 0014 之前的旧行）；claim 时 token 只写 hash 列，明文仅存于 kernel 进程内存并在 claim 响应返回给 runner（传输面明文、存储面哈希，重启后重取的 job 记录不再携带明文 token；fencing 校验用 sha256(提供值) 对照 hash 列，重启后依然可验）。0014 对旧行回填：`payload.__lease_token` 存在的 running 行按行计算 hash 写入列（已有数据不动，payload 原样保留）；hash 为空的行走旧路径兼容比较（对照 legacy payload token，fail-closed）。`pty_sessions` 同轮重建（复制→校验→原子 rename，与 0009 的 runs 同模式）：旧形状 `lease_token TEXT NOT NULL`（明文落盘）改为 `lease_token TEXT`（可空，旧行值保留审计）+ `lease_token_hash TEXT NOT NULL DEFAULT ''`（open 时写入 sha256；新会话明文只存在于内存与 open 响应，`PtySession.lease_token` wire 形状改为 nullable）。新形状与 pty-session.ts 的 `PTY_SESSIONS_TABLE_DDL` 共享同一 DDL 常量，杜绝两处漂移。验证：tests/unit/migrations.test.ts（0014 列存在/回填/pty 重建）、tests/unit/kernel.test.ts（claim 后 hash 匹配、payload 无明文、hash 比较 fencing、空 hash 旧行兼容）、tests/unit/pty-session.test.ts（hash 存储、读回 null）。

## 6. Artifact CAS

CAS path 只由服务端 SHA-256 计算。put 写同目录临时文件、fsync（可配置）、atomic rename；已有 Blob 校验 size/hash 后幂等返回。读取重新验证标识格式，关键发布流程可复算 hash。

Blob 无 project_id；授权永远从 artifacts 表开始。相同 Blob 在多个项目有不同 artifact_id。GC 只删除没有任何 Artifact/FileRevision/Bundle 引用且超过 grace period 的 Blob。

## 7. 事务边界

必须原子：

- Gate Decision + target freeze + Decision Principal + Project revision + Outbox；
- Budget increment + limit check + BLOCKED_GATE + Gate + Outbox；
- Job claim/heartbeat/cancel/complete 的各自状态 CAS；
- complete + RunManifest + Artifact links + Run + budget + Outbox；
- Analysis completion + Evidence + Claim re-evaluation + Outbox；
- TeX save + revision + manifest invalidation + Outbox；
- TeX build completion + PDF/log/diagnostics + Job + Outbox；
- Workspace mutation + file revision + workspace revision/event + snapshot invalidation + Outbox；
- PTY open/control/exit 的 generation/client_seq CAS 与审计；
- Intake adoption + Project/Artifact/Workspace mappings + pending Gates/Actions + Receipt + Outbox；
- Config patch + revision/redacted audit；target drain 与 profile disable；
- Release verification + Bundle + Release Gate Request。

CAS 写与 DB 无法共用事务时采用 stage/finalize：先写不可达 Blob，事务登记可达引用；失败 Blob 后台 GC。Outbox 消费不得与业务事务耦合外部网络。

## 8. 迁移规则

1. released migration 不可修改，只追加新版本；
2. 启动前创建 DB backup 和 CAS inventory；
3. SQLite 复杂变更使用新表、复制、校验、原子 rename；
4. 每步记录 row counts、orphan、conflict、hash report；
5. 迁移必须可在真实旧 fixture 上重复运行且幂等；
6. schema_version 只在全部步骤成功后更新；
7. 失败恢复旧 DB，保留报告；
8. downgrade 仅在明确脚本中执行，不能靠旧二进制打开新 DB。

编号固定：0001_schema_v2_initial.sql 用于空库并在同一事务插入 meta schema_version=2、database_id=<128-bit random id>、created_at、last_migrated_at；0002_import_legacy_v1.ts 读取旧表、写 v2 staging 表、运行计数/hash/invariant scan，再原子切换；0003_terminal_tex_i18n_capabilities.sql 只用于曾经生成过早期 v2 preview 的数据库；后续能力必须依次追加 `0004_workspace_pty.sql`、`0005_runner_config.sql`、`0006_research_onboarding.sql`、`0007_trajectory_projection.sql`（实现仓库已有更高编号时使用下一个空号，禁止改写已发布 migration）。每个迁移在 schema_migrations(id,checksum,applied_at,report_json) 留记录；相同 id/checksum 幂等跳过，checksum 不同 loud fail。

**STORE-08 冻结规则（0003 为已发布迁移，禁止改写）**：0003 的 canonical body 是函数源码，函数体按名引用共享 `TERMINAL_DDL`/`TEX_DDL` 常量——这就是发布时的行为，既有数据库记录的 checksum 绑定这份源码文本。**已发布迁移不可修改**：曾有一次尝试把内联 DDL 快照冻结进 0003（`TERMINAL_DDL_0003`/`TEX_DDL_0003`），改变了函数源码导致所有既有库 checksum mismatch（standalone 无法启动），已整体回退。正确姿势：共享常量属于 0003 的已发布行为，只能通过新迁移 + live store 自带 CREATE IF NOT EXISTS 收敛来演进，**禁止原地编辑常量文本**；任何对 0003 自身文本的改动都会 checksum mismatch loud fail。验证：tests/unit/migrations.test.ts STORE-08 用例（body 引用共享常量、无内联冻结文本、checksum 为 id+body 纯函数、对 body 的任何编辑都改变 checksum、新库仍收敛 terminal/TeX 表）。

**STORAGE-07 已落地（§8.2/§10 备份与完整性扫描）**：`bin/kernel.ts` 启动钩子 `--backup-on-start`（或 env `DSH_SCHOLAR_BACKUP_ON_START=1`，默认关闭；bin 级开关，不属 Config Registry 键）：在 kernel 打开/迁移数据库**之前**对 `<dataDir>/backups/` 执行 `VACUUM INTO` 生成 `kernel-<ts>.db`（0600，WAL 安全的一致快照，即迁移前状态），并写 CAS inventory `inventory-<ts>.json`（0600，每个 blob 的 sha256+size_bytes+mod_time + cas_root/db_path/schema_version_at_backup/database_id/blob 计数/字节数）；数据库文件不存在（首启）时跳过并注明，请求了备份但失败则 loud fail 退出。kernel 侧新增 `scanIntegrity()`：一次扫描返回 `{missing_blobs, orphan_blobs, size_mismatch, hash_mismatch, scanned_blobs, skipped_blobs, total_blobs}`——blob 缺失（同 scanMissingBlobs）、无 Artifact 引用的孤儿 blob、尺寸与 artifacts.size_bytes 不符、对 blob 内容重算 sha256 与记录不符（篡改字节检出）；大 CAS 传 `limit` 限量复验（缺省全量）。验证：tests/unit/backup.test.ts（快照可打开且为迁移前 schema、inventory 与 CAS 逐字节一致、0600、缺库 loud fail）、tests/unit/cas-gc.test.ts（损坏/篡改/孤儿/缺失/限量/修复后自愈）。

jobs/status/kind、Evidence provenance、Claim status 等 enum 由文中 CHECK 和 Kernel Zod 双重保证；SQLite 无法表达的跨项目/按 kind snapshot 条件在 transaction 函数中校验，并由 invariant scan 与故障测试覆盖。迁移脚本及旧 fixture DB 是仓库必需资产，路径 tests/fixtures/databases/v1-kernel.db。

## 9. 从当前 v1 迁移

- projects 保留 ID/revision/history，补 membership 和 integrity 字段；
- decisions 将即时响应中的 principal 迁为 durable column；无法证明身份的标 legacy_unverified；
- artifacts 拆 blob_objects 与 project artifacts，修复跨项目重复 ID；
- jobs 唯一约束改 project_id + idempotency_key，补 lease_generation 和 snapshot；
- 旧 message-only Run 标 synthetic_fixture，不能用于 Evidence；
- 旧 unsigned Manifest 标 unsigned_legacy；
- 现有 Evidence 全部 legacy_unverified，Claim 重新验证；
- manuscript 字符串转换为初始 TexDocument/FileRevision，保留原 Artifact；
- 旧一次性 log 转为 final log Artifact，不伪造 terminal frames；
- 当前 SCHEMA_VERSION=1 下的隐式列修复必须整理为显式有序迁移。

**v2 形状对齐已落地（0016_v2_shape_alignment，SCHEMA_VERSION 15，幂等；commit d960f34）**：`jobs` 新增可空 `created_by_principal_id TEXT`（domain-model.md §9 的持久化提交者 principal；旧行 NULL 兼容），`budget` 新增 `storage_bytes INTEGER NOT NULL DEFAULT 0`（domain-model.md §16 的存储计量；旧行 0 兼容）。两列均纯追加、幂等，不触碰 0001–0014 已发布迁移的 checksum；无回填——旧行如实读回 NULL/0。验证：tests/unit/migrations.test.ts（0016 列存在/SCHEMA_VERSION）、tests/unit/v2-shape.test.ts（落库/读回/旧行兼容）。

**MIG-V1 已实现（0017_v1_legacy_marks，SCHEMA_VERSION 15，幂等；commit d960f34）**：审计报告 §4 #6 的三步以**独立迁移追加**实现——不改 0002 函数体、不触碰 0001–0016 已发布迁移的 checksum（§8.1"只追加新版本"）。(1) **synthetic_fixture**：jobs 新增 `synthetic_fixture INTEGER NOT NULL DEFAULT 0`；v1 旧行按 `kind IN ('echo','smoke')` 回填 1（v1 message-only fixture 运行，输出内联在 payload），使审计/统计可区分真实实验与 fixture；新 echo/smoke 作业由 submitJob 写入 1，非 fixture 新行恒 0。(2) **unsigned_legacy**：jobs 新增 `signature_status TEXT`（**仅旧行使用**；新行保持 NULL，仍由 runs.signature_status 的 pending/signed/unsigned 治理）：run_manifest 存在但无签名的旧作业（v1 manifest 均早于签名强制）与 succeeded 且无任何 manifest 的非 fixture 旧作业（早于 RUN-01 run_manifest_required）回填 `legacy_unsigned`；runs 表 `signature_status='unsigned'` 的旧行（0017 之前终结，必早于"必签 Manifest"默认化）与 `'pending'` 但携带无签名 manifest 的不一致旧行同样回填 `legacy_unsigned`——默认开启后旧数据不被误判为新违规。(3) **旧 log→final log Artifact**：jobs 新增 `legacy_log_artifact TEXT`；v1 一次性 stdout/stderr（存于 jobs.payload 字符串键 `stdout`/`stderr`/`output`）在迁移时经 openDatabase/runMigrations 注入的 casRoot **写入 CAS** 并创建 `kind='log'` Artifact 行（media_type text/plain、file_name `legacy-run-<job_id>.log`、metadata `legacy_log:true`），引用以 `sha256:<hex>` 记在 job 上；**不伪造 terminal frames**（§4 帧语义只属于真实运行）。CAS root 不可用时只写 `legacy:in-payload` 标记，绝不创建引用缺失 Blob 的 Artifact 行（避免 STORAGE-07 完整性扫描误报 missing blob）。验证：tests/unit/migrations.test.ts（v1 fixture 全链标记+Artifact+CAS 一致、rewind 幂等、新行不受回填影响、无 CAS 标记路径）。v1 fixture（tests/fixtures/databases/v1-kernel.db，由 build-v1-fixture.mjs 重建）新增 echo/smoke 作业、无签名 manifest 作业与 payload 内联日志字段。

## 10. 备份、恢复与完整性扫描

备份包含 SQLite consistent backup、CAS inventory、schema version 和 instance metadata。恢复后运行：foreign_key_check、Artifact Blob existence/hash、跨项目引用、Job lease/run_id、Decision Principal、Evidence provenance、Workspace/Tex manifest/file refs、PTY generation/expiry、Config hash、Intake adoption completeness、Trajectory cursor/event uniqueness、Bundle hashes。

Kernel kill -9 后 WAL 恢复必须保持 Gate、Job、Terminal/PTY exit、Workspace/TeX revision、Adoption、Config revision 和 Outbox 一致。恢复流程不得把 running 直接视为 succeeded；过期 lease 进入 retryable，in-progress adoption 只能重驱同一 transaction 或回滚。

### 10.1 Workspace 崩溃恢复协议（WORK-01 §5 P2，migration 0018）

workspace 的每次 mutation 是**两种介质上的两个提交**：磁盘字节的原子写（临时文件+rename / rename / unlink）与 SQLite 的 `workspace_nodes` row + `workspace_ops` ledger 更新。两者之间崩溃会留下两个窗口——"磁盘新字节+旧 row"（rename 已完成、row 更新未落）或 "row 指向缺失字节"（unlink 已完成、row 删除未落）。恢复协议 = **op-ledger 回放 + 启动恢复扫描**（`WorkspaceStore.scanWorkspaceIntegrity()`，kernel 构造期自动运行（`KernelOptions.recoverWorkspacesOnOpen`，默认 true）+ 按需调用；每 workspace 的修复在单事务内应用，全部幂等——double-scan 收敛到同一状态）。

**ledger 可回放性**：`workspace_ops` 已记录的内容足以回放——create/write 携带目标 `version`+`sha256`，delete 携带被删 `version`+`sha256`，move 携带目标 `path`+`from_path`+`version`+`sha256`；每个路径的"最后一条 op"即该路径应处的状态。无需扩展 ledger 字段。

**逐窗口处理**（对每个 fs/DB 边界）：

- **写（rename 后、row 更新前）**：磁盘新字节 + 旧 row → 按磁盘字节前滚 row（version+1、hash/size/media 取自字节、补记 write op、revision+1）。二进制节点要求新字节已在 CAS（writeBinary 先 `cas.put` 再 rename）；新字节不在 CAS → 视为篡改，从 CAS 恢复**已提交**字节。
- **row 指向缺失字节**：
  - 二进制 → 从 artifact CAS 恢复精确字节（blob_sha256 即内容寻址副本）；
  - 文本且本版本字节保留于 history（`{path}@{version}`——只有 delete 路径先 keepHistory 再 unlink）→ 前滚完成 in-flight delete（删 row、补记 delete op；undo 经 readVersion 仍可回退）；
  - move rename 已发生但未落库 → 孤儿文件 hash 与源 row 匹配 → 回滚 re-associate（rename 回源路径）；目标 row 已插入（同 hash 兄弟 row 持有磁盘字节）→ 前滚完成 move（删源 row、补记 move op 带 from_path）；
  - 无任何可证副本 → **隔离**。
- **孤儿磁盘文件（无 row 无 op 且非 move 目标）**：未提交的 create（rename 完成、row insert 未落）→ 回滚删除。
- **已删 row 但缺 delete op**（row+字节已无、op 未落）→ 补记 delete op，ledger 保持完整历史。
- **磁盘字节等于某更早 ledger 版本**（operator 从 history 恢复过）→ row 回滚到该版本（op 已存在，不补记）。
- **孤儿 `.ws-tmp-<8hex>`**（树内 + `.ws-meta` 历史区）→ 删除；被 row 覆盖的同名文件不误删。
- **超上限文件 / 树内 symlink**：外部篡改——有 CAS 副本则恢复，否则隔离。

**隔离语义**：无法可证修复时把 `workspaces.quarantine = <reason>` 落库（migration 0018 引入该列时为 SCHEMA_VERSION 16；当前 0019 后为 17，幂等 ensureColumn；0011 已发布 WORKSPACE_DDL 不原地改，store 自身连接用同款存在性检查收敛——STORE-08）。隔离 workspace 的一切读写/move/delete/history/watch/快照拒绝（HTTP 503 `workspace_inconsistent`）直到字节恢复后下一次扫描干净收敛自动清除（自愈，无手工 flag）。列由 0018 增加，旧库升级即得。

**验证**：tests/unit/crash-recovery.test.ts 11/11（全窗口 + 双扫幂等 + 重启持久 + 自愈）、tests/unit/workspace-store.test.ts 16/16、tests/unit/workspace-search.test.ts 12/12（内容搜索，WORK-01）、tests/unit/backup.test.ts 2/2、tests/unit/migrations.test.ts 17/17（0018 workspace 隔离 + 0019 Project tombstone 列/索引及 rewind 幂等）、tests/security/run-workspace-tests.sh 48/48（ws-crash-recovery 3 断言：真实 kernel 进程 kill+重启同 dataDir——启动隔离 503、恢复字节自愈、rename-before-row 前滚 v2；ws-content-search 7 断言）。

**Fleet 侧**（§5 P2 附项）：`InMemoryAgentRegistry`、`RemoteFleetServer` 的 pending/outstanding/stages/claimedJobIds 与代理端 `AgentOutboundSpool` 全部为内存态（无磁盘 spool）。重启丢失按既有 lease 过期语义自愈，不引入大持久化框架：agent 重启后重新 register/heartbeat；fleet 重启后 kernel lease 过期（默认 300s TTL）→ 旧 claim 后续写入 409 lease_stale、job 回 queued retryable → fleet 重新 claim 分发；spool 内存条目随 agent 进程丢失 → terminal 帧缺 seq（kernel retention/gap 语义兜底），业务终态仍由 complete/cancel transaction 决定（详见 remote-runner-wire.md §5.3 / execution-runtime.md §5.1）。

## 11. Init、Intake upload、Provider 与 OCR 增量

后续 migration 只追加、不改已发布 checksum，并至少包含：projects.brief_status（collecting/confirmed）；intake_artifact_stages（stage/intake/project/owner/file/expected size+hash/committed offset/state/temp uri/expiry/finalized artifact）；model_providers（global descriptor、SecretRef metadata、revision）；project_model_bindings（purpose/provider/model/revision）；ocr_requests（source/provider/model/config pin/status/result/safe error/idempotency）。

stage 创建按 expected_size 事务预留 Intake 配额；finalize 与 intake_artifacts 写入原子，失败不泄漏权威 Artifact。Provider/OCR 记录不得保存 secret value。备份/恢复与 integrity scan 必须覆盖开放 stage offset/temp 文件、binding foreign key、OCR config pin 和终态 result ref；GC 只删除 expired/aborted 临时文件，不触碰已采用或共享 Blob。

## 12. Reproduction、Execution Environment 与 Session PTY 增量

追加 `reproduction_specs`、`reproduction_attempts`、`reproduction_reports`、material/source link、`runner_targets`/`runner_profiles`/Config revision，并为 `pty_sessions` 增加 context_kind/context_id/parent_session_id 与 `(project_id,context_kind,context_id)` 索引。Spec/Attempt/Report 各自保存 canonical hash、revision/idempotency、Principal、Artifact refs；Report 不可变。Target/PTY 只保存 SecretRef metadata/token hash，不保存 SSH key/token 明文。

恢复检查开放 attempt/lease/report ref、target/environment pin、PTY context/generation/lease expiry；同一 context 多 PTY 不互相覆盖。删除/retention 不得破坏 Report、signed RunManifest、released Bundle 或共享 Blob。
