# RemoteRunnerAgent Wire 协议

> 规范性文档（RUN-REMOTE-01，execution-runtime.md §5.1 的实现契约）。
> 定义受控远端 Runner Fleet 的服务端（RemoteFleetServer，runner-gateway）与
> 代理端（RemoteAgent 客户端）之间的 HTTP+JSON wire 协议。全部消息 schema
> 为 zod（`@dsh-scholar/research-schemas/remote-runner-wire`），两端共享同一
> 份 schema——协议层完整可测。

## 1. 目标与非目标

目标：

- 同一 ExecutionPlan / lease / run_id / Manifest 跨 Local/Remote 一致：远端
  路径与本地 runner 走同一 kernel claim/frames/artifact/complete 路径；
- 离线 fail closed 且不静默降级：target offline / capability mismatch 返回
  明确 retryable 环境错误；没有显式 PI/Operator 新 attempt 时不回退
  LocalDocker，更不回退 subprocess；
- 协议层（schema + 服务端 + 代理端 + mock 传输）完整可测。

非目标（本阶段如实记录，属后续阶段）：

- 真实 mTLS 证书链与 CA 签发/吊销（本阶段用 `x-service-token` 等价实现，
  见 §3）；
- 真实远端 sandbox 的隔离验收（容器/虚机/裸金属差异）；
- 网络分区故障注入的集群级验证（mock 传输层已覆盖断网/恢复语义）。

## 2. 角色与生命周期

```
┌─────────────────────────┐   wire（HTTP+JSON）   ┌──────────────────────┐
│  Research Kernel        │◄──────────────────────►│  RemoteFleetServer   │
│  (job/lease/frames/     │   kernel client        │  (runner-gateway)    │
│   artifacts/manifest)   │                        └──────────▲───────────┘
└─────────────────────────┘                                   │ /v1/agents/*
                                                              ▼
                                              ┌──────────────────────┐
                                              │  RemoteAgent 客户端   │
                                              │  (register/heartbeat/ │
                                              │   claims/执行/spool)   │
                                              └──────────────────────┘
```

- 服务端从 kernel 按既有 `claimJobs` 路径拉取 Job（同一 lease owner/
  generation/token/run_id），固定并**签名 ExecutionPlan**，按 agent 的
  target_id + capability 匹配分发；
- 代理端验签 → 拉取 CAS 输入并复算 hash（不一致拒绝执行）→ 隔离 sandbox
  执行 → 按 generation/token 上报 frames、stage/finalize Artifacts、
  complete；
- 服务端把 frames/artifacts/complete 原样转发 kernel（与本地 runner 同路径，
  kernel 的 lease fencing 是最终权威）。

## 3. 传输与认证

生产必须双向 mTLS service identity（服务端持有 CA 签发证书，客户端持有
service 证书；撤销即断开）。**本阶段环境无 CA/mTLS 设施**，本地 wire 用
`x-service-token` 头等价实现——与 kernel 内部路由（API-01/EVID-01）同一
机制：配置 serviceToken 后所有 `/v1/agents/*` 路由要求该头，常数时间比较，
缺失/错误 → 403 `service_token_required`。

生产差异（如实记录）：

- `x-service-token` 只证明"持有共享密钥"，不证明 agent 身份；生产必须替换
  为 mTLS 证书指纹校验（`RemoteAgentRegistration.cert_fingerprint` 已为远程
  Agent 预留必填语义）；
- 真实证书吊销/轮换/跨租户隔离未验收。

## 4. 端点

所有路径前缀 `/v1/agents`。除 CAS 外均为 JSON POST；错误面统一
`{ "error": { "code", "message", "retryable" } }`（§7）。

| 方法 | 路径 | 请求/响应（wire schema） | 语义 |
|---|---|---|---|
| POST | `/v1/agents/register` | `AgentRegisterRequest`/`AgentRegisterResponse` | 注册（capabilities/labels/health/cert_fingerprint）；`acknowledged=true` 表示服务端认可该 target |
| POST | `/v1/agents/{agent_id}/heartbeat` | `AgentHeartbeatRequest`/`AgentHeartbeatResponse` | 心跳（可携带 draining、更新 capability/labels）；未注册 → 404 `agent_not_registered` |
| POST | `/v1/agents/{agent_id}/claims` | `AgentClaimRequest`/`AgentClaimResponse` | 拉取匹配 claim（含签名 ExecutionPlan + lease generation/token）；空数组 = 无工作 |
| POST | `/v1/agents/{agent_id}/runs/{run_id}/frames` | `RemoteFramesRequest`/`RemoteFramesResponse` | terminal frames（kernel 语义：全局 seq 单调、chunk/gap/exit、retention 记账） |
| POST | `/v1/agents/{agent_id}/runs/{run_id}/artifacts` | `RemoteArtifactStageRequest`/`RemoteArtifactStageResponse` | stage：声明 sha256/size/kind/元数据，不携带内容 |
| POST | 同上（finalize 分支） | `RemoteArtifactFinalizeRequest`/`RemoteArtifactFinalizeResponse` | finalize：携带内容，服务端复算 sha256 比对（不一致 → 409 `cas_hash_mismatch` 不落库） |
| POST | `/v1/agents/{agent_id}/runs/{run_id}/complete` | `RemoteCompleteRequest`/`RemoteCompleteResponse` | 完成：签名 run_manifest + fencing 字段；kernel 拒绝 → 409 |
| GET | `/v1/agents/{agent_id}/cas/{sha}?project_id=` | `CasFetchResponse` | CAS 拉取：响应携带服务端复算的 sha256，代理端必须复算比对 |

`/v1/agents/{agent_id}/runs/{run_id}/artifacts` 按 body 区分分支：含
`stage_id` + `content_base64` → finalize；否则 → stage。

## 5. 语义

### 5.1 claim：匹配、保留与 fencing

- 分发条件：`plan.target_id === agent.target_id`（精确）+ `matchesTargetCapability`
  （images/os/arch/runner_ver 下限）+ agent 在线（`isTargetAvailable`）；
- **无匹配 target → 任务留在服务端 pending（retryable），绝不静默改派到其它
  target / LocalDocker / subprocess**；pending 有界（`maxPendingJobs`），
  lease 过期后由 kernel 侧 `recoverExpiredLeases` 回收为 retryable；
- claim 分发的任务进入 outstanding（按 agent 保留）：**agent 断连期间服务端
  保留任务，恢复后 resume 返回同一 claim（同一 claim_id/run_id/lease）**；
  单 agent outstanding 有界（`maxOutstandingPerAgent`）；
- claim 响应中的 ExecutionPlan 由服务端签名（Ed25519，§12.7 同源语义）；
  代理端必须验签，缺签名/验签失败/未配置公钥 → 拒绝执行。

### 5.2 frames：kernel terminal 语义复用

- 全局 seq 单调（幂等回放/乱序跳过由 kernel 执行）、stream_seq 按通道、
  chunk/gap/exit、byte offset/length、`lease_generation` 逐帧携带；
- `owner`/`lease_token` 在请求级携带——服务端逐条核对 claim 的 lease，
  kernel 侧再按 job 当前 lease 精确匹配（409 `lease_stale`）；
- 服务端转发复用本地 runner 的 lease 头路径（`appendTerminalFramesWithLease`）；
- 淘汰/溢出由 kernel retention 记账（truncated/total_bytes/dropped_bytes）。

### 5.3 代理端离线 spool（有界）

网络断开（`transport_unreachable` 等 retryable 传输错误）时代理端把
frames/stage/finalize/complete 保存到本地有界 spool（`maxEntries`/
`maxBytes`，默认 256 条 / 4 MiB），恢复后按序重放：

- 只有 `frames`（chunk 数据）条目可淘汰；淘汰时记录该 run 的 overflow 区间，
  **重放前先补发 gap frame**（`frame_kind='gap'`，payload 带
  dropped_from_seq/dropped_to_seq/dropped_bytes/reason=`agent_spool_overflow`）
  ——kernel retention 记账可见，不静默丢弃；
- `exit_frame` / `artifact_*` / `complete` 条目不可淘汰——spool 满时 push 被
  拒绝，该 run 本地失败（fail closed，无合成成功）；
- **complete 必须是该 run 的最后一条 wire 消息**：发送 complete 前先冲刷
  spool；若该 run 仍有 spool 条目（网络仍断），complete 强制入队（顺序保证）；
- 重放时 `lease_stale` 条目视为死条目丢弃并继续（该 run 已被新 attempt
  接管，留在队列只会阻塞后续条目）；该 run 的 log artifact 与 complete 是
  权威输出记录；
- resume 幂等：断连恢复后 poll 回放同一 claim 时，代理端按 run_id 返回已存
  结果，不重复执行。

### 5.4 artifacts：staged + finalize + sha256

- stage 只声明 `sha256`（64 位小写 hex）/`size`/`kind`/元数据；finalize 携带
  内容，服务端复算 sha256 并与 stage 声明比对——不一致 → 409
  `cas_hash_mismatch`（不落库）；size 不一致 → 409 `cas_size_mismatch`；
- stage 表有界（`maxStages`）；finalize 内容上限 32 MiB（与 UPLOAD-01 同一量级）；
- 代理端自生成 `stage_id`（跨 spool 重放保持一致）。

### 5.5 complete：manifest 签名 + fencing

- `run_manifest` 必须携带 `signature`/`payload_sha256`/`signed_by`（§12.7，
  kernel 验签）并携带 `lease.generation/token`；
- lease 过期后旧 agent 的 complete 被 kernel 拒绝（409 `lease_stale`）——
  服务端把该 claim 置 settled，旧 agent 的后续 frames/stage/finalize/
  complete 一律 409；**旧 agent 只能丢弃或保留本地诊断，不能完成 Job**。

### 5.6 CAS

- 按 artifact id/sha 寻址（支持 `sha256:<hex>` / 裸 64-hex；注册 id 由 kernel
  侧解析，当前 mock 按 id 直查）；
- 响应携带服务端对内容的 sha256；代理端复算内容 hash 并与响应比对，再与
  寻址 hash（当 id 为内容 hash 形态时）比对——任何不一致 → 拒绝执行；
- 404 `cas_missing` 由代理端视为输入缺失（拒绝执行）。

## 6. 服务端离线判定

`AgentRegistry`（内存实现）持有注册记录（opaque target_id/agent_id/
capabilities/labels/health/cert_fingerprint；`.strict()` 拒绝
address/certificate/SSH bootstrap——连接信息只由服务端 Config/SecretRef
解析）。离线判定与调度纯函数同一规则：`health.status !== 'online'` 或
`last_seen` 超过 `offline_after_ms`（默认 30s）。offline agent 的 claims →
409 `agent_offline`（retryable）；心跳恢复 last_seen 后重新可用。

## 7. 错误面

统一 envelope：`{ "error": { "code", "message", "retryable" } }`。

| 状态 | code | retryable | 说明 |
|---|---|---|---|
| 403 | `service_token_required` | false | 缺/错 x-service-token（生产为 mTLS 校验失败） |
| 404 | `agent_not_registered` | true | 未注册 agent 的任意调用 |
| 404 | `claim_unknown` | true | 无 outstanding claim 的 run 写入 |
| 404 | `stage_unknown` | false | finalize 未知 stage |
| 404 | `cas_missing` | true | CAS 输入不存在 |
| 409 | `agent_offline` | true | agent last_seen 超时 |
| 409 | `lease_stale` | true | fencing 不匹配/settled claim（旧 agent 写入） |
| 409 | `cas_hash_mismatch` / `cas_size_mismatch` | false | 内容寻址完整性失败 |
| 409 | `stage_capacity` | true | stage 表满 |
| 413 | `payload_too_large` | false | 请求体/finalize 超限 |
| 422 | `validation_error` | false | wire schema 校验失败（.strict()） |
| 422 | `missing_project_id` | false | CAS 缺 project_id |
| 502/503 | `kernel_unreachable` | true | kernel client 调用失败 |

调用方对 retryable 错误必须把任务留在队列/标记重试——**绝不静默降级**。

## 8. 测试与实现证据

- 协议 schema：`packages/research-schemas/src/remote-runner-wire.ts`；
- 服务端：`workers/runner-gateway/src/remote-fleet-server.ts`
  （RemoteFleetServer + attachRemoteFleetRoutes + startFleetHttpServer）；
- 代理端：`workers/runner-gateway/src/remote-agent.ts`
  （RemoteRunnerAgentImpl + HttpRemoteFleetTransport + defaultSubprocessExecutor）；
- spool：`workers/runner-gateway/src/agent-spool.ts`；
- mock 传输：`workers/runner-gateway/src/in-memory-transport.ts`
  （InMemoryFleetTransport 直连服务端处理器 + JSON round-trip；
  FailingFleetTransport 断网/按方法故障注入）；
- 测试：`tests/unit/remote-wire.test.ts`（15 用例，mock 传输 + HTTP loopback；
  覆盖 §4/§5 全部语义）与 `tests/unit/remote-fleet.test.ts`（23 用例，接口层）。

**剩余（如实记录）**：真实 mTLS 证书链（CA/吊销/轮换）验收、真实远端
sandbox 隔离验收、跨主机网络分区故障注入、Remote PTY 与浏览器 UI
（hardening-v0.2-status.md §3 RUN-REMOTE-01）。
