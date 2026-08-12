# 产品规范

> 规范性文档。实现、UI 文案和验收不得与本文件冲突。

## 1. 产品定位

DSH Scholar 面向需要可追溯、可恢复、可人工治理的纯计算研究项目。它不是“替用户自动发表论文”的机器人，而是一套把研究问题、论文证据、代码、实验合同、运行记录、统计结论、TeX 稿件和复现包连成一条审计链的科研工作台。

产品正式名称是 `DSH Scholar`；Web UI 的组合字标统一显示为 `dsh Scholar`。顶部栏、侧边栏、独立解锁页、浏览器标题、Chat 欢迎语/导出标题、设置卡片与命令帮助不得再显示 `dsh Research`、`DSH Research` 或以 `dsh` + `Research` 分段拼出旧品牌。`Research Kernel`、Research/Session lane、API 路径和科研动作中的 `research` 是领域或技术名称，不得因品牌替换而改名。

支持领域以机器学习、数据科学、生物信息学等纯计算研究为主。涉及临床决策、人体试验、湿实验、武器、生物安全或其他高风险领域时，系统必须停止自动推进并要求独立政策扩展。

## 2. 用户与职责

| 用户 | 主要目标 | 可以做 | 不可以做 |
|---|---|---|---|
| Human PI | 定义范围、承担预算和发布责任 | 决定 Gate、取消任务、批准预算、导出与发布 | 绕过 Kernel 不变量 |
| Researcher | 调研、查看、编辑、运行和解释 | 创建草稿、编辑 TeX、查看终端和证据 | 冒充 PI、直接写 accepted Evidence |
| Operator | 运行计算基础设施 | 提交、观察、取消符合合同的 Job | 改写 Manifest 或研究结论 |
| Auditor | 检查证据、引用、安全与复现 | 读取全链路并提出问题 | 修改原始 Run 和 Evidence |
| DSH Agent | 执行受控科研动作 | 提议、检索、生成 Patch、请求 Gate | 决定 Gate、宿主正式执行、公开发布 |

## 3. 产品模式

### 3.1 gate-only

默认且唯一可用于真实项目的模式。系统在 Scope、Idea、Contract、Budget 和 Release Gate 暂停，等待认证人类决定。Gate 期间不得占用模型会话或保留易失进程状态。

### 3.2 full-auto

只允许 fixture-only 配置。可用于 CI、演示和确定性 Golden Path，不得接触真实凭据、私有数据或公开发布入口。界面必须持续显示 fixture 标识。

## 4. 端到端用户旅程

1. 未选择项目时，用户从 Init、Resume、Upload 三入口开始。Init 首次只填写项目名并创建 `DRAFT/brief_status=collecting` 项目；Resume 回到已有权威状态；Upload 把外部研究先放入隔离 Intake。
2. Init 在项目 Chat 中通过 Grill Me 每轮收集一个问题，允许先批量上传材料并由 OCR/parser 提供带来源候选；PI 确认完整 Brief 后才创建唯一 Scope Gate。Upload 经静态扫描和 Grill Me 形成阶段/缺口提案，只有 Human adoption 后才创建或合并项目，且不能伪造历史 Gate、Run 或 Evidence。
3. PI 批准 Scope 后，系统执行多源检索、去重和冻结 Corpus Snapshot；若采用了已有调研，先验证来源、license 与缺口。
4. Idea Panel 生成可证伪候选，完成新颖性反查；PI 选择一个版本。
5. 系统物化 Baseline 代码和数据，在隔离 Runner 中真实复现。
6. 系统生成 ExperimentContract；PI 审批并冻结合同。
7. Engineer 生成 Patch 和代码快照；Operator 执行 Smoke、Pilot 和多 Seed Formal Runs。
8. 用户可在 Run Terminal 中实时查看每个 Job 的 stdout/stderr，也可打开独立 Interactive Terminal，在受控 Workspace/Runner 中输入命令、使用 TUI、调整窗口并重连会话。
9. Analysis Worker 按合同生成统计 Artifact 与 accepted Evidence；Claim Verifier 更新 Claim。
10. Writer 生成版本化 Workspace；用户以 VS Code 式文件树、标签页、搜索和编辑器直接修改项目文件，LaTeX 在保存后增量编译并实时刷新诊断、日志和 PDF。
11. Reviewer 检查数字、引用、限制、构建和复现；系统生成私有 Release Bundle。
12. Clean-room Verifier 重跑关键结果并重建 PDF；PI 最终决定 Release Gate。

每一步由权威 `NextAction` 卡说明“现在做什么、为什么、由谁做、被什么阻断”，一项主 CTA 进入目标页面。Agent 运行时，用户可打开 Trajectory 查看消息/工具轨迹和 subagent 父子拓扑，并进入有权限的 child 查看详情。

## 5. 核心能力

### 5.1 研究控制面

- 项目状态机、Revision CAS、历史与下一步动作；
- Human Gate 请求、决定、理由、对象版本和认证 Principal；
- 预算、数据、执行、网络和发布策略；
- Durable Orchestrator，在重启后根据 Kernel 投影恢复。

### 5.2 学术工作流

- OpenAlex、Crossref、arXiv 的结构化检索与失败透明；
- Unicode-aware 去重、引用图、Passage 与不可变 Corpus Snapshot；
- IdeaCard、Novelty Audit、Pareto shortlist；
- ExperimentContract、代码/数据快照、真实隔离实验；
- MetricSpec、RunSet、AnalysisPlan、EvidenceItem、Claim；
- 确定性稿件、图表、BibTeX、复现包。

Chat 是项目内部工作面，不是跨项目共享的全局收件箱。每个本地 Chat session、active session、transcript、草稿、引用回复、附件引用、搜索上下文和异步命令/上传回写都必须绑定明确 `project_id`；切换项目只加载目标项目的对话，返回原项目时恢复其自身状态。固定全局 localStorage key、无项目字段的 session、或仅凭同名 session id 回写结果均不符合隔离要求。跨项目附件引用必须拒绝或过滤，项目 A 发起后延迟完成的命令/上传不得写入项目 B。

Chat composer 必须同时接受自由自然语言与一级 slash command。显式 `/...` 是确定性高级入口；普通文本在 active Init Grill 时仍只回答当前唯一问题，其他阶段进入 project-scoped natural turn，由意图路由器结合 Kernel `next_actions_v2` 选择只读查询、可执行 Agent 动作或普通对话，不能把 prose 当成未知命令。自然语言路由不得根据状态 label 猜 mutation：未知/歧义/blocked/权限不足时只解释并给出候选；Gate Decision、Brief confirm、Intake adoption、Release 决定等 Human-only 动作永远不能由模型代做。任何自动触发结果都必须回显解析出的动作、参数、执行状态和最新权威 NextAction；显式 slash 与自然语言必须进入同一 canonical operation/权限/审计语义。

每次 assistant 回答结尾都应给出与当前阶段相符的一项下一步引导，但不得自动跳页或覆盖用户正在编辑的草稿。Chat transcript 在底部时随新消息继续贴底；用户向上查看历史时，新消息、8 秒投影刷新、locale 切换和 Dock 重绘必须保持当前滚动锚点并显示“跳到最新”，不得反复回到顶部或强制拉到底部。滚动/follow 状态按 project + session + surface 隔离，切换回来恢复各自位置。

### 5.3 执行可观测性

- Runs 列表和任务详情；
- stdout/stderr 分通道且按全局序号合并；
- 实时流、断线续传、截断标记、最终退出码或信号；
- 取消实际进程树或容器，并显示权威取消结果；
- 完整日志作为项目级 CAS Artifact 下载。

Run Terminal 是正式 Job 的只读、可恢复账本。Interactive Terminal 是单独的真实 PTY 会话，必须使用 xterm-compatible 浏览器终端模拟器，支持可聚焦键盘输入、粘贴、IME/Unicode、ANSI/VT 光标与 alternate-screen TUI、窗口自动 resize、INT/TERM/KILL、断线续传、显式关闭和审计。把服务端输出逐行放进普通 `div/textContent`、只提供 resize/signal 按钮或存在未接线的 `sendText()` 均不算 Web Terminal 完成。Interactive Terminal 不得直接产生正式 Metrics、accepted Evidence 或 Human Decision；浏览器不能获得 Runner/SSH/Kernel secret。

### 5.3.1 可配置实验环境

- 实验执行环境是版本化 `RunnerTarget + RunnerProfile`，至少支持 `local-process`、`local-docker`、`remote-ssh` 三种显式类型；项目、Contract、Job 和复现 attempt 只引用 opaque ID，并在 submit 时固定 target/profile/environment revision 与 hash；
- `local-process` 仅允许明确标记的 trusted development/smoke 工作负载，不能承载 baseline、pilot、formal、reproduce、latex-compile 等正式隔离任务；`local-docker` 使用固定 digest、非 root、只读根、资源/网络策略；`remote-ssh` 连接受控实验机器并在远端执行同一冻结 ExecutionPlan，不能成为业务权威；
- Settings 的 Execution 折叠组提供 Target/Profile 列表、创建、编辑、禁用、健康状态与能力配置。远端 endpoint、known-host/CA 与 credential 分别以完整 SecretRef 配置，界面必须显式覆盖 `scheme`、`name`、可选 `version` 与可选 `scope`，编辑已有 Target 时不得丢失任何可选元数据；SecretRef 只保存于服务端，浏览器、项目、Job、argv、导出包和日志均不得得到私钥或原始 endpoint 内容；
- 当前项目必须能在 Settings 中以 CAS 保存默认 RunnerTarget；`/run` 与 `/reproduce` 的 JSON 可用顶层 `runner_target_id` 对单次 Job 显式覆盖。解析优先级固定为“Job 覆盖 > 项目默认”，两条路径都必须在 Job/ExecutionPlan 中固定同一 target revision/hash；页面只显示 opaque id、类型、能力与健康摘要；
- unknown/offline/draining/capability mismatch/host-key mismatch 必须 fail closed 或保持 retryable，绝不静默切换到本机或 Docker。目标在排队、claim 或 spawn 前任一时刻被禁用、排空、换 kind 或 revision/hash 漂移，旧 pin 均不得执行；更换环境必须由用户创建显式新 attempt，并产生新 pin/审计。
- 论文复现的 execution binding 与 environment lock 不能只保存未经解析的字符串：创建/更新 spec 与启动 attempt 都要对照 RunnerTarget Registry 校验 target/profile 兼容性，并固化 target revision/hash；未知、禁用、排空、冲突或过期的环境绑定必须 fail closed。

### 5.4 Workspace Workbench

- 项目可有 code、manuscript、scratch 等版本化 Workspace，文件树和路径均为项目根相对形式；
- VS Code 式 Explorer、已打开标签页、全局搜索、行号、语法高亮、查找替换、撤销重做、快捷键、Problems 和集成 Terminal；
- 文本与二进制文件可直接查看；可编辑类型由 media type 和策略决定，未知/大文件安全降级为只读或下载；
- manuscript TeX facade 与 generic Workspace API 必须是同一文件权威的两种视图：list/tree/read/version/blob/write/move/delete/search/watch 任一 generic 操作都必须先解析 workspace backend，不能因“generic store 未命中”把已存在的 TeX 文件误报 404；公共节点大小字段缺失或非法时 UI 安全显示 `0 B`，不得出现 `NaN undefined`；
- create/read/write/move/delete/upload/watch/search/snapshot 共用 Revision/ETag/CAS，冲突提供 base/current/local，禁止静默覆盖；
- 编辑器只是 Workspace interface 的 adapter；Kernel 不依赖 Monaco、CodeMirror 或 VS Code Web。

### 5.5 Manuscript Workbench

- 项目级 TeX 文件树，至少支持 .tex、.bib、.sty、.cls、图片和生成图表；
- 文本编辑、保存、版本冲突、历史与恢复；
- 固定镜像中的 latex-compile Job；
- pdflatex/bibtex 或配置的 biber 多遍构建；
- 实时编译终端、结构化诊断、点击跳到文件和行；
- PDF 安全预览、下载、过期提示和输入版本追踪。

LaTeX “实时预览”表示：成功保存后按可配置 debounce 创建可取消、可取代的 preview build，实时显示同一 build 的编译输出和诊断，并在成功时刷新 PDF；编辑发生后旧 PDF 立即标记 stale。preview build 不得进入 Evidence。显式 Compile 仍创建冻结输入、固定镜像和完整 RunManifest 的权威 latex-compile Job。

### 5.6 Runner Fleet

- 默认 target 是本机 Docker；可登记受控远端 Runner machine 或 scheduler target；
- UI/Job 只引用不透明 `runner_profile_id`，不能提交 hostname、SSH command、credential、Docker socket 或宿主路径；
- Kernel 保持队列、lease、Run、Artifact、Manifest、预算和审计权威；远端 Runner 只物化 CAS 输入、隔离执行并回传事实；
- target capability、health、draining、latency 和资源可见；无能力或离线时 fail closed，不静默回退到本机或 subprocess；
- 远端控制和 Artifact 传输使用 mTLS/短期 service identity、断点续传、hash、generation/token fencing。

### 5.7 配置中心

- 所有可配置项由单一版本化 Config Schema 定义，并生成 Zod、JSON Schema、配置文件模板、HTTP schema、CLI help 和 Settings 表单；
- 每项声明 instance/user/project/workspace/session/target/job scope、类型、默认值、范围、是否 secret、是否可热更新、是否需要重启以及是否允许更窄的下层覆盖；
- effective config 展示每个字段的值和来源；修改使用 revision CAS，外部文件修改与 UI 修改不会静默互相覆盖；
- secret 值不进入普通配置、浏览器、argv、日志、Manifest 或 Bundle，只保存 `SecretRef` 并由服务端解析；
- 唯一的浏览器明文例外是用户在 DSH Plugin config 显式触发“复制 standalone 访问 Token”：loopback-only Host action 从固定 `0600` 普通文件读取后直接写 Clipboard，不回显、不持久化、不进入 URL/日志/配置；该例外不适用于 Kernel、Runner、Provider、SSH 或任何其他 secret；
- 运行中的 Job、PTY 和 Build 固定创建时的 config revision/hash，新配置只影响新动作。

### 5.8 全页面 i18n

- 所有页面 chrome、弹窗、aria、通知、Terminal 状态和 TeX Workbench 控件首发支持简体中文与英文；
- 浏览器 UI 仍只构建和交付一份 standalone 实现；DSH Agent 插件可在会话区注入 `dsh Scholar` 页签，以受控 iframe/新页面启动器复用同一 standalone URL，不复制业务 UI 或 BFF；
- 语言选择、fallback、插值、复数和 Intl 格式遵循 gui-plugin-plan.md；
- 项目名、论文、模型文本、Terminal 输出、TeX 源码和原始编译消息保持原文。

### 5.9 既有研究接入与文件上传

- 支持上传单文件、Workspace/TeX archive、代码、数据、日志、结果与私有 Release Bundle；上传可暂停、恢复、取消并显示 hash/scan 状态；
- ResearchOnboarding 以静态 parser 和 Grill Me 收集缺口，输出 observed phase 与安全采用 proposal；
- 用户可在创建新项目或合并授权项目之间选择，所有 path/role/revision 冲突显式解决，绝不静默覆盖；
- 导入日志只是 log Artifact，导入指标只是 legacy/draft Evidence；没有本系统签名 Manifest 时必须重跑或重新分析；
- 精确状态、映射和安全边界见 research-onboarding.md。

### 5.10 Trajectory 与 Subagent 拓扑

- Research Trajectory 展示 Kernel Outbox 的权威研究链；Session Trajectory 展示 DSH/Agent 的观察性过程，两者必须显式区分；
- subagent 以可折叠树/图展示 parent-child、role、mode、activity、duration、token/cost、失败和 children；
- 用户可进入 child，使用 breadcrumb 返回；one-shot 只读，continuable 只有 exact-parent 授权后可续问；
- history/cold read 不得激活 Agent，默认只返回脱敏安全摘要；
- 精确模型、流协议和 DSH 移植边界见 trajectory-subagents.md。

### 5.11 Model Provider 与 OCR

- instance/global Provider Registry 支持内置与自定义 Provider；credential 只保存 SecretRef，项目只引用 provider/model ID；
- OCR 是显式选择模型的异步 Intake pipeline，无匹配模型时 fail closed，禁止静默回退；
- OCR/parser 结果保持 `observed_unverified`，带来源、页码、模型 revision 和 confidence，经 Chat 逐项由 Human 确认；
- name-only Init、单题 Grill、批量分块上传和 Provider/OCR 的生成级契约见 `init-grill-upload-models.md`。

### 5.12 论文复现

- 用户用 `/reproduce` 或在 Chat 上传论文/PDF/代码/数据进入复现向导；所有 slash command 直接使用一级命令，不注册、不解析、不展示旧聚合前缀；
- 系统固定论文来源、代码 commit/CodeSnapshot、数据/hash、ExperimentContract、环境和目标结果，在本机 Docker 或配置的远端 SSH Runner 上执行；
- execution exit 0 不等于复现成功；必须生成不可变 ReproducibilityReport，对齐指标、表格、图和可选 TeX/PDF，结果为 pass/fail/blocked/inconclusive；
- Chat 附件先进入隔离 Intake；Interactive Terminal 按 Research/Chat/Subagent session 打开多个独立 PTY，不能作为正式复现证据；
- 生成级对象、比较算法、环境绑定、API、NextAction 与验收见 `reproduction-contracts.md`。

### 5.13 全页面可停靠侧栏

- 左侧 Project Sidebar 只负责项目搜索、选择和项目生命周期；页面停靠区统一称为 Panel Dock/页面侧栏，二者不是同一个导航或配置对象；
- Chat、Overview、Approvals、Runs、Artifacts、Evidence、Budget、Manuscript、Run Terminal、Trajectory、Topology、Workspace、Interactive Terminal 等全部当前页面既可占据主区，也可作为一个活动面板停靠在右侧或底部；
- 同一页面任一时刻只允许一个活实例。把当前主页面放入 Dock 时，主区切到安全回退页；从 Dock 打开到主区时先关闭 Dock 中的该实例，禁止复制 Chat 草稿、PTY 输入目标、Workspace/TeX 编辑状态或流消费器；
- 右侧与底部切换必须移动同一个已挂载面板，不重建 DOM、不关闭 SSE/PTY，也不丢失焦点、草稿、选中文件和滚动位置；主区与 Dock 之间切换允许按最后序号安全重连，Terminal、PTY、Workspace watch 与 Trajectory 不得丢帧或重复展示；
- 用户可拖动分隔条调整尺寸，也可用方向键、Home/End 完成同一操作。默认右侧 420 px、底部 320 px，右侧限制 280–720 px、底部限制 180–640 px；无效或过期持久化值必须 fail closed 回默认值；
- Dock 的打开页面、首选位置和尺寸是当前浏览器的本地展示偏好，不是 Kernel Config Registry、运行时 config pin、项目数据或跨设备同步配置，不得保存 token、secret、聊天内容或研究文件；
- 视口小于 720 px 时，右侧首选位置只在视觉上投影为底部，不覆盖已保存的右侧偏好；Dock 标题、选择器、移动/关闭动作、分隔条 aria 和提示全部支持 zh/en 即时切换。

## 6. 明确不做

- 不把 LLM 对新颖性或结果的自评当作 Evidence；
- 不允许 Writer 从 stdout 或聊天内容抄取正式数字；
- 不允许模型调用 Human Gate Decision；
- 不允许正式 Job 使用宿主 subprocess、任意宿主路径或可变镜像标签；
- 不允许从 stdout 自由 JSON 行生成正式指标；
- 不提供通用网页抓取、任意 MCP 或 Cordis 自指工具的默认权限；
- 不渲染不可信 HTML，不让 SVG 脚本执行；
- 不自动提交 arXiv、会议或期刊；
- 不承诺通过当前原型即可进行无人值守正式研究。

## 7. 用户可见信息架构

页面采用渐进披露。未选项目只显示 Start；选中项目后顶栏只显示 Overview、Workspace、Runs、Manuscript 四个高频入口和 Settings 齿轮。其他能力收进 More、上下文 CTA 和可复制深链，不能因此失去键盘可达性。表中的全部当前业务页面都支持主区、右侧 Dock 和底部 Dock 三种展示位置；Settings 仍是独立设置面，不作为业务页复制到 Dock。

| 分组 | 页面/路由 | 核心任务 |
|---|---|---|
| Start | `/start` | Init、Resume、Upload/Continue existing research |
| Research | Overview | 唯一主 NextAction、阶段、Brief、可折叠 Trajectory/Topology |
| Research | Chat | 自由对话、按阶段自动引导与自然语言动作路由；保留 `/new`、`/reproduce` 等一级 slash command，上传材料并查看结构化结果卡 |
| Execution | Approvals | Human Gate 决策和审计 |
| Execution | Runs | 任务筛选、详情、取消和 Manifest |
| Execution | Run Terminal | 查看活动或历史 Run 的真实只读终端流 |
| Execution | Interactive Terminal | 在授权 Workspace 和执行 target 中操作真实 PTY；与 Run Terminal 分离 |
| Research | Workspace | 浏览、搜索、查看、编辑和版本化项目文件 |
| Research | Trajectory / Topology | 查看权威研究事件和 Agent/subagent 运行拓扑，进入 child |
| Review | Artifacts | 搜索、预览、下载项目产物 |
| Review | Evidence | Claim–Evidence、CI、效应量和限制 |
| Review | Manuscript | TeX 文件、编辑、编译、诊断和 PDF |
| Operations | Budget | 模型、API、GPU、并发和硬限制 |
| Operations | Settings | 配置作用域、Runner targets、TeX、Terminal、限制、来源和 Secret 引用 |

Settings 首次进入时所有 section 默认折叠，按 Essentials、Execution、Workspace、Terminal、LaTeX、Agent/Trajectory、Security & Secrets、Diagnostics 分组；非默认项显示 badge，每项显示 effective value、来源 scope/revision/hash、热更新或重启标识以及 reset-to-default。配置不得散落在业务页常驻展示。

## 8. 成功指标

| 类别 | 最低标准 |
|---|---|
| Gate | 100% Gate Decision 绑定认证人类；通用 transition 无法进入 Gate 状态 |
| Run | 正式 Job 100% 容器执行；非 echo 不存在合成成功 |
| Terminal | 日志断线恢复无静默丢失；截断、缺口和退出原因可见 |
| Interactive PTY | 输入、resize、signal、重连和关闭可操作；无权限、过期会话或背压 fail closed |
| Workspace | 文件树/搜索/编辑/冲突/快照无越界与丢失更新；桌面和窄屏核心动作可达 |
| Evidence | 对外 Claim 100% 可追溯到 accepted Evidence 和签名 Run |
| TeX | 保存后实时 preview；固定镜像权威编译；日志/诊断可定位；PDF 与输入版本绑定 |
| Runner | 本机 Docker 与远端 target 使用同一 Plan/lease/Manifest；网络分区不产生合成成功 |
| Config | 所有可配置项 schema/UI/file parity；来源可解释；secret 零泄漏；运行固定 config hash |
| Onboarding | 任意阶段材料可恢复接入；pre-accept 零权威写；历史 Gate/Run/Evidence 无伪造；上传可恢复且冲突不覆盖 |
| Guidance | 每个非终态项目都有结构化下一步、原因、负责人和目标路由；未知 action 不会误执行 |
| Trajectory | Research/Session 权威性明确；subagent 拓扑可展开/进入/返回；详情脱敏、history 不激活 Agent |
| i18n | zh/en key 完整；全页面无硬编码 chrome；切换后即时更新且格式 locale 一致 |
| Panel Dock | 全部当前页面可在主区/右侧/底部间切换；同页仅一活实例；位置与尺寸可恢复；窄屏、键盘、i18n 与流重连无数据丢失 |
| 隔离 | 项目级 Job、Artifact、日志、文档和权限不串项目 |
| 恢复 | Kernel/Runner/UI 重启后无重复正式 Run、无丢失 Gate、无孤儿容器 |
| 复现 | Release Bundle 在空环境重建关键指标和论文，满足合同容差 |

## 9. 发布策略

Security Alpha 阶段只能私有导出。重新使用“全自动科研系统”定位，必须同时具备真实文献检索、真实 Baseline、Human-approved Contract、隔离 Formal Runs、确定性 Evidence、可编辑并可编译的 TeX 稿件、clean-room 重跑和 Human Release Gate。
