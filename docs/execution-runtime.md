# 执行、分析与自动编排规范

> 规范性文档。这里定义从不可变输入到可验证结果的完整计算链路。

## 1. 执行原则

- echo 是唯一允许不启动命令的 Job；
- baseline、pilot、formal、reproduce、latex-compile、clean-room 必须容器执行；
- smoke 默认容器，只有 trusted-smoke-fixture 可显式使用隔离 subprocess；
- Runner 不接受任意宿主路径，只接受 Kernel 已登记的 Snapshot 和 Artifact；
- stdout 是日志，不是正式指标来源；
- 成功以 Kernel 验证签名 Manifest、Artifact 和 lease fencing 后的事务结果为准。

## 2. Job 提交

Kernel 接收 JobSpec 后依次：

1. 校验 Project 状态和权限；
2. 校验 kind 与运行 profile；
3. 对正式实验校验 approved Contract version；
4. 校验 code/data/Tex Snapshot 属于同一项目且内容存在；
5. 校验固定 image digest、command 数组和 output contract；
6. 检查预算、并发和项目级 Idempotency-Key；
7. 事务写入 queued Job 与 job.submitted Outbox；
8. 同一 project/key 重试返回原 Job，不创建重复 Run。

正式 Run 推荐键：formal:{contract}:{version}:{codeSha}:{dataSha}:{metric}:{seed}。TeX 键：latex:{document}:{revision}:{engine}:{imageDigest}。

## 3. Claim、Heartbeat 与 Fencing

Runner 使用内部接口批量 claim。每个被 claim 的 Job 获得 lease_owner、lease_generation、lease_token、lease_expires_at。token 是不可猜测且绑定 Job、generation、owner 的值。

claim 事务同时创建一个 Run attempt（run_id、job_id、attempt_no、started_at、signature_status=pending）；Terminal 从此 run_id 开始写。lease 过期后的新 claim 创建新的 attempt，旧 attempt 保留而不复用 run_id。只有当前 generation 的 attempt 可 complete Job。

Runner 在执行期间每 15–20 秒 heartbeat，TTL 默认 120 秒。heartbeat、Terminal frame、Artifact upload finalize 和 complete 都携带 generation/token。lease 过期后 Kernel 将 running 改 retryable；新 claim 增加 generation，旧 Runner 的任何写入返回 lease_stale。

## 4. Snapshot 物化

Runner 在新临时目录中：

1. 从 BFF-independent internal client 获取 archive Artifact；
2. 校验 Artifact ownership、sha256、manifest hash 和总大小；
3. 拒绝绝对路径、..、NUL、重复规范化路径、越界 symlink、设备和 FIFO；
4. 展开至 /work 输入区；
5. 代码和数据挂载只读，/outputs 独立可写；
6. Job 结束后清理临时目录和容器，无论成功、失败、取消或 Runner 崩溃恢复。

CodeSnapshot 保存实际文件内容；仅包含文件 hash 的旧 manifest 不能执行正式 Job。

## 5. Docker 执行 Adapter

最低参数：

~~~text
--rm
--network none
--user 65534:65534
--read-only
--cap-drop ALL
--security-opt no-new-privileges
--pids-limit <policy>
--memory <policy>
--memory-swap <policy>
--cpus <policy>
--tmpfs /tmp:size=64m
--mount code/data read-only
--mount outputs read-write
~~~

禁止 Docker socket、privileged、host network/PID/IPC、宿主 Home、DSH_HOME、模型/API credential、可变镜像 tag。Runner 启动前将环境缩减为合同白名单，不能继承 DSH 进程环境。

Docker CLI 自身被终止时，finally 仍执行 docker rm -f 兜底。取消必须结束进程组或容器并等待确认，然后才能写 cancelled。

### 5.1 Runner Fleet 与远端 Adapter

Runner Gateway 只依赖 `ExecutionTarget` port：prepare(plan)、start(plan)、attach(run)、cancel(run)、wait(run)。生产 Adapter 至少有 LocalDocker 和 RemoteRunnerAgent；Scheduler 是后续可选 Adapter。ExecutionPlan 在 Kernel 固定 project/job/run/lease/profile/config/image/snapshot/artifact/limits/network/output contract 并签名，target 不得改写。

远端 Agent 通过 mTLS service identity 注册 health/capability/labels，拉取 CAS 输入并复算 hash，在隔离 sandbox 执行，按 generation/token 上报 frames、stage Artifacts 和 complete。网络断开时 spool 有界保存；lease 过期后旧 Agent 只能丢弃或保留本地诊断，不能完成 Job。target offline/capability mismatch 返回明确 retryable 环境错误；没有显式 PI/Operator 新 attempt 时不回退 LocalDocker，更不回退 subprocess。

远端配置中的 address、certificate、SSH bootstrap 等只由服务端 Config/SecretRef 解析；Job/UI 永远只见 opaque profile/target ID 与安全健康摘要。生产执行不支持“输入 hostname + shell command 即运行”的任意 SSH 模式。

## 6. 实时 Terminal

现有“任务结束后拼接 stdout/stderr”不足以满足产品。Execution adapter 必须接受 onChunk 回调，并同时保留有界本地 spool。

每个 chunk 记录全局 seq、通道 seq、stdout 或 stderr、UTF-8 安全文本、byte offset、时间和 lease generation。Runner 批量上报，Kernel 做单调性、幂等和 fencing 校验。二进制控制字节经安全 sanitizer 处理；ANSI 颜色可以保留在白名单解析层，禁止注入 HTML。

默认策略：

- 内存渲染窗口不超过 10,000 行；
- Kernel 热日志按项目策略保留，例如每 Run 8 MiB；
- 完整执行输出最大值受 maxLogBytes 限制；超限可终止任务或继续丢弃，必须由 Job policy 明确；
- 无论策略如何，都记录 truncated、total_bytes、dropped_bytes；
- 最终 stdout/stderr/combined 日志作为 CAS Artifact；
- exit frame 在任务终态之前持久化，但业务终态仍由 complete/cancel transaction 决定。

终端的 inferred_idle 或 timeout 不是命令退出。UI 只在收到 exit 或 Job 权威终态时显示完成。

### 6.1 Interactive Terminal（PTY）

Interactive Terminal 与本节 Run Terminal 是两个 Interface。PTY open 固定 Principal、Project、Workspace、Runner profile/target、allowlisted shell preset、relative cwd、config hash 和 session lease。PTY Adapter 必须分配真实 pseudo-terminal，支持 bytes input、resize、INT/TERM/KILL、detach/reconnect 和显式 close；每个 control frame 使用 client_seq 幂等，输出使用 server seq/gap/retention。

PTY 连接断开不自动结束进程，idle TTL 和 retention 从 Config Schema 读取；权限撤销立即 detach/close。LocalDockerPty 与 RemoteRunnerPty 共享同一 wire，不得向浏览器暴露 Docker socket、SSH credential、Kernel token 或 host path。PTY 输出可审计和有限保留，但不是正式 Job log，不能生成 Metrics、Manifest、accepted Evidence 或 Gate Decision。

## 7. 指标与 RunManifest

实验指标只读取 output_contract.metrics 指定的固定 JSON：

~~~json
{
  "schema_version": 1,
  "run_id": "run_x",
  "contract_id": "expc_x",
  "seed": 11,
  "metrics": [{"name":"macro_f1","value":0.812,"unit":"ratio"}]
}
~~~

Runner 校验 run、contract、seed、有限数值、metric 名称和 unit。stdout JSON fallback 只允许 legacy fixture，不能进入 accepted Evidence。

完成顺序：保存 log/metrics/checkpoint/PDF 等 Blob；登记项目 Artifact；构建 canonical Manifest；签名；调用 complete。Kernel 事务内校验并写 Run、Job status、Artifact links、预算和 Outbox。

## 8. 失败分类

稳定 failure_class：environment、resources、code_error、data_issue、possible_data_leakage、budget_exhausted、timeout、cancelled、unknown。

分类用于恢复策略，不掩盖原 exit、signal 和安全日志。环境/资源可以有界重试；code_error 创建 repair action；数据泄漏立即 Block；无改进是有效负结果；预算耗尽创建 Gate。

## 9. Analysis Worker

Analysis Worker 是纯确定性模块，接口为 AnalysisPlan + baseline RunSet + treatment RunSet + metrics files，输出 PairedAnalysisResult 和 draft Evidence。它不得读取聊天、自由 stdout 或修改 Project。

校验：

- 一个 Contract、一个 Metric、明确 higher/lower direction；
- RunSet 的 Seed 唯一且两组按 Seed 配对；
- 达到 minimum_n；
- 同一代码/数据策略按 Contract 执行；
- metrics file schema 与 run identity 一致；
- estimator paired_mean_difference、bootstrap_95、固定 resamples、Holm；
- PRNG 从计划和输入 hash 确定，重跑结果一致。

Worker 以内部身份写 verified Evidence；Kernel Verifier 再校验 Artifact、provenance 和 Claim 规则后转 accepted。当前简单 Kernel aggregate 逻辑不得与 Worker 并存为第二套正式算法。

## 10. Durable Orchestrator

Orchestrator 使用 SQLite/PostgreSQL ActionStore，Action status 为 queued、running、done、failed、blocked，唯一键 project_id + idempotency_key。执行前先持久化 Action，再调用 Kernel；重启时 running 恢复 queued，并通过 Kernel 投影调和已完成副作用。

状态动作：

| 状态 | 自动动作 | 阻塞 |
|---|---|---|
| DRAFT | 校验 Brief，创建 Scope Gate Request | Human Scope |
| SCOPED | Scholar Panel、Corpus Snapshot | 来源/策略 |
| SURVEYING | Idea Panel、Novelty Audit | 覆盖不足 |
| IDEATING | 创建 Idea Gate | Human Idea |
| IDEA_APPROVED | Baseline snapshot 与复现 | 失败/预算 |
| BASELINE_REPRO | Contract Draft 和 AnalysisPlan | Human Contract |
| CONTRACT_APPROVED | Patch、Smoke、Pilot、Formal | 执行/预算 |
| EXPERIMENTING | Analysis、Evidence、Claims | Seed/数据问题 |
| EVIDENCE_READY | TeX workspace、图表和 BibTeX | Evidence 不完整 |
| WRITING | latex-compile、Reviewer | 构建或 major revision |
| REVIEWING | clean-room、Bundle、Release Gate | Human Release |

Orchestrator 不直接保存或执行任意 shell，不在 Gate 期间保持会话占用。

## 11. Scholar Connectors

连接器固定域名：api.openalex.org、api.crossref.org、export.arxiv.org。搜索并发使用 allSettled；任一来源失败保留 source_status 和错误摘要。缓存键包含 source、query、limit、year 和 parser version。

所有返回文本标记不可信；只抽取 Schema 字段。多源去重优先 DOI/arXiv ID，再用 Unicode title fingerprint。Passage 有定位并默认 is_untrusted=true。

## 12. Manuscript 与 latex-compile

Manuscript Builder 只读 Brief、冻结 Corpus、approved Contract、accepted Evidence、Claim、确定性图表和 Venue Template，生成版本化 TeX workspace，而不是只返回一个字符串 Artifact。

latex-compile Job：

- 输入为冻结 TexWorkspaceSnapshot；
- 镜像使用固定 TeX Live digest；
- 默认 pdflatex -interaction=nonstopmode -halt-on-error -file-line-error -recorder -no-shell-escape；
- 按配置运行 latex、bibtex/biber、latex、latex，最多四遍；
- 检测引用和目录是否收敛；
- 实时上报终端；
- 解析 LaTeX Error、file:line:error、undefined citation 和 overfull warnings；
- 输出 PDF、完整 log、aux、bbl、blg、fls 和可选 synctex；
- PDF、log 和所有输入 manifest 进入 RunManifest。

TeX source 可能不可信，正式构建仍必须容器、禁网、禁 shell escape、非 root 和资源限制。

### 12.1 实时 Preview

文件保存事务成功后，Workspace event 按配置 debounce 创建 preview build。相同 document 新 revision 到达时，queued preview 取消、running preview 标 superseded；旧 PDF 立即 stale。preview 使用同一固定 TeX image、路径安全、禁网与 no-shell-escape，实时发 Terminal/diagnostics/PDF events，但可以使用较短 retention，且不创建 accepted Evidence。

用户点击 Compile 时必须冻结当前 manifest 并创建权威 latex-compile Job；它不被后续 preview 取代，产出完整 RunManifest/Artifact。保存失败或 revision conflict 不触发 preview。build/preview 状态在 UI 重连后可由 Kernel 投影恢复，不能只存在浏览器 debounce timer。

## 13. Release Bundle 与 clean-room

Bundle 包含 manifest、TeX/PDF/BibTeX/figures、源代码、数据 manifest、锁文件、镜像 digest、contracts、RunManifest、metrics、analysis、licenses、AI usage、reproduce 和 verify 脚本。

Clean-room 在新 dataDir 和 Runner 中验证所有 hash，物化、重跑关键实验、重算分析、重建 PDF，比较合同容差并生成 reproducibility-report。只有 Pass 后才创建 Release Gate Request；Bundle 默认 private/unapproved。

## 14. Self-referential Cordis 与执行面的隔离

开发模式的 cordis_mount 运行在 DSH 进程内，不是 Runner，也不是安全沙箱。它不能用于正式 Job、TeX 编译、Evidence 或 Gate。动态工具不得拿到 Runner key、Kernel internal token 或数据库路径。完整开发开关与限制见 dsh-integration.md 和 security-baseline.md。
