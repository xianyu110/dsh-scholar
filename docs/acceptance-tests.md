# 验收与测试规范

> 规范性文档。任何新增需求或修复建议必须在这里增加可自动化的验收场景。

## 1. 测试层级

| 层级 | 范围 | 原则 |
|---|---|---|
| Unit | Schema、状态、统计、path、diagnostic parser、i18n | 纯函数和稳定错误 |
| Module contract | Kernel、Client、Runner、BFF、UI state | 通过模块接口，用真实 SQLite/CAS |
| Integration | DSH composition、sidecar、BFF、SSE、TeX | 多模块真实协议 |
| Security | AuthZ、CSRF、路径、容器、日志、self-mod | 阻断发布 |
| Recovery | kill -9、lease、stream reconnect、DB/CAS | 不丢状态、不重复执行 |
| UI | 两种 locale、keyboard、a11y、responsive | 用户可完成核心任务 |
| Scientific | RunSet、Evidence、Claim、引用、负结果 | 防止科研语义漂移 |
| Reproduction | Bundle、clean-room、PDF | 从空环境复现 |

## 2. Project 与 Gate

- create-project-defaults：gate-only、预算和 integrity 默认值正确；
- transition-revision-conflict：旧 revision 返回 409；
- gate-state-cannot-transition：四个 Gate 控制状态返回 422；五种 Gate type 均有独立流程；
- agent-cannot-decide-gate：工具目录和 Agent HTTP 无 Decision；
- human-principal-durable：Decision 重读仍有 principal/tenant/session；
- gate-atomicity：在 target/Gate/Decision/Project/Outbox 每个故障点均无部分提交；
- concurrent-decision：两个请求只有一个成功；
- budget-gate-resume：只允许 payload 声明的 resume_to。

## 3. Project 隔离与 Artifact

- 相同 idempotency key 在两个项目生成独立 Job；
- 相同 Blob 在两个项目有独立 artifact_id 和授权；
- 跨项目 Artifact、Terminal、TeX、Evidence 读取返回 404；
- binary round-trip 对 PDF/image/random bytes hash 一致；
- malformed percent path 返回 JSON 400，不崩溃；
- CAS 原子写、重复 put、孤儿 GC、缺失 Blob scan。

## 4. Runner 与 Manifest

- formal/baseline/pilot/reproduce/latex-compile 拒绝 subprocess；
- 非 echo 空 command 和 message-only payload 失败；
- secure Job 缺 approved Contract、Snapshot、digest 被拒绝；
- Snapshot traversal、symlink escape、duplicate normalized path 被拒绝；
- Docker uid 非 root、network none、read-only、cap drop、memory/cpu/pids/time 生效；
- timeout/cancel/Runner crash 无孤儿容器；
- heartbeat 阻止 lease 重领；过期 lease 恢复 retryable；
- stale generation/token 的 heartbeat、chunk、complete 全 409；
- invalid signature、unknown key、missing/cross-project Artifact 拒绝；
- complete transaction 故障不出现 succeeded 无 Artifact。

## 5. Terminal

- interleaved-output：stdout/stderr 按全局 seq 重放，单通道仍完整；
- live-view：运行中 UI 逐 chunk 更新，不等任务完成；
- reconnect-after-seq：断线后无重复无缺失；
- retention-gap：请求已淘汰 seq 先收到 gap 和 dropped bytes；
- overflow：达到上限显示 truncated，最终 log Artifact 可下载；
- exit-replay：成功、非零、signal、timeout、cancel 的最终原因永久可读；
- backpressure：慢客户端不使 Runner/Kernel 内存无限增长；
- hidden-tab：暂停渲染后恢复到 latest；
- ansi-injection：OSC clipboard/link/title 和 HTML 不能执行；
- log-authz：无 job_log_read、无 token、跨项目、撤权连接均被拒绝；
- cancel-kills-process：UI 只有确认停止后显示 cancelled。

## 6. Analysis、Evidence 与 Claim

- metrics schema identity、有限数值、MetricSpec direction；
- duplicate seed、mixed metric、mixed contract、minimum_n 拒绝；
- paired bootstrap 输入相同输出字节一致；
- lower-is-better 的 effect 解释正确；
- public Evidence 路由不能提交 verified/accepted；
- draft/legacy Evidence 不能支持 Claim；
- 缺 effect/CI/n 或 CI 跨无效区间为 inconclusive；
- contradicted Claim 不被 Manuscript 当正面结论；
- Analysis Artifact、图表和稿件数字一致。

## 7. TeX Workbench

- create-document 生成 paper.tex/references.bib 和 revision；
- tree 只含根内路径，文件 kind/media/version 正确；
- save expected version 成功并生成新 immutable revision；
- 并发保存一个 200、一个 409，无丢失更新；
- delete/rename/asset upload 执行 path 和 version 校验；
- compile 自动冻结当前 manifest，不能读取之后编辑；
- pdflatex + bibtex/biber + 多遍编译得到非空 PDF；
- shell escape、network、越界文件访问被拒绝；
- compile Terminal 实时显示，完整 log 进 Artifact；
- LaTeX error 解析到 file/line，点击定位编辑器；
- undefined citation 和 missing file 有结构化诊断；
- 源文件改变后旧 PDF 显示 stale；
- PDF Content-Type、Blob preview、download hash 正确；
- build history 可重放日志和 PDF；
- clean-room 能用 Bundle 中 TeX 源重新构建同等 PDF 结构。

## 8. UI 与 i18n

- zh/en 字典 key 完全一致，静态检查阻止硬编码 chrome；
- persisted locale > browser regional locale > zh；
- setLocale 后已开 modal、tabs、aria、Terminal status、TeX chrome 更新；
- Intl 显式使用 active locale，不能出现中英文日期混用；
- unknown enum 和 wire/model/Terminal/TeX raw text 原样显示；
- standalone 首屏和 token error 双语，html lang 正确；
- DSH LocaleFace 与 standalone adapter 行为一致；
- 所有核心动作仅键盘可完成；focus trap、aria-live、contrast、reduced motion 通过；
- 640/720/1024 px 无不可达控件；
- 关闭页面后 SSE、interval、Blob URL、listener 清理；
- DSH 和 standalone 对同一 fixture 产生等价页面和操作结果。

## 9. DSH 集成与 Skills

- clean DSH_HOME 安装 bundle 并自动发现 client；
- headless 无 httpServer 仍可使用工具；
- unknown Agent 的研究写工具全部 deny；
- Human Decision 工具不存在；
- Session link 在重启后恢复；
- research-core、两个 domain 和 venue skill 都可发现；
- npm pack 包含 runtime skill assets；source/prepared copy hash 一致；
- domain/venue 根据 Brief 确定性选择；
- 插件停止清理 route/tool/listener/sidecar ownership。
- /research help/list/status/gates/jobs/claims 等文档和 UI starter 命令均有真实 handler，不落入 generic help；
- Tool catalog 与 reconstruction-contracts.md canonical 名一致，旧 claim_verify/analysis_build/release_bundle 别名返回 deprecation metadata 而非 unknown tool；

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
- Browser 不见 Kernel token，进程 argv/log 不见 secret；
- upstream 5xx/path/stack 脱敏；
- SSE 和 binary 不经 text() 缓冲；
- malicious HTML/SVG/Markdown/ANSI/TeX 无脚本执行；
- Connector SSRF/redirect allowlist；
- Runner env 不含 DSH/credential；
- Release 未批准没有外部发布能力。

## 12. Recovery 与 Golden Path

故障矩阵对 Kernel、Runner、Orchestrator、BFF 在 queued/running/complete、Gate transaction、TeX save/build 和 Terminal stream 各点 kill -9。100 次压力要求无重复正式 Run、无不可解释 succeeded、无丢 Gate/Decision、无孤儿容器。

Golden Path：创建项目→Scope Gate→Corpus→Idea Gate→真实 Baseline→Contract Gate→代码 Patch/Snapshot→多 Seed Formal→实时 Terminal→Analysis/Evidence/Claim→生成并人工编辑 TeX→实时编译/诊断/PDF→Review→Bundle→clean-room→Release Gate。不得注入手工指标或跳过容器。

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

## 14. 文档治理与 subagent 流程验收

- docs-contract-sync 校验 Markdown 链接、标题、fence、规范索引和目标/现状标签；
- 修改 src/packages/workers/apps/configs 中的接口、Schema、UI 或行为时，变更集必须同时触达负责的规范、acceptance-tests.md 和 hardening-v0.2-status.md；允许通过 PR label 明确 no-contract-change，但需要 reviewer 理由；
- 新增 UI chrome 时静态检查要求 zh/en key，而不是硬编码文本；
- 新增 route/table/event/tool 时 contract snapshot 与 reconstruction-contracts.md 的 version 同步；
- 开发任务模板含 delegation plan：可并行检索/核验/无重叠实现默认派 subagent；任务写明范围、输出证据和文件所有权；
- 合并记录包含主代理对基础文档、修改代码、方案取舍和最终验收的确认；
- 流程验收不要求为了单文件小改强行派代理，但若存在两个以上独立重任务而未并行，需在记录中说明原因。

缺少 Docker 或 TeX 的本地环境可以明确 skip 开发测试，但 CI 不允许 skip 成功。历史 README 中的测试计数仅作记录，不能代替当前 CI 结果。
