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

当前仓库已经具备 Research Kernel、DSH Agent 插件、独立 Web UI、Runner、统计分析、学术连接器、持久编排、Claim–Evidence、LaTeX 输出基础、发布包和测试基础。浏览器 UI 只支持独立模式，不再注入 DSH Web。以下 v2 能力仍在开发：

- 实时 Terminal：查看命令、stdout/stderr、退出状态和可恢复日志流；
- TeX Workbench：编辑 `.tex`/`.bib`、编译、查看诊断和 PDF；
- 全页面中英文 i18n；
- 完整的认证 Principal、项目级 AuthZ、`/v2` API 和显式数据库迁移。

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

在独立 UI 的 Chat 中通过 `/research` 推进研究流程：

```text
/research new <name> [brief-json]
/research status
/research survey <query>
/research ideas
/research reproduce [json]
/research contract <json>
/research run <kind> <json>
/research evidence <json>
/research write
/research review
/research export
/research release
```

正式 `run` 必须绑定已经批准的 Experiment Contract 和真实 Code Snapshot。完整流程、Gate 停点和参数说明见 [docs/USAGE_GUIDE.md](docs/USAGE_GUIDE.md)。

### 4. 可选：启用 DSH Agent 开发集成

DSH 仍可以加载 Scholar 的 tools、`/research` commands、subagents、Skills、Session 关联和 headless 能力，但不会注入任何 Scholar 浏览器页面：

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
