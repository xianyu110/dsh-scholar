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

## 环境与依赖

规范文档见 [docs/test-instance-plan.md](docs/test-instance-plan.md)（实例矩阵、前置环境、测试命令）。

### 1. 基础运行时

| 依赖 | 要求 | 说明 |
|---|---|---|
| 操作系统 | Linux（推荐） | 启动脚本依赖 bash + util-linux 的 `setsid`/`nohup`；macOS 可用于文件权限语义测试，但需自行提供 `setsid` 替代或手工启动服务进程 |
| Node.js | 24（规范与 CI 基准） | 仓库未声明 `engines` 字段；`docs/test-instance-plan.md` 与 CI（`node-version: 24`）均按 24 验收 |
| pnpm | 11（`packageManager: pnpm@11.20.0`） | 建议启用 corepack；安装必须 `--frozen-lockfile` |
| bash / curl | 任意近期版本 | 所有启动、测试、演示脚本均为 bash + curl |
| git | 任意近期版本 | 复现的 Git 代码来源必须固定 exact commit |
| 浏览器 | 现代桌面浏览器 | standalone UI（`http://127.0.0.1:18610`），支持中/英文界面 |

### 2. Docker 与固定镜像

Docker Engine 是**正式实验、Golden Path、TeX 编译和 clean-room 复现的硬依赖**（`docker info` 必须通过）。CI 中缺失 Docker 是 FAIL，不允许以 skip 通过。

- 正式 Job 由 Runner 从 CAS 物化代码后，在容器内真实执行；
- 镜像一律用 digest 固定，锁在 `configs/runner-profiles/images.lock.json`（可用 `DSH_IMAGES_LOCK` 覆盖路径）：
  - 节点 fixture：`node@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32`（node:22-alpine）
  - TeX Live：`texlive/texlive@sha256:8957c916b8160049f89c24d362a6d86c09d8a04095acde37e88404c4afed85b4`
- 镜像首次使用自动拉取；**本机不需要安装 pdflatex**，TeX 编译在固定 TeX Live 镜像内完成。

### 3. 依赖包面

安装与构建：

```bash
pnpm install --frozen-lockfile
pnpm -r --filter './packages/*' --filter './workers/*' run build
```

运行时依赖（公共 npm registry 可安装）：

- `zod ^3.24.0`；
- workspace 内部包：`@dsh-scholar/research-client`、`@dsh-scholar/research-kernel`、`@dsh-scholar/research-schemas`、`@dsh-scholar/scholar-connectors`、`@dsh-scholar/dsh-research-ui`、`@dsh-scholar/runner-gateway`。

开发依赖：`typescript ~5.7`、`vitest ^3`、`tsdown`、`tsx`、`@types/react ~18.3` 等（以各包 package.json 为准）。

DSH 宿主 peer 依赖（**仅 DSH Agent 集成需要；这些包不在公共 npm registry**，由 DSH 宿主提供）：

- `@deepseek-ai/cordis` `>=4.0.0-rc.7 <4.0.1 || >=4.0.1-rc.1 <5`
- `@deepseek-ai/schemastery` `>=3.18.0 <3.18.1 || >=3.18.1-rc.1 <4`
- 可选：`@deepseek-ai/dsh-commands`、`@deepseek-ai/dsh-client-locale`、`@deepseek-ai/dsh-client-runtime`、`@deepseek-ai/dsh-client-ui-plugin-config`、`@deepseek-ai/dsh-client-ui-settings`、`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-settings`、`@deepseek-ai/dsh-skill-local`、`@deepseek-ai/dsh-tools`（均为 `^0.0.1-rc.1`）、`react ^18.2.0`

standalone 工作台的干净构建**不依赖** DSH checkout/symlink；只有 DSH 插件构建（`pnpm build:plugin`）需要先执行 `bash scripts/link-dsh-deps.sh`（`DSH_SCHOLAR_DSH_ROOT` 指向 DSH checkout，自动候选为 `../test-lzszq` 与 `~/.dsh/source/current`）。运行时由 DSH profile 的扁平 node_modules 提供同一 Cordis 实例，不打包第二份 Cordis。

### 4. 实例与端口矩阵

端口只是默认值，可覆盖；实例隔离以 dataDir/database_id 为准（health 必须返回 instance_id、protocol_version、schema_version 与 database_id）。

| 实例 | Web | Kernel | 数据目录 | 用途 |
|---|---|---:|---:|---|---|
| Standalone 工作台 | 18610 | 17413 | `~/.dsh-scholar-standalone` | 完整产品 UI（唯一浏览器 UI） |
| Scholar Agent dev | 3081 | 17412 | `~/.dsh-scholar-agent-dev` | DSH tools/commands/Skills，无 Scholar UI |
| Scholar selfmod dev | 3082 | 17414 | `~/.dsh-scholar-selfmod-dev` | Cordis 运行时调试（显式启用，仅隔离 dev） |
| 日常 DSH 宿主 | 3080 | 7412 | 用户 `DSH_HOME` | 非 Scholar 日常工作 |
| CI / eval | 随机 | 随机 | mktemp workspace | 自动验收 |

### 5. 环境变量

| 变量 | 用途 | 默认 |
|---|---|---|
| `DSH_SCHOLAR_STANDALONE_HOST` / `_PORT` / `_KERNEL_PORT` | standalone UI 与 Kernel 监听 | `127.0.0.1` / `18610` / `17413` |
| `DSH_SCHOLAR_STANDALONE_DATA` | standalone 数据目录（含 token 文件与日志） | `~/.dsh-scholar-standalone` |
| `DSH_SCHOLAR_STANDALONE_PRINCIPAL` | loopback 操作者 principal | `ops-1` |
| `DSH_SCHOLAR_AGENT_HOME` / `_PORT` / `_KERNEL_PORT` | DSH Agent dev 实例 | `~/.dsh-scholar-agent-dev` / `3081` / `17412` |
| `DSH_SCHOLAR_DSH_ROOT` | DSH checkout 路径（link-dsh-deps.sh / 插件构建） | 自动探测 |
| `DSH_SCHOLAR_ENABLE_SELFMOD` | 显式启用 Cordis self-mod（值必须为 `1`） | 未设置 = 禁止 |
| `DSH_SCHOLAR_SELFMOD_HOME` / `_PORT` / `_KERNEL_PORT` | selfmod dev 实例 | `~/.dsh-scholar-selfmod-dev` / `3082` / `17414` |
| `DSH_SCHOLAR_EXTRA_PATCH` | 追加 cordis patch 文件 | 空 |
| `DSH_SCHOLAR_KERNEL_TOKEN` | Runner 连接 Kernel 的 bearer token | 必填，读数据目录的 `kernel-token` 文件 |
| `DSH_SCHOLAR_SERVICE_TOKEN` | Runner / 评估脚本的内部路由服务 token | 必填，读数据目录的 `service-token` 文件 |
| `DSH_IMAGES_LOCK` | 覆盖镜像锁文件路径 | `configs/runner-profiles/images.lock.json` |
| `DSH_HOME` | DSH 配置与实例目录（DSH 宿主侧） | `~/.dsh` |
| `CI=true` | security 聚合器 fail-closed 模式 | — |
| `DSH_PRIVATE_REGISTRY_URL` / `_TOKEN` | 发布兼容性验收的私有 registry 与短期只读 token | 无（缺失时记 `NOT_RUN_MANUAL_PENDING`） |
| `DSH_PRIVATE_DSH_SPEC` / `DSH_SCHOLAR_PLUGIN_SPEC` | 验收用的固定包 spec | 无 |

### 6. 远端执行环境

- 第二台受控 Linux 主机/VM/容器 namespace（远端验收不能用同一进程 fake 代替）；
- OpenSSH 客户端：`BatchMode=yes`、`StrictHostKeyChecking=yes`、`IdentitiesOnly=yes`，只允许启动 `dsh-scholar-runner`，不接受 ProxyCommand 或任意远端 shell；
- 远端机器必须已安装 runner，并通过受控环境提供 Fleet service token；endpoint JSON、0600 credential 与预固定 known_hosts 只存服务端 SecretRef，绝不进入仓库、日志或 argv；
- 生产环境必须 mTLS（开发 wire 可用 `--service-token`）；远端验收需要 mTLS test CA 与可注入网络分区的 transport；
- 远端离线、能力不匹配或 host key 校验失败时，任务明确失败或等待，**不会静默回退到本机执行**。

### 7. 私有 registry 发布验收

```bash
DSH_PRIVATE_REGISTRY_URL='https://registry.example.invalid' \
DSH_PRIVATE_REGISTRY_TOKEN='<short-lived-read-token>' \
DSH_PRIVATE_DSH_SPEC='@deepseek-ai/dsh@0.0.1' \
DSH_SCHOLAR_PLUGIN_SPEC='@dsh-scholar/research-plugin@0.1.0' \
bash tests/integration/run-dsh-private-registry-tests.sh
```

脚本自行创建全新安装目录、`DSH_HOME` 与权限 0600 的临时 npm userconfig，输出脱敏。缺少真实 registry/credential 时登记 `NOT_RUN_MANUAL_PENDING`；本地 symlink / fake host 不计 PASS；secret 不写入仓库 `.npmrc`。

### 8. CI 参考环境

GitHub Actions（`.github/workflows/ci.yml`）：`ubuntu-latest` + Node 24 + pnpm 11 + Docker。本地等价入口：`bash scripts/ci-gate.sh`（`pnpm test` → `verify-docs` → security 聚合器 → 插件 typecheck）。

## 快速开始

### 1. 准备环境

完整的环境、依赖、端口与变量清单见上节「[环境与依赖](#环境与依赖)」。最小可用环境：

- Node.js 24；
- pnpm 11.20.0；
- Docker（执行正式实验、TeX 编译、Golden 与 clean-room 时必须）。

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
