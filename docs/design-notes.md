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
  Analysis["Analysis Worker"] --> Client
  Connectors["Scholar Connectors"] --> External["OpenAlex / Crossref / arXiv"]
  Orchestrator --> Connectors
  Runner --> Sandbox["Docker Execution Adapter"]
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
| Research Client | 类型化请求方法和流订阅 | Token、超时、重试、错误解码、二进制与 SSE | 无，仅协议 adapter |
| DSH Adapter | Cordis apply、工具、命令、Skill、client module | 角色 ACL、会话关联、生命周期、宿主兼容 | 无 |
| Research BFF | 同源项目接口 | Principal、Project AuthZ、CSRF、代理、限流、错误脱敏 | Web 身份上下文 |
| Runner Gateway | claim、execute、cancel、complete | 快照物化、容器、心跳、日志、签名、清理 | 活动进程或容器 |
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
- Terminal 使用 SSE，断线后以 last sequence 续传；
- UI 的 8 秒轮询只更新项目摘要，不替代活动 Terminal 流；
- TeX 编辑读取返回内容、版本和媒体类型，保存使用 expected_version。

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

## 6. 关键生命周期

### 6.1 DSH 插件

1. Cordis Loader 注入 tools、commands、subagents；Web 配置可额外注入 httpServer。
2. apply 创建 ResearchClient、RoleRegistry、Connector cache；只在配置要求时启动 Kernel sidecar。
3. 注册工具、ACL waterfall、命令、BFF 路由、Skill provider 和 client module。
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

## 7. Seam 与 Adapter

| Seam | 接口 | 生产 Adapter | 测试 Adapter |
|---|---|---|---|
| Kernel transport | ResearchClient | HTTP loopback 或 Unix socket | in-process HTTP server |
| Store | transaction/query | SQLite WAL | 临时 SQLite，不 mock SQL |
| Blob | put/read/has | filesystem CAS | 临时目录 CAS |
| Execution | spawn/signal/wait | Docker | deterministic fixture，仅 echo/smoke |
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
| 009 | UI 使用认证 BFF；独立和 DSH 模式共用客户端 | 避免两套功能分叉 |
| 010 | UI 全面 i18n，DSH 模式接 LocaleFace，独立模式提供兼容实现 | 页面无硬编码文案，zh/en 一致 |
| 011 | Release Bundle 自包含并 clean-room 验证 | “可复现”成为可验证结论 |
| 012 | DSH SessionEvent 可扩展，但 Kernel Outbox 是业务权威 | 会话展示不替代业务账本 |

## 9. 当前实现迁移说明

当前仓库已有 Kernel、CAS、Runner、Analysis Worker、Orchestrator、Connectors、DSH 插件和完整原生 DOM UI，但存在目标差距：v1 路由、Web Human Principal 不真实、Evidence provenance 可绕过、两个 UI bundle、技能打包路径、最终式日志、无 TeX workspace、无 i18n。迁移顺序和证据见 hardening-v0.2-status.md；新代码不得把现状缺陷提升为规范。
