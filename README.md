# DSH Research OS (`@dsh-scholar/research-plugin`)

一个可作为 **DSH(DeepSeek Harness)插件**使用的全自动科研系统:从领域论文调研、
Idea 生成、Baseline 复现、实验预注册与隔离执行,到 Claim-Evidence 账本、
论文与私有复现包生成。按设计文档
`DSH_fully_automated_scientific_research_plugin_execution_design_document.md`
实施,采用「DSH 控制面 + Research Kernel + 隔离 Runner」三层架构。

## 能力速览

| 层 | 组件 | 职责 |
|---|---|---|
| DSH 插件 | `src/plugin/` | kernel sidecar 生命周期、27 个科研工具(带角色 ACL)、12 个 `/research` 命令、research-core skill、`/research-api` Web 桥 + 浏览器面板(E7) |
| Research Kernel | `packages/research-kernel/` | 项目状态机 + Gate(CAS 原子决策)、Research Ledger(SQLite)、Artifact CAS、durable Job Store、预算策略、事件 outbox、多种子统计分析(mean/sd/bootstrap-95%CI/效应量)+ SVG 图表 |
| 科研服务 | `packages/scholar-connectors/` | OpenAlex/Crossref/arXiv 受控连接、缓存、去重、快照 |
| 隔离执行 | `workers/runner-gateway/` | 租约/心跳/恢复、echo/smoke 作业、RunManifest 签名、失败分类 |
| 共享契约 | `packages/research-schemas/` `packages/research-client/` | Zod 权威 schema + 类型化 Kernel 客户端 |

## 快速开始(作为 DSH 插件使用)

前置:DSH dev checkout(`/home/dev/Desktop/test-lzszq`,提供 `dsh` profile/plugin
命令);本仓库已推送到 GitHub。

```bash
# 1) 安装到任意 profile(web 或新建 research-headless)
./scripts/dsh-dev plugin --profile web add /home/dev/Desktop/dsh-scholar
#    或从 GitHub 安装:
# ./scripts/dsh-dev plugin --profile web add github:lzszq/dsh-scholar#main

# 2) 启动 Web
./scripts/dsh-dev --profile web

# 3) 在 Web 会话中使用
/research new my-study '{"problem":"...","scope":"...","primary_metrics":["macro_f1"]}'
/research status
/research survey "temporal action localization"
/research ideas
# 实验编排由模型调用 research_* 工具完成;Gate 由人类批准。
```

无头模式(CI/无人值守):

```bash
./scripts/dsh-dev --profile research-headless "/research new demo && /research status"
```

插件安装后自动完成:spawn/reuse Kernel sidecar(127.0.0.1:7412,
`$DSH_HOME/research-kernel/` 持久化)、注册工具与命令、挂载 skill。
DSH 进程退出**不会丢失**研究状态(SQLite 权威状态)。

## /research 命令面(设计附录 A)

`new` `status` `survey` `ideas` `reproduce` `contract` `run` `evidence` `write`
`review` `export` `release` — 见 `src/plugin/commands.ts`;27 个 `research_*`
工具(含 `research_panel` 并行子代理面板、`workspace_snapshot`/`patch_apply`/
`baseline_prepare`/`test_run`/`analysis_build`/`idea_compare`)见
`src/plugin/tools.ts`;角色工具 ACL 见 `src/plugin/acl.ts`。

## 开发

```bash
pnpm install
bash scripts/link-dsh-deps.sh        # 链接 DSH 安装的 @deepseek-ai/* 类型(本地类型检查)
pnpm run build                        # 构建全部包
pnpm test                             # 单元测试(31)
bash tests/fault-injection/run-fault-tests.sh   # 故障注入(6,含跨进程并发 Gate CAS)
bash tests/e2e/golden-path.sh         # 黄金路径 e2e(14,可选 --live-connectors)
bash evals/fault-stress.sh 100        # §11.4 恢复门槛:100 次 kill -9 压力
bash evals/survey-eval.sh --live      # §11.3 Survey 评测(真实连接器 recall@K)
bash evals/clean-room-rerun.sh        # §13.1 DoD#9:空环境重跑复现
```

## 仓库结构(设计 §8.2 映射)

```text
src/plugin/            dsh-research-plugin(根包即 bundle)
packages/research-kernel    apps/research-kernel
packages/research-schemas   research-schemas(+fixtures/migrations)
packages/research-client    research-client
packages/scholar-connectors scholar-connectors
workers/runner-gateway      workers/runner-gateway
skills/research-core        skills/research-core
configs/                    research-web/headless overlay 参考
tests/                      unit + fault-injection + e2e
docs/                       design-notes(RSP-001)、security-baseline(RSP-012)
plugins/research-core/.dsh-plugin  repository-plugin 静态 skill 包(GitHub 可装)
```

## 安全立场(设计 §1.2 / §4.9 / RSP-012)

- 不启用 danger-full-access、通用 web_fetch、MCP、Cordis 自指工具;
  默认权限保持 workspace-write + ask。
- 不可信实验代码不进 DSH 宿主:Runner 独立进程,容器模式禁网/非 root/
  无 socket;subprocess 模式仅限本地 smoke。
- Writer 只读 Evidence Ledger;数字/引用必须绑定 artifact;Release Gate
  默认未批准,不存在自动发布路径。
- 外部文献文本一律视为不可信数据。

## 独立测试实例

`bash scripts/start-test-dsh.sh` 在完全隔离的 DSH 环境(`~/.dsh-scholar-test`,
web :3081, kernel :17412)启动第二个 DSH 用于测试本项目,与生产 GUI(:3080)
互不影响。详见 `docs/test-instance-plan.md`。

## Roadmap / 已登记需求

- **独立 GUI 插件**(已登记):当前 E7 面板为内嵌轻量 client module;后续拆分为
  `packages/dsh-research-ui` 独立 client-plugin(React 槽位 + RPC + Gate 交互 +
  Runs/Artifacts/Evidence 面板),详见 `docs/gui-plugin-plan.md`。

## 状态

已实现并验证:E0/E1(插件/持久项目)、E2(学术连接器+快照)、E3(Idea+
新颖性+并行 Idea Panel)、E4(Runner/Contract/Baseline/正式运行)、E5(统计
分析+Claim+图表)、E6(确定性论文/评审/复现包)、E7(Web 面板:阶段/Gate/
预算/Runs/Artifacts/Evidence)、E8 主体(100 次故障注入压力、clean-room
rerun、安全基线)。Team/Cluster 部署(§9.2)与多模型路由(§8.5)为演进项。
