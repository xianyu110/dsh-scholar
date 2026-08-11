# 验收与测试规范

> 规范性文档。任何新增需求或修复建议必须在这里增加可自动化或可重复人工执行的验收场景。

## 1. 测试层级

| 层级 | 范围 | 原则 |
|---|---|---|
| Unit | Schema、状态、统计、path、diagnostic parser、i18n | 纯函数和稳定错误 |
| Module contract | Kernel、Client、Runner、BFF、UI state | 通过模块接口，用真实 SQLite/CAS |
| Integration | DSH Agent composition、standalone sidecar/BFF、SSE、TeX | 多模块真实协议 |
| Security | AuthZ、CSRF、路径、容器、日志、self-mod | 阻断发布 |
| Recovery | kill -9、lease、stream reconnect、DB/CAS | 不丢状态、不重复执行 |
| UI | 两种 locale、keyboard、a11y、responsive | 用户可完成核心任务 |
| Scientific | RunSet、Evidence、Claim、引用、负结果 | 防止科研语义漂移 |
| Reproduction | Bundle、clean-room、PDF | 从空环境复现 |

## 1.1 两阶段验收策略

- **代码实现阶段**不要求开发机连接真实远端、mTLS CA、完整 DSH host、GPU、浏览器矩阵或生产 Docker/TeX 环境；实现者必须完成生产代码路径、build/typecheck、能运行的 unit/module/static checks，并为不可用环境写出确定的人工步骤、期望结果、失败判据和取证项；
- 环境不可用只能产生 `NOT_RUN_MANUAL_PENDING`，不能产生 PASS；它不阻塞后续代码实现、提交或合并，但状态最多为“已实现未验收”，并持续阻止发布；
- **人工验收阶段**按 `manual-acceptance.md` 执行。一次有效记录至少绑定 commit SHA、目标环境、操作者、时间、场景 ID、实际结果和证据位置；失败项回到 hardening 的“部分/未实现”，并先内化修复建议再改代码；
- CI 是可选的重复执行载体，不是开发实现的前置条件。环境具备后若运行 CI，仍适用零 SKIP、断言数大于 0 和 fail-closed 规则；人工验收不能把未执行场景批量勾选为通过。

## 2. Project 与 Gate

- create-project-defaults：gate-only、预算和 integrity 默认值正确；
- transition-revision-conflict：旧 revision 返回 409；
- gate-state-cannot-transition：四个 Gate 控制状态返回 422；五种 Gate type 均有独立流程；
- agent-cannot-decide-gate：工具目录和 Agent HTTP 无 Decision；
- human-principal-durable：Decision 重读仍有 principal/tenant/session；
- gate-atomicity：在 target/Gate/Decision/Project/Outbox 每个故障点均无部分提交；
- concurrent-decision：两个请求只有一个成功；
- budget-gate-resume：只允许 payload 声明的 resume_to。

## 2.1 结构化 NextAction（GUIDE-01）

- next-action-every-phase：17 个 ProjectStatus 每个至少投影一个 schema 合法动作，未知/未来状态退化 `code='unknown'` 的只读动作，不抛错、不生成 mutation CTA；
- next-action-code-stable：相同状态输入两次投影产生相同 code/id 集合（确定性机器码）；
- next-action-required-gaps：缺少前置条件（`approved_contract`、`succeeded_runs`、`proposed_idea`）时动作 `state=blocked` 且 `required` 列出缺失项，满足后转 ready；
- next-action-legacy-derivation：`next_actions: string[]` 与 `next_actions_v2` 中非 done 动作的 label 完全一致（终态为空数组），UI/API 旧消费端不受破坏；
- next-action-pending-gate：pending gate 产生 gate 决策动作（budget → `budget_resolve`，其余 → `gate_decide`），base 动作已引用的 gate 不重复；
- next-action-budget-block：预算超限 + pending Budget Gate → `budget_resolve` `state=blocked`、`required=['budget_headroom']`、`blocking=true`；
- next-action-failed-job：失败/retryable 作业产生 `job_retry`（attempts 未耗尽 ready；耗尽 blocked + `repair_decision`，capability=pi）；
- next-action-phase-flow：每阶段主动作与状态机一致——DRAFT→scope_gate_submit、SCOPED→survey_run、SURVEYING→idea_generate、IDEATING→idea_gate_approve、IDEA_APPROVED/BASELINE_REPRO→contract_register+baseline_reproduce、CONTRACT_APPROVED/EXPERIMENTING→pilot_formal_submit+evidence_verify、EVIDENCE_READY→manuscript_write、WRITING→reviewer_run、REVIEWING→release_bundle+release_gate、RELEASE_READY→release_gate、BLOCKED_GATE→gate_resolve（+budget_resolve）、FAILED→project_stop、ARCHIVED/RELEASED/STOPPED→done；
- next-action-revision：动作携带依赖对象 revision（gate 决策=project.revision，run 动作=contract version，idea gate=idea version）。

## 3. Project 隔离与 Artifact

- 相同 idempotency key 在两个项目生成独立 Job；
- 相同 Blob 在两个项目有独立 artifact_id 和授权；
- 跨项目 Artifact、Terminal、TeX、Evidence 读取返回 404；
- binary round-trip 对 PDF/image/random bytes hash 一致；
- malformed percent path 返回 JSON 400，不崩溃；
- CAS 原子写、重复 put、孤儿 GC、缺失 Blob scan。

### 3.1 单文件 Artifact Upload（UPLOAD-01 服务端/BFF 层，api-contracts.md §7）

- upload-success：真实 `curl -F` multipart（kind + file part）→ 201；artifact_id=`sha256:<hex>` 与内容 sha256 一致（hash 由服务端计算，客户端不可声明）；artifact GET 回读字节与上传字节完全一致；恰好 32 MiB 的文件上传成功；
- upload-too-large：>32 MiB（含 33 MiB 真实请求）→ 413 `payload_too_large`，错误消息含 limit 与实测字节数，不产生 artifact 行；降低 `ResearchKernel.UPLOAD_MAX_FILE_BYTES` 静态上限后同规则生效（可配置上限）；
- upload-path-traversal：filename=`../…`、绝对路径、NUL、Windows 盘符、含路径分隔符 → 422 `invalid_file_name`（两种分隔符均拒绝，execution-runtime.md §4 同源约束）；
- upload-multipart-validation：非 multipart Content-Type → 415 `unsupported_media_type`；boundary 缺失/畸形或 body 解析失败 → 400 `invalid_multipart`；缺 file part → 422 `missing_file`；多个文件 part → 422 `multiple_files`；kind 非枚举 → 422 `invalid_kind`；未知 project → 404 `project_not_found`（无枚举）；
- upload-hash-binding：stage 与 finalize 各复算一次 sha256 并核对；staged 字节被篡改（hash 不匹配）→ 422 `stage_corrupted` 且 staged 文件回滚、无 artifact 行、无 CAS blob；
- upload-staged-finalize：stage 后只存在会话 id 命名的 `stage_<id>.part/.json`（CAS root 下 staged-uploads/），无 artifact 行；finalize 原子 rename 进 CAS blob 槽并插行；缺 stage → 409 `artifact_stage_expired`；
- upload-idempotent：同 project + sha256 + file_name 重传 → HTTP 200 `reused: true`，返回原 artifact_id，artifact 行数与 CAS blob 数不增长（kernel 与 BFF 双面）；
- upload-gc：`cleanupStagedUploads(maxAgeMs)` 只清理超过 grace period 的 staged 文件（.part+.json），fresh stage 保留；已 finalize 的 blob 永不被 GC 触碰；
- upload-bff-passthrough：multipart 经 standalone BFF（bearer + 同源 Origin）原样透传 → 201，字节回读一致；BFF 无 bearer → 401、foreign Origin → 403、未知/跨项目 → 404（membership fail-closed 与其它 /v1 写一致）；
- 浏览器拖拽上传 UI、intake quarantine/scan UI 属浏览器层验收（Playwright 类环境不可用时如实记录为剩余，不宣称关闭）。

## 4. Runner 与 Manifest

- formal/baseline/pilot/reproduce/latex-compile 拒绝 subprocess；
- smoke 默认容器（RUN-02）：subprocess runner 下未标记 trusted_fixture 的 smoke job（script 尝试写宿主 marker 文件）必须 failed/environment，错误消息含 trusted-smoke-fixture（execution-runtime.md §1），且宿主 marker 文件必须不存在——证明脚本从未在宿主执行；
- trusted-smoke-fixture 放行（RUN-02）：同一 subprocess runner 下显式 `payload.trusted_fixture=true` 的 smoke job 正常 succeeded，脚本输出/metrics artifact 可断言；docker 模式 smoke 无需标记，始终容器执行、不受影响；
- 非 echo 空 command 和 message-only payload 失败；
- secure Job 缺 approved Contract、Snapshot、digest 被拒绝；
- formal/baseline/pilot/reproduce 必须绑定同项目、`status=approved`、带 Human Gate Decision 且版本冻结的 Contract；draft/foreign/missing Contract 一律 422；
- `image_digest` 必须与受信任 lock 中的 `<image>@sha256:<64hex>` 完全一致；tag、`latest`、缺 digest 和提交后换 digest 一律拒绝；
- code snapshot 和每个 `data_artifact_ids` 必须存在、属于同一项目、hash 可重验；跨项目或缺失输入不得进入 queued；
- Snapshot traversal、symlink escape、duplicate normalized path 被拒绝；
- Docker uid 非 root、network none、read-only、cap drop、memory/cpu/pids/time 生效；
- timeout/cancel/Runner crash 无孤儿容器；
- heartbeat 阻止 lease 重领；过期 lease 恢复 retryable；
- stale generation/token 的 heartbeat、chunk、complete 全 409；
- invalid signature、unknown key、missing/cross-project Artifact 拒绝；
- complete transaction 故障不出现 succeeded 无 Artifact。
- formal/baseline/pilot/reproduce 成功必须存在 `output_contract.metrics` 指定路径的 MetricsFileV1；缺文件、空 metrics、NaN/Infinity、重复 metric、非 Contract metric、run/contract/seed 不匹配或 stdout fallback 均不得 succeeded；
- heartbeat、Terminal frame、Artifact finalize 和 complete 都必须携带当前 owner/generation/token；缺任一字段、旧 generation、未来 generation 或错误 token 均 409，不能保留 owner-only 兼容放行。
- local/remote-plan-parity：同一 ExecutionPlan 在 LocalDocker/RemoteAgent 使用同一 run_id、snapshot/image/config/output contract；target 不能改写；
- remote-mtls-capability：未知/撤销 service、plan 签名错误、capability mismatch、offline/draining 均 fail closed；
- remote-partition-fencing：分区后 spool 有界；lease 过期的旧 Agent frames/finalize/complete 全拒绝，不产生合成成功；
- no-silent-fallback：remote 失败不自动转 LocalDocker/subprocess；显式新 attempt 才能换 target；
- remote-cas-resume：断点拉取/上传重试后 hash/size 一致，跨项目或 stale generation 拒绝。

### 4.1 RUN-REMOTE-01 接口层（ExecutionTarget/plan/注册表/调度 schema；真实 mTLS 传输未实现）

- execution-plan-schema：ExecutionPlan 固定 project/job/run/lease/profile/config/image digest/snapshot/artifact refs/limits/network/output contract 并签名（signature/payload_sha256/signed_by；Ed25519 验签 + payload_sha256 复算，篡改或未签名一律 fail closed，不执行）；plan `.strict()` 拒绝计划外字段——address/certificate/SSH bootstrap 等连接信息不得进入 plan/注册记录（只由服务端 Config/SecretRef 解析，Job/UI 只见 opaque profile/target ID 与安全健康摘要）；
- execution-plan-immutable：target 不得改写 plan——prepare() zod 校验 + 深度冻结 + fingerprint，start() 复算 fingerprint 对账，plan 变异或未先 prepare → ExecutionPlanMutationError（execution-target.test.ts）；
- local-docker-adapter-contract：LocalDockerAdapter 实现 ExecutionTarget port（prepare(plan)/start(plan)/attach(run)/cancel(run)/wait(run)）；docker 参数由 plan 纯函数映射（buildLocalDockerArgs：--network none、--user 65534:65534、--read-only、--cap-drop ALL、--security-opt no-new-privileges、--pids-limit/--memory/--cpus 取自 plan.limits、输入只读 + outputs 唯一 rw 挂载、--tmpfs、固定 image digest），与既有容器基线逐项一致；command/run_id 一律取自 plan，dockerRun 引擎行为不变；
- remote-agent-registry：注册/心跳更新 health.last_seen/offline 判定（status 非 online 或 last_seen 超时即 offline，未注册 fail closed）；注册记录只含 opaque target_id/agent_id/capabilities{os,arch,runner_ver,images}/labels/health/cert_fingerprint，`.strict()` 拒绝 address/certificate（remote-fleet.test.ts）；
- scheduled-target-pure：scheduledTarget(plan, registrations, policy) 纯函数——capability 匹配（images/os/arch/runner_ver 下限）、offline/draining 拒绝、无匹配 → 明确 retryable 错误（offline/draining/capability_mismatch/no_capable_target/policy_blocked 可区分），任务留在队列/标记 retryable；bound target 不可用时默认不回退 LocalDocker（policy.allow_bound_fallback_to_local 显式开启才回退），结果面永不出现 subprocess；policy 可配置（prefer local/local_only/allow_remote）；
- remote-not-implemented-fail-closed：真实 mTLS 传输未实现——createRemoteRunnerAgent 的任何执行/注册方法抛 RemoteRunnerAgentNotImplementedError（明确环境错误，绝不静默降级）；
- 上述场景的端到端形态（remote-mtls-capability/remote-partition-fencing/no-silent-fallback/remote-cas-resume 的真实 mTLS 传输验收）待远端传输实现后关闭，本轮仅接口层（hardening-v0.2-status.md §3 RUN-REMOTE-01）。

### 4.2 RUN-REMOTE-01 wire 协议 + 服务端/代理端（mock 传输；真实 mTLS 证书验证受限）

协议定义见 [remote-runner-wire.md](remote-runner-wire.md)（HTTP+JSON，消息 schema 全 zod：`research-schemas/src/remote-runner-wire.ts`，两端共享；生产必须 mTLS service identity，本地 wire 用 `x-service-token` 等价实现并文档注明生产差异）。覆盖（tests/unit/remote-wire.test.ts 15/15，InMemoryFleetTransport JSON round-trip mock 传输 + 真实 HTTP loopback）：

- remote-wire-register-heartbeat：注册 acknowledged、心跳 accepted（含 draining 与 capability/labels 更新）、未注册 agent → 404 agent_not_registered（fail closed）；wire schema `.strict()` 拒绝 address/certificate → 422 validation_error；
- remote-wire-claim-match：target_id 精确 + capability（images/os/arch/runner_ver）匹配才分发；claim 响应含签名 ExecutionPlan（Ed25519 可验）+ lease generation/token，run_id/lease 与 kernel claim 一致；**无匹配 target → 任务留在 pending（retryable），绝不静默改派/回退 LocalDocker**；agent 断连期间服务端保留 outstanding，恢复后 resume 返回同一 claim（同一 claim_id/run_id/lease）；
- remote-wire-cas-hash：CAS 拉取后代理端复算 sha256——响应 hash 与内容不一致、寻址 hash 与内容不一致均拒绝执行（executor 未被调用，fail closed）；自洽则正常执行；
- remote-wire-frames：全局 seq 单调、stream_seq 按通道、exit 帧最后、逐帧 lease_generation；artifacts staged + finalize 由服务端复算 sha256，篡改 → 409 cas_hash_mismatch / cas_size_mismatch（不落库）；
- remote-wire-complete-fencing：complete 携带 Ed25519 签名 run_manifest（kernel 侧 §12.7 验签通过）+ fencing 字段；**lease 过期被新 claim 抢占后旧 agent 的 complete → 409 lease_stale，claim 置 settled，后续 frames/complete 全拒，无合成成功**；agent last_seen 超时 → claims 409 agent_offline（retryable），心跳恢复可用；
- remote-wire-spool：断网期间 frames/stage/finalize/complete 全部本地有界 spool，恢复后按序重放并完成 Job；spool 有界——frames 条目可被淘汰并先补发 gap frame（dropped 区间/字节数可见，不静默丢弃），exit_frame/complete 不可淘汰，spool 满 → 本地失败（fail closed，无合成成功）；resume 幂等（回放同一 claim 不重复执行）；
- remote-wire-http-auth：HTTP 面 x-service-token 缺失/错误 → 403 service_token_required；正确 token 下 register/heartbeat/claim/CAS/frames/artifacts/complete 全链路可用（HttpRemoteFleetTransport + 真实 HTTP loopback）。
- fleet-bin-mode-exclusive（FLEET-01，tests/unit/fleet-bin.test.ts）：runner 二进制三角色互斥——缺省 local；`--fleet-server <port>` → fleet-server；`--agent <url>` → agent；两者同给 → 拒绝（FleetCliConfigError，互斥）；任一 fleet 角色与 `--mode` 同给 → 拒绝（`--mode` 仅本地模式有意义）；parseCli/validateConfig 对新增 fleet 键（runner.fleet_server_port/runner.fleet_url/runner.agent_id/runner.fleet_target_id/runner.fleet_public_key）解析/校验/默认合并，未知 flag 仍 unknown_config_key；
- fleet-bin-http-chain（FLEET-01，tests/unit/fleet-bin.test.ts）：startFleetServer 把 wire 挂真实 node:http listener（固定端口绑定、baseUrl 可达、x-service-token 缺失 → 403）；runFleetAgentMain 客户端循环（register → heartbeat → claim → 执行 → frames/artifacts/complete）全链经真实 HTTP 完成 Job succeeded，frames seq 单调 + exit 最后、manifest 带 fencing 字段；
- fleet-bin-http-spool（FLEET-01，tests/unit/fleet-bin.test.ts）：离线 spool 恢复在 HTTP 层成立——断网（transport_unreachable）期间 frames/stage/finalize/complete 全量进本地有界 spool（Job 保持 running，无合成成功），恢复后按序重放完成 Job；
- fleet-bin-nomatch-target（FLEET-01，tests/unit/fleet-bin.test.ts）：无匹配 target（HTTP 层）→ 任务留在服务端 pending（retryable，绝不静默改派/回退 LocalDocker）；匹配 target 的 agent 注册后拿到同一 Job（同一 claim_id/run_id/lease）；未注册 agent 的 claims → 404 agent_not_registered。
- fleet-bin-frames-lease-headers（FLEET-01，tests/unit/fleet-bin.test.ts）：appendTerminalFramesWithLease 的 request 绑定回归——真实 node:http 接收端断言 POST /v1/jobs/{id}/terminal-frames 携带 x-lease-owner/x-lease-token/x-service-token 头且 body（run_id/frames/max_log_bytes）原样送达（修复 009531c 引入的未绑定 request 调用：本地 runner 帧静默丢失、fleet 转发 502 kernel_unreachable）。
- **剩余（如实记录，属后续阶段）**：真实 mTLS 证书链（CA 签发/吊销/轮换）验收、真实远端 sandbox 隔离验收、跨主机网络分区故障注入、Remote PTY 与浏览器 UI——本轮协议层用 service-token 等价实现，生产差异见 remote-runner-wire.md §3。

## 5. Terminal

- interleaved-output：stdout/stderr 按全局 seq 重放，单通道仍完整；
- live-view：运行中 UI 逐 chunk 更新，不等任务完成；
- reconnect-after-seq：断线后无重复无缺失；
- retention-gap：请求已淘汰 seq 先收到 gap 和 dropped bytes；
- overflow：达到上限显示 truncated，最终 log Artifact 可下载；
- terminal-dom-bounded：Playwright 在 Job 未完成前观察到 stdout/stderr DOM 增量；全局 seq 单调、只生成安全文本节点，保留窗口滚动后 DOM 行数不超过配置上限；
- download-full-log：overflow/gap 后下载动作必须读取最终 log Artifact，字节等于 canonical 完整或明确截断日志，不能仅导出浏览器内 retained lines；
- exit-replay：成功、非零、signal、timeout、cancel 的最终原因永久可读；
- terminal-frame-integrity：同 (run_id, seq) 重放内容（frame_kind/stream_seq/channel/text/byte_offset/byte_length/payload_json）不同 → 409 `terminal_frame_conflict`（storage-migrations.md §4，不再 INSERT OR IGNORE 静默）；内容相同 → 幂等跳过（重放语义保留）；retention 已淘汰的 seq 重放不报错（storage-migrations.md §4，tests/unit/terminal.test.ts）；
- backpressure：慢客户端不使 Runner/Kernel 内存无限增长；
- hidden-tab：暂停渲染后恢复到 latest；
- ansi-injection：OSC clipboard/link/title 和 HTML 不能执行；
- log-authz：无 job_log_read、无 token、跨项目、撤权连接均被拒绝；
- cancel-kills-process：UI 只有确认停止后显示 cancelled。
- cancel-timeout-distinct：非合作进程在 deadline 内完成 TERM→KILL 兜底、无孤儿；cancelled 与 timed_out 在 exit、重载和下载日志中保持不同终态。
- pty-real-interaction：真实 shell/TUI 接受 input、返回 output，resize 生效，INT/TERM/KILL 和 exit 可辨；
- pty-reconnect-seq：detach/reconnect 使用 generation/after_seq 无重复，retention 淘汰先发 gap；
- pty-control-authz：跨项目、无 terminal_write、撤权、旧 generation、重复/乱序 client_seq 拒绝；
- pty-safe-open：任意 endpoint/SSH credential/Docker socket/host cwd/argv 被 schema 拒绝，只能 preset + relative cwd；
- pty-not-evidence：PTY output 不能被 Metrics/RunManifest/Evidence/Decision 路径引用；Run Terminal 永远没有 input route。
- pty-interface-state-machine（PTY-01 接口层，无真实 tty，adapter 未实现——tests/unit/pty-session.test.ts 13/13）：open→attached→detached→closed 状态机（closed 终态、close 幂等、attach/detach generation 递增供重连 fencing）；idle TTL 超时→close（activity 重置 TTL）；权限撤销立即 detach（进程存活）；client_seq 幂等（重复 seq 回放 no-op、乱序/跳号 409 pty_client_seq_out_of_order）；输出 server_seq 单调、after_seq 重放无重复无缺失；retention_bytes 有界淘汰先发 gap（含 dropped_bytes/gap_from_seq）；lease token/expiry 固定；spawn 失败→adapter_failed 关闭并保留审计行；closed 后 control/appendOutput 均拒绝；
- pty-http-validation（PTY-01 接口层，同上）：POST /v1/pty/sessions 参数校验（坏 preset/extra key/非法 config_hash→422 validation_error、未知 project/workspace→404、host cwd→422），**adapter 未注册一律 501 pty_adapter_not_implemented 且不创建惰性会话行**；kernel-created 会话可经 HTTP 驱动（control 200 幂等 + delivered=false 如实标注、GET 会话、frames?after_seq= 200 seq/gap 投影、close control 生效）；未知会话 control/frames→404、after_seq 非整数→422；控制帧不泄漏进输出流；
- pty-not-evidence-kernel（PTY-01 接口层）：pty 活动（input/resize/signal/output/exit/close）后 Jobs/Runs/Evidence/Claims/Gates/Artifacts 计数全 0，帧只落 pty_frames（terminal_frames 为 0）——接口层无任何 pty→业务表写路径（tests/unit/pty-session.test.ts）。
- pty-local-real-tty（PTY-01 LocalPtyAdapter，tests/unit/pty-local.test.ts）：真实 pseudo-terminal（python3 `pty.fork()` 桥，Node 无内置 PTY）——打开 preset shell 后 bytes 回显与命令输出可见（`echo` 圆环）；resize 生效（`stty size` 反映新 cols/rows，132x43）；信号按 pty 前台进程组投递：INT 中断前台作业而 shell 存活、TERM 终止前台作业（交互式 shell 按设计忽略 SIGTERM，真实终端语义）、KILL 终止 shell 且 exit frame 带 signal=SIGKILL（exit frame 严格晚于最终输出字节）；显式 close 拆除真实 tty（adapter live 计数归零，无孤儿进程/进程组）。
- pty-local-detach-reconnect（同上）：detach 后进程存活且输出继续流入 session store（断开不杀进程，execution-runtime.md §6.1）；reconnect（attach）generation 递增供 fencing；after_seq 重放无重复无缺失（server_seq 单调）。
- pty-local-idle-ttl（同上）：idle TTL 超时（kernel 持有 sweep 定时器 + 显式 ptySweepIdle）→ session 以 idle_ttl 关闭且真实 tty 被拆除。
- pty-local-env-whitelist（同上）：shell 环境只有白名单（PATH/TERM/LANG/…）；DSH_SCHOLAR_KERNEL_TOKEN / DSH_SCHOLAR_SERVICE_TOKEN / 模型凭据（OPENAI_API_KEY）在 shell 中不可见；`$HOME` 被重定向进 workspace sandbox（host `/home/…` 不可达），host 路径永不进入子进程环境。
- pty-local-safe-boundaries（同上）：adapter 层防御性拒绝 host cwd / `..` 段 / 未知 preset（即使绕过 kernel schema）；python3 缺失 → spawn 诚实失败 → 会话 adapter_failed 关闭且保留审计行。
- pty-local-http-open（同上）：注册真实 adapter 后 `POST /v1/pty/sessions` 缺 `x-principal-id` → 422 principal_required、非成员 → 404 project_not_found、成员 → 201 真实会话（principal/adapter_id 钉在行上）；control 携带他人 principal → 403 pty_principal_mismatch；owner control delivered=true、frames?after_seq= 可回放真实输出；close control 关闭会话并拆除 tty；无 adapter 注册时仍 501 pty_adapter_not_implemented 且不创建惰性会话（pty-session.test.ts 保持）。
- pty-local-not-evidence（同上）：真实 adapter 会话（input/resize/signal/output/exit/close）后 Jobs/Runs/Evidence/Claims/Gates/Artifacts 计数全 0，帧只落 pty_frames——真实 tty 也不产生 Metrics/Manifest/accepted Evidence/Gate Decision。
- 浏览器 TUI 验收（真实终端渲染、键盘、resize 交互、640/720/1024 视口）仍属 UI 浏览器层，Playwright 类环境不可用时如实记录为剩余。

## 6. Analysis、Evidence 与 Claim

- metrics schema identity、有限数值、MetricSpec direction；
- duplicate seed、mixed metric、mixed contract、minimum_n 拒绝；
- paired bootstrap 输入相同输出字节一致；
- lower-is-better 的 effect 解释正确；
- public Evidence 路由不能提交 verified/accepted；
- Evidence provenance 状态机为 draft_unverified→verified→accepted；public 只创建 draft，Analysis Worker 只创建 verified，只有 Verifier/Auditor internal accept 可转 accepted；
- draft/legacy/verified Evidence 在 accepted 之前都不能支持 Claim；伪造 body `status=accepted`、非 service identity、跨项目 accept 必须拒绝；
- accepted transition 必须重验 RunManifest、Contract、RunSet、Analysis Artifact 和 service Principal，并留下 request_id/Outbox；
- 缺 effect/CI/n 或 CI 跨无效区间为 inconclusive；
- contradicted Claim 不被 Manuscript 当正面结论；
- Analysis Artifact、图表和稿件数字一致。

## 7. TeX Workbench

- create-document 生成 paper.tex/references.bib 和 revision；
- ui-new-file：通过 UI 新建根内文件后 tree/GET 返回正确 path/kind/media/version；新文件 create-if-absent 不得用会被 positive schema 拒绝的 `expected_version=0`；
- tree 只含根内路径，文件 kind/media/version 正确；
- save expected version 成功并生成新 immutable revision；
- 并发保存一个 200、一个 409，无丢失更新；
- delete/rename/asset upload 执行 path 和 version 校验；
- compile 自动冻结当前 manifest，不能读取之后编辑；
- snapshot-frozen-bytes：冻结时 snapshot store 保存每文件可物化字节；冻结后编辑/删除当前文件，GET snapshot-files?revision=&path= 仍返回冻结 revision 的字节且 hash 与 manifest 一致；未知 revision/path 404、参数缺失/非法 422；Runner 物化只读 snapshot store 字节（无当前文件读取），不可读或 hash 不匹配一律硬失败（tex-build.test.ts 负向：revision 不可物化、字节被篡改、路径逃逸）；
- dirty-before-compile：修改或清空非空文件后立即显示 dirty；dirty 基线必须是文件 GET/最近保存内容（tree/GET 无 content，不能作为基线）；revert 到已保存字节（含 ''）后 dirty=false（manuscript-dirty.test.ts）；
- clear-revert-cas：清空非空文件（content=''）是 CAS 可见变更（新 version + 新 revision，hash=sha256('')）；清空/恢复用过期 expected_version 一律 409；revert 恢复原字节（tex-workspace.test.ts）；
- save-conflict-terminates-compile：并发保存后 document revision 前进，本地保存 409；随后用旧 revision 编译必须在冻结与提交两处被 409 document_version_conflict 拒绝，不得创建 latex-compile Job、不得创建 build 行、不得产出 PDF（tex-build.test.ts HTTP 集成 + tex-kernel.test.ts 单元）；carried manifest revision 与 tex_revision 不一致同样 409；
- compile 期间文件被修改：build 输入仍是冻结 revision 的字节（snapshot store 按 revision 返回原字节，hash 与 job payload manifest 一致），新编辑只前进 document revision 供 stale 判定；
- build-job-linkage：POST builds 201 响应携带 build.job_id、build.revision（输入 revision）与 job；UI 用 job_id 接入同一 Job 的 Terminal SSE（GET /v1/jobs/{job_id}/terminal）；build.revision < document.revision 时旧 PDF 显示 stale；queued/running 期间 Compile 按钮禁用（防重复提交）；
- pdflatex + bibtex/biber + 多遍编译得到非空 PDF；
- shell escape、network、越界文件访问被拒绝；
- compile Terminal 实时显示，完整 log 进 Artifact；
- build-terminal-dom：编译完成前 UI 已显示真实 latex/bibtex 输出；该输出和最终 compile-log Artifact 可重放且绑定同一 build/input manifest；
- LaTeX error 解析到 file/line，点击定位编辑器；
- undefined citation 和 missing file 有结构化诊断；
- 源文件改变后旧 PDF 显示 stale；
- PDF Content-Type、Blob preview、download hash 正确；
- build history 可重放日志和 PDF；
- clean-room 能用 Bundle 中 TeX 源重新构建同等 PDF 结构。
- workspace-vscode-flow：Explorer/create/open/tabs/search/edit/move/delete/upload/download/history/snapshot 全部走 Workspace Revision/CAS；
- workspace-binary-and-conflict：图片/PDF/随机 bytes hash 一致；大/未知文件只读；并发保存/上传给 base/current/local 且不覆盖；
- workspace-watch：change seq 重连无重复，retention gap 触发 resync；跨项目/路径越界拒绝；
- workspace-interface（WORK-01 接口层已升级为磁盘 adapter，见 §7.1——tests/unit/workspace-store.test.ts 15/15）：list/read/write/delete/move + workspace revision/每路径 version/strong etag（`"<version>-<sha256[0..12]>"`）；预期 version/etag 不匹配一律 409 workspace_version_conflict/workspace_etag_conflict（无静默 last-write-wins）；expected_version=0 create-if-absent（存在→409）、缺文件 + N>0→409；二进制 CAS（服务端计算 sha256、CAS blob 回读字节一致、相同 bytes 幂等复用同一 blob、文本写二进制节点 422 workspace_binary_read_only、二进制 move 按 blob 引用）；路径安全（绝对/`..`/`.`/NUL/反斜杠/Windows 盘符/空段拒绝，tree 只含 root-relative 路径）；move 目标已存在→409 workspace_move_destination_exists；history op ledger（create/write/delete/move + workspace revision）；`dir` 节点由路径前缀投影；
- workspace-tex-facade（WORK-01 接口层，同上）：TeX 文档作为 `manuscript` workspace 经同一 WorkspaceStoreLike 契约读写（workspace_id=`ws_<document_id>`、版本/etag/hash 与 tex 权威一致、写后 tex store 直接可见且 document revision 前进——无第二套字节/revision 权威）；CAS 冲突穿透 facade；删除/移动经 facade 生效；二进制写→422；history 映射 tex 历史；
- live-preview：保存成功后（POST /v1/documents/{id}/preview-builds，或 kernel previewAutoTrigger 自动路径）进入 server 端 debounce（默认 800ms 可配置），Kernel 持有定时器并写持久化 tex_preview_pending；合并窗口内多次保存只产生一个 preview build，编译结束前 UI 已见日志/诊断；新 revision 使旧 PDF stale（build.revision < document.revision → build 记录 stale=true）并 supersede 旧 preview；preview build 记录状态 queued/running/superseded/succeeded/failed（queued 被取代时标 cancelled），带 preview=true 与 superseded_by/superseded_at；preview 提交响应携带 job_id 与输入 revision（同一 Job 的 live Terminal SSE 与 stale 判定）；UI 重连/内核重启后 GET preview-builds 投影（pending+builds）可恢复，preview 状态不只在浏览器 debounce timer（tex-preview.test.ts：debounce 合并、取消 queued、running→superseded、stale、权威 supersede、去重、重启持久化、previewAutoTrigger）；
- preview-vs-compile：preview 运行同一固定 TeX image/禁网/no-shell-escape（复用 latex-compile runner 路径，payload.preview=true），但不产 Evidence、不冻结/不参与权威 manifest 链；显式 Compile 固定 manifest/config/image，创建权威 latex-compile Job 时 supersede 该 document 全部非终态 preview，且不被后续 preview 取消/取代（活跃权威编译期间 preview flush 跳过，不排队冗余容器）。

### 7.1 通用 Workspace 磁盘 Adapter（WORK-01 adapter 轮，api-contracts.md §17）

通用 workspace 的**真实磁盘 adapter**（替换接口层的 DB-only 文本内联实现；tests/unit/workspace-store.test.ts 15/15 + tests/security/run-workspace-tests.sh 38/38，详见 hardening-v0.2-status.md §3 WORK-01 行）：

- ws-disk-layout：每个项目一个 workspace 根 `dataDir/workspaces/{project_id}/{workspace_id}/`（目录链 chmod 0750、文件 0640），节点字节是树内真实文件（规范化路径）；元数据（path/kind/media/size/version/hash/etag/updated_at）存 `workspace_nodes`（磁盘 adapter 不再写 `content` 列）；`ensure` 即建根；
- ws-atomic-write：写入先落目标目录内临时文件（`<name>.ws-tmp-<rand>`）再原子 rename——读方永远看不到半写文件，写后无临时残留；
- ws-revision-etag：每次 mutation 前进 workspace revision 与每路径 version，etag=`"<version>-<sha256[0..12]>"` 随之变化（单调、确定性）；
- ws-cas-conflict：预期 version/etag 不匹配一律 409 `workspace_version_conflict`/`workspace_etag_conflict`（无静默 last-write-wins）；`expected_version=0` create-if-absent（已存在→409）；move 目标已存在→409 `workspace_move_destination_exists`；delete/move 均走 source CAS；
- ws-move-delete：move 原子 rename 磁盘文件（hash 保持、旧路径消失、目标 version 重置为 1）；delete 移除磁盘文件并保留历史；
- ws-binary：任意字节节点（不强制 UTF-8）——multipart `assets` 上传（≤32 MiB 复用 UPLOAD-01 上限，服务端 sha256，路径字段走同一规范化）；GET `blobs?path=` 返回原始字节 + media type（扩展名映射或 octet-stream）+ 强 etag 头；`blob_sha256` 同时注册进 artifact CAS（按内容幂等），工作字节以树文件为准；
- ws-size-cap：单节点 >32 MiB（`WORKSPACE_MAX_FILE_BYTES`，复用 upload limits）→ 413 `workspace_file_too_large`（multipart 路径为 413 `payload_too_large`）；超过 readJson 32 MiB 上限的 JSON 文本写请走 assets 路径；
- ws-path-safety：绝对路径/`..`/`.`/NUL/反斜杠/Windows 盘符/空段 → 422 `invalid_path`；磁盘层额外拒绝路径上**任意** symlink（读、写、删、移动前 lstat 每个已存在组件，→ 422 `workspace_symlink`）——通用 workspace 树只含普通文件，是 snapshot-walk“symlink 不得逃出根”的严格超集；宿主在树内埋 link 指向根外也不能被读写穿透（负向：escape target 字节不变）；
- ws-history：每路径保留最近 `HISTORY_KEEP_VERSIONS`=8 个版本字节于 `dataDir/workspaces/.ws-meta/{workspace_id}/history/{path}@{version}`（树外，用户路径不可达）；GET nodes `?path=&version=N` 回退读（当前版本读活文件，旧版本读历史字节，删除后版本仍可读——undo）；超出保留窗口 → 404 `workspace_file_not_found`；history op ledger 不变；
- ws-watch：GET nodes `?after_revision=N` → 该 revision 之后被触碰路径的当前节点 + `deleted` tombstone 列表（`since >= 当前 revision` → 空集），watch/change 重连 feed（TeX facade 无 per-op ledger，保守整树上报）；
- ws-search：POST search（`prefix` 和/或 `glob`，AND）——路径前缀与 `*`/`?` glob（`*` 不跨 `/`）匹配，`dir` 节点投影参与；**内容搜索未实现**（无全文索引，如实记录）；
- ws-http-routes：`POST/GET /v1/projects/{id}/workspaces`（创建/列出 code/manuscript/scratch，manuscript 含 TeX facade 工作区）、`GET .../workspaces/{wsid}/tree`、`GET/POST/DELETE .../workspaces/{wsid}/nodes`（读/写/删 + watch/rollback）、`POST .../workspaces/{wsid}/moves`、`POST .../workspaces/{wsid}/search`、`POST .../workspaces/{wsid}/assets`（multipart）、`GET .../workspaces/{wsid}/blobs?path=`（原始字节）；跨项目 workspace → 404 `workspace_not_found`（路径项目绑定，BFF membership/role 检查同其它 /v1 写）；BFF multipart 原始字节/原 boundary 透传 + bearer/Origin/CSRF/membership 与既有 /v1 写一致；
- ws-facade：TeX 文档经同一接口可读/写（workspace_id=`ws_<document_id>`、kind=manuscript、版本/etag/hash 与 tex 权威一致——无第二套字节/revision 权威）；facade search/listSince/readVersion 语义与取舍见 execution-runtime.md §12.2；
- 浏览器编辑器 UI（tabs/search/watch/upload、move/history 面板、Problems、集成 PTY）与桌面/窄屏/冲突/路径/二进制**浏览器**验收：无 Playwright 类环境，如实保留（§4 行 96 剩余）。

## 8. UI 与 i18n

- zh/en 字典 key 完全一致，静态检查阻止硬编码 chrome；
- browser client 源码必须纳入 strict `tsc --noEmit`，不得只由 tsdown 跳过类型后转译；
- persisted locale > browser regional locale > zh；
- setLocale 后已开 modal、tabs、aria、Terminal status、TeX chrome 更新；测试不得导航或 reload，必须在一个 render tick 内断言可见 text/title/aria/status 与 `html[lang]` 同步切换；
- i18n-runtime（tests/unit/i18n-runtime.test.ts）：locale 切换后 tab/header/model/density/aria/document title 由纯 chrome 模型（i18n/chrome.ts）重新求值，pipeline 步骤（phasePipeline()）、Terminal status/meta/exit、状态 pill/sidebar/search 状态文案（statusLabel()）随 locale 重求值；已开 modal 经 overlay registry（registerOverlayRebuild/relocalizeOpenOverlays）重开；t() 遇全字典缺 key 返回 raw key 并在开发模式 console.warn 一次/键（含字典路径提示），注入 setMissingKeyReporter 收集器可断言；zh→en→zh 往返文案一致；unknown enum 仍原样显示；静态 zh/en parity 断言保持；
- Intl 显式使用 active locale，不能出现中英文日期混用；
- unknown enum 和 wire/model/Terminal/TeX raw text 原样显示；
- standalone 首屏和 token error 双语，html lang 正确；
- i18n-static-chrome：新增或现有 header、status pill、tooltip、placeholder、aria、toast、空态不得硬编码英文/中文；zh/en namespace 与 key 精确一致，缺 key 在开发模式 warning、CI fail；
- 页面不依赖 DSH LocaleFace/ThemeFace/slots，locale/theme 只由 standalone adapter 管理；
- 所有核心动作仅键盘可完成；focus trap、aria-live、contrast、reduced motion 通过；
- 640/720/1024 px 无不可达控件；
- 关闭页面后 SSE、interval、Blob URL、listener 清理；
- 同一 fixture 在 standalone 重启前后产生等价页面和操作结果。
- ui-start：无项目首屏只有 Init/Resume/Upload 三项主行动，高级设置不可见；Resume 显示 status/pending Gate/NextAction；
- ui-guide：所有非终态项目显示结构化 NextAction 的 state/reason/required/revision/CTA；409 刷新，unknown action 不执行；
- ui-next-action-v2-cards（client 逻辑层，tests/unit/next-action-cards.test.ts 26/26）：Overview 渲染 `next_actions_v2` 结构化卡——code 徽标、三态视觉类名（ready/blocked/done）、label 优先按 i18n key 翻译（未登记 code 原样显示 kernel label，属 wire 数据）、reason 行、required 缺失前置条件列表（blocked 点击展开）、route 按钮经现有导航机制跳转（nav.ts `#tab=` 深链 + activeTab 切换；ideas/contracts/release/overview 收敛到 Overview tab）、blocking 说明；done 灰显禁用、blocked（有缺口时）禁用、ready 高亮；`code='unknown'` 只读、无 CTA、不构造 mutation（api-contracts.md §21）；缺失 `next_actions_v2` 时回退 legacy `next_actions: string[]` 列表（向后兼容），畸形 v2 字段安全退化；
- ui-routes：Workspace、Run Terminal、Interactive PTY、Manuscript、Trajectory/Topology、Settings 可由上下文/命令面板/深链到达，URL 无 Token；
- ui-settings：Accordion 默认折叠；每项展示 effective source/hash/revision/default/restart，reset 与 CAS 冲突工作；secret value 零渲染；
- ui-settings-dynamic（CONFIG-01/UI-02/UI-03 client 逻辑层，2026-08-11，tests/unit/settings-model.test.ts 21/21）：Settings 由 `/v1/config/schema` + `/v1/config/effective` 动态生成（settings-model.ts `settingsConfigModel` 纯模型）——每 ConfigScope 一组 Accordion（global/project/job/runner-profile/orchestrator/kernel/standalone 七组覆盖注册表全部键，job 组保留 reserved），每字段展示 effective 当前值（服务端 redacted；secret 只渲染"已设置,不显示明文"掩码，明文零回显）、scope、声明来源（registry `sources` 客户端镜像，对真实注册表逐键钉死）、安全基线标记、env 别名、schema 描述与默认；config pin 显示 + 变化提示（configPinChanged）；热生效/需重启按声明来源推断（注册表无 hot_reload 标记，规则文档注明；http/ui → 即时生效，cli/env/file → 重启）；本地校验（validateSettingsField：number 整数+边界/boolean/enum/string minLength+pattern）与服务端错误回显映射（mapSettingsServerErrors：validation_error/unknown_config_key/security_floor_violation → 字段级，未知名键 unmatched）；无写接口（kernel 仅 GET effective/schema）→ 提交按钮禁用并注明"当前配置只读,经 CLI/env 提供"；55 字段 label + 7 scope 标题 + 元信息键 zh/en 齐备，双语求值零缺 key（负向测试）；Workspace/Trajectory/Topology 无逻辑层组件，待页面落地时补 namespace（如实记录）；
- ui-simple-responsive：640/720/1024 下 Start、More、树/编辑/Preview/Terminal、固定主 CTA 均键盘可达，不因隐藏高级项丢能力；
- ui-simple-logic（UI-SIMPLE-01 client 逻辑层，tests/unit/ui-simple.test.ts 12/12）：startActions() 恰三卡（new-project/open-project/import，code/route 稳定、label 随 locale 重求值）；tabGroups() 四 primary（phase/runs/evidence/manuscript）+ More（chat/gates/artifacts/budget/terminal + settings modal）且全覆盖（ALL_TAB_KEYS 每键恰属一组、deepLink 唯一稳定）；settingsSections() 九组（连接/外观/偏好/runner/workspace/terminal/TeX/agent/config provenance）全部 defaultCollapsed，title/summary/row 键在 zh/en 双字典存在且运行时零缺 key；深链 `#tab=<key>`/`#settings` 稳定解析、query 路由不受影响、navOrder() 覆盖全部可达目标；浏览器级剩余（无 Playwright 环境，如实记录）：ui-simple-responsive 的 640/720/1024 视口与键盘导航验收、Start/More/Accordion 的 DOM 有界断言；
- i18n-new-surfaces：start/guide/workspace/settings/trajectory/topology/PTY/upload/grill 的 zh/en key、状态、error、aria 精确 parity。

### 8.1 Onboarding、Upload 与继续既有研究

- intake-preaccept-zero-authority：begin/stage/scan/grill/propose 后 Project/Gate/Artifact/Workspace/Job/Run/Terminal/Evidence/Claim 表与 Outbox 均无业务写；
- upload-resume-integrity：分块 offset/hash 重传幂等，gap/different bytes 409，pause/resume/finalize 得到相同 Blob；
- malicious-archive：absolute/..、symlink、device/FIFO、case collision、bomb/nesting/over-limit、active TeX/script/HTML/SVG 都被 quarantine/reject，parser 无网无执行；
- grill-deterministic：相同 observation/taxonomy version 生成相同 question codes；required 未答保持 needs_input，answer 持久化 Human Principal/revision/human_assertion；
- safe-phase-adoption：每个 observed phase 只落到允许的 safe status；Scope/Idea/Contract/Release 声称不产生 Decision，创建对应 pending Gate；
- import-no-forgery：日志只变 log Artifact/ImportedRunObservation，结果只变 legacy/draft Evidence；无签名 Manifest 不产生 RunSet/accepted Evidence/supported Claim；
- adoption-atomic-idempotent：每个故障点全回滚；同 key/hash 返回同 Receipt，不同 hash 409；target/proposal stale 要重新 propose；
- merge-conflicts-visible：path/role/revision 冲突必须 Human keep/current/import/rename，禁止静默覆盖；
- intake-recovery-gc：BFF/Kernel 重启可恢复 upload/scan/questions/proposal；expiry/quarantine/purge 审计，accepted Blob 不被 intake GC。

#### 8.1.1 Intake kernel/服务端层（ONBOARD-01，已实现——tests/unit/intake.test.ts 32/32、HTTP /v1/projects/{id}/intake*、migration 0012 SCHEMA_VERSION 11；浏览器向导 UI 与拖拽接入属 UI 层剩余）

- intake-begin（research-onboarding.md §1/§3）：`POST /v1/projects/{id}/intake` 创建 Intake 会话（status=draft，owner Principal，source_label，target_phase 驱动 taxonomy，默认 7 天过期）；Idempotency-Key 重放同会话、不同 request hash→409 idempotency_conflict；每项目恰一个 active 会话（复用）；未知项目→404 project_not_found；
- intake-stage-isolated：`POST .../intake/{iid}/artifacts` multipart（复用 UPLOAD-01 ≤32MiB/路径安全/服务端 sha256 上限）写入**隔离 staging CAS**（CAS root 下 intake-staged/<iid>/<sha256>.part），project Artifact 表与 CAS blob 空间零写；内容寻址幂等（同 bytes 复用行）；改文件使已生成 proposal 失效（proposal_stale 语义）；
- intake-scan-static：`POST .../scan` 复算每文件服务端 sha256（篡改→422 stage_corrupted）+ 静态安全扫描（扩展名白名单/可执行 deny→rejected、HTML/SVG/无扩展名→quarantined、magic 校验不匹配→quarantined、ELF/PE magic→rejected、静态 secret 模式（private_key/AWS/GitHub/OpenAI）→quarantined 且 secret value 永不回显）；scan_summary 如实记录 av_available=false（无 AV，深度 archive 解包/炸弹/嵌套/symlink 检查由采用时既有 code-snapshot walk 执行，observation 记录 archive_extract_pending）；observations trust 固定 observed_unverified；
- grill-deterministic-kernel：`GET .../questions` 返回版本化 taxonomy（taxonomy_version=1、question_revision=1、稳定 question_code/label_key/prompt/reason/required/depends_on）；按 target_phase 确定性裁剪（experiment 含 seed/run_manifest_signature/statistics_ci_n，brief 仅 owner_scope_license/observed_phase_claim/privacy_secret_network）；`POST .../answers` 要求 principal（缺失→422 principal_required fail-closed）、未知问题→422 unknown_question、revision 不匹配→409 question_revision_conflict；答案持久化 human_assertion + Human Principal + revision；必答未齐→grilling、齐→proposal_ready；'unknown' 答案保留 gap 并降 confidence；
- intake-propose-deterministic：`POST .../propose` 必答未齐→422 question_required；proposal 确定性生成（observed_phase 取 human claim/目标阶段、safe_project_status 只来自 Kernel 状态机——新项目恒 DRAFT、required_gates/plan/risks/pre_accept_checklist/suggested_mappings/next_actions、confidence 由答案+scan verdict 计算）；status→awaiting_human，revision 递增；再 propose 仅升 revision；
- intake-adopt-atomic（§7）：`POST .../adopt` 要求 Human Principal（422 principal_required）；proposal revision 钉定（409 proposal_stale）、target project revision 钉定（409 project_revision_conflict）、quarantined/rejected 文件→422 artifact_quarantined；单事务内：staged blobs→CAS + project Artifact 行（pdf→pdf、docx/tex→paper、代码→code、数据→data、日志→log、图表→chart、lock→manifest）+ 阶段 Gate 只创建 **pending**（idea→idea gate、contract→contract gate、release→release gate、brief/survey→scope gate——绝不伪造 IDEA_APPROVED/CONTRACT_APPROVED/RELEASED）+ metrics/results JSON（MetricsFileV1 形态）→ draft legacy_unverified Evidence + log→ImportedRunObservation（**绝不创建 TerminalLog/RunSet/accepted Evidence/supported Claim**）+ AdoptionReceipt（钉 proposal/target revision + idempotency hash）+ outbox intake.accepted；项目状态机不被跳过（新项目保持 DRAFT，Scope Gate 照常走）；同 Idempotency-Key+hash 重放同 Receipt、异 hash→409、无 key 重放返回已存 Receipt；
- intake-reject-expire-gc：`POST .../reject`（principal 必填）GC 隔离 staged 并置 rejected（审计+outbox）；`expireIntakes` 7 天过期未采用会话→expired+GC（accepted 永不触碰）；`cleanupIntakeStaged` 24h 龄 staged 文件 GC（CAS blobs 永不触碰）；
- intake-preaccept-zero-authority（§2.1）：begin/stage/scan/answers/propose 后 gates/decisions/artifacts/jobs/runs/evidence/claims/terminal_frames/workspaces/tex_documents 计数全 0、Outbox 无业务写（仅 project.created）、CAS blob 空间为空——只写 intake_* 表 + 隔离 staging；intake.ts 源码无任何 Gate/Run/Evidence 写路径（代码断言）；
- intake-resume-recovery：GET .../intake/{iid} 返回完整可恢复投影（session/artifacts/observations/questions+answers/proposal/receipt/audit）；kernel 重启后 answers/status/proposal 完整恢复并可继续 adopt；跨项目访问→404 intake_not_found（无存在性泄漏）；
- 剩余（如实记录，属浏览器视觉/后续轮次）：拖拽/向导 Intake UI 的浏览器视觉验收（向导 DOM 已接线——client/modals/intake.ts 真实 begin→stage→scan→grill→propose→adopt，2026-08-11；视觉/拖拽/真实上传交互待 Playwright 类环境）、quarantine/scan 进度展示、分块 offset/hash 恢复上传（服务端整文件 staged ≤32MiB，UI 如实不做分块；恢复 = 已 staged 文件续传/重传幂等）、archive 解包扫描、TeX workspace/CodeSnapshot 的采用物化（当前按 §6.1 映射为 paper/code Artifact 并记录 gap）、merge 冲突 keep/current/import/rename 交互、BFF /v2+accept 面与 Agent tool 面（begin/stage/scan/grill/propose/status）。**GUIDE-01 投影的 Intake/Grill 覆盖动作已落地（2026-08-11）**：kernel next-action.ts `intake_resume`/`intake_scan`/`intake_answer`/`intake_propose`/`intake_adopt`（`NextActionContext.intakes` 可选输入、projectProjection 从 listIntakes 投影、终态零动作），client `intakeGuidance` 把 next_actions_v2 的 intake 动作并入向导每步引导列表。

### 8.2 Trajectory 与 Subagent Topology

**standalone 投影与拓扑 API 层已实现（TRAJ-01/SUBAGENT-01 kernel/服务端轮，tests/unit/trajectory.test.ts 12/12、migration 0013 SCHEMA_VERSION 12、research-schemas `trajectory.ts`、research-kernel `trajectory.ts`、BFF child 路由解析；commit 待定——见 hardening-v0.2-status.md §3 TRAJ-01/SUBAGENT-01 行）**：

- trajectory-projection-redacted：`GET /v1/projects/{id}/trajectory`（kernel 只读投影，`after_seq`/`after_event_id`/`limit`/`lane` 查询参数）按 `(event_seq, event_id)` keyset 分页——outbox event_seq 是 per-aggregate 单调，跨 bucket 数值相等由 event_id 续传（断言 5 条含 seq 平局的记录分页不丢不重）；单页上限 500、total 计数、has_more 稳定；`projectTrajectoryLanes`（`GET .../trajectory-lanes`）同时返回 research/session 两条泳道（各自游标），`lane=research|session` 过滤生效；
- trajectory-redaction（断言）：投影 entry 只有白名单 `summary`（无 payload 字段）；token（sk-/ghp_/xoxb-/Bearer…）、secret 赋值、绝对宿主路径（/home//Users//tmp//var//etc//opt/C:\…）在 summary 中一律不出现（`[redacted]`）；statement 服务端截断 ≤240 字符（长标题以 `…` 结尾且恰好 240）；child summary 写入与读取双次脱敏；
- trajectory-scale-10k：造 10_000 事件后 `limit=500` 分页 21 页无重复无丢失（10_001 total）、页大小上限即使请求 5000 也强制 500、全程 <10s 且内存有界（DOM 虚拟化属浏览器轮剩余）；
- topology-direct-child：`GET /v1/projects/{id}/topology?parent_id=` 只返回 exact direct children（孙节点不出现在父列表）、`has_children`/`children_count`/`seq` 游标/`total` 正确；`parent_id` 省略 = 顶层根列表；
- topology-enter-breadcrumb：`GET /v1/topology/{child_id}` 返回 exact-parent + breadcrumb（root→parent 路径，自节点不含）；root 无 parent；orphan（parent 未注册）fail-soft parent=null；cycle（a→b→a）深度有界不悬挂；未知 child 与无权限统一 404 child_not_found（无存在性泄漏）；
- subagent-read-no-activate：`GET /v1/topology/{child_id}/history` 只读（started/registered/state/followup 追加账本，`after_seq` 每 child 单调分页）——读取前后 child state 不变（断言）；history 永不激活 Agent；
- subagent-followup-authz：`POST /v1/topology/{child_id}/followup` 需要 project membership（BFF 先解析 child→project 再查成员，kernel 侧 x-principal-id fail-closed 422 principal_required、非成员 404）；standalone kernel 只记录 message 并返回 `message_id`（`msg_…`），`read_only=true`、`state_unchanged=true`、不冒充已执行（trajectory-subagents.md §3）；followup 进入 child_history 与 outbox（`trajectory.child.followup`，session 泳道）；execution 需 DSH host + exact live-parent 校验（剩余）；
- topology-register-state：`POST /v1/projects/{id}/topology/children` 记录 child（child_id/parent_id/label/summary/mode/role/state），re-register 不复活已终态 child（state 只经 `PATCH /v1/topology/{child_id}/state` 变更，ended_at 首次终态钉定）；outbox 事件 `trajectory.child.started/updated/followup` 均为 session（observational）泳道；
- topology-permissions：trajectory/topology 全部路由（含 PATCH state、POST followup）要求认证 principal + project membership；缺 principal 422 principal_required、非成员/未知 child 404（HTTP 断言）；
- 剩余（如实记录，属 UI/DSH 集成轮）：浏览器拓扑渲染/进入 child/breadcrumb 导航、trajectory/topology 的 SSE 实时流（after_seq replay/gap/revoke——**服务端已实现（commit 待定主代理统一提交，api-contracts.md §22）**：trajectory/stream keyset 增量 + workspace watch/stream + pty frames/stream，tests/unit/sse-streams.test.ts 7/7 + run-sse-tests.sh 67/67；浏览器事件源消费观感 NOT_RUN_MANUAL_PENDING）、10k node 浏览器 DOM 虚拟化与键盘/ARIA/zh-en 验收（Playwright 类环境不可用）、token 四桶/cost/permissions/retention 详情（需 DSH session adapter）、research_panel 插件侧调用 registerChildLink/updateChildState 接线（本轮 kernel/服务端已就绪，插件代码未动）。

UI 目标场景（浏览器/DSH 集成验收，保持契约原文）：

- research-vs-session：UI 明确 authoritative Outbox 与 observational Session，Session 事件不能推进 Project；
- topology-direct-child：树只用 exact direct child；orphan/cycle fail-soft，普通 fork 停止 subagent 聚合；
- topology-enter-breadcrumb：可展开、进入任意 child、返回 parent、刷新/重启恢复安全 route；
- subagent-read-no-activate：cold list/history 不激活 Agent；one-shot/diagnostic/parent offline 只读；
- subagent-followup-authz：只有 continuable + exact live parent + membership + capability 可接收，返回 message_id；伪 parent/mode/跨项目 404/403；
- trajectory-stream：after_seq replay/dedupe/gap/reconnect/revoke 正确，终态单调，retry 是新 node；
- trajectory-redaction：raw prompt/tool args/results/env/provider secret 默认不存在；detail allowlist、bounded preview/spill/TTL/purge 审计；
- topology-usage：四桶 token、active duration 与 cost unknown/estimated 正确，父子不双计；
- topology-scale-a11y：10k nodes/records DOM 有界，>100 virtualize、prepend anchor 稳定，tree/treeitem keyboard/ARIA 和 zh/en 通过。

## 9. DSH 集成与 Skills

- clean DSH_HOME 安装 Agent bundle，tools/commands/subagents/Skills 可发现；
- 根包无 `dshClient`、`./client` export 和 browser bundle；
- DSH 组装不注册 `/research-api`、`/research-ui-api` 或 Scholar Web slot；
- standalone HTTP 对 `/research-api/*` 和 `/research-ui-api/*` 必须真实返回 404，不能 fallback 到 SPA 或 `/v1`；
- `@dsh-scholar/research-ui` 无 Cordis host export、`dsh.bundle.patch` 和 host bridge 源码；
- headless 无 httpServer 仍可使用工具；
- unknown Agent 的研究写工具全部 deny；
- Human Decision 工具不存在；
- Session link 在重启后恢复；
- research-core、两个 domain 和 venue skill 都可发现；
- npm pack 包含 runtime skill assets；source/prepared copy hash 一致；
- Skill provider 从发布包根目录解析四组 skill，不得解析到不存在的 `lib/skills`；
- domain/venue 根据 Brief 确定性选择；
- 插件停止清理 tool/listener/sidecar ownership，standalone 停止清理 BFF/listener/sidecar。
- 插件 apply 是 async 且被 Cordis await（cordis 4.0.0-rc.7 的 fiber `_execute` 收集 thenable apply 结果，`ctx.plugin()` 经 `fiber.await()` 在 apply 落定后才 resolve）：`sidecar.start()` 完成（port=0 时解析出真实端口）后才发布 `ctx.research`/client/endpoint 并注册工具、命令与 skills；start 失败有明确日志且不留下半初始化资源（fiber FAILED 并卸载已注册效果）；sidecar disposer 在 apply 开头注册，启动期间 dispose/reload 也能停掉 kernel；
- 同一进程加载两个 research 插件实例时 endpoint/client/缓存/角色/ACL 全部独立（实例闭包，无模块级可变 ref），工具执行解析到本实例的 client，dispose 一个不影响另一个；
- reload/dispose：dispose 后 sidecar 停止、端口释放、owned endpoint.json 清理、工具/命令/skills/pre-execute 监听器全部回收；cordis `update()` 重载先卸载旧 fiber（旧 kernel 停止、注册全部回收）再重新 apply，不重复注册、同 dataDir 数据保留；
- port=0 时 sidecar 只使用 0600 `runtime/endpoint.json` 返回的实际端口；10 秒无握手、protocol/schema/database/config 不匹配均失败；
- 同一端口已有其他 dataDir/database identity 的 Kernel 时拒绝复用，且不得终止非本实例进程；
- /research help/list/status/gates/jobs/claims 等文档和 UI starter 命令均有真实 handler，不落入 generic help；
- Tool catalog 与 reconstruction-contracts.md canonical 名一致，旧 claim_verify/analysis_build/release_bundle 别名返回 deprecation metadata 而非 unknown tool；
- research_onboarding tool 只含 create/stage/scan/grill/propose/status，Schema/ACL 中不存在 accept/adopt/Decision；
- standalone Trajectory/Subagent UI 不导入 DSH Web slot/runtime/client；只通过安全 BFF adapter，DSH 不可用时 Research Outbox 仍可读；

## 9.1 Standalone 负向安全与运维验收

- `--no-token` 只接受 `localhost`、`::1` 或 `127.0.0.0/8`；与 `0.0.0.0`、LAN 地址或其他 hostname 组合时必须在 listen 前失败；
- token 模式不得把 token 写入服务日志或 Kernel argv；目标态改用 0600 token file/匿名通道，迁移期环境传递也不得回显；
- `/api/chat/survey`、Kernel proxy 和启动错误只返回稳定错误码/通用消息，不向浏览器回显 connector URL、内部路径或环境细节；
- `/api/chat/survey` 必须在调用 connector 和写 corpus 之前执行认证 Principal membership；unknown/foreign project 返回 404，且 Corpus Snapshot/Outbox 计数不变；
- `start-standalone-ui.sh` 只有在当前实例 token-check readiness 成功后才退出 0，不能把同端口旧服务的根页 200 当成功；子进程提前退出或 40 秒未就绪必须清理进程组、非零并指出日志；
- Preferences 的 Auto refresh、Accent 和 Auth 文案在 standalone 中可操作，不引用 apply 局部变量或已删除的 DSH boot token；
- `@dsh-scholar/research-ui` 的 clean build 与旧工作树 npm pack 都不得包含 `src/host`、`lib/host` 或 UI Cordis patch；package `files` 使用 standalone allowlist；根 Agent 包仍保留只插入 Agent row 的 `cordis.patch.yml`；
- CI 必须构建全部 standalone packages 并执行 docs verifier、standalone unit/security 与删除面负向断言；根 Agent plugin 的 clean build/full unit 必须在显式 DSH host fixture job 中执行，不得依赖开发机 symlink。

## 10. Cordis self-referential 开发模式

- production dump-config 没有 tool-cordis，工具目录没有 cordis_inspect/mount/unmount；
- dsh web --dev 单独启动仍没有 self tools；
- dev overlay + isolated DSH_HOME 可 inspect 六类信息；
- mount harmless dev_probe，下一轮可调用，unmount 后立即消失；
- provider/consumer pending→active→pending，重新 provide 可恢复；
- duplicate tool/service 失败且旧注册保留；
- mount throw/timeout/HMR/shutdown 清理临时 subtree；
- process、Buffer、raw require、ctx.root/registry 和未注入服务被拒绝；
- 重启不恢复 dyn-N；
- shared/headless/unattended profile 启用 overlay 由启动 guard 拒绝；
- tool call/result 和动态代码可审计。

## 11. Web 与 Security

- token/cookie、Origin、CSRF、SameSite、rate limit、body cap；
- standalone `/v2`/`/bff/research` 忽略浏览器伪造 actor，从认证 Principal 建立身份；无 membership 的跨项目读写统一 404；
- principal-fail-closed：除公开 health 外，缺失、空、非法 Principal 的 project list/create/read/write、Artifact、Evidence、Corpus、Job、Terminal SSE 和 Document 路由必须 401/404 stable code；不得回退为全量列表或 `principal=null` 全放行；
- forged-principal-ignored：body/header 中客户端自报的 creator/actor/principal/tenant 不能建立认证身份或改变授权结果；只有 BFF/service resolver 注入的 Principal 生效；
- mutation 缺失/错误 CSRF token、foreign Origin 或撤权后的 SSE 均拒绝，且不会只依赖 bearer 持有者自报 project/actor；
- Browser 不见 Kernel token，进程 argv/log 不见 secret；
- upstream 5xx/path/stack 脱敏；
- SSE 和 binary 不经 text() 缓冲；
- malicious HTML/SVG/Markdown/ANSI/TeX 无脚本执行；
- Connector SSRF/redirect allowlist；
- Runner env 不含 DSH/credential；
- Release 未批准没有外部发布能力。
- Intake stage/accept、Workspace/PTY、Runner target/config、Trajectory summary/detail/followup 都执行独立 capability 和 Project AuthZ；
- Config schema/UI/file/CLI key parity；错误 scope/unknown key/放宽 security floor 拒绝；effective provenance 可解释，SecretRef value 不进 browser/log/argv/Manifest/Bundle；
- config-defaults-merge：registry 对请求 scope 合并默认（project scope 与 ExecutionConfig/IntegrityConfig 的 zod 默认逐字段一致），覆盖当前全部运行项（ExecutionConfig/IntegrityConfig 全字段、kernel CLI port/host/token/service-token/db/cas、runner CLI poll/heartbeat/timeout/cancel/owner/mode、standalone --host/--port/--token/--principal、images.lock 路径与 digest、network_policy）；
- config-unknown-key-reject：注册表外键与 scope 过滤外的键一律 `unknown_config_key`，不静默忽略；
- config-secret-redaction：secret 键（token/service-token 等）在明文输出中恒为 `<redacted>`，只进入单向 pin hash；换 secret 后 pin 变化（config-registry.test.ts）；
- config-security-floor：`runner.privileged`/`runner.docker_socket`/`runner.network=host`、`network_policy=none` 下的非 none 网络、`allow_automatic_public_release=true`、`--no-token` 非 loopback host、锁外 image digest 一律 `security_floor_violation` 拒绝；
- config-generated-artifacts：JSON Schema/template/CLI help 由注册表生成并与 Zod 一致（同键同默认、secret/floor 注解、enum 集合），生成物写入 configs/generated/（scripts/generate-config-artifacts.mjs）；
- config-pin-hash：相同 effective config 的 pin 稳定，任何值变更（含 secret）pin 变化；kernel 构造期 pin 生效配置（kernel.configPinHash），HTTP 响应带 `x-config-pin` 头、`/v1|v2/health` 带 `config_pin`；kernel CLI 把 pin 写入 0600 endpoint 文件；
- config-project-enforcement：createProject 的项目级 execution+integrity 经 registry 校验，security floor 违规（如自动发布）在落库前拒绝且不产生项目行；

## 12. Recovery 与 Golden Path

故障矩阵对 Kernel、Local/Remote Runner、Orchestrator、BFF 在 queued/running/complete、Gate/Adoption transaction、Workspace/TeX save/preview/build、PTY/Terminal/Trajectory stream、Config patch 各点 kill -9。100 次压力要求无重复正式 Run、无不可解释 succeeded、无丢 Gate/Decision/Adoption、无孤儿容器/PTY。

Golden Path：创建项目→Scope Gate→Corpus→Idea Gate→真实 Baseline→Contract Gate→代码 Patch/Snapshot→多 Seed Formal→实时 Terminal→Analysis/Evidence/Claim→生成并人工编辑 TeX→实时编译/诊断/PDF→Review→Bundle→clean-room→Release Gate。不得注入手工指标或跳过容器。

Bundle-only clean-room 必须把 Bundle 复制到空目录，删除或拒绝访问原 checkout、DB、CAS 和网络，仅允许 Bundle 文件及其中声明的固定 runtime/image digest。外部 `KERNEL_BIN`/`RUNNER_BIN`、原 `$WORK/code`、旧 CAS 或手工重建 payload 一旦被读取即失败。重跑报告必须比较 Bundle manifest hash、正式 metrics/analysis、RunManifest、TeX 输入和 PDF 结构。

REL-01 自动化场景（tests/security/run-release-bundle-tests.sh）：

- clean-room-empty-dir：把原 checkout 目录改名后仍仅从 Bundle 重放成功（KERNEL_BIN/RUNNER_BIN 指向改名后的同一 runtime 树，sha256 与 manifest.runtime 一致）；任何对原 checkout 路径的读取都会使重放失败；
- clean-room-fresh-state：报告 `cleanroom` 字段记录 snapshot_dir/kernel_db/kernel_cas/work_dir，全部位于本次重放新建的临时目录，不得解析进原 checkout 或原 bundle 目录——证明 kernel DB 与 CAS 是全新实例，未复用旧 DB/CAS；
- clean-room-external-runtime：`KERNEL_BIN`/`RUNNER_BIN` 解析进原 dsh-scholar checkout 且 sha256 与声明 digest 不一致 → preflight 立即失败（`external checkout access prohibited`，非零退出，fail report 记录 status=fail 且 compared 全 false）；checkout 之外任意文件的 sha256 与 manifest.runtime 不一致 → 同样立即失败（`sha256 do not match`），均不启动 kernel/runner；
- clean-room-node-mismatch：`node --version` 与 manifest.runtime.node 不一致 → 重放完成但 runtime_verified.node=false、status=fail，其余 compared 字段仍逐字段计算；
- clean-room-tex-field-compare：compared.tex 对 manifest.tex 声明的每个 TeX 输入逐文件比较路径清单与 sha256（bundle 快照 vs 重放内核重建的 document），并对 latex-compile 的 PDF 比较结构（字节大小）；
- clean-room-metrics-field-compare：compared.metrics 对每个成功作业的每个 metric 比较 name/unit/value（数值容差内）与 seed；
- clean-room-analysis-field-compare：compared.analysis 比较 mean（容差内）、n 相等、effect_size 与 baseline_value 相等（双 null 视为相等）；
- clean-room-runmanifest-field-compare：compared.run_manifest 比较成功作业的 idempotency-key 集合、数量、每个 key 的 kind 与 run_manifest/metrics_artifact 存在性（run_id 为 runner 每次运行生成，不做字节相等）。

## 13. CI 阻断矩阵

| Job | 必跑 |
|---|---|
| build-typecheck-unit-contract | 是 |
| security-blocking | 是 |
| ui-i18n-a11y | 是 |
| docker-runner-terminal | 是 |
| latex-compile | 是 |
| golden-path-v2 | 是 |
| clean-room-release | 是 |
| migrations-old-fixtures | 是 |
| package-install-skills | 是 |
| docs-contract-sync | 是 |
| workspace-pty-remote | 是 |
| onboarding-upload-grill | 是 |
| trajectory-subagents | 是 |
| config-schema-parity | 是 |

本矩阵是**最终发布验收覆盖矩阵**，不是开发阶段必须立即搭建的真实环境 CI。所有实际运行的“必跑”Job 在 `CI=true`/GitHub Actions 中必须满足 `skip_count=0`、实际断言数大于 0、`continue-on-error=false`。暂时没有真实环境时，把对应 Job 映射到 `manual-acceptance.md` 的待人工场景；缺 Docker、pdflatex、镜像、DSH fixture、git base 或其他能力不能输出 `SKIP` 后 exit 0 或被聚合器计入 PASS。本地非 CI 环境可以显式 allow-skip，但结果只能记为“未运行”。

## 14. 文档治理与 subagent 流程验收

- docs-contract-sync 校验 Markdown 链接、标题、fence、规范索引和目标/现状标签；
- `verify-docs --diff-check <base>` 必须先解析并验证精确 base SHA；base 缺失、歧义、浅克隆不可达或任意 git error 以 `base_ref_unavailable` 非零退出，禁止将 changed files 当空集；
- diff scope 必须覆盖 `src/`、`packages/`、`workers/`、`apps/`、`configs/`、`migrations/`、`tests/`、`evals/` 和 manifest；行为变更至少同时触达负责规范、本文和 hardening，或带 reviewer 批准的 no-contract-change 记录；
- hardening 状态只允许未实现、部分、已实现未验收、已验收、已关闭；“已验收”必须绑定当前 commit、acceptance 场景以及 CI 报告或结构化人工验收记录，历史计数不能升级状态；
- README、USAGE、hardening 和源码对当前能力有矛盾时，docs-contract-sync 必须失败，且默认采用较低完成状态；
- 修改 src/packages/workers/apps/configs 中的接口、Schema、UI 或行为时，变更集必须同时触达负责的规范、acceptance-tests.md 和 hardening-v0.2-status.md；允许通过 PR label 明确 no-contract-change，但需要 reviewer 理由；
- 新增 UI chrome 时静态检查要求 zh/en key，而不是硬编码文本；
- 新增 route/table/event/tool 时 contract snapshot 与 reconstruction-contracts.md 的 version 同步；
- 开发任务模板含 delegation plan：可并行检索/核验/无重叠实现默认派 subagent；任务写明范围、输出证据和文件所有权；
- 合并记录包含主代理对基础文档、修改代码、方案取舍和最终验收的确认；
- 流程验收不要求为了单文件小改强行派代理，但若存在两个以上独立重任务而未并行，需在记录中说明原因。

缺少 Docker、TeX、DSH fixture 或其他能力的开发环境可以明确标记 `NOT_RUN_MANUAL_PENDING`，先完成代码并继续开发；它不得计入 PASS 或“已验收”。真实环境后续由人工按结构化场景补验，或在条件成熟后补 CI。历史 README 中的测试计数仅作记录，不能代替当前提交的人工/机器验收结果。

## 15. 最终差距审计轮新增场景（2026-08）

- full-auto-fixture-required：`mode=full-auto` 且 execution.fixture_id 缺失或未登记 → 422 `fixture_required`，零项目行落库；已登记 fixture → 201 且绑定持久化（tests/unit/full-auto.test.ts）；
- full-auto-job-inside-profile：full-auto 项目提交作业时 data_artifact_ids 的 blob sha256 必须 ∈ fixture profile.data（否则 422 `fixture_artifact_outside_profile`）；镜像 digest 必须等于 profile.image（否则 422 `fixture_image_mismatch`，缺省绑定 profile.image）；profile.code.archive_sha256 钉定时 code snapshot 不匹配 → 422 `fixture_code_mismatch`（tests/unit/full-auto.test.ts）；
- fixture-guardrails-forced：FixtureProfile 的 automatic_release/allow_private_data/allow_external_release 由 z.literal 强制 false，任何覆写 parse 失败（tests/unit/full-auto.test.ts）；
- archive-running-jobs-409：项目存在 queued/running/retryable 作业时 archive → 409 `jobs_running`，项目保持未归档（reconstruction-contracts.md §4，tests/unit/kernel.test.ts）；
- high-risk-domain-rejected：brief.domain ∈ {clinical, human-trial(s), wet-lab, weapons, biosecurity} → 422 `domain_unsupported`，零落库；默认纯计算域不受影响（product-spec.md §1，tests/unit/kernel.test.ts）；
- orchestrator-lease-election：orchestrator_leases 首占/同 owner 续约 generation+1/过期抢占/他人 live lease 跳过（detail.skipped 不双推进）、每轮 refresh、close() 释放、--token-file 附 Authorization（缺失 fail fast）——tests/unit/orchestrator.test.ts 41/41；
- v2-health-canonical：GET /v2/health 返回 protocol_version='v2'、capabilities 对象（14 项能力布尔 + locales ['zh','en'] + locale_contract_revision 1）+ config_pin（tests/unit/v2.test.ts）；
- v1-health-identity：GET /v1/health 返回 instance_id/protocol_version/schema_version/database_id（test-instance-plan.md §1，保留 ok/instance/config_pin）；
- sqlite-busy-timeout：openDatabase 设置 WAL + foreign_keys + busy_timeout=5000（storage-migrations.md §2，tests/unit/migrations.test.ts）；
- cas-put-reverify-size：CAS put 对已存在 Blob 复验 size，不匹配（内容地址损坏）→ 拒绝（storage-migrations.md §6，tests/unit/cas-gc.test.ts）；
- evidence-provenance-visible：Evidence 面板按 item.provenance_status 原样渲染，不硬编码 verified（gui-plugin-plan.md §10）。
- next-action-v2-cards-rendered：Overview 渲染结构化 NextAction v2 卡——三态 tone（ready/blocked/done）与禁用规则（done 灰显、blocked 有 required 缺口禁用、ready 高亮）、label 按 i18n key 翻译或原样显示 kernel label、required 缺口列表（已知缺口 code 翻译/未知原样）、route 映射（gates/runs/evidence/manuscript/budget 直达、ideas/contracts/release/overview 收敛 Overview tab、未知 route 安全回退）、`code='unknown'` 只读无 CTA、legacy `next_actions: string[]` 回退与畸形 v2 安全退化——tests/unit/next-action-cards.test.ts 26/26（gui-plugin-plan.md §5.1，审计报告 §4 #11）。
- metrics-endpoint-loopback（OBS-01，reconstruction-contracts.md §18）：GET /internal/metrics 返回 JSON 快照（counters + histograms + generated_at/uptime_ms），仅 loopback 可达——127.0.0.1/::1/::ffff:127.0.0.1 来源 200，非 loopback 来源 403 `loopback_only`，bind host 为 loopback 时放行；不要求 service token（配置 serviceToken 时同样 200）；快照不含 token/路径/内容（tests/unit/metrics.test.ts）；
- metrics-key-path-counters（OBS-01）：kernel 关键路径打点后 counter 增长——outbox append（emit）/dead-letter（deadLetterEvent）、job claim/complete、lease expiry（recoverExpiredLeases 累计回收数）、terminal dropped bytes（appendTerminalFrames 累计淘汰字节）、CAS orphan GC（collectOrphanBlobs 累计清除数）、TeX build 完成（texUpdateBuild 终态）、budget 记账（recordUsage 计数 + model_cost_usd 直方图）；HTTP 请求计数与延迟直方图由 server 层按 response finish 记录（tests/unit/metrics.test.ts）；
- connector-failure-metric（OBS-01）：multiSourceSearch 任一 source 失败 → `connector.source_failure{source}` 计数（观察者钩子可选参数，缺省 no-op，既有调用方行为不变）（tests/unit/metrics.test.ts）。
- terminal-frame-conflict-409（STORE-05，storage-migrations.md §4）：appendTerminalFrames 对已存在 (run_id, seq) 重放，内容不同 → 409 `terminal_frame_conflict`（通道/文本/byte 范围/frame_kind/payload_json 任一不同即冲突）；内容相同 → 幂等跳过；retention 已淘汰行重放不报错；既有 reconnect-after-seq/retention-gap/overflow 场景不破坏（tests/unit/terminal.test.ts 新增 3 用例）。
- runner-profile-registry-opaque（domain-model.md §2/§9.1，审计 §4 #8）：内置 RunnerProfile 注册表恰含三个 opaque id——`profile_local_docker_cpu_v1`（local-docker/CPU）、`profile_local_docker_gpu_v1`（local-docker/GPU 意图，无 GPU 路径故 CPU-only pin，capability 标注 `gpu-requested`+`cpu-only`）、`profile_isolated_subprocess_v1`（isolated-subprocess，trusted-smoke-fixture 专用非容器）；Job 只引用 opaque profile_id，记录 `.strict()` 拒绝 docker flags/hostname/credential/endpoint；profile image digest 与 configs/runner-profiles/images.lock.json 的 node_fixture 条目逐字节一致（tests/unit/runner-profile.test.ts）；
- runner-profile-config-hash：`computeProfileConfigHash` 对同一记录恒同值且与记录 `config_hash` 自洽（sha256:<64 hex>），任一字段（display_name/image/limits/capabilities/enabled/profile_id）变更即变——Job 固定 profile/config hash 的 pin 语义（tests/unit/runner-profile.test.ts）；
- runner-profile-enum-map：v1 enum `local-docker-cpu/gpu/isolated-subprocess` → 同名本机 opaque id 映射；未知 id（含裸字符串）→ 422 `runner_profile_unknown`——createProject（execution.runner_profile_id 未登记，零落库）与 submitJob（job 级 runner_profile_id 未登记）双面 fail closed（tests/unit/runner-profile.test.ts + kernel.test.ts）；
- job-profile-pinned：submitJob 对 secure kinds（baseline/pilot/formal/reproduce/latex-compile）注入 `payload.runner_profile_id` + `payload.profile_config_hash`（与注册表解析一致，DB read-back 保留）；优先级 job 级 runner_profile_id > project 级 execution.runner_profile_id > v1 enum 映射；非 secure kind（echo/smoke）不注入（legacy 兼容）（tests/unit/kernel.test.ts）；
- runner-profile-hash-mismatch-environment：runner executeJob 读取 job 的 profile id/hash，按注册表复算校验——未知 id 或 config hash 不一致 → completeJob failed/`failure_class=environment`（绝不执行）；校验通过后 docker 参数（limits/network/opaque profile_id）取自 profile 记录，缺省值与既有容器基线字节级一致（buildLocalDockerArgs 纯函数不变，execution-target.test.ts 不破坏）；
- isolated-subprocess-restricted：secure kinds 解析到 isolated-subprocess profile（enum 或 opaque id 任一途径）→ 422 `container_execution_required`；`trusted_fixture=true` 的 smoke 仍可提交，runner 端仅 trusted-smoke-fixture 允许 subprocess（tests/unit/kernel.test.ts + execution-runtime.md §1）。

## 17. 存储层实现轮新增场景（2026-08，STORE-06/STORAGE-07/STORE-08）

- lease-token-hash-persisted（STORE-06，storage-migrations.md §4 / domain-model §10.1）：claim 后 jobs 行 `lease_token_hash` = sha256(claim 返回的明文 token)，64-hex；`payload` 与公开 payload 均不含 `__lease_token` 明文；同进程 getJob 仍返回明文 token（claim 响应面），重启后重取为 null（存储面哈希、传输面明文，文档注明）——tests/unit/kernel.test.ts；
- lease-fencing-hash-compare（STORE-06）：heartbeat/complete/terminal frames 的 token 半区比较对象为 sha256(提供值) vs `lease_token_hash`——旧 generation/旧 token/错 token 一律 409 `lease_stale`，当前凭据通过；`recoverExpiredLeases` 释放内存 token，重 claim 轮换 generation+token——tests/unit/kernel.test.ts；
- lease-legacy-row-compat（STORE-06）：hash 列为空的旧行（pre-0014 明文在 payload.__lease_token）走旧路径比较仍通过 heartbeat/complete，错误 token 依旧 fail-closed——tests/unit/kernel.test.ts；
- migration-0014-backfill（STORE-06）：0014 对 payload.__lease_token 存在的旧行回填 hash（payload 原样不动）、pty_sessions 旧形状（明文 NOT NULL）重建为 `lease_token TEXT`（可空）+ `lease_token_hash TEXT NOT NULL DEFAULT ''` 并回填 hash、保留 project 索引、新会话 NULL 明文 + hash 写入可行；SCHEMA_VERSION 13——tests/unit/migrations.test.ts；
- pty-lease-hash-only（STORE-06）：pty open 只落 hash 列（`lease_token_hash`），明文仅存在于返回的 session 对象；读回（getSession）`lease_token` 为 null 且过 `PtySession` schema（nullable）——tests/unit/pty-session.test.ts；
- backup-on-start-hook（STORAGE-07，storage-migrations.md §8.2/§10）：`--backup-on-start`/`DSH_SCHOLAR_BACKUP_ON_START=1` 在迁移前对 dataDir/backups/ 生成 `kernel-<ts>.db`（VACUUM INTO，0600，可打开、含迁移前 schema_version）与 `inventory-<ts>.json`（0600，每个 blob sha256+size+mod_time，与 CAS 逐字节一致）；库不存在（首启）跳过并注明；备份失败 loud fail——tests/unit/backup.test.ts + bin/kernel.ts 冒烟；
- scan-integrity-report（STORAGE-07，storage-migrations.md §10）：`scanIntegrity()` 返回 `{missing_blobs, orphan_blobs, size_mismatch, hash_mismatch, scanned_blobs, skipped_blobs, total_blobs}`——删除 blob → missing、无引用 blob → orphan、同长篡改字节 → hash_mismatch、截断 → size_mismatch、`limit` 限量复验并报告 skipped、修复后自愈——tests/unit/cas-gc.test.ts；
- migration-0003-checksum-frozen（STORE-08，storage-migrations.md §8.1）：0003 的 checksum 绑定冻结的内联 DDL 快照（body 含 tex_documents/tex_snapshot_files/tex_preview_pending 文本、不含共享 TERMINAL_DDL/TEX_DDL 引用）；共享常量演进不影响 0003 校验（checksum 为 id+body 纯函数），对 body 的任何编辑都改变 checksum（immutability 兜底）——tests/unit/migrations.test.ts。

## 18. v2 形状对齐组新增场景（2026-08，domain-model.md §5/§6/§8/§9/§16，审计报告 §4 #9）

- corpus-snapshot-v2-shape：`snapshotCorpus` 写入 `schema_version=1` + `source_status='complete'`（默认）并持久化读回；显式 `source_status='pending'` 记录来源失败；旧快照行（无两字段）经 `CorpusSnapshot` schema 解析回退默认值（旧读兼容）——tests/unit/v2-shape.test.ts；
- passage-content-hash-forced：快照写入时每条 passage 强制 `content_hash = sha256(text)`（调用方提供的 hash 被覆盖，客户端不可声明）；验证步骤要求非空；存储读回全为非空 64-hex；无 content_hash 的旧 passage 仍可解析（新写必填、旧读兼容）——tests/unit/v2-shape.test.ts；
- idea-gate-corpus-bound：card 携带同项目 `corpus_snapshot_id` → Idea Gate 批准；snapshot 不存在 → 422 `idea_corpus_unknown`（Gate 保持 pending、项目状态不动）；跨项目 snapshot → 422 `idea_corpus_foreign`；无该字段的旧卡与无 idea_id payload 的 idea gate 原样放行（兼容）——tests/unit/v2-shape.test.ts；
- artifact-kind-tex-extension：`registerArtifact`/HTTP artifact 路由接受 `tex-source|bib|compile-log|compile-aux` 并回读；非法 kind 仍 422 `invalid_kind`；旧 kind（log/data 等）不受影响（tests/unit/v2-shape.test.ts）；runner latex-compile 完成路径以 `compile-log`/`compile-aux` 注册 TeX 日志与 aux/bbl/blg/fls 打包（PDF 保持 `pdf`），既有 tex-build/tex-preview/tex-kernel 套件不破坏（`bash evals/latex-compile-e2e.sh`）；
- job-created-by-principal：`submitJob` 持久化 `created_by_principal_id`（getJob/listJobs/原始列读回）；HTTP 作业路由以 BFF 注入的 `x-principal-id` 为提交者（body 覆写仅供内部调用方），两者皆缺 → NULL；旧行 NULL 兼容——tests/unit/v2-shape.test.ts；
- budget-storage-bytes：`recordUsage({storage_bytes})` 在事务内与 model_cost_usd/gpu_hours/api_requests 原子累计并读回；HTTP budget 路由接受 `storage_bytes`；legacy budget 行读回 0（默认值）——tests/unit/v2-shape.test.ts；
- migration-0016-v2-shape：jobs 追加 `created_by_principal_id TEXT`、budget 追加 `storage_bytes INTEGER NOT NULL DEFAULT 0`（幂等、不动旧迁移 checksum、SCHEMA_VERSION 14）；既有 v1 fixture 导入在 0016 下仍数据完整——tests/unit/migrations.test.ts。

## 19. v1 迁移补 3 步新增场景（2026-08，MIG-V1，migration 0017_v1_legacy_marks / SCHEMA_VERSION 15，审计报告 §4 #6）

- v1-fixture-three-marks（storage-migrations.md §9）：v1 fixture 库迁移后——echo/smoke 旧作业 `synthetic_fixture=1`（非 fixture 旧行保持 0）；run_manifest 无签名的旧作业与 succeeded 且无 manifest 的非 fixture 旧作业 `signature_status='legacy_unsigned'`；payload 内联 stdout/stderr 的旧作业获得 final log Artifact（`kind='log'` Artifact 行 + 真实 CAS blob + `jobs.legacy_log_artifact='sha256:<hex>'`，blob 内容与记录 sha256 逐字节一致、media_type/file_name/legacy metadata 齐备），不产生任何 terminal_frames——tests/unit/migrations.test.ts；
- migration-0017-idempotent（storage-migrations.md §8.5/§9）：重复打开幂等（无重复标记、无重复 Artifact、SCHEMA_VERSION 15）；rewind 重跑 0017 只补旧行——signed/pending 运行、签名 manifest 作业、kernel 写入的 echo/smoke 新行均不受回填影响（新行不被误标 legacy_unsigned/synthetic_fixture）——tests/unit/migrations.test.ts；
- legacy-log-no-cas-marker（storage-migrations.md §9）：openDatabase 无 casRoot 时旧日志只记 `legacy:in-payload` 标记，不创建引用缺失 Blob 的 Artifact 行（完整性扫描不产生 missing blob）——tests/unit/migrations.test.ts。

## 20. TeX save 单事务 + tex.file.saved Outbox 新增场景（2026-08，TEX-SAVE，审计报告 §4 #3）

- tex-save-single-transaction（storage-migrations.md §5/§7，execution-runtime.md §12）：writeFile/deleteFile/moveFile 的「文件行变更 + document revision 递增」在 tex store 连接上包单事务（withTx：BEGIN IMMEDIATE/COMMIT/ROLLBACK；`isTransaction` 守卫使 moveFile→writeFile 嵌套复用同一事务，无嵌套 BEGIN）。最后一条语句（revision bump）注入失败时整体回滚——writeFile 无文件行且 revision 不变（无半写）、deleteFile 文件原样保留且 revision 不前进、moveFile 源保留且目标不出现；成功路径文件行与 revision 原子落库——tests/unit/tex-workspace.test.ts；
- tex-file-saved-outbox（storage-migrations.md §5/§7，domain-model.md §12）：kernel texWriteFile 成功保存后追加一条 `tex.file.saved` 事件——event_seq 按 project aggregate 单调、aggregate_type='project'/aggregate_id=project_id/aggregate_revision=保存后 document revision、payload 含 project_id/document_id/path/revision（request_id/session_id 由调用方传入时透传，HTTP PUT file 路由以 x-request-id/x-principal-session 关联）——tests/unit/tex-event.test.ts；
- tex-file-saved-no-event-on-conflict：保存 409 document_version_conflict 时不追加事件（写未提交即无 outbox），文件内容与 revision 均未动——tests/unit/tex-event.test.ts；
- tex-file-saved-delete-move-quiet：delete/move 按设计不发事件（只有 save 发出 tex.file.saved）——tests/unit/tex-event.test.ts；
- tex-file-saved-trajectory-lane：tex.file.saved 投影为 research lane 条目（redacted summary，raw payload 不出投影）——tests/unit/tex-event.test.ts；
- tex-cross-connection-ordering（storage-migrations.md §7 取舍）：tex store 是独立 WAL 连接，tex 写先提交、outbox 后写；kernel 连接损坏时保存仍成功（outbox 追加失败只记录 error 不阻塞保存——写已提交、客户端已见成功，失败只会导致 409 重试）——tests/unit/tex-event.test.ts。

## 21. 2026-08-11 当前复审强制回归场景

本节来自 `main@fda346b` 代码复审。以下场景全部是发布阻断验收；在源码修复、当前提交自动化报告和目标环境证据同时存在前，hardening §5 对应项不得升级状态。

- sidecar-kernel-bearer-required：standalone/plugin sidecar 每次启动生成并注入普通 Kernel Bearer（0600 `<dataDir>/kernel-token`，首次随机 32 hex、之后复用，env 传递、永不进 argv/log/client bundle）；除 `/v1|v2/health` 豁免外，直接访问 sidecar Kernel 的 GET/POST/stream 在缺失、错误、旧 token 时均 401（读写负向都测）；`x-service-token` 是独立内部路由层——不能替代普通 bearer（public 路由 401），bearer 也不能解锁内部路由（403 `service_token_required`），两者齐备时内部路由 200；BFF（proxy 与内部 lookup）、Runner（`--token` 或 `DSH_SCHOLAR_KERNEL_TOKEN` env）、Orchestrator（`--token-file` 或同 env）全部使用正确 token；无 token 的裸 kernel 才允许跳过检查（显式开发模式，sidecar 场景永不出现）；**代码侧已闭环（2026-08-11 修复轮，hardening §5 P0 API-01/SIDE-01，commit 4b92ed8）**：两个 sidecar 按 service-token 同款模式维护 0600 `<dataDir>/kernel-token`（首次随机 32 hex、之后复用，env 注入永不进 argv），kernel 配置 token 后除 health 外全部路由强制 Bearer（缺/错一律 401）；BFF/Runner/Orchestrator 全带正确 token；两层凭据严格分离（bearer 不解锁内部路由 403，x-service-token 不替代普通 bearer 401）；证据：tests/unit/kernel.test.ts server 矩阵 + tests/unit/sidecar.test.ts + run-standalone-http-tests.sh 直接 sidecar 端口负向段；
- global-id-project-authz：Artifact、Document/TeX、PTY session、event、child 等 global-id 路由先由服务端解析 owning project，再做 membership/role；跨项目或撤权后 read/write/stream/control 一律 404/403，无 ID 枚举；BFF 和 direct Kernel 两层都有负向测试。**代码侧已闭环（2026-08-11 修复轮，hardening §5 P0 API-01/PTY-01）**：BFF 代理 handler 对 `memberProjectId=null` 的 global-id 路由经 kernel 逐类解析所属项目——`artifactProjectId`（GET/HEAD `/v1/artifacts/{id}`，HEAD 读权威 `x-project-id`，`?project_id=` 直接校验）、`documentProjectId`（`/v1/documents/{id}/*` 全部子路由，经 …/tree 的 `document.project_id`）、`ptySessionProjectId`（`/v1/pty/sessions/{id}*`，带注入 principal 读会话行；kernel 对非 owner 的 403 在 BFF 同为 404）、`eventsProjectId`（`/v1/events` 必须显式 `?project_id=`，无 scope 直接 404）；`globalResourceProject` 派发 + `isGlobalIdRoute` 兜底——无法解析的 global-id 路由一律 404，kernel 的 422/409 形状不穿透 BFF；解析后先 membership（非成员 404，与 project-scoped 同契约）再转发，role 策略自动生效（viewer/auditor 禁写）；`POST /v1/artifacts` 按 body project 补 membership/role（镜像 pty-open 规则，跨项目注册 404）。证据：tests/security/run-standalone-http-tests.sh P0-2 段（跨项目 artifact/document/pty/events 404、成员 200、猜 ID 404、无 scope events 404、body 注册进 foreign 项目 404、撤权后同 BFF 下一请求 404；原 180 断言全部保留）+ 手工 smoke 全链；剩余：浏览器级与多人真实撤权人工验收（NOT_RUN_MANUAL_PENDING）；
- pty-owner-fencing-all-operations：PTY GET/control/frames/attach/detach/close 都要求 authenticated principal、owner、current lease/generation；header 缺失不是兼容放行；他人 session ID、旧 generation、撤权和重连抢占均失败且不泄漏 frames。**代码侧已闭环（2026-08-11 修复轮，hardening §5 P0 PTY-01）**：kernel `requirePtyOwner`（server.ts）对 GET `sessions/{id}`、control、frames 强制 principal+owner——缺 `x-principal-id` → 422 principal_required（GOV-01 模式）、非 owner → 403 pty_principal_mismatch（与既有 control 检查一致）、未知会话仍 404 pty_session_not_found；control 强制 session lease（`x-pty-lease`）：缺失 → 403 lease_required、错误 → 403 lease_invalid；frames 可选 lease 但给错仍 403——"header 缺失即放行"不再存在；lease 校验在 pty-session.ts `verifyLease`（sha256+timingSafeEqual 常数时间，STORE-06 hash 列为主、legacy 明文列回退、两者皆无 fail-closed）；BFF 对全部 `/v1/pty/sessions/*` 转发注入 server-derived `x-principal-id` 并透传 `x-pty-lease`（kernel 校验，BFF 不读不铸）。证据：tests/unit/pty-session.test.ts 14/14（direct-kernel 负向矩阵：无 principal 422、owner 不符 403、lease 缺失/错误 403、frames 错 lease 403、跨项目 control 403、未知 id 404 + 正向 owner+lease 200）、tests/security/run-hardening-tests.sh direct-kernel PTY 段（同矩阵 say/ok/bad + 正向 control 200）、run-standalone-http-tests.sh P0-2 段（跨项目会话 404、成员会话 200、无 lease control 403 穿透 BFF）；剩余：浏览器 interactive-terminal-browser 真实 stdin/resize/signal 与撤权抢占人工验收（NOT_RUN_MANUAL_PENDING）；
- code-snapshot-approved-workspace-only：code snapshot wire 只接受 workspace_id + root-relative path；绝对路径、`..`、用户 home、仓库外目录、symlink 逃逸全部 422，且 CAS/Artifact/manifest 零写；批准 workspace 内文件逐字节归档。**代码侧已闭环（2026-08-11 修复轮，hardening §5 P0 SNAPSHOT-01/API-01）**：`POST /v1/projects/{id}/code-snapshots` 只接受 `{workspace_id, root_relative_path, description}`（strict schema——旧 `{path}` 宿主路径形状 422 废弃，api-contracts.md 同步）；服务端从批准的项目 workspace 解析实际根（`dataDir/workspaces/{project_id}/{workspace_id}/`），跨项目/未知 workspace 404 `workspace_not_found`（不可枚举）；相对路径拒绝绝对路径、`..`/`.` 段、NUL、盘符、反斜杠与空段（复用 `normalizeWorkspacePath`，422 `invalid_path`），尾斜杠裁剪接受；realpath 容器校验拒绝 workspace 目录被 symlink 替换逃逸（422 `snapshot_path_escape`）；walk 拒绝任何逃逸根的 symlink；secret 文件（`.env`、`*_token`、`*.key`/`*.pem`、`id_rsa`/`id_ed25519`、`.aws/credentials`、`service-token`/`kernel-token`、`.npmrc`/`.pypirc`/`.netrc`/`.htpasswd`）拒绝整个快照并列出全部文件名（422 `snapshot_secret_file`，CAS/Artifact/manifest 零写）；SNAPSHOT_MAX_FILES/MAX_FILE_BYTES/MAX_TOTAL_BYTES 上限保留；`code_snapshots.source_json` 记录 workspace 绑定溯源且宿主路径零泄漏。证据：tests/unit/snapshot-root.test.ts 8/8、tests/unit/kernel.test.ts 快照用例（workspace 语义迁移后全绿）、tests/security/run-hardening-tests.sh P0-4 HTTP 段（workspace 根 201、子目录 201、旧形状 422、绝对/`..`/盘符 422、跨项目 404、secret 422 列名）；剩余：真实 golden-path Docker 端到端与浏览器/人工验收（NOT_RUN_MANUAL_PENDING，队列见 manual-acceptance.md §4）；
- manuscript-open-never-regenerates：首次 ensure 可生成模板；之后页面 render、locale 切换、poll、save 后 rerender、tab 往返不得改写 `paper.tex`/`main.bib` 或推进 revision；regenerate 是独立显式操作，有确认、版本历史和冲突保护。**代码侧已闭环（2026-08-11 修复轮，hardening §5 P0 TEX-01/TEX-03）**：`GET /v1/projects/{id}/manuscript-drafts` 只读（无内容 404 `manuscript_not_found`，绝不建行/写字节）；POST 默认 ensure（已有文件即原样返回，created=false，字节/revision 不变）；`regenerate=true` 才重写且生成前冻结当前内容为 revision-scoped snapshot（旧字节 `GET snapshot-files?revision=&path=` 可回退）；client 先 GET 后创建（rerender 零写入，resolveOpenDocument 纯逻辑）——tests/unit/tex-ensure.test.ts 8/8 + tests/unit/manuscript-flow.test.ts 15/15；浏览器视觉验收（打开/往返无写入的观感）NOT_RUN_MANUAL_PENDING；
- tex-save-live-preview：成功保存调用一次 debounce preview hook；快速连续保存合并；queued/running/failed/superseded/stale/PDF/diagnostics 在同页实时更新；权威 Compile 与 preview 清楚分离；保存 409 不触发 preview/compile。**代码侧已闭环（2026-08-11 修复轮）**：client 保存成功（PUT file 200）后调用一次 `POST /v1/documents/{id}/preview-builds`（服务端 debounce 800ms 合并；服务端 1907897 未动，仅接线 client），UI 轮询 `GET preview-builds` 投影并展示 pending/queued/running/succeeded/failed/cancelled/superseded/stale 状态文本 + 最新 succeeded preview 的 PDF embed/下载（previewPanelModel 纯逻辑）；保存 409 路径不触发（msSaveFile 冲突分支直接返回）——tests/unit/manuscript-flow.test.ts 15/15 + tex-preview.test.ts 12/12；浏览器视觉验收（保存→debounce→PDF 自动刷新同页链）NOT_RUN_MANUAL_PENDING；
- remote-secure-container-only：baseline/pilot/formal/reproduce/latex-compile 在远端只能使用 digest-pinned restricted container；宿主 subprocess 对 secure kinds fail-closed；trusted fixture 是唯一显式例外，并验证宿主 marker 未执行。**代码侧已闭环（2026-08-11 修复轮，hardening §5 RUN-REMOTE-01 两行）**：远端 Agent 默认执行器按 kind 路由（remote-agent.ts `defaultRemoteExecutor`）——secure kinds 经 `buildLocalDockerArgs`（与本地 docker 路径逐项一致：digest-pinned image/`--network none`/`--user 65534:65534`/`--read-only`/`--cap-drop ALL`/`--security-opt no-new-privileges`/pids/memory/cpus）容器执行；`dockerProbe` 失败 → 该 kind `failure_class=environment` 完成，绝不 subprocess；subprocess 仅 echo 与显式 trusted smoke fixture（`ExecutionOutputContract.trusted_fixture` 固定进 plan；未标记 → environment 失败）。证据：tests/unit/remote-wire.test.ts（无 docker → environment 失败 complete、docker 可用 → 参数断言 + 成功、defaultSubprocessExecutor 负向/trusted 正向）；剩余：真实远端主机容器运行时验收（NOT_RUN_MANUAL_PENDING）；
- remote-identity-fencing-manifest：Fleet route 强制 mTLS service identity，证书吊销即时生效；assignment/job/run/owner/generation/token/manifest.run_id 全链绑定；container_digest/data_hash/code snapshot/seed/metrics/output contract 缺一即拒绝；stale complete 不改变终态。**代码侧已闭环（2026-08-11 修复轮，hardening §5 RUN-REMOTE-01 两行）**：remote 与 local 复用唯一 manifest builder（run-manifest.ts）——complete 携带 container_digest/data_hash/code_commit/code_snapshot_id/seed/metrics_artifact/run_id；kernel completeJob 对 secure kinds 强制 required facts（缺失/不一致 → 422 manifest_facts_missing/manifest_seed_mismatch/manifest_snapshot_mismatch/manifest_container_mismatch/manifest_data_mismatch）且 manifest.run_id 必须等于本 attempt 的 runs.run_id（422 manifest_run_mismatch）；Fleet 层 complete/stage/finalize 顶层 run_id 必须与 claim 的 plan.run_id 一致（422 run_id_mismatch，stale complete 拒绝）；lease/owner/generation/token fencing 既有。证据：tests/unit/remote-wire.test.ts（run_id 不匹配 422、缺 facts 422、stale attempt 拒绝）、tests/unit/kernel.test.ts（五个 422 负向 + analysis/§12.5/STAT-01/duplicate-seed/TeX 全链适配）；剩余：真实 mTLS service identity + 证书吊销即时生效（NOT_RUN_MANUAL_PENDING）；
- remote-cas-binary-auth：Fleet CAS 使用 authenticated byte stream，不经过 `text()`/UTF-8 round-trip；随机二进制、PDF、压缩包和 NUL bytes 往返 hash/size 完全一致；caller 声明 project_id 不能越过 claim 所属项目。**代码侧已闭环（2026-08-11 修复轮，hardening §5 RUN-REMOTE-01 两行）**：ResearchClient `fetchArtifactBytes`（arrayBuffer 原生字节，404 → null、401 等抛 KernelApiError fail fast）+ FleetKernelClient/handleCas 全程 Buffer→base64（零 UTF-8 编解码）；fleet client 请求 kernel 带 Authorization Bearer（`--token`/`DSH_SCHOLAR_KERNEL_TOKEN`；401 非 retryable）；handleCas project binding——agent 必须持有该 project 的 outstanding claim（403 cas_project_forbidden）；stage/finalize 也带 run_id 绑定。证据：tests/unit/remote-wire.test.ts（NUL/0xFF 随机字节 round-trip 逐字节一致 + 越权 project 403）、tests/unit/fleet-bin.test.ts（真实 HTTP kernel stub：无 token 401 fail fast 不静默当 cas_missing、带 token 字节往返）；剩余：真实两主机二进制 CAS 验收（NOT_RUN_MANUAL_PENDING）；
- membership-revocation-no-stale-cache：成员/角色变更后下一次请求立即采用新 revision；旧 Promise/cache 不继续授权；researcher/viewer/auditor 对 PI-only intake adopt、archive/unarchive、Gate Decision 全部 403（pi/operator 是放行角色）。**代码侧已闭环（2026-08-11 修复轮，hardening §5 P0 API-01 + §5 P1 GOV-01/ONBOARD-01）**：① BFF 删除永久 membership Promise 缓存（projectMembers 每次请求实时查 kernel `project_members`，job/child 的 resource→project 映射仍缓存——映射不可变，无授权语义）；同一 BFF（--principal p0-2-role）在成员被 kernel 移除后下一次请求立即 404（project-scoped 与 global-id document 路由都验）。② PI-only capability route table（transitions/gates/decisions/budget/approve/accept + intake adopt + project archive/unarchive）：BFF 与 kernel 共用同一份表，双侧不漂移——researcher 在 BFF 层 403 `role forbidden`（永不转发）；kernel 在 adopt/archive/unarchive 路由自身从 `project_members` 解析角色二次校验（researcher/viewer/auditor → 403 role_forbidden、非成员 → 404、缺身份 → 422 principal_required），BFF 对这些转发注入 server-derived x-principal-id/x-principal-role。证据：tests/security/run-standalone-http-tests.sh P0-2 段（添加成员→200、kernel 删除成员→同 BFF 立即 404）+ §5 P1 段（BFF researcher/viewer/auditor adopt/archive/unarchive 403、kernel direct researcher 403/无 principal 422/非成员 404、PI 全链 adopt 200 + archive/unarchive 200、撤权后下一请求 404；全套 246/246）、tests/unit/kernel.test.ts v1 PI-only 矩阵；剩余：浏览器/多进程真实撤权人工验收与 researcher 角色 UX（NOT_RUN_MANUAL_PENDING）；
- init-resume-intake-grill：有无历史项目都先显示可选择的 Init/Resume；可从 research brief、survey、idea、contract、experiment、evidence、manuscript 任一阶段接入；上传/恢复上传、scan、Grill Me、proposal、PI adopt 全链可运行；取消/重连不丢进度。**代码侧已闭环（2026-08-11 修复轮，hardening §5 P1 ONBOARD-01/UPLOAD-01/GUIDE-01）**：(1) 显式选择——Start 屏「未选中项目即显示三入口」（`target = state.projectId`，`projects[0]` 自动回退删除；nav.ts `startScreenVisible`/`filterProjects`/`pickProject` 纯函数——精确 id 优先、唯一 name 次之、歧义/缺失返回 null 绝不回退；Start 屏内嵌打开列表 + id 输入）。(2) 导入卡真实 intake 向导（client/modals/intake.ts）：begin（目标项目/新建 + source_label + target_phase 按阶段裁剪 taxonomy）→ stage（multipart ≤32MiB 逐文件、`apiMultipart` 原始 boundary 透传 + bearer/CSRF、客户端 32MiB/文件名预检、服务端 413 兜底、已 staged 列表 verdict/删除/续传、sha256 幂等复用）→ scan（scan_summary + observations + rejected 拒因）→ grill（答案 `principal:{}` 持久化 human_assertion + revision）→ propose（plan/risks/pre_accept_checklist/置信度/缺口/mappings/required_gates）→ PI adopt（proposal/target revision 钉定 + 幂等键 + AdoptionReceipt 展示）；每步从 GET intake 投影恢复，错误显示稳定错误码文案（`INTAKE_ERROR_KEYS` 25+ 码 zh/en）。(3) NextAction 引导——kernel next-action.ts intake 覆盖动作（`intake_resume`/`intake_scan`/`intake_answer`/`intake_propose`/`intake_adopt`(pi)，`NextActionContext.intakes` 可选、projectProjection 从 listIntakes 投影、终态零动作）+ client `intakeGuidance` 并入每步引导列表（去重/tone 保留）+ Overview 卡 route='intake' 打开向导。(4) 分块——服务端整文件 staged（≤32MiB），UI 如实不做分块；恢复上传 = 已 staged 文件继续/重传（幂等）与删除后重传。证据：tests/unit/intake-flow.test.ts 23/23（三入口选择、状态机每步可恢复、错误码映射、adopt 需 principal、引导映射、zh/en parity 零缺 key）、next-action.test.ts 16/16（intake overlay 全状态 + 终态零动作 + kernel 集成 begin→stage→scan 投影）、ui-simple.test.ts 15/15、next-action-cards.test.ts 29/29、i18n-chrome.test.ts 3/3、根 pnpm test 全绿、research-ui typecheck+build 全绿、run-upload-tests.sh / run-hardening-tests.sh（standalone 段）不破坏、verify-docs 19/19。剩余（浏览器视觉验收，NOT_RUN_MANUAL_PENDING）：向导拖拽/上传交互、scan/grill/proposal/adopt 同页观感、Start 屏列表观感、真实浏览器多步断点续接（队列见 manual-acceptance.md §4）；
- workspace-browser-workbench：真实磁盘 workspace 提供文件树、tabs、文本编辑、binary preview、search/watch、upload、create/move/delete/history/problems；version/etag 冲突可比较/重载/另存；桌面/窄屏与键盘/a11y 通过；**逻辑层已闭环（2026-08-11，见下方 workspace-client-tree-tabs 行——树/多标签/CAS 保存/二进制/历史回退/路径搜索模型与面板接线全绿）**；剩余为本行的浏览器视觉验收（文件树渲染/拖拽上传/多标签观感/窄屏/键盘 a11y），记 NOT_RUN_MANUAL_PENDING（队列见 manual-acceptance.md §4）；
- workspace-client-tree-tabs（WORK-01，hardening §5 P1，api-contracts.md §17）：**代码侧已闭环（2026-08-11，commit 待定主代理统一提交）**——client 新增 `workspace-model.ts`（纯逻辑层，NO DOM）+ `panels/workspace.ts`（挂入 More 导航，`#tab=workspace` 稳定深链）：树模型（flat 节点列表按父目录分组 + 懒展开——子项仅在父目录展开后渲染、implied dir 由文件路径前缀客户端投影（listSince 喂不带 dir 节点）、空目录为客户端虚拟节点——服务端目录由路径前缀投影、无 dir-create 操作、首个文件落盘后由投影取代、选中状态）；操作模型（create 文件 = write expected_version=0 create-if-absent、CAS 保存 expected_version/etag → 409 冲突提示重载（markWorkspaceTabConflict + reloadWorkspaceTab 重基线，绝不静默覆盖）、delete/move 带源 CAS（move 目标已存在 409 `workspace_move_destination_exists` → 换名提示）、readVersion 历史回退 = 旧版本字节以**当前** version/etag 为守卫写回）；二进制（上传 multipart POST `/assets` ≤32 MiB 服务端 sha256、客户端预检 `binaryTooLarge`、CAS 守卫可选；下载 GET `/blobs?path=` 原始字节 + 节点 media type——`binaryDownload` 模型 + 面板经认证 fetch → object URL 下载）；watch/listSince 增量刷新（`applyWorkspaceListSince` 合并变更节点 + delete tombstone（含后代删除）+ implied dir 重投影、幂等收敛；**client SSE 消费已实现（commit 待定主代理统一提交）**——`WorkspaceWatchClient`（client/sse-client.ts）消费 `GET .../workspaces/{wid}/watch/stream?after_revision=N`（每节点 `change`/`delete` 事件 + revision 前进，info 合并；与真实内核端点的集成见 tests/unit/sse-client-kernel.test.ts），流断开重连失败回退 `WORKSPACE_WATCH_POLL_MS` listSince 轮询；离开 Workspace tab 停止流+轮询（index.ts `stopWorkspaceWatch`））；search 为**路径过滤**（客户端 substring 过滤 + 服务端 prefix/glob PATH 搜索调用模型；服务端内容搜索未实现——如实记录，面板注明）；多标签编辑（每个 tab 持有 path/version/etag/content/savedContent，dirty 语义与 manuscript-dirty `isEditorDirty` 一致——'' 是真实值、清空读 dirty、恢复已保存读 clean；保存 409 → conflicted 标记 + 重载提示；watch 喂检测服务端版本前进 → tab 标记 conflicted 提示重载）；工具栏（新建文件/新建目录/上传/刷新/搜索框）+ 左侧树 + 右侧 tab 编辑区（textarea + 保存按钮；二进制只读 meta + 下载）+ 历史视图（选中文件 revision 列表 + 回退，op 文案 create/write/delete/move zh/en）。i18n 新增 workspace namespace zh/en 全 key + shell.tab.workspace（localeParity 与 i18n-chrome 扫描保持绿）。证据：tests/unit/workspace-client.test.ts 38/38（树懒加载/展开状态、虚拟目录、CAS 保存 409 冲突重载/etag 传递、move/delete 模型、历史回退、多标签 dirty/冲突/watch 服务端变更检测、二进制上传下载模型、路径搜索过滤、SSE watch 流与轮询等价合并/delete tombstone/隐含目录重投影/回退轮询/tab-leave 停止、nav 深链、双语求值零缺 key）、tests/unit/workspace-store.test.ts 16/16 不破坏、根 pnpm test 全绿、research-ui typecheck+build 全绿。剩余（浏览器视觉验收，NOT_RUN_MANUAL_PENDING，队列见 manual-acceptance.md §4）：文件树渲染/拖拽上传/多标签视觉/窄屏/键盘 a11y（`workspace-browser-workbench`）；Problems 面板与集成 PTY 入口；SSE watch 流浏览器事件源观感（client 消费已实现，观感仍 NOT_RUN_MANUAL_PENDING）。**服务端 SSE 实时流已实现（commit 待定主代理统一提交，api-contracts.md §22）**：kernel `GET .../watch/stream?after_revision=N`（change/delete + revision 前进、命名心跳、principal+membership fail-closed 422/404、跨项目 404）+ BFF 透传（bearer 401、CSRF GET 豁免、非成员首字节前 404、x-principal-id 注入）；证据 tests/unit/sse-streams.test.ts 7/7 + tests/security/run-sse-tests.sh 67/67（三流 kernel/BFF 真 HTTP：首字节 event、after_seq 续传无重复、live 追加、gap/exit 事件、跨项目 404、无 token 401、非成员首字节前 404、BFF 透传）；浏览器消费验收 NOT_RUN_MANUAL_PENDING。
- interactive-terminal-browser：浏览器 PTY 支持 stdin、resize、INT/TERM/KILL、detach/reconnect、after_seq/gap、完整日志下载；本机 Docker 与 RemoteRunner 共用同一 UI/权限语义；PTY 输出不能成为 Metrics/Manifest/Evidence；**浏览器验收（NOT_RUN_MANUAL_PENDING，manual-acceptance.md §4 队列）；代码侧逻辑层已闭环（2026-08-11，见下 pty-client-logic-layer 行：pty-session-model.ts + panels/pty.ts，pty-client.test.ts 36/36）**；
- pty-client-logic-layer（PTY-01，hardening §5 P1，execution-runtime.md §6.1 / api-contracts.md §18）：**代码侧已闭环（2026-08-11，commit 待定主代理统一提交）**——client 新增 `pty-session-model.ts`（纯逻辑层，注入 transport+scheduler 可单测）+ `panels/pty.ts`（挂入 More 导航，`#tab=pty` 稳定深链）：会话状态机 idle→opening→open⇄detached→closed/error（open 失败→error 可重开、close ack→closed、reopen 新会话周期）；control 队列（bytes/resize/INT/TERM/KILL/close）client_seq 单调自增、单帧 in-flight、失败重试**重发同一 seq**（服务端幂等不重复——网络丢失不双发）、超限保留排队可手动重试、409 `pty_client_seq_out_of_order` 经会话行 resync（服务端已应用→推进不致命；服务端游标落后→error 提示重连）；frames 消费 after_seq 增量轮询；**client SSE 消费已实现（commit 待定主代理统一提交）**——`PtyClientModel` 经 `SseClient`（client/sse-client.ts，fetch ReadableStream + SSE 帧解析 + 指数退避重连从最后 server_seq 续传 + 心跳超时断开 + AbortController 取消）消费 `GET /v1/pty/sessions/{id}/frames/stream?after_seq=`（frame/gap/exit/heartbeat 事件，与轮询共用 applyFrame 的 gap/exit/retention 语义、≤serverSeq 重放跳过、显示缓冲有界默认 3000 行；与真实内核端点的集成见 tests/unit/sse-client-kernel.test.ts），流重连失败回退 after_seq 轮询（framesMode `poll`，状态行 `pty.stream.*` 文案）、页面 gap（retained_from_seq 落后）与显式 gap 帧都落显示标记 + retention 截断提示（dropped_bytes/total_bytes）、exit 帧记录 code/signal、重放幂等、显示缓冲有界；detach 停轮询（进程服务端存活，断开不杀进程语义）→ reconnect 从 serverSeq 重放（generation+after_seq fencing 无重复）、generation 变更提示新会话周期；idle TTL / lease 过期 / 权限撤销 / adapter 失败的服务端关闭经周期性会话刷新（每 N 次轮询 GET 会话行）检测并映射 close-reason 提示（pty.notice.*）；403 `lease_invalid`/`lease_required` 致命→error 状态 + 提示重连/重新 open（新 lease）；错误码→稳定 i18n key（pty.error.* 映射，原始 message 永不直接展示）；open 表单（`GET /v1/projects/{id}/workspaces` 选择 + preset/cwd/cols/rows + 钉定 profile/target）+ 会话工具栏（resize 输入、信号按钮、detach/reconnect/close）+ 输出区（纯文本，ANSI 渲染如实不实现）+ 状态行（会话状态/in-out seq/掩码 lease+过期/generation/字节数）。i18n 新增 pty namespace zh/en 全 key + shell.tab.pty（localeParity 与 i18n-chrome 扫描保持绿）。证据：tests/unit/pty-client.test.ts 43/43（状态机、client_seq 单调/重试幂等/out-of-order resync、frames 增量/gap/retention/exit/重放幂等/显示上限、SSE frames 流与轮询等价应用/SSE gap/重连从 serverSeq 续传/流失败回退轮询/流 403 致命 lease/detach 停流、detach-reconnect 重放、generation、idle TTL/lease 关闭检测、lease 失效处理、错误码映射、nav 深链、双语求值零缺 key）、tests/unit/pty-session.test.ts 14/14 不破坏、根 pnpm test 全绿、research-ui typecheck+build 全绿。剩余（浏览器视觉验收，NOT_RUN_MANUAL_PENDING，队列见 manual-acceptance.md §4）：真实终端渲染（ANSI/xterm 类）、键盘输入、resize 拖拽、完整日志下载与窄屏验收（`interactive-terminal-browser`）；SSE frames 流浏览器事件源观感（client 消费已实现，观感仍 NOT_RUN_MANUAL_PENDING）。**服务端 SSE 实时流已实现（commit 待定主代理统一提交，api-contracts.md §22）**：kernel `GET /v1/pty/sessions/{id}/frames/stream?after_seq=`（frame/gap/exit/心跳事件、owner+lease 校验与轮询 frames 一致 422/403/404、exit 结束连接可重放）+ BFF 透传（bearer 401、非成员/非 owner 首字节前 404、x-principal-id 注入）；证据 tests/unit/sse-streams.test.ts 7/7 + tests/security/run-sse-tests.sh 67/67；浏览器消费验收 NOT_RUN_MANUAL_PENDING。
- trajectory-topology-browser：Research/Session 双 lane 增量投影；subagent DAG 显示 parent/child、状态、深度、运行时间、阻断与产物；稳定地址可进入 child、查看详情和发 follow-up；跨项目 child ID 与撤权负向通过；**代码侧已闭环（2026-08-11 修复轮，hardening §5 TRAJ-01/SUBAGENT-01 UI 逻辑层）**：client 新增 Trajectory 面板（panels/trajectory.ts + trajectory-model.ts——Research 权威/Session 观察双 lane 分组渲染模型、per-lane (event_seq,event_id) keyset 分页状态机（load-more、entry_id 幂等去重）、服务端 redacted summary 原样展示、allowlisted detail 点击展开）与 Topology 面板（panels/topology.ts + topology-model.ts——直系 tree 懒展开/cycle-safe 扁平化、breadcrumb 逐级返回 parent、child 详情（状态/只读 history）、one-shot 只读 follow-up：POST /v1/topology/{child_id}/followup 返回 message_id 不激活 child）；两者挂入 More 导航（#tab=trajectory / #tab=topology 稳定深链），i18n 新增 trajectory/topology namespace zh/en 全 key + shell.tab.trajectory/topology（localeParity 与 i18n-chrome 扫描保持绿）。证据：tests/unit/trajectory-ui.test.ts 38/38（双 lane 分组渲染模型、分页状态机、tree 扁平化/展开状态、breadcrumb 组装、followup 只读调用模型、SSE 增量流 lane 过滤/entry_id 去重/重连从 last seq/回退分页/tab-leave 停止、缺 key 告警）、根 pnpm test 全绿、research-ui typecheck+build 全绿。**client SSE 消费已实现（commit 待定主代理统一提交）**——Trajectory 面板经 `TrajectoryStreamClient`（client/sse-client.ts）消费 `GET /v1/projects/{id}/trajectory/stream?after_seq=&lane=research|session` 增量条目（lane 过滤 + entry_id 去重；与真实内核端点的集成见 tests/unit/sse-client-kernel.test.ts），流重连失败回退 keyset 分页（load-more 路径）；离开 Trajectory tab 关闭两 lane 流（index.ts `stopTrajectoryStream`，同 stopWorkspaceWatch 机制）。剩余（浏览器视觉验收，NOT_RUN_MANUAL_PENDING）：双 lane 滚动/虚拟化（10k 节点 DOM 有界）、树展开/键盘/ARIA、进入 child 与 follow-up 交互观感、跨项目 child ID 与撤权浏览器观感、SSE 增量流浏览器事件源观感；**服务端 SSE 实时流已实现（commit 待定主代理统一提交，api-contracts.md §22）**：kernel `GET /v1/projects/{id}/trajectory/stream?after_seq=&lane=research|session`（keyset (after_seq, after_event_id) 续传、双 lane 过滤、redaction 由投影保证、命名心跳、principal+membership fail-closed 422/404）+ BFF 透传（bearer 401、非成员首字节前 404、x-principal-id 注入）；证据 tests/unit/sse-streams.test.ts 7/7 + tests/security/run-sse-tests.sh 67/67；浏览器消费验收 NOT_RUN_MANUAL_PENDING；
- settings-schema-complete-i18n：runner/workspace/terminal/tex/agent/remote/security 等所有配置由 schema/effective 生成，支持 scope/source/validation/SecretRef/config pin/重启提示；新增 Init/Workspace/Trajectory/Topology/Settings 文案 zh/en 齐全，运行时切换即时更新，无 module-load 时冻结译文；**代码侧已闭环（2026-08-11 修复轮，hardening §5 P1 CONFIG-01/UI-02/UI-03）**：Settings 由 `/v1/config/schema` + `/v1/config/effective` 动态生成（settings-model.ts `settingsConfigModel` + modals/settings.ts）——7 个 ConfigScope Accordion 组覆盖注册表全部 55 键（job 组 reserved 空），每字段展示 effective 值（服务端 redacted；secret 只渲染"已设置,不显示明文"掩码，明文零回显——SecretRef 存储层属后续，如实记录）、scope、声明来源（registry `sources` 客户端镜像，tests/unit/settings-model.test.ts 对真实注册表逐键钉死）、安全基线标记、env 别名、schema 描述/默认；config pin 显示 + 本地记忆变化提示；热生效/需重启按声明来源推断（注册表无 hot_reload 标记，规则见 docs/config-registry.md §6——http/ui → 即时生效，cli/env/file → 重启）；本地校验（number 整数+边界/boolean/enum/string minLength+pattern）与服务端错误映射（validation_error/unknown_config_key/security_floor_violation → 字段级）为写面就绪；写接口不存在（kernel 仅 GET effective/schema）→ 提交禁用并注明"当前配置只读,经 CLI/env 提供"；55 字段 label + 7 scope 标题 + 元信息/校验文案 zh/en 双字典（shell.ts），localeParity + i18n-chrome 扫描绿，全模型双语求值零缺 key（负向测试）；Init 文案已由 intake namespace 覆盖；Workspace/Trajectory/Topology 无逻辑层组件，待页面落地时同一提交补 zh/en namespace + 切换与缺 key 负向测试。证据：tests/unit/settings-model.test.ts 21/21、config-registry.test.ts 30/30、ui-simple.test.ts 15/15、i18n-chrome.test.ts 3/3、i18n-runtime.test.ts 12/12、根 pnpm test 全绿、research-ui typecheck+build 全绿、verify-docs 19/19。剩余（浏览器视觉验收，NOT_RUN_MANUAL_PENDING）：动态 Settings 同页观感（scope 组/字段值/掩码/meta chips/pin 变化提示/只读注记）、zh/en 切换即时生效、640/720/1024 视口；`/bff/research/config/*` 写面与 SecretRef 存储层落地后启用编辑（本地校验与错误映射机制已就绪）。
- workspace-crash-recovery-idempotent：workspace 的磁盘字节与 SQLite 元数据（`workspace_nodes` + `workspace_ops` ledger）必须由同一恢复协议收敛——对每个 fs/DB 边界注入崩溃并验证幂等恢复：rename 后 row 未更新（磁盘新字节+旧 row → 前滚修复 v+1/新 hash/补 op）、row 指向缺失字节（二进制从 CAS 恢复；文本本版本在 history → delete 前滚完成且 undo 保留；无任何副本 → `workspace_inconsistent` 隔离且重启持久、恢复字节后重扫自愈）、孤儿 `.ws-tmp-*` 清理（被 row 覆盖的同名文件不误删）、move 两窗口（未落库 rename 回滚 re-associate / 目标 row 已插入前滚完成）、double-scan 状态收敛一致。**代码侧已闭环（2026-08-11，hardening §5 P2 STORE-01/WORK-01）**：`scanWorkspaceIntegrity()`（kernel 构造期自动运行 + 按需；`workspaces.quarantine` 持久化隔离列，migration 0018，SCHEMA_VERSION 16；隔离 workspace 读写 503 `workspace_inconsistent`）；证据：tests/unit/crash-recovery.test.ts 11/11（全窗口 + 幂等双扫 + 重启持久 + 自愈）、tests/security/run-workspace-tests.sh 41/41（新增 ws-crash-recovery 3 断言：真实 kernel 进程 kill+重启同 dataDir——启动隔离 503、恢复字节自愈、rename-before-row 前滚 v2）、根 pnpm test 866/866；剩余：真实 kill -9/双进程/长期 recovery drill（NOT_RUN_MANUAL_PENDING，队列见 manual-acceptance.md §4）；fleet 侧结论见 hardening §5 P2 行（registry/assignment/spool 内存态，按 lease 过期语义自愈，不引入大持久化框架）；
- workspace-permission-under-umask：在 umask 0000/0022/0077 下创建 workspace 及多级子目录，结果满足规范声明的完整 0750 chain（或经安全评审把契约改成“不得宽于 0750”并同步全部文档/测试）；文件为 0640 或更严格，原子 tmp 不残留；**已实现未验收（2026-08-11）**：workspace-store.ts 对新建目录链显式 chmod 0750（仅新建目录，既有目录不动）、文件写后 chmod 0640 兜底（writeFileSync mode 亦被 umask 剥离）；证据：tests/unit/workspace-store.test.ts 16/16（umask 0077 用例：workspaces 根/项目根/嵌套目录/.ws-meta history 全链 0750、树文件与历史副本 0640、既有 0700 目录不被改写、原子写无 tmp 残留）；剩余：CI job 绑定；
- ci-current-evidence-no-exclusion：CI 安装并固定 package manager，运行完整 unit（不得排除 `security.test.ts`）、UI typecheck/build、packaging、security aggregator 与 docs diff-check；必跑项零 SKIP；报告绑定当前 SHA，历史计数不能复用；**已实现未验收（2026-08-11）**：ci.yml 移除 `--exclude tests/unit/security.test.ts`；pnpm 调用统一经 npm_execpath→PATH 探测→明确安装提示解析（packaging.test.ts `resolvePnpm` 与 run-selfmod-tests.sh `resolve_pnpm`，无 pnpm 时给出明确错误而非 ENOENT）；根 package.json 声明 `packageManager: pnpm@11.20.0`；证据：tests/unit/packaging.test.ts 10/10（无 pnpm PATH 模拟：npm_execpath 路径全绿、无 pnpm 时明确报错）、tests/unit/security.test.ts 26/26；剩余：CI job 绑定（辅助 workflow 为 ci.yml，主网关 scripts/ci-gate.sh）；
- selfmod-production-and-tarball-negative：显式 dev overlay 可 inspect→mount harmless probe→调用→unmount，失败/HMR/shutdown 清理并审计；production profile、patch、dump-config、clean tarball/consumer install 均不存在 tool-cordis 与 cordis_*；无 pnpm/DSH fixture 时该场景失败或记未运行，不得 PASS。 **已实现未验收（2026-08-11）**：tests/security/run-selfmod-tests.sh 19/19——生产 profile/patch/dump-config 零 tool-cordis 引用、显式 dev overlay 组合后 2 引用且无 opt-in env 拒绝启动、tarball 负向（resolve_pnpm 修复后 `pnpm pack` 正常产出、解包断言无 tool-cordis）、clean consumer install 无 cordis_*；证据：19/19 全绿（含 tarball 负向与 overlay 组）。剩余：真实 DSH host 动态 mount/unmount/HMR 清理审计（NOT_RUN_MANUAL_PENDING，manual-acceptance.md §4 队列）。
