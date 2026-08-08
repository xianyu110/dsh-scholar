# 当前实现与目标规范差距

> 信息性文档，更新于 2026-08-08。它描述当前仓库，不覆盖规范性文档。状态必须以源码和当次 CI 复核，历史测试计数不能自动继承。

## 1. 当前可复用基础

| 范围 | 当前实现 |
|---|---|
| Kernel | TypeScript + node:sqlite；Project/Gate/Job/Artifact/Evidence/Claim/Budget/Outbox |
| CAS | SHA-256、临时文件 + rename、项目级 Artifact record |
| HTTP | /v1 JSON 接口、可选 bearer、32 MiB、Zod 422 |
| Plugin | Cordis tools/commands/subagents、角色 ACL、Sidecar、/research-api bridge |
| UI | 完整原生 DOM Workspace UI；Chat/Overview/Approvals/Runs/Artifacts/Evidence/Budget |
| Runner | Docker/subprocess、真实 snapshot materialize、lease、heartbeat、cancel、Ed25519 Manifest |
| Analysis | MetricSpec/RunSet/AnalysisPlan、paired bootstrap、Holm、fixed metrics parser |
| Orchestrator | durable SQLite ActionStore 和状态计划 |
| Connectors | OpenAlex/Crossref/arXiv、缓存、Unicode 去重、部分失败透明 |
| Release | manuscript、LaTeX 格式、bundle/clean-room eval 基础 |
| Tests | unit、安全脚本、Docker、Golden、fault、release、LaTeX 脚本 |

## 2. 目标差距矩阵

| ID | 目标 | 当前状态 | 差距/修复方向 |
|---|---|---|---|
| GOV-01 | 认证 Human Principal durable | 未达成 | UI 提交 actor=web-user；HTTP schema 无 principal；DB decisions 无 principal column |
| GOV-02 | Gate target freeze | 部分 | Gate transaction 有状态 CAS，但 target/version 和 Contract freeze 需要统一事务 |
| API-01 | v2 + BFF AuthZ | 未达成 | 当前 /v1 loopback bridge 主要是 token/CSRF，不是 membership-aware BFF |
| EVID-01 | accepted Evidence only from Worker | 未达成 | 公共 HTTP 可传 provenance_status；verifyClaim 不过滤 verified/accepted |
| STAT-01 | 单一正式分析实现 | 部分 | Analysis Worker 严格；Kernel computeAnalysis 仍是另一套较浅算法 |
| RUN-01 | 正式 Docker/快照/fencing | 基本具备 | 默认 Runner CLI 仍 subprocess；签名 enforcement 默认兼容关闭；integrity require_signed_manifest Schema 未持久化 |
| RUN-02 | 完整容器基线 | 部分 | 当前 flags 有 network/user/memory/cpu/tmpfs，但需 read-only、cap-drop、no-new-privileges、pids 等完整策略 |
| TERM-01 | 实时有序终端 | 未实现 | Runner 结束后才返回 stdout/stderr，Kernel 无 frames/SSE，UI 无 Terminal tab |
| TEX-01 | TeX workspace/editor/version | 未实现 | buildManuscript 只生成字符串和 Artifact，无文件树/保存/CAS version |
| TEX-02 | latex-compile Job/诊断/PDF | 部分 | eval 脚本能 pdflatex/bibtex；产品接口和 UI 不存在；Job kind 不含 latex-compile |
| UI-01 | 单一共享 UI | 未达成 | 主插件轻面板与 dsh-research-ui 完整 UI 两个 client bundle；UI 包可启动第二 Kernel |
| UI-02 | i18n zh/en | 未实现 | 单个约 7,500 行 client 含大量硬编码英文；standalone 首屏固定 lang=en |
| UI-03 | DSH slots/locale/theme | 未达成 | 当前 Shadow DOM 私有主题与 localStorage，不接宿主 slots/LocaleFace |
| ART-01 | binary in all modes | 部分 | DSH bridge 流式；standalone proxy 对 upstream.text() 会破坏图片/PDF |
| ART-02 | media type | 部分 | Kernel Artifact GET 常用 application/octet-stream，PDF preview 依赖猜测 |
| STORE-01 | 显式迁移版本 | 未达成 | SCHEMA_VERSION 仍为 1，同时启动代码隐式 ensure/rebuild v2 字段 |
| STORE-02 | CodeSnapshot durable model | 部分 | archive/manifest 是 Artifact，但没有 code_snapshots 权威表；snapshot_id 与可执行 artifact id 容易混淆 |
| EVENT-01 | 正确 DSH event assumption | 文档已修 | DSH SessionEventMap 实际可扩展；业务仍选择 Kernel Outbox 权威 |
| SKILL-01 | 所有 Skill 可安装发现 | 未达成 | runtime path 可能解析 lib/skills 而 build 不复制；静态 plugin 仅打包 core；domain/venue 不自动选择 |
| PACK-01 | clean remote install | 未证实 | .dsh-plugin prepare 依赖未声明，generated assets 被 ignore；需要 tarball/install 测试 |
| SELFMOD-01 | dev-only Cordis self tools | 配置与隔离 wrapper 已新增，尚未自动验收 | shipped production composition 无 tool-cordis；需补 CI inspect/mount/unmount 与否定测试 |
| DOC-01 | Markdown 是生成权威 | 本轮建立 | 后续每个需求/修复必须同步规范、验收和本状态 |

## 3. 当前代码中的具体不一致

- createProject 对 ResearchBrief parse 后仍可能保存 raw brief，默认值一致性需修；
- approveContract 不是 Gate decision 的原子内置步骤；
- Decision Schema 有 principal，存储和 listDecisions 丢失；
- cancelJob 未统一发 job.updated；
- computeAnalysis 可能重复发 artifact.registered；
- verifyClaim 的注释要求 verified，实际读取全部 Evidence；
- public evidence route 可声明 verified；
- lower-is-better 的 Claim 语义未在 Kernel 简单验证中完整实现；
- UI Job detail 先请求不存在的 /v1/jobs?job_id=... 再做昂贵 fallback；
- standalone binary proxy 以 text() 缓冲；
- main plugin runtime Skill path 与发布 files 布局不一致；
- cordis.patch 注释允许 port=0，但 sidecar/client 没有 endpoint handshake；
- 当前 hardening shell 脚本头部宣称的部分 case 没有真正执行对应断言；
- CI/评测 README 的历史通过数量需每次重新验证。

## 4. 新增需求的落地状态

### 实时终端

已写入 product、domain、HTTP、execution、UI、storage、security、acceptance 和 repository 规范。当前代码未实现，P0 顺序为 Schema/DB frames → Runner chunk callback → internal batch write → SSE/BFF → Terminal UI → recovery/security tests。

### TeX 编辑和编译结果

已定义 TexDocument、FileRevision、Snapshot、Build、Diagnostic、latex-compile Job、三栏 Workbench 和 PDF freshness。当前只有字符串 LaTeX 和 eval 脚本，需按 repository-blueprint.md 生成模块。

### i18n

已定义 zh/en、LocaleFace/standalone adapter、资源完整性、fallback、Intl 和 UI 测试。当前没有 locale 模块，需先拆分巨型 client，再迁移全部 chrome；动态研究内容保持原文。

### Cordis self-referential 开发模式

生产配置仍默认关闭。新增 configs/research-dev-selfmod.cordis.yml 后，开发者可在隔离 DSH_HOME 显式启用 cordis_inspect/mount/unmount。该 VM 不是安全边界，不进入 unattended 或生产。

### 文档内化与 subagent

docs/README.md 与 repository-blueprint.md 已把文档同步和积极 subagent 并行写为工程 DoD。

## 5. 推荐实现批次

1. P0 Governance：Principal/AuthZ/BFF、Decision migration、Evidence provenance；
2. P0 Execution observation：Terminal Schema/DB/Runner/SSE/UI；
3. P0 Manuscript：TeX workspace/save/compile/diagnostics/PDF；
4. P0 UI foundation：拆分 client、共享 embedded/standalone、i18n/slots/theme；
5. P1 Storage/API：显式 migrations、v2、media type、binary fix；
6. P1 Skills/package：runtime assets、domain/venue selection、clean install；
7. P1 Full validation：security/recovery/Golden/clean-room 与文档校准。

## 6. 状态更新规则

每个实现变更必须修改本文件对应行：未实现、部分、基本具备、已验收。只有 acceptance-tests.md 的阻断场景在当前提交和 CI 环境通过，才能标“已验收”。不得使用旧日期的手工计数代替证据。
