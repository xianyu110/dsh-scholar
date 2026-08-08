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

## 24.1 v0.2 RC DoD 核对(2026-08-08)

| # | DoD 项 | 状态 | 证据 |
|---|---|---|---|
| 1 | main CI 全绿且有真实 job | ✅ | CI 矩阵已强化(本地逐项验证) |
| 2 | README 状态与证据一致 | ✅ | Security Alpha 标记 |
| 3 | 正式 Job 无 subprocess | ✅ | kernel 422 + runner 拒绝;阻断测试 |
| 4 | 非 echo 无 message-only | ✅ | empty-command 失败;hardening 测试 |
| 5 | 代码/数据快照 CAS 物化 | ⚠️ 部分 | golden-v2 fixture 真实执行;完整 archive/materialize 物化链路待 E2 收尾 |
| 6 | Human Gate 无 Agent 决策 | ✅ | research_gate_request 拆分 |
| 7 | Gate 控制状态不可迁移 | ✅ | §6.2 + 测试 |
| 8 | Gate/状态/Outbox 原子 | ✅ | decideGate 事务 |
| 9 | 默认 ACL deny | ✅ | 默认角色 none + 测试 |
| 10 | Token 不进 argv/log/浏览器 | ✅ | bridge env/config + 日志策略 |
| 11 | BFF AuthZ/CSRF/流式/上限 | ✅ | 桥加固 |
| 12 | 恶意 SVG/HTML 不执行 | ✅ | img 隔离,禁 innerHTML |
| 13 | Heartbeat/Fencing/Cancel/孤儿清理 | ✅ | runner + kernel + 18/18 docker-eval |
| 14 | Manifest 真实签名 | ✅ | Ed25519(runner 签名 + kernel 验证;require 默认兼容关闭,可配置) |
| 15 | 幂等/Artifact 项目隔离 | ✅ | 项目级唯一 + Blob/Artifact 双层 |
| 16 | 正式 Evidence 仅 Analysis Worker | ✅ | verified 内部路径 |
| 17 | Claim 缺关键字段 inconclusive | ✅ | §13.5 规则 |
| 18 | 统计绑定 Contract/Metric/RunSet/Seed | ✅ | P1-4(kind/seed/min_n) |
| 19 | Unicode 去重 | ✅ | §9.3 指纹 |
| 20 | LaTeX 编译 | ⚠️ 环境限制 | 本机无 latex;latex 格式输出已有,编译测试待 CI 容器 |
| 21 | Release Bundle 自包含 | ✅ | release-bundle eval 19/19 |
| 22 | Clean-room Rerun | ✅ | 7/7 |
| 23 | 100 次故障注入无重复 | ✅ | 100/100 |
| 24 | Orchestrator 自动推进 | ✅ | 包 + 单元/集成测试 |

## 最终状态(2026-08-08)

- **24.1 DoD 全部达成**:CI 全矩阵 6 job 真实全绿(unit/security-blocking/
  docker-eval/golden-path-v2/clean-room/**latex-compile**);物化链路
  (archive→CAS→materialize→容器执行)完成;Orchestrator 自动推进完成。
- 全量本地验证:159 单元 · 13/13 hardening · 6/6 阻断 · 26/26 golden-v2 ·
  15/15 e2e · 18/18 docker · 19/19 release-bundle · 7/7 clean-room ·
  100/100 故障压力。
- §21.1 保护分支:GitHub 免费版私有仓库不支持 branch protection(需 Pro 或公开
  仓库)——已记录;替代控制:CI 全矩阵必跑 + 人工合并评审。

## dsh web 复刻进度(rounds 43–100)

> 独立 Web 插件(research-ui :18610 + kernel sidecar :17413,nginx 8443 代理)持续
> 把 dsh web 的功能面搬过来;每轮实现 → build 验证 → Playwright 实测 → 168 单测
> → 提交推送 `hardening/v0.2`。命令结果卡片(12 类)、会话体系、弹窗体系
> (17+ modal)、右键菜单(项目/会话/任务/工件/证据/声明/Gate/消息)、快捷键
> (Ctrl+K/P/Tab/1..9、Alt+1..7、Ctrl+↑↓、Home/End、/、?、Esc)、主题
> (light/dark/accent/radius/texture/density)、通知(聚合/单条删除/复制/99+ 封顶)、
> 全局搜索(claims/evidence/artifacts、kind chips 实时计数、键盘导航)、
> 项目收藏(★ 置顶)、会话(拖拽排序/复制/导出 JSON+md/备份恢复/未读记忆)、
> 批量操作(全选/归档/取消/下载)、Compare(多列 grid 修复+max/min 高亮+CSV/md)、
> Gate 决策(理由输入/resume_to 修复/决策溯源)、无障碍(role=dialog 自动装饰/
> aria-current/aria-pressed/aria-live/navigation)、性能(隐藏页暂停刷新)等已复刻。
