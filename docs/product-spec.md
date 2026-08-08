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

1. 用户创建项目并填写 Research Brief；系统创建 Scope Gate。
2. PI 批准后，系统执行多源检索、去重和冻结 Corpus Snapshot。
3. Idea Panel 生成可证伪候选，完成新颖性反查；PI 选择一个版本。
4. 系统物化 Baseline 代码和数据，在隔离 Runner 中真实复现。
5. 系统生成 ExperimentContract；PI 审批并冻结合同。
6. Engineer 生成 Patch 和代码快照；Operator 执行 Smoke、Pilot 和多 Seed Formal Runs。
7. 用户可在 Runs 与 Terminal 中实时查看每个命令的 stdout、stderr、状态、退出码和取消结果。
8. Analysis Worker 按合同生成统计 Artifact 与 accepted Evidence；Claim Verifier 更新 Claim。
9. Writer 生成 TeX 工作区；用户可编辑 .tex/.bib、编译、查看诊断和 PDF。
10. Reviewer 检查数字、引用、限制、构建和复现；系统生成私有 Release Bundle。
11. Clean-room Verifier 重跑关键结果并重建 PDF；PI 最终决定 Release Gate。

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

### 5.4 Manuscript Workbench

- 项目级 TeX 文件树，至少支持 .tex、.bib、.sty、.cls、图片和生成图表；
- 文本编辑、保存、版本冲突、历史与恢复；
- 固定镜像中的 latex-compile Job；
- pdflatex/bibtex 或配置的 biber 多遍构建；
- 实时编译终端、结构化诊断、点击跳到文件和行；
- PDF 安全预览、下载、过期提示和输入版本追踪。

### 5.5 全页面 i18n

- 所有页面 chrome、弹窗、aria、通知、Terminal 状态和 TeX Workbench 控件首发支持简体中文与英文；
- DSH 嵌入模式使用宿主 LocaleFace，独立模式使用兼容 locale adapter；
- 语言选择、fallback、插值、复数和 Intl 格式遵循 gui-plugin-plan.md；
- 项目名、论文、模型文本、Terminal 输出、TeX 源码和原始编译消息保持原文。

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

| 分组 | 页面 | 核心任务 |
|---|---|---|
| Research | Chat | 使用受控 /research 命令，查看结构化结果卡 |
| Research | Overview | 阶段、Brief、下一步、Idea、Contract、历史 |
| Execution | Approvals | Human Gate 决策和审计 |
| Execution | Runs | 任务筛选、详情、取消和 Manifest |
| Execution | Terminal | 查看活动或历史 Run 的真实终端流 |
| Review | Artifacts | 搜索、预览、下载项目产物 |
| Review | Evidence | Claim–Evidence、CI、效应量和限制 |
| Review | Manuscript | TeX 文件、编辑、编译、诊断和 PDF |
| Operations | Budget | 模型、API、GPU、并发和硬限制 |

## 8. 成功指标

| 类别 | 最低标准 |
|---|---|
| Gate | 100% Gate Decision 绑定认证人类；通用 transition 无法进入 Gate 状态 |
| Run | 正式 Job 100% 容器执行；非 echo 不存在合成成功 |
| Terminal | 日志断线恢复无静默丢失；截断、缺口和退出原因可见 |
| Evidence | 对外 Claim 100% 可追溯到 accepted Evidence 和签名 Run |
| TeX | 保存无丢失更新；固定镜像编译；诊断可定位；PDF 与输入版本绑定 |
| i18n | zh/en key 完整；全页面无硬编码 chrome；切换后即时更新且格式 locale 一致 |
| 隔离 | 项目级 Job、Artifact、日志、文档和权限不串项目 |
| 恢复 | Kernel/Runner/UI 重启后无重复正式 Run、无丢失 Gate、无孤儿容器 |
| 复现 | Release Bundle 在空环境重建关键指标和论文，满足合同容差 |

## 9. 发布策略

Security Alpha 阶段只能私有导出。重新使用“全自动科研系统”定位，必须同时具备真实文献检索、真实 Baseline、Human-approved Contract、隔离 Formal Runs、确定性 Evidence、可编辑并可编译的 TeX 稿件、clean-room 重跑和 Human Release Gate。
