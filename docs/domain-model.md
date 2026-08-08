# 领域模型与状态机

> 规范性文档。所有外部写入必须由这里定义的 Schema 校验；数据库行和 HTTP 负载不得引入未定义语义。

## 1. 通用约定

- 时间：UTC ISO 8601，数据库保留毫秒；UI 按活动 locale 和 time zone 格式化。
- ID：小写前缀加不可预测后缀，例如 rsp_、gate_、job_、run_、artifact_、claim_、doc_、build_。
- Hash：sha256: 加 64 位小写十六进制。
- Revision：从 0 开始的整数，并发修改使用 expected_revision 或 expected_version。
- JSON：安全关键对象拒绝未知字段；自由 metadata 只能放在明确的 metadata 对象中。
- Project ownership：所有业务对象除 BlobObject 外都有 project_id，跨对象引用必须同项目。

## 2. ResearchProject

~~~yaml
project_id: rsp_xxx
name: Example Study
workspace: /display-only/path
mode: gate-only
status: DRAFT
revision: 0
brief:
  problem: required string
  scope: required string
  questions: []
  primary_metrics: []
  target_outputs: [conference-paper]
  target_venue: null
  baseline_repo: null
  domain: machine-learning
constraints:
  datasets: public-only
  external_model_upload: prohibited-for-private-data
  max_model_cost_usd: 250
  max_gpu_hours: 120
  max_parallel_jobs: 4
execution:
  runner_profile: local-docker-cpu
  runner_network_policy: none
  connector_network_policy: scholar-allowlist
  artifact_store: local-cas
integrity:
  require_baseline_reproduction: true
  require_experiment_contract: true
  require_claim_evidence_links: true
  require_signed_manifest: true
  require_clean_room: true
  automatic_release: false
session_id: optional
dsh_workspace_id: optional
fixture_id: null
created_at: timestamp
updated_at: timestamp
history: []
~~~

Project name 去除首尾空白后长度 1–120。archive 是可恢复动作；ARCHIVED 项目默认只读，unarchive 恢复 archive 前状态。

## 3. 状态机

状态全集：DRAFT、SCOPED、SURVEYING、IDEATING、IDEA_APPROVED、BASELINE_REPRO、CONTRACT_PENDING、CONTRACT_APPROVED、EXPERIMENTING、EVIDENCE_READY、WRITING、REVIEWING、RELEASE_READY、RELEASED、BLOCKED_GATE、STOPPED、FAILED、ARCHIVED。

~~~mermaid
flowchart LR
  DRAFT -->|Scope Gate| SCOPED --> SURVEYING --> IDEATING
  IDEATING -->|Idea Gate| IDEA_APPROVED --> BASELINE_REPRO --> CONTRACT_PENDING
  CONTRACT_PENDING -->|Contract Gate| CONTRACT_APPROVED --> EXPERIMENTING
  EXPERIMENTING --> EVIDENCE_READY --> WRITING --> REVIEWING --> RELEASE_READY
  RELEASE_READY -->|Release Gate| RELEASED
~~~

通用 transition 允许主路径的非 Gate 状态，以及明确的 Refine、Stop、Fail 路径。SCOPED、IDEA_APPROVED、CONTRACT_APPROVED、RELEASED 永远不能成为通用 transition 的目标。mutation 必须携带 expected_revision；冲突返回 revision_conflict。

## 4. Gate 与 Decision

Gate 类型：scope、idea、contract、budget、release。

~~~yaml
gate_id: gate_xxx
project_id: rsp_xxx
type: contract
title: Approve experiment contract
summary: human-readable summary
target:
  type: experiment_contract
  id: expc_xxx
  version: 1
payload: {}
status: pending
requested_by:
  kind: agent
  id: agent_xxx
created_at: timestamp
decided_at: null
~~~

Decision 必须包含 decision_id、project_id、gate_id、principal、decision、reason、diff、request_id 和 decided_at。principal 至少包含 principal_id、tenant_id、auth_method 和 session_id。reject/revise 必须有 reason。

一个 Gate 只有一个终态 Decision。批准事务同时校验 Principal、冻结 target version、更新 Gate、持久化 Decision、推进 Project revision 并写 Outbox。Principal 必须持久化，不能只存在响应对象中。

## 5. Corpus

Paper 使用规范化 paper_id，优先 DOI，其次 arXiv ID，再用来源 ID。source 是 openalex、crossref、arxiv、semantic-scholar 或 user。Passage 必须携带 paper_id、定位、文本、内容 hash，并固定 is_untrusted=true。

CorpusSnapshot 包含 snapshot_id、project_id、schema_version、查询及时间、每源状态、Paper、Passage、citation_edges、external_claims、coverage 和 frozen=true。创建后不可编辑；新调研产生新快照。任一来源失败必须保存在 source_status。

标题去重顺序为 NFKC、Unicode case fold、字母数字保留、标点和空白归一；不得使用只支持 ASCII 的规则。

## 6. IdeaCard

必填字段：idea_id、project_id、version、corpus_snapshot_id、title、hypothesis、exact_delta、falsification.observation、minimum_viable_experiment、scores 和 status。

MVE 必须包含 dataset_ref、baseline_ref、primary_metric 和 estimated_gpu_hours。Novelty Audit 保存查询、结果、重叠论文和未解决风险。Idea 进入 Gate 前必须绑定冻结 Corpus、至少一个最近邻、明确反证、可执行 MVE 和数据或伦理评估。

## 7. ExperimentContract

~~~yaml
contract_id: expc_xxx
version: 1
project_id: rsp_xxx
idea_id: idea_xxx
status: approved
code_snapshot_id: code_snap_xxx
data:
  dataset_id: fixture-v1
  version: v1
  split: official
  artifact_id: artifact_xxx
  preprocessing_hash: sha256:...
methods:
  baseline: baseline_b
  treatment: method_a
metrics:
  primary:
    name: macro_f1
    direction: higher_is_better
    aggregation: mean
    unit: ratio
  secondary: []
seeds: [11, 23, 47, 89, 101]
analysis:
  paired_by: seed
  effect_size: mean_difference
  interval: bootstrap_95
  multiple_testing: holm
stop_conditions:
  max_gpu_hours: 48
  min_completed_seeds: 5
  stop_on_data_leakage: true
tolerances:
  macro_f1:
    absolute: 0.001
    relative: 0.01
runner:
  profile: local-docker-cpu
  image_digest: sha256:...
approval:
  gate_decision_id: dec_xxx
  principal_id: user_xxx
  approved_at: timestamp
~~~

approved Contract 不可原地修改。任何口径、Seed、镜像、数据或主指标变化都创建新版本并重新 Gate。

## 8. Blob、Artifact 与 Snapshot

BlobObject 只有 sha256、size_bytes、storage_uri、created_at，是全局内容对象。ProjectArtifact 包含 artifact_id、project_id、blob_sha256、kind、media_type、file_name、metadata、created_at，是授权和 provenance 单位。

Artifact kind 至少支持 code、pdf、data、log、model、chart、paper、analysis、manifest、bundle、tex-source、bib、compile-log、compile-aux。

CodeSnapshot 和 TexWorkspaceSnapshot 都保存实际内容的 archive Artifact 与 manifest Artifact。Manifest 文件路径是根相对 POSIX 路径，拒绝绝对路径、..、NUL、设备、FIFO 和越界 symlink。

## 9. Job、Lease 与 RunManifest

Job kind：echo、smoke、baseline、pilot、formal、analysis、reproduce、latex-compile、clean-room。Job status：queued、running、succeeded、failed、cancelled、retryable。项目内 idempotency 唯一键为 project_id + idempotency_key。

JobSpec 至少包含 project_id、contract_id 可选、kind、idempotency_key、command 数组、payload、code_snapshot_id、data_artifact_ids、image_digest、output_contract、max_attempts。正式实验必须有 approved Contract、快照和固定 digest；latex-compile 必须有 TexWorkspaceSnapshot 和固定 TeX image digest。

Job 还必须持久化 created_by_principal_id；researcher 的 own cancel 以此字段判断。full-auto 项目必须有 fixture_id，且所有 Job 绑定同一受信任 fixture profile；无 fixture_id 的 full-auto 创建直接 422。

Lease 包含 owner、generation、opaque token、expires_at 和 heartbeat_at。每次重新 claim 增加 generation 并生成新 token。

RunManifest 必须包含 run_id、project_id、job_id、contract 和版本、代码或 TeX 快照 hash、image digest、数据 hash、命令、Seed、资源、时间、exit_code 或 signal、Artifact 引用、lease generation、runner_key_id、payload hash 和 Ed25519 signature。

## 10. TerminalLog

TerminalLog 是 Job 的有序附属流，不是聊天文本。

~~~yaml
job_id: job_xxx
run_id: run_xxx
seq: 42
stream_seq: 21
channel: stdout
text: "epoch 2...\n"
byte_offset: 8192
created_at: timestamp
lease_generation: 3
~~~

seq 在单个 run 内严格递增，保留 stdout 和 stderr 交错顺序；stream_seq 用于单通道校验。终态 frame 为 exit，包含 exit_code 或 signal、cancelled、timed_out、truncated、total_bytes、dropped_bytes。旧 lease frame 拒绝写入。

日志可有保留上限，但删除必须产生 gap 或 truncated 元数据；禁止静默丢失。最终完整或明确截断的日志保存为 Artifact。

## 11. Evidence 与 Claim

EvidenceItem source_type 为 run、analysis、external-passage、reproduction；provenance_status 为 draft_unverified、legacy_unverified、verified、accepted、rejected。只有 Analysis Worker 服务身份可创建 verified，只有确定性校验与 Auditor 流程可转 accepted。

正式分析 Evidence 至少包含 contract_id、analysis_plan_id、RunSet、Artifact refs、metric direction、baseline 和 treatment mean、effect_size、CI、n_pairs、adjusted_p_value 和 worker provenance。

Claim status：proposed、supported、contradicted、inconclusive、retracted。默认 proposed；验证缺方向、效应、CI、最小样本或 accepted Evidence 时必须 inconclusive。历史追加，不覆盖。

## 12. TeX 文档模型

TexDocument 包含 document_id、project_id、name、root_path、active_manifest_id、revision、last_build_id、created_at、updated_at。

TexFileRevision 包含 document_id、path、kind、version、blob_sha256、media_type、size、author Principal、created_at。kind 为 tex、bib、sty、cls、image、generated 或 other。

保存请求必须提供 expected_version。版本不匹配返回 document_version_conflict，并带 current_version、current_hash 和可选 diff；服务器不能自动覆盖。

TexBuild 包含 build_id、document_id、input_manifest_id、job_id、status、engine、passes、diagnostics、pdf_artifact_id、log_artifact_id、aux_artifact_ids、started_at、finished_at。PDF 是否新鲜由 input_manifest_id 等于 active_manifest_id 决定。

Diagnostic 包含 severity、file、line、column、code、message、raw、pass。用户可见的本地诊断 code 可以翻译；TeX 原始消息必须原样保留。

## 13. Budget

预算记录 model_cost_usd、gpu_hours、api_requests、storage_bytes 和 updated_at。增量必须非负并在事务内原子累计。越限时同一事务把项目置 BLOCKED_GATE、创建 Budget Gate 并写 policy.violation Outbox。恢复状态只接受 Gate payload 中经过校验的 resume_to。

## 14. Outbox Event

事件包含 event_id、project_id、kind、source、payload、created_at、delivered_at。业务事务和对应事件原子提交。消费是 at-least-once，消费者按 event_id 去重。

事件族：project.*、gate.*、artifact.*、job.*、terminal.*、corpus.*、idea.*、contract.*、evidence.*、claim.*、manuscript.*、tex.*、budget.*、policy.*、session.*。DSH SessionEvent 可承载展示和关联事件，但 Kernel Outbox 始终是科研业务审计权威。
