# DSH Scholar

DSH Scholar 是运行在 DeepSeek Harness（DSH）上的科研工作台，面向机器学习、数据科学、生物信息学等纯计算研究场景。

它把研究问题、文献、Idea、实验合同、代码与数据快照、运行记录、统计证据和论文稿件组织在同一个可恢复工作流中。DSH Agent 可以协助检索、提出方案、生成实验 Patch、执行受控计算和撰写稿件；Research Kernel 保存权威状态，隔离 Runner 执行真实计算，Claim–Evidence 账本负责追溯结论，Human Gate 负责关键决策。

## 使用边界

DSH Scholar 的目标是辅助研究，而不是代替研究者承担决策和发布责任。

- 默认使用 `gate-only` 模式；Scope、Idea、Experiment Contract、Budget 和 Release 必须由人类审批。
- Agent 不能批准 Human Gate、伪造正式 Evidence、绕过实验合同或自动公开发布。
- 正式实验必须从不可变代码和数据快照启动，并在隔离 Runner 中真实执行。
- 论文中的正式数字必须能够追溯到受控 Run 和 accepted Evidence，不能直接来自聊天内容或普通 stdout。
- `full-auto` 只允许用于 CI、演示和确定性 fixture，不得用于真实项目、私有数据或公开发布。
- 项目聚焦纯计算研究，不适用于临床决策、人体试验、湿实验、生物安全、武器或其他高风险研究。

## 开发状态

项目仍处于 **Security Alpha / Architecture Prototype** 阶段，适合开发、评测和人工监督下的私有实验，不应作为无人值守的正式科研系统使用。

当前仓库已经具备 Research Kernel、DSH Agent 插件、独立 Web UI、Runner、统计分析、学术连接器、持久编排、Claim–Evidence、LaTeX 输出基础、发布包和测试基础。浏览器 UI 只支持独立模式，不再注入 DSH Web。以下 v2 能力的**服务端/契约层已实现**（浏览器 UI 层与真实环境验收仍待 Playwright 类环境）：

- 实时 Terminal：SSE、seq/gap/reconnect、分通道、lease fencing、权威终态与最终日志 Artifact（tests/unit/terminal.test.ts、run-terminal-tests.sh）；
- Interactive Terminal（PTY）与通用 Workspace：真实 PTY adapter、磁盘 workspace adapter、TeX facade（tests/unit/pty-local/pty-session/workspace-store.test.ts、run-workspace-tests.sh）；浏览器 TUI/Explorer 剩余；
- TeX Workbench：版本化编辑、冻结字节编译、实时 Preview（TEX-01/TEX-03,tex-preview/tex-build/tex-kernel.test.ts）；浏览器同页实时 Terminal/Preview 剩余；
- 本机 Docker 与受控远端 Runner：ExecutionTarget port、Remote Fleet wire 协议与代理端（RUN-REMOTE-01）；真实 mTLS/远端 sandbox 验收剩余；
- 统一 Config Schema：canonical Config Registry、parseCli 四二进制、pin/redaction、生成物（CONFIG-01）；Settings UI 与 SecretRef 存储剩余；
- Init / Resume / Upload、Grill Me、结构化下一步引导：Intake 服务端全链 + NextAction 结构化投影（ONBOARD-01/GUIDE-01）；浏览器向导与 Agent tool 面剩余；
- Research Trajectory 与 subagent 父子拓扑：只读投影、redaction、direct-child、followup 记账（TRAJ-01/SUBAGENT-01）；浏览器树/SSE 剩余；
- 全页面中英文 i18n：运行时 locale 模型与静态 parity 检查已实现；浏览器全表面验收剩余；
- 完整的认证 Principal、项目级 AuthZ、`/v2` API 和显式数据库迁移：v2 project adapter 与 BFF AuthZ 已实现，v2 全表面为迁移目标（v1 为当前迁移 adapter）。

当前状态与目标差距见 [docs/hardening-v0.2-status.md](docs/hardening-v0.2-status.md)。

## 如何使用

### 1. 准备环境

需要 Node.js 24 和 pnpm 11。正式 Runner 和完整测试还需要 Docker。

```bash
pnpm install --frozen-lockfile
pnpm -r --filter './packages/*' --filter './workers/*' run build
```

### 2. 启动独立 UI

```bash
bash scripts/start-standalone-ui.sh
```

启动后访问 <http://127.0.0.1:18610>，并使用脚本输出位置中的访问令牌登录。默认令牌文件为：

```text
~/.dsh-scholar-standalone/research-ui-standalone/standalone-token
```

### 3. 使用研究命令

在独立 UI 的 Chat 中直接使用一级 slash command；创建项目只需名称，随后在 Chat 中逐题完成 Grill Me，也可以给消息附加论文、代码、数据或已有结果：

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
/reproduce [json]
/contract <json>
/run <kind> <json>
/evidence <json>
/claims [project_id]
/write
/review
/export
/release
```

正式 `run` 必须绑定已经批准的 Experiment Contract、真实 Code Snapshot 和固定的执行环境。Workspace 可直接查看、编辑和上传项目文件；每个 Research/Chat/Subagent session 使用各自的 Terminal context；Manuscript 同页编辑 TeX、查看编译日志与实时 PDF；实验环境通过 Settings 选择本机 Docker 或受控远端 target，远端不可用时不会静默回退本机。完整流程、Gate 停点和参数说明见 [docs/USAGE_GUIDE.md](docs/USAGE_GUIDE.md)。

### 4. 可选：启用 DSH Agent 开发集成

DSH 仍可以加载 Scholar 的 tools、直接 slash commands、subagents、Skills、Session 关联和 headless 能力，但不会注入任何 Scholar 浏览器页面：

```bash
export DSH_SCHOLAR_DSH_ROOT=/absolute/path/to/dsh
bash scripts/link-dsh-deps.sh
pnpm build:plugin
bash scripts/start-dsh-agent-dev.sh
```

### 5. 启用开发期 Cordis self-modification

仅在隔离、loopback、人工监督的开发实例中使用：

```bash
DSH_SCHOLAR_ENABLE_SELFMOD=1 bash scripts/start-selfmod-dev.sh
```

该模式会启用 `cordis_inspect`、`cordis_mount` 和 `cordis_unmount`。Cordis VM 不是安全边界，禁止在生产、共享、headless 或 unattended 环境启用。

项目规范和后续开发要求以 [docs/README.md](docs/README.md) 为准。
