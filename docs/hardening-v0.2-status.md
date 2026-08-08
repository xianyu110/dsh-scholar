# 当前实现与目标规范差距

> 信息性文档，更新于 2026-08-09。它描述当前仓库，不覆盖规范性文档。状态必须以源码和当次 CI 复核，历史测试计数不能自动继承。

## 1. 当前可复用基础

| 范围 | 当前实现 |
|---|---|
| Kernel | TypeScript + node:sqlite；Project/Gate/Job/Artifact/Evidence/Claim/Budget/Outbox |
| CAS | SHA-256、临时文件 + rename、项目级 Artifact record |
| HTTP | /v1 JSON 接口、可选 bearer、32 MiB、Zod 422 |
| Plugin | Cordis Agent tools/commands/subagents、角色 ACL、Skills、Sidecar；无 browser client/bridge |
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
| GOV-01 | 认证 Human Principal durable | 已实现 | decisions 表新增 principal_id/tenant_id/auth_method/session_id 列(含 ensureColumn 迁移);decideGate 事务持久化;listDecisions 重建 principal;decisionSchema 透传 principal 且 rejected/revised 强制 reason;单测覆盖持久化/旧行兼容 |
| GOV-02 | Gate target freeze | 部分 | Gate transaction 有状态 CAS，但 target/version 和 Contract freeze 需要统一事务 |
| API-01 | v2 + BFF AuthZ | 未达成 | 当前 /v1 loopback bridge 主要是 token/CSRF，不是 membership-aware BFF |
| EVID-01 | accepted Evidence only from Worker | 已实现 | 公共 POST evidence 拒绝 verified(evidenceSchema 仅 draft/legacy);新增内部 POST /evidence/verified(ingestVerifiedEvidence);provenance_status 随 body 存储;verifyClaim 只读 verified 证据,无 verified 时返回 inconclusive(带原因);demo/standalone 脚本切换 verified 路径,14/14 绿 |
| STAT-01 | 单一正式分析实现 | 已实现 | kernel.computeAnalysis 不再自带统计:收集 baseline+treatment 运行、按 seed 配对(§13.6 matched-seed),全部数学委托 @dsh-scholar/analysis-worker computePairedAnalysis(seeded percentile bootstrap CI、holm 校正 p 值、direction_ok);无配对种子→422 matched_seeds_required;kernel 内 bootstrapCi95/mulberry32 私有实现移除;单测改为配对设计(44/44),全量 209/209,demo 14/14 |
| RUN-01 | 正式 Docker/快照/fencing | 已实现 | IntegrityConfig 新增 require_signed_manifest(默认 false)并经 createProject 持久化;项目置 true 时无签名 manifest→422 manifest_signature_required,签名后放行(单测);SECURE_KINDS 拒绝 subprocess 由 kernel+runner 双层强制;Runner CLI subprocess 默认仅用于 echo/smoke 信任夹具 |
| RUN-02 | 完整容器基线 | 已实现 | runDocker 补齐 --read-only(根文件系统只读)+--cap-drop ALL+--security-opt no-new-privileges+--pids-limit 256;/outputs 为唯一 rw 挂载、/tmp tmpfs;latex-compile e2e 10/10 与 docker-eval 18/18 在加固 flags 下全绿(含 texlive 容器与 cancel/清理) |
| TERM-01 | 实时有序终端 | 已实现 | 全链路已落地并 e2e 验证:terminal_frames/terminal_retention 表、kernel append/list(单调 seq、幂等、lease fencing、8 MiB 有界保留+dropped/truncated)、POST /v1/jobs/{id}/terminal-frames、GET /v1/jobs/{id}/terminal SSE(subscribed/chunk/gap/exit、心跳、gap 语义)、runner-gateway onChunk 实时批量上报(200ms/64 帧、job 身份 run、exit 帧)、Terminal tab(运行选择/通道/ANSI 白名单/状态栏/lastSeq 续传);单测 4 项+Playwright e2e;验收测试与 CI 待跑 |
| TEX-01 | TeX workspace/editor/version | 基本具备 | 后端已落地:tex-workspace.ts(独立 WAL、tex_documents/tex_files/tex_snapshots/tex_builds、normalizePath、expected_version CAS 写 409、snapshot 冻结 manifest)+ kernel 集成(createProject 存 parse 后 brief、generateTexWorkspace paper.tex+main.bib、/v1/documents/{tree,file,moves,history,snapshots,builds});UI 已落地:Manuscript tab(文件树/编辑器 Ctrl+S/dirty+conflict/snapshot builds 诊断/PDF 预览下载),Playwright 验证渲染与无请求风暴;单测 4 项;验收测试待跑 |
| TEX-02 | latex-compile Job/诊断/PDF | 已实现 | 全链路落地并 e2e 验证:builds POST 冻结快照(manifest 随 job payload 携带)→ runner materializeTexWorkspace(逐文件经 kernel GET、sha256 校验、路径防护)→ texlive/texlive 容器 run.sh(pdflatex×3+bibtex,显式清单复制避免挂载点递归)→ PDF(application/pdf)/完整 log/结构化 diagnostics/aux 包 artifacts→ completeJob 将 manifest.tex_* 映射到 tex_builds(status/diagnostics/pdf/log/finished_at);latex-compile 默认镜像 texlive/texlive:latest;artifact GET 支持 HEAD;e2e evals/latex-compile-e2e.sh 10/10(真实 bibtex 引用编译出 PDF);单测 5 项;CI job tex-compile-e2e 已加(先拉固定镜像) |
| UI-01 | standalone-only 单一 UI | 基本具备，待 CI 运行 | 根轻面板、两个 DSH HTTP bridge、UI Cordis host/patch 与 client floating 死分支已删除；manifest/files allowlist、docs verifier 和 standalone CI build 已接入，尚需 clean checkout 实跑 |
| UI-02 | i18n zh/en | 部分 | locale adapter + zh/en 字典(common/shell/standalone/terminal/manuscript)+ 设置语言切换与即时重渲染已实现;manuscript 工作台 chrome 已全部走 t();独立解锁页在首帧前选择 locale(dsh.locale→navigator.languages→navigator.language→zh)、<html lang> 动态化、中文词典 DOMContentLoaded 应用,Playwright 验证 zh 全量生效;tab 标签/其余视图 chrome 仍有硬编码,UI-04 拆分时一并迁移 |
| UI-03 | standalone locale/theme adapter | 部分 | 已去除 DSH slots/LocaleFace 目标；当前仍是硬编码文案和局部 localStorage |
| UI-04 | browser client strict typecheck | 已实现 | tsconfig.client.json 将 client 纳入 strict+noUncheckedIndexedAccess 检查并清零(93 个错误):TAB_GROUPS 显式 tuple 类型、modal 签名放宽 ShadowRoot|null|undefined+入口 guard、projection.project 归一化为非可选、writeTheme 接受 string、health/workspace 类型补全、tokenProvider 闭包安全、Element→HTMLElement 转型、正则索引可选链;已并入 research-ui typecheck 脚本 |
| UI-05 | standalone settings runtime | 已实现 | 浏览器交互验证通过(Playwright,chromium headless):设置弹窗(Connection/Bridges/Auth/Appearance/Preferences/Conversation)、语言切换→dsh.locale 持久化+<html lang>+即时重渲染、主题 Toggle→dark 持久化+data-theme、强调色→violet 持久化+--accent CSS 变量、Auto refresh Toggle→'off' 持久化且 10s 内 body 零重渲染(轮询停止) |
| ART-01 | standalone binary/SSE 流式 | 代码已修，待验收 | proxy 已改为 Web stream 转发、保留 media headers 并处理 source/client 中断；需补真实 PDF/image/SSE round-trip CI |
| ART-02 | media type | 已实现 | 迁移 0004 增加 media_type/file_name 列;GET /v1/artifacts/:id 按存储类型服务(pdf→application/pdf、log→text/plain)、ETag+If-None-Match 304、Content-Disposition(inline/attachment)、单区间 Range 206/416;runner 上传 run log 带 media_type;单测 3 项;真实库原地迁移验证 |
| STORE-01 | 显式迁移版本 | 已实现 | schema_migrations 台账(每步 checksum=sha256(id+body)、applied_at、report_json)、事务化 up(失败 ROLLBACK)、幂等重开、checksum 篡改/版本超前 loud fail、schema_version=2 且仅全部成功后更新、database_id/created_at/last_migrated_at;0001 全量初始 DDL、0002 legacy v1 导入(principal 列、provenance 回填、artifacts 项目级重建+跨项目 ID 再生、jobs lease/snapshot+项目级幂等、manuscript→初始 TeX 工作区)、0003 terminal/tex/i18n 能力(早期 preview 库);真实 standalone 库原地 1→2 迁移验证(11 项目+TeX+terminal 数据保留);fixture tests/fixtures/databases/v1-kernel.db(3da1392 原版 v1 DDL)+ 可再生成脚本;单测 7 项;§3.1 列名级 DDL 对齐(如 brief_json/body_json/blob_objects/code_snapshots/runs 表)仍未实施,属 schema-parity 剩余项 |
| STORE-02 | CodeSnapshot durable model | 部分 | archive/manifest 是 Artifact，但没有 code_snapshots 权威表；snapshot_id 与可执行 artifact id 容易混淆 |
| EVENT-01 | 正确 DSH event assumption | 文档已修 | DSH SessionEventMap 实际可扩展；业务仍选择 Kernel Outbox 权威 |
| SKILL-01 | 所有 Skill 可安装发现 | 已实现 | 4 个 skill 包(research-core/两个 domain/venue)从包根 skills/ 挂载;clean tarball 安装后 4 个 SKILL.md 落盘且 name/description frontmatter 校验通过(packaging 测试);宿主内自动选择与 source/prepared hash 行为待 DSH fixture job(CI-01)验证 |
| PACK-01 | clean remote install | 已实现 | 根插件与 5 个子包 pnpm pack 全部可打;tarball 完整性断言(lib/、4×SKILL.md、cordis.patch.yml);声明 @deepseek-ai/dsh-* 为 optional peer(仓库 autoInstallPeers:false)+ prepare 构建步骤;clean consumer 用 overrides 解析全部 file: 依赖并安装成功,skills 落盘;发布到 registry 与宿主全量 boot 仍需 CI-01 fixture |
| SELFMOD-01 | dev-only Cordis self tools | 已实现 | verify-docs 静态否定检查:production cordis.patch.yml 与 research-web/research-headless 配置禁止 tool-cordis;start-selfmod-dev.sh 必须显式加载 dev overlay 而 start-dsh-agent-dev.sh 禁止;CI unit-and-build 自动执行;mount/unmount 运行时行为仍待 DSH fixture(CI-01) |
| SEC-UI-01 | standalone token/loopback | 已实现 | HTTP 验收 12 项全绿(tests/security/run-standalone-http-tests.sh):非 loopback+--no-token 拒绝且不监听、token 文件 0600/非 symlink/非空/与 --token 一致、token-check 401/200、/v1/* 无/bad/good bearer 401/401/200、跨源写 403、同源(127/8+同端口)放行、跨端口 loopback 403 |
| OPS-01 | standalone 启动可靠报错 | 已实现 | 验收 6 项全绿:自定义 host/port/dataDir/token 启动并以真实 URL+token-check 就绪、kill 后 web+kernel 端口释放、占用端口启动非零退出且日志含 EADDRINUSE、--no-token 非 loopback 拒绝 |
| CI-01 | clean DSH Agent fixture | 未达成 | 根 plugin 编译依赖 DSH host packages/cordis，目前仅开发机 symlink；CI 先阻断 standalone+docs，需新增可复现 DSH checkout/fixture job 后再启用 root build/full security unit |
| DOC-01 | Markdown 是生成权威 | 本轮建立 | 后续每个需求/修复必须同步规范、验收和本状态 |
| DOC-02 | change-aware docs sync | 已实现 | verify-docs --diff-check:对 base...HEAD 范围检查,packages/workers src 或 evals 变更必须同时更新 hardening-v0.2-status.md,否则 CI 失败;已接入 CI unit-and-build job |

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
- standalone auth、旧 `/research-*` 404、binary/SSE 仍缺自动化真实 HTTP contract test；本轮仅完成手工 smoke；
- standalone BFF 仍只有 `/v1` bearer/Origin，尚无 v2 Principal、Project AuthZ 和 CSRF token 注入；
- sidecar 的 port=0 没有 endpoint handshake；配置示例已撤掉 0 的可用承诺，但目标能力仍未实现；
- Agent/standalone sidecar 只凭端口 health 复用实例，没有核对 dataDir/database identity，存在跨实例误复用风险；
- Agent Kernel token 已从 argv/日志移到显式清理父级污染后的子进程环境，最终目标仍是 0600 token file 或匿名通道；
- research-ui `tsc` 不覆盖 browser client；已修两个可达 settings 作用域错误，但其余严格类型错误仍未清零；
- survey connector 与 Kernel 4xx/5xx 已改成稳定 code/通用消息，其他外部错误响应仍需自动化泄露扫描；
- UI package 已加发布 files allowlist，verifier 已禁止 source/ignored `host`，仍需 clean/升级工作树 pack 测试；
- 当前 hardening shell 脚本头部宣称的部分 case 没有真正执行对应断言；
- CI 已接入 standalone packages、standalone unit 和 docs verifier；根 plugin build/full DSH security unit 等待 clean host fixture，Docker/TeX/Golden 等 job 仍需在 GitHub 实跑后才能宣称通过；
- CI/评测 README 的历史通过数量需每次重新验证。

## 4. 新增需求的落地状态

### 实时终端

已写入 product、domain、HTTP、execution、UI、storage、security、acceptance 和 repository 规范。当前代码未实现，P0 顺序为 Schema/DB frames → Runner chunk callback → internal batch write → SSE/BFF → Terminal UI → recovery/security tests。

### TeX 编辑和编译结果

已定义 TexDocument、FileRevision、Snapshot、Build、Diagnostic、latex-compile Job、三栏 Workbench 和 PDF freshness。当前只有字符串 LaTeX 和 eval 脚本，需按 repository-blueprint.md 生成模块。

### i18n

已定义 zh/en、standalone locale adapter、资源完整性、fallback、Intl 和 UI 测试。当前没有 locale 模块，需先拆分巨型 client，再迁移全部 chrome；动态研究内容保持原文。

### 删除 DSH 浏览器嵌入模式

规范已改为 standalone-only UI。代码已删除根 `client-panel`、`/research-api` bridge、UI Cordis host/`/research-ui-api` bridge、两个 `dshClient` manifest 面与嵌入 patch。DSH 仍保留 Agent tools、commands、subagents、Skills、Session 和 dev-only Cordis selfmod。standalone server 是唯一浏览器入口。

### Cordis self-referential 开发模式

生产配置仍默认关闭。新增 configs/research-dev-selfmod.cordis.yml 后，开发者可在隔离 DSH_HOME 显式启用 cordis_inspect/mount/unmount。该 VM 不是安全边界，不进入 unattended 或生产。

### 文档内化与 subagent

docs/README.md 与 repository-blueprint.md 已把文档同步和积极 subagent 并行写为工程 DoD。

## 5. 推荐实现批次

1. P0 Governance：Principal/AuthZ/BFF、Decision migration、Evidence provenance；
2. P0 Execution observation：Terminal Schema/DB/Runner/SSE/UI；
3. P0 Manuscript：TeX workspace/save/compile/diagnostics/PDF；
4. P0 UI foundation：拆分 standalone client、实现 i18n/locale/theme adapter；
5. P1 Storage/API：显式 migrations、v2、media type、binary fix；
6. P1 Skills/package：runtime assets、domain/venue selection、clean install；
7. P1 Full validation：security/recovery/Golden/clean-room 与文档校准。

## 6. 状态更新规则

每个实现变更必须修改本文件对应行：未实现、部分、基本具备、已验收。只有 acceptance-tests.md 的阻断场景在当前提交和 CI 环境通过，才能标“已验收”。不得使用旧日期的手工计数代替证据。
