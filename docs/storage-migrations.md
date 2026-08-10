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

### 3.1 Schema v2 初始 DDL

除 §4 Terminal 与 §5 TeX 表外，初始迁移必须等价于下列 DDL。JSON body 在写入前由 reconstruction-contracts.md 对应 Zod Schema 校验。

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

## 10. 备份、恢复与完整性扫描

备份包含 SQLite consistent backup、CAS inventory、schema version 和 instance metadata。恢复后运行：foreign_key_check、Artifact Blob existence/hash、跨项目引用、Job lease/run_id、Decision Principal、Evidence provenance、Workspace/Tex manifest/file refs、PTY generation/expiry、Config hash、Intake adoption completeness、Trajectory cursor/event uniqueness、Bundle hashes。

Kernel kill -9 后 WAL 恢复必须保持 Gate、Job、Terminal/PTY exit、Workspace/TeX revision、Adoption、Config revision 和 Outbox 一致。恢复流程不得把 running 直接视为 succeeded；过期 lease 进入 retryable，in-progress adoption 只能重驱同一 transaction 或回滚。
