# 系统架构与设计决策

> 规范性文档。这里定义模块、接口、seam、权威状态和部署关系。

## 1. 架构原则

本项目使用深模块设计：调用者通过较小的接口获得完整行为，复杂性集中在模块实现中。接口包括类型、前置条件、错误、顺序、鉴权、幂等、性能和恢复语义，不只是一组函数。

- DSH 是交互控制面，不是科研权威状态；
- Research Kernel 是业务写入和策略权威；
- Runner Gateway 是计算执行权威，但不能自行决定业务状态；
- 浏览器只访问 BFF，不直接持有 Kernel 凭据；
- 外部论文、代码和任务输出一律是不可信数据；
- 模块接口也是测试表面，验收不得穿过接口检查内部细节；
- 真正变化的地方才建立 seam，生产 adapter 与测试 adapter 共同证明 seam 存在。

## 2. 总体结构

~~~mermaid
flowchart TB
  Human["Human PI / Researcher"] --> UI["Research UI"]
  Agent["DSH Agent / Commands / Skills"] --> Plugin["DSH Adapter"]
  UI --> BFF["Research BFF Adapter"]
  Plugin --> Client["Research Client"]
  BFF --> Client
  Client --> Kernel["Research Kernel"]
  Kernel --> Store["SQLite Store Adapter"]
  Kernel --> CAS["Filesystem CAS Adapter"]
  Kernel --> Outbox["Transactional Outbox"]
  Orchestrator["Durable Orchestrator"] --> Client
  Runner["Runner Gateway"] --> Client
  Remote["Remote Runner Agent"] --> Runner
  Targets["Runner Target Registry"] --> Runner
  Analysis["Analysis Worker"] --> Client
  Connectors["Scholar Connectors"] --> External["OpenAlex / Crossref / arXiv"]
  Orchestrator --> Connectors
  Runner --> Sandbox["Docker Execution Adapter"]
  Runner --> RemoteSandbox["Remote Docker / Scheduler Adapter"]
  UI --> Workspace["Workspace Runtime"]
  UI --> PTY["Interactive PTY BFF"]
  Workspace --> Client
  PTY --> Runner
  Config["Config Resolver"] --> BFF
  Config --> Runner
  BFF --> Intake["Research Onboarding"]
  Intake --> Quarantine["Quarantine / Parser Sandbox"]
  Outbox --> Trajectory["Trajectory Projection"]
  Plugin --> SessionAdapter["Safe Session Adapter"]
  SessionAdapter --> Trajectory
  Trajectory --> BFF
  Analysis --> Kernel
  Kernel --> Manuscript["Manuscript Module"]
  Manuscript --> Tex["TeX Compile Job"]
  Tex --> Runner
  Kernel --> Bundle["Release Bundle + Clean-room Verifier"]
~~~

## 3. 模块目录

| 模块 | 小接口 | 隐藏的实现复杂性 | 权威范围 |
|---|---|---|---|
| Research Kernel | create/read/transition/gate/job/artifact/evidence/document | Schema、状态机、事务、AuthZ、Revision、Outbox | 所有科研业务状态 |
| Artifact CAS | put/read/has | SHA-256、原子写、去重、路径布局 | Blob 字节内容 |
| DSH Adapter | Cordis apply、工具、命令、Skill | 角色 ACL、会话关联、生命周期、宿主兼容 | 无 |
| Research BFF | 同源项目接口 | Principal、Project AuthZ、CSRF、代理、限流、错误脱敏 | Web 身份上下文 |
| Runner Gateway | claim、execute、cancel、complete | 快照物化、容器、心跳、日志、签名、清理 | 活动进程或容器 |
| Runner Fleet | resolve/submit/attach/cancel | target capability、local/remote 选择、mTLS、分区恢复、Artifact 传输 | 无；Kernel 仍是 Job/Run 权威 |
| Config Resolver | effective/patch/watch | layer merge、CAS、来源、secret reference、热更新、config hash | 生效配置 revision |
| Workspace Runtime | tree/read/write/search/watch/snapshot | path、Revision/ETag、CAS、文本/二进制、冲突与文件事件 | 项目文件版本 |
| Interactive Terminal | open/attach/input/resize/signal/close | PTY、双向传输、回压、会话租约、重连、审计 | 活动交互会话；不拥有科研结论 |
| Research Onboarding | begin/stage/scan/grill/propose/accept/resume | 临时 CAS、扫描、parser、缺口 taxonomy、阶段映射、事务 adoption | accept 前仅 Intake；accept 后 Kernel 权威 |
| Trajectory Projection | roots/children/history/subscribe/followup | Outbox/session 归一化、树、分页、脱敏、retention、gap/replay | 无；可重建的读取投影 |
| Analysis Worker | analyze(plan, runSets) | 校验、配对、bootstrap、方向、多重检验 | 分析结果 |
| Durable Orchestrator | pollOnce(project) | 幂等 Action、恢复、重试、阶段计划 | 自动动作账本 |
| Scholar Connectors | search/resolve | 多源协议、缓存、去重、失败透明 | 外部来源读取 |
| Manuscript | read/save/build/review | TeX 文件树、版本、编译、诊断、PDF、引用 | 稿件工作区 |
| Research UI | mount(config) | 导航、i18n、终端、编辑器、轮询/流、可访问性 | 浏览器临时状态 |

## 4. 权威与数据流

### 4.1 写入路径

任何业务修改遵守同一路径：

~~~text
Caller -> Adapter -> ResearchClient -> Kernel HTTP Interface
       -> Schema parse -> AuthZ/Policy -> Kernel transaction
       -> DB rows + Outbox -> response/projection
~~~

浏览器、Cordis 插件、Runner 和 Worker 不得导入 Store 或直接打开 kernel.db。Artifact 字节先写临时区，哈希和所有权校验成功后，由 Kernel 在事务中登记 ProjectArtifact。

### 4.2 读取路径

- 小型对象与投影使用 JSON；
- Artifact 使用流式二进制，并保留媒体类型、长度和下载名；
- Run Terminal 使用 SSE 只读重放，断线后以 run_id + last sequence 续传；
- Interactive Terminal 使用独立双向 transport（WebSocket，或 SSE 输出 + POST control adapter），支持输入、resize 和 signal；不得把 Run Terminal 写接口化；
- UI 的 8 秒轮询只更新项目摘要，不替代活动 Terminal 流；
- Workspace 读取返回 bytes/text、版本、媒体类型和 ETag，保存同时使用 expected file version 与 workspace revision；
- TeX preview 订阅 Build events；轮询只作恢复兜底，不能代替编译日志/诊断/PDF 实时更新。
- Intake upload 使用独立 staged bytes 与 scan/proposal 投影；accept 前所有读取都带 `observed_unverified`，不能混入 Project Projection；
- Research Trajectory 从 Outbox 分页/订阅；Session Trajectory 经安全 Adapter 归一化。subagent history 按 exact parent/child/mode 读取且不得激活 Agent。

## 5. 信任区域

| 区域 | 信任 | 允许 | 禁止 |
|---|---|---|---|
| DSH Agent | 不可信决策者 | 提议、受控工具、Gate Request | Human Decision、正式 Evidence、宿主正式执行 |
| Browser | 已登录但输入不可信 | 通过 BFF 读取、编辑、审批 | Kernel Token、直接数据库、跨项目读取 |
| BFF | 受信任 adapter | Principal、AuthZ、CSRF、流式代理 | 保存模型 secret 到前端 |
| Kernel | 高信任 | 业务校验、事务、账本 | 执行研究命令 |
| Runner Gateway | 受限高信任 | 物化、隔离执行、签名、日志 | DSH 凭据、业务状态绕过 |
| 研究容器 | 完全不可信 | 读取冻结输入、写 outputs | 宿主 Home、默认网络、特权、Docker socket |
| 外部内容 | 完全不可信 | 结构化抽取和引用 | 改变系统指令和权限 |
| Intake quarantine | 完全不可信 | 静态扫描、受限 parser、Human Grill answer | 自动执行、访问网络、写 Project、制造 provenance |
| Session trajectory | 观察性、可缺失 | 脱敏摘要、拓扑、导航、授权续问 | 替代 Outbox、推进 Project、暴露 raw secret/tool payload |

## 6. 关键生命周期

### 6.1 DSH 插件

1. Cordis Loader 注入 tools、commands、subagents；DSH Adapter 不注入 httpServer 或 browser services。
2. apply 创建 ResearchClient、RoleRegistry、Connector cache；只在配置要求时启动 Kernel sidecar。
3. 注册工具、ACL waterfall、命令和 Skill provider；独立 BFF 路由与 browser client module 只由 standalone app/BFF 组装。
4. 所有注册通过 effect disposer 管理。
5. 插件停止时先停止接收新请求，再断开流，最后停止自己启动的 sidecar；复用的 sidecar不得被错误终止。

### 6.2 Kernel sidecar

1. 解析 DSH_HOME 和实例 dataDir；
2. 检查现有 health 的 instance、protocol、database identity；
3. 不匹配则拒绝复用，不能静默连接其他项目实例；
4. Token 通过 0600 文件或匿名通道传递，不进入 argv；
5. port=0 时由子进程握手返回实际地址；
6. SIGTERM 有界等待，超时才升级终止。

### 6.3 Job

~~~mermaid
stateDiagram-v2
  [*] --> queued
  queued --> running: claim and lease
  retryable --> running: new generation and token
  running --> succeeded: valid manifest and artifacts
  running --> failed: execution or validation failure
  running --> cancelled: confirmed stop
  running --> retryable: expired lease recovery
  queued --> cancelled: cancel
  retryable --> cancelled: cancel
~~~

旧 lease generation 的 heartbeat、log chunk 或 complete 必须被拒绝。

### 6.4 TeX 编辑与编译

~~~text
Open file(version N)
-> edit locally
-> save(expected N)
-> immutable revision N+1 + workspace manifest
-> submit latex-compile(manifest N+1)
-> live terminal + diagnostics
-> PDF/log/aux artifacts
-> build marked fresh for manifest N+1
~~~

保存和编译是两个不同动作。用户继续编辑后，已有 PDF 显示“源文件已更新，预览过期”，不得误认为是最新构建。

### 6.5 Workspace、PTY 与远端执行

1. Workspace Runtime 先解析 Project、Principal、Workspace revision 和 effective config；编辑器不接触宿主绝对路径。
2. Interactive Terminal 创建 `PtySession`，固定 project/workspace/target/config hash 和会话租约；连接断开不等于进程退出，输入/resize/signal 使用 client_seq 去重。
3. Runner Fleet 用不透明 `runner_profile_id` 解析 adapter。本机默认选择 Local Docker；远端选择经 mTLS 认证的 Runner Agent 或 scheduler sidecar。
4. 所有 adapter 接收同一冻结 `ExecutionPlan`，只物化登记的 Snapshot/Artifact；远端 machine 不读取 DSH_HOME、Kernel DB 或浏览器 secret。
5. Job claim 产生的唯一 run_id 贯穿 Terminal、Artifact、Manifest 和 Evidence；网络分区只进入 spool/retryable，不得推断成功。
6. 配置热更新原子替换 effective revision；已有 Job、PTY、Build 保持原 config hash，target 删除先进入 draining。

### 6.6 既有研究接入与 Agent 轨迹

1. Upload 写入 intake-scoped temporary CAS；scanner 和 parser 只产生不可变 observation。
2. Grill Me 由版本化缺口 taxonomy 生成问题，Human answer 只标记为 assertion；Proposal 同时给出 observed phase、safe status、未解决缺口和 Gate plan。
3. Human accept 在单事务校验 proposal/target revision，把允许的文件和 observation 映射为 ProjectArtifact/Workspace/draft Evidence，并创建待办或 Gate Request；不创建历史 Decision/Run/TerminalLog。
4. Kernel Outbox 投影为 Research Trajectory；DSH Session adapter 投影为 observational Session Trajectory；二者只用安全 refs 关联。
5. subagent tree 只列直接 child，展开懒加载；进入 child 或 continuable follow-up 时服务端再次校验 exact parent、mode、Principal 和 project membership。
6. Session raw detail 经 allowlist/redaction/bounded spill，TTL 清理产生 redacted/gap 记录；Outbox 业务事件不随 Session 清理。

## 7. Seam 与 Adapter

| Seam | 接口 | 生产 Adapter | 测试 Adapter |
|---|---|---|---|
| Kernel transport | ResearchClient | HTTP loopback 或 Unix socket | in-process HTTP server |
| Store | transaction/query | SQLite WAL | 临时 SQLite，不 mock SQL |
| Blob | put/read/has | filesystem CAS | 临时目录 CAS |
| Execution | spawn/signal/wait | Docker | deterministic fixture，仅 echo/smoke |
| Execution target | prepare/start/resume/cancel/wait | Local Docker、Remote Runner Agent、Scheduler sidecar | deterministic in-memory target |
| Interactive PTY | open/attach/input/resize/signal/close | local/container PTY、remote PTY | replayable fake PTY |
| Workspace files | tree/read/write/search/watch/snapshot | Kernel SQLite/CAS | 临时 SQLite/CAS |
| Configuration | effective/patch/watch | built-in + user/project files + UI | in-memory layers |
| Secret resolution | resolve scoped SecretRef | 0600 file、OS keyring、team vault | deterministic secret vault |
| Intake blob/scanner | stage/scan/parse/quarantine | temporary CAS + sandbox parser | deterministic fixture scanner |
| Question/phase policy | questions/propose | versioned taxonomy + deterministic mapper | recorded observations/answers |
| Adoption materializer | accept | Kernel transaction | temporary SQLite/CAS |
| Session trajectory source | list/history/subscribe/followup | DSH safe adapter | recorded event source |
| Scholar source | search/resolve | OpenAlex/Crossref/arXiv | recorded fixture |
| Identity | Principal resolver | DSH session/BFF | fixed test principal |
| Time/IDs | 内部 Clock/ID source | system clock/random | deterministic fake |

不得为只有一个实现且没有测试替代价值的内部函数创建公开 port。SQLite 和本地 CAS 有廉价本地替代，测试应运行真实实现。

## 8. 设计决策

| ADR | 决策 | 结果 |
|---|---|---|
| 001 | DSH 控制面、Kernel 科研权威、Runner 计算权威 | 重启不依赖聊天猜测状态 |
| 002 | Human Gate 与 Agent 工具完全分离 | Agent 只能 Request |
| 003 | Gate 状态不在通用 transition 目标中 | 无绕过路径 |
| 004 | 正式执行强制不可变快照和容器 | 宿主 workspace 不成为执行输入 |
| 005 | Blob 全局去重，Artifact 项目级拥有 | 相同内容不造成跨项目授权 |
| 006 | Runner 日志是有序持久流，最终日志仍进 CAS | 终端实时、可重连、可审计 |
| 007 | TeX 源文件使用版本化 workspace，编译是 Job | 编辑、执行和产物共用安全链路 |
| 008 | accepted Evidence 只能由 Analysis Worker 生成 | Agent note 永远 draft_unverified |
| 009 | 浏览器 UI 只使用独立同源 BFF；DSH Adapter 仅保留 Agent 能力 | 删除双 Host、双 bridge 和客户端分叉 |
| 010 | UI 全面 i18n，独立模式提供 locale adapter | 页面无硬编码文案，zh/en 一致 |
| 011 | Release Bundle 自包含并 clean-room 验证 | “可复现”成为可验证结论 |
| 012 | DSH SessionEvent 可扩展，但 Kernel Outbox 是业务权威 | 会话展示不替代业务账本 |
| 013 | Run Terminal 与 Interactive PTY 分离 | 前者是只读科研执行账本；后者可输入但不能产生正式 Evidence |
| 014 | Workspace Runtime 是编辑器 seam | Monaco/CodeMirror/VS Code Web 只是 adapter，Kernel 文件契约保持稳定 |
| 015 | Runner target 使用 ports & adapters | Local Docker、Remote Agent、Scheduler 共享 ExecutionPlan/lease/Manifest，不向 UI 泄漏 transport |
| 016 | 配置由单一 Config Schema 生成 | 文件、HTTP、UI、CLI 和文档无各自硬编码；secret 仅以引用出现 |
| 017 | LaTeX preview 与权威 build 分离 | preview 可 debounce/取代且不产 Evidence；Compile 冻结输入并进入正式 Job 链 |
| 018 | 既有研究通过隔离 Intake + Human adoption 接入 | 可从任意阶段继续，但不伪造历史 Gate、Run、TerminalLog 或 Evidence |
| 019 | NextAction 是 Kernel 的结构化确定性投影 | 引导可恢复、可审计；浏览器和 LLM 不能猜测推进 |
| 020 | Research 与 Session Trajectory 分离 | Outbox 保持权威；DSH 轨迹可观察、可过期且默认脱敏 |
| 021 | Subagent 使用 exact parent-child address | 支持拓扑展开、进入和授权续问，history 读取不激活 Agent |
| 022 | UI 使用渐进披露 | 高频工作面保持简洁，配置集中在默认折叠 Settings，深层能力仍可深链访问 |

## 9. 当前实现迁移说明

当前仓库已有 Kernel、CAS、Runner、Analysis Worker、Orchestrator、Connectors、DSH Agent 插件和独立原生 DOM UI。DSH 浏览器嵌入面已从目标和交付面删除。ResearchOnboarding、结构化 NextAction、通用 Workspace、Interactive PTY、远端 Runner、Config Registry、Trajectory/Subagent projection 尚未完整实现；其余 v1 路由、Human Principal、Evidence provenance、最终式日志、TeX workspace 和 i18n 差距见 hardening-v0.2-status.md。
