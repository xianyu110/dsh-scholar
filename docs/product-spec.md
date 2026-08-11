# 产品规范

> 规范性文档。实现、UI 文案和验收不得与本文件冲突。

## 1. 产品定位

DSH Scholar 面向需要可追溯、可恢复、可人工治理的纯计算研究项目。它不是“替用户自动发表论文”的机器人，而是一套把研究问题、论文证据、代码、实验合同、运行记录、统计结论、TeX 稿件和复现包连成一条审计链的科研工作台。

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

### 5.3 执行可观测性

- Runs 列表和任务详情；
- stdout/stderr 分通道且按全局序号合并；
- 实时流、断线续传、截断标记、最终退出码或信号；
- 取消实际进程树或容器，并显示权威取消结果；
- 完整日志作为项目级 CAS Artifact 下载。

Run Terminal 是正式 Job 的只读、可恢复账本。Interactive Terminal 是单独的真实 PTY 会话，必须支持 stdin、UTF-8/二进制安全帧、窗口 resize、INT/TERM/KILL、断线续传、显式关闭和审计。Interactive Terminal 不得直接产生正式 Metrics、accepted Evidence 或 Human Decision；浏览器不能获得 Runner/SSH/Kernel secret。

### 5.4 Workspace Workbench

- 项目可有 code、manuscript、scratch 等版本化 Workspace，文件树和路径均为项目根相对形式；
- VS Code 式 Explorer、已打开标签页、全局搜索、行号、语法高亮、查找替换、撤销重做、快捷键、Problems 和集成 Terminal；
- 文本与二进制文件可直接查看；可编辑类型由 media type 和策略决定，未知/大文件安全降级为只读或下载；
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
- 运行中的 Job、PTY 和 Build 固定创建时的 config revision/hash，新配置只影响新动作。

### 5.8 全页面 i18n

- 所有页面 chrome、弹窗、aria、通知、Terminal 状态和 TeX Workbench 控件首发支持简体中文与英文；
- 浏览器 UI 仅以独立模式交付，使用本地 locale adapter；DSH Agent 插件不注入 Web UI；
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

页面采用渐进披露。未选项目只显示 Start；选中项目后顶栏只显示 Overview、Workspace、Runs、Manuscript 四个高频入口和 Settings 齿轮。其他能力收进 More、上下文 CTA 和可复制深链，不能因此失去键盘可达性。

| 分组 | 页面/路由 | 核心任务 |
|---|---|---|
| Start | `/start` | Init、Resume、Upload/Continue existing research |
| Research | Overview | 唯一主 NextAction、阶段、Brief、可折叠 Trajectory/Topology |
| Research | Chat | 使用 `/new`、`/reproduce` 等一级 slash command，上传材料并查看结构化结果卡 |
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
| 隔离 | 项目级 Job、Artifact、日志、文档和权限不串项目 |
| 恢复 | Kernel/Runner/UI 重启后无重复正式 Run、无丢失 Gate、无孤儿容器 |
| 复现 | Release Bundle 在空环境重建关键指标和论文，满足合同容差 |

## 9. 发布策略

Security Alpha 阶段只能私有导出。重新使用“全自动科研系统”定位，必须同时具备真实文献检索、真实 Baseline、Human-approved Contract、隔离 Formal Runs、确定性 Evidence、可编辑并可编译的 TeX 稿件、clean-room 重跑和 Human Release Gate。
