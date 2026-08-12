# DSH Scholar

DSH Scholar 是面向纯计算研究的 AI 科研工作台。它把研究资料、项目对话、代码与数据、实验运行、证据账本和 TeX 论文稿件放在同一个可恢复项目中，既可以从一个新问题开始，也可以接入已经在其他地方完成到一半的研究。

完整产品以独立 Web 工作台运行，主要由以下部分组成：

- `dsh Scholar` Web UI：项目、Chat、Workspace、Terminal、实验、证据和论文工作台；
- Research Kernel：保存权威状态、Gate、Job、Artifact、Evidence 和审计记录；
- Runner：在本机 Docker 或受控远端机器上执行冻结的实验计划。

## 使用边界

- DSH Scholar 辅助研究，不代替研究者承担科学判断、审批、署名和发布责任。
- 默认采用 `gate-only`：Scope、Idea、Experiment Contract、Budget 和 Release 等关键节点由人类决定。
- Agent 不能批准 Human Gate、伪造 accepted Evidence、绕过实验合同或自动公开发布。
- 正式实验必须绑定不可变代码/数据快照和固定执行环境，并由受控 Runner 真实执行。
- Chat、普通 stdout 和 Interactive Terminal 输出不能直接作为正式 Evidence；论文结论必须能追溯到受控 Run 和 accepted Evidence。
- 产品聚焦机器学习、数据科学、生物信息学等纯计算研究，不适用于临床决策、人体试验、湿实验、生物安全、武器或其他高风险研究。

## 快速开始

### 1. 准备环境

推荐使用：

- Node.js 24；
- pnpm 11.20.0；
- Docker，仅在需要执行正式本机实验或 LaTeX 编译时需要。

安装依赖并构建 Web UI、Kernel 与 Runner：

```bash
pnpm install --frozen-lockfile
pnpm -r --filter './packages/*' --filter './workers/*' run build
```

### 2. 启动工作台

```bash
bash scripts/start-standalone-ui.sh
```

脚本会启动 Web UI 和 Research Kernel sidecar。默认地址是 <http://127.0.0.1:18610>，Kernel 使用 `127.0.0.1:17413`。

打开页面后，粘贴以下文件中的访问令牌：

```text
~/.dsh-scholar-standalone/research-ui-standalone/standalone-token
```

令牌文件权限为 `0600`。不要把令牌提交到仓库、放进项目资料或写进命令行参数。日志位于 `~/.dsh-scholar-standalone/standalone.log`。

可使用参数覆盖默认监听和数据目录：

```bash
bash scripts/start-standalone-ui.sh --host 127.0.0.1 --port 18610 --kernel-port 17413
```

`--no-token` 只用于 loopback、隔离且人工监督的开发环境。

### 3. 启动实验 Runner

只启动工作台时可以创建项目、上传资料、编辑文件和管理研究状态，但提交的实验 Job 没有 Runner 时会保持排队。需要在本机 Docker 中真实执行实验时，另开一个终端：

```bash
export DSH_SCHOLAR_KERNEL_TOKEN="$(< ~/.dsh-scholar-standalone/research-ui-standalone/kernel-token)"
export DSH_SCHOLAR_SERVICE_TOKEN="$(< ~/.dsh-scholar-standalone/research-ui-standalone/service-token)"
node workers/runner-gateway/lib/bin/runner.js \
  --kernel http://127.0.0.1:17413 \
  --mode docker
```

正式 `/run` 还必须有已批准的 Experiment Contract、真实 Code Snapshot 和明确配置的 Runner Target/Profile。远端执行环境在 Settings 中登记为 `remote-ssh` target；目标离线或不兼容时系统会失败或等待，不会静默回退到本机。

## 开始一个研究项目

进入工作台后可从三种方式开始：

1. **Init**：只填写项目名，然后在项目 Chat 中通过 Grill Me 逐题补全研究 Brief；确认 Brief 后才会创建 Scope Gate。
2. **Resume**：打开 DSH Scholar 中已有的项目，继续其当前阶段、会话、文件和任务。
3. **Upload**：上传论文、代码、数据、日志或已有结果，从研究流程的某个阶段接入。

Chat 支持附件按钮、拖拽和粘贴。上传内容会先进入隔离 Intake，经过扫描、OCR、Grill 和人工采用后才可能成为项目事实；它不会自动变成 Evidence。

典型流程是：

```text
创建/接入项目 → Grill Me → Scope Gate → 文献调研 → Idea Gate
→ Baseline/复现 → Experiment Contract → 实验运行 → 分析与 Evidence
→ Claim → TeX 写作与评审 → 私有导出 → Release Gate
```

每个阶段的 Overview 和 Chat 都会读取 Kernel 的权威 `NextAction`，说明下一步、原因、执行者和阻断项。

## 使用工作台

- **Chat**：每个项目拥有独立会话；可上传文件、回答 Grill、查询状态并触发明确的研究操作。
- **Workspace**：像代码编辑器一样浏览、打开、编辑、上传、移动和保存项目文件，使用 version/etag 防止静默覆盖。
- **Run Terminal**：查看某个正式 Job 的只读 stdout/stderr、退出状态和可恢复日志。
- **Interactive Terminal**：打开绑定项目或 session 的真实 Web PTY，可输入命令、运行 TUI、调整窗口并重连。
- **Manuscript**：编辑 TeX、查看诊断和编译日志，并预览最新 PDF。
- **Trajectory / Topology**：查看研究轨迹、subagent 父子关系、状态和产物，并进入有权限的 child 查看详情。
- **Settings**：配置 Model Provider、OCR 模型、预算、Runner Profile，以及本机 Docker 或远端 SSH 实验环境。

Chat、Terminal、Workspace、Manuscript 和 Trajectory 等页面可停靠在主区域、右侧或底部。对话滚动位置按项目、session 和停靠位置保存；查看历史时刷新不会强制跳回顶部，主动发送或点击“跳到最新”后才继续跟随底部。

## Chat 与 slash commands

Chat 同时接受普通文本和一级 slash command：

- Init 阶段的普通文本用于回答当前 Grill 问题；
- 其他阶段会识别状态、下一步、调研、想法、Gate 和 Job 等确定性意图，并结合当前 `NextAction` 路由；
- 不明确、被阻断或需要人类决定的请求只给出解释和建议，不自动修改项目；
- 普通文本当前只支持上述确定性意图和阶段引导，不应被当作科研事实或权威状态。

常用命令：

```text
/help
/new <name>
/confirm-brief [project_id]
/list
/status [project_id]
/survey <query>
/ideas
/gates [project_id]
/jobs [project_id]
/contract <json>
/run <kind> <json>
/evidence <json>
/claims [project_id]
/write
/review
/export
/release
```

Standalone 中的 `/reproduce` 用于提交 baseline Job，不接受 DOI、arXiv ID 或论文 Artifact。`/evidence` 只创建 `draft_unverified` 记录，不会直接产生 accepted Evidence。

更完整的操作说明见 [使用指南](docs/USAGE_GUIDE.md)。
