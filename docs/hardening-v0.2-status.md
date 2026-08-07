# v2.0 Hardening 进度(DSH_Scholar_v2.0.md)

> 分支 `hardening/v0.2`;基线 `main` 快照 2e0677f;更新:2026-08-08。

## 已完成(含测试证据)

| Epic / Ticket | 状态 | 证据 |
|---|---|---|
| P0-1 禁宿主正式执行(E1/SCH-SEC-001) | ✅ | kernel 422 + runner 拒绝 formal 类 subprocess;`tests/security/run-hardening-tests.sh` 5/5 |
| P0-2 关闭假实验(E2/SCH-EXEC-001) | ✅ | 非 echo 空命令/message-only 失败;无合成指标 |
| P0-3 Human Gate(E3/SCH-GATE-001/002/003) | ✅ | Gate 控制状态不可通用迁移;`research_gate_request` 拆分;决策事务化+principal |
| P0-4 Evidence 可信化(E4/E9/SCH-EVID-001/002) | ✅ | `evidence_note_create`(draft_unverified);verified 仅 Analysis Worker;Claim 缺 effect/CI/n→inconclusive |
| P0-5 Web 安全(E5/SCH-WEB-001/002/SEC-002) | ✅ | Origin/CSRF、请求体上限、二进制流、SVG img 隔离 |
| P1-2 项目隔离(E7/SCH-DB-001/ART-001) | ✅ | `(project_id, idempotency_key)` 唯一;Blob/Artifact 双层(表重建迁移) |
| P1-3 事务化(E8/SCH-GATE-003) | ✅ | decideGate/recordUsage 单事务(含 Outbox/BLOCKED_GATE) |
| P1-8 Unicode 去重+失败透明(SCH-CONN-001) | ✅ | NFKC/case-fold/Unicode 字母指纹;source_status |
| Analysis Worker(§13) | ✅ | MetricSpec/RunSet/AnalysisPlan/配对 bootstrap/固定 metrics 文件解析 |
| Golden Path v2(§19.3) | ✅ | fixture 仓库 + docker 真实执行 + 确定性指标 18/18 |

## 进行中(本轮 subagent 并行)

| 任务 | 负责 | 文件边界 |
|---|---|---|
| P1-5 签名 Manifest + Fencing(SCH-MANIFEST-001/SCH-JOB-001) | subagent A | kernel/schemas/client |
| P1-1 Runner 心跳 + Cancel 容器(SCH-JOB-001/002) | subagent B | runner-gateway |
| P1-6 自包含 Release Bundle(SCH-REL-001) | subagent C | evals/release-bundle |
| P1-7 Durable Orchestrator(SCH-ORCH-001) | subagent D | workers/research-orchestrator |
| P0-6 CI 强化(SCH-CI-001) | subagent E | .github/workflows + package.json |

## 待办(全部完成后核对 24.1 DoD)

- P1-4 统计绑定收尾(computeAnalysis:seed 唯一/min_n/不混 kind)
- 24 项 v0.2 RC DoD 逐项核对
- README 状态与测试证据校准(§19.4)
- 合并回 main 前的保护分支策略(§21.1)
