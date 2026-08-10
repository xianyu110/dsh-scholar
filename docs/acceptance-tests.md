# 验收与测试规范

> 规范性文档。任何新增需求或修复建议必须在这里增加可自动化的验收场景。

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

## 5. Terminal

- interleaved-output：stdout/stderr 按全局 seq 重放，单通道仍完整；
- live-view：运行中 UI 逐 chunk 更新，不等任务完成；
- reconnect-after-seq：断线后无重复无缺失；
- retention-gap：请求已淘汰 seq 先收到 gap 和 dropped bytes；
- overflow：达到上限显示 truncated，最终 log Artifact 可下载；
- terminal-dom-bounded：Playwright 在 Job 未完成前观察到 stdout/stderr DOM 增量；全局 seq 单调、只生成安全文本节点，保留窗口滚动后 DOM 行数不超过配置上限；
- download-full-log：overflow/gap 后下载动作必须读取最终 log Artifact，字节等于 canonical 完整或明确截断日志，不能仅导出浏览器内 retained lines；
- exit-replay：成功、非零、signal、timeout、cancel 的最终原因永久可读；
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
- live-preview：保存成功后 debounce 启动 preview，编译结束前 UI 已见日志/诊断；新 revision 使旧 PDF stale 并 supersede 旧 preview；
- preview-vs-compile：preview 不产 Evidence；显式 Compile 固定 manifest/config/image，且不被后续 preview 取消。

## 8. UI 与 i18n

- zh/en 字典 key 完全一致，静态检查阻止硬编码 chrome；
- browser client 源码必须纳入 strict `tsc --noEmit`，不得只由 tsdown 跳过类型后转译；
- persisted locale > browser regional locale > zh；
- setLocale 后已开 modal、tabs、aria、Terminal status、TeX chrome 更新；测试不得导航或 reload，必须在一个 render tick 内断言可见 text/title/aria/status 与 `html[lang]` 同步切换；
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
- ui-routes：Workspace、Run Terminal、Interactive PTY、Manuscript、Trajectory/Topology、Settings 可由上下文/命令面板/深链到达，URL 无 Token；
- ui-settings：Accordion 默认折叠；每项展示 effective source/hash/revision/default/restart，reset 与 CAS 冲突工作；secret value 零渲染；
- ui-simple-responsive：640/720/1024 下 Start、More、树/编辑/Preview/Terminal、固定主 CTA 均键盘可达，不因隐藏高级项丢能力；
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

### 8.2 Trajectory 与 Subagent Topology

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

所有“必跑”Job 在 `CI=true`/GitHub Actions 中必须满足 `skip_count=0`、实际断言数大于 0、`continue-on-error=false`。缺 Docker、pdflatex、镜像、DSH fixture、git base 或其他能力时必须非零退出，不能输出 `SKIP` 后 exit 0，也不能被聚合器计入 PASS。本地非 CI 环境可以显式 allow-skip，但结果只能记为“未运行”，不得更新 hardening 状态。

## 14. 文档治理与 subagent 流程验收

- docs-contract-sync 校验 Markdown 链接、标题、fence、规范索引和目标/现状标签；
- `verify-docs --diff-check <base>` 必须先解析并验证精确 base SHA；base 缺失、歧义、浅克隆不可达或任意 git error 以 `base_ref_unavailable` 非零退出，禁止将 changed files 当空集；
- diff scope 必须覆盖 `src/`、`packages/`、`workers/`、`apps/`、`configs/`、`migrations/`、`tests/`、`evals/` 和 manifest；行为变更至少同时触达负责规范、本文和 hardening，或带 reviewer 批准的 no-contract-change 记录；
- hardening 状态只允许未实现、部分、已实现未验收、已验收、已关闭；“已验收”必须绑定当前 commit、CI job 和 acceptance 报告，历史计数不能升级状态；
- README、USAGE、hardening 和源码对当前能力有矛盾时，docs-contract-sync 必须失败，且默认采用较低完成状态；
- 修改 src/packages/workers/apps/configs 中的接口、Schema、UI 或行为时，变更集必须同时触达负责的规范、acceptance-tests.md 和 hardening-v0.2-status.md；允许通过 PR label 明确 no-contract-change，但需要 reviewer 理由；
- 新增 UI chrome 时静态检查要求 zh/en key，而不是硬编码文本；
- 新增 route/table/event/tool 时 contract snapshot 与 reconstruction-contracts.md 的 version 同步；
- 开发任务模板含 delegation plan：可并行检索/核验/无重叠实现默认派 subagent；任务写明范围、输出证据和文件所有权；
- 合并记录包含主代理对基础文档、修改代码、方案取舍和最终验收的确认；
- 流程验收不要求为了单文件小改强行派代理，但若存在两个以上独立重任务而未并行，需在记录中说明原因。

缺少 Docker、TeX、DSH fixture 或其他能力的本地环境可以明确标记“未运行”，但不得计入 PASS。CI 不允许 skip 成功。历史 README 中的测试计数仅作记录，不能代替当前提交和精确 CI job 的结果。
