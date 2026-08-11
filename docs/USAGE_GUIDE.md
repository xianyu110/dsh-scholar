# DSH Scholar 使用指南

> 目标版本 2.3。浏览器 UI 仅支持 standalone，产品仍在开发中。本指南同时描述目标使用流程和当前限制；任何能力只有在 hardening-v0.2-status.md 标为“已验收”并绑定当前 CI 证据后才能用于正式科研。

## 1. 启动

~~~bash
bash scripts/start-standalone-ui.sh
~~~

访问 http://127.0.0.1:18610，输入启动脚本打印的 Token。DSH Web 不再注入 Scholar 页面。打开页面后可以在 Settings → Language 选择中文或 English。没有手动选择时，系统先读 dsh.locale，再匹配浏览器语言，最后使用中文。切换语言不会翻译项目名、论文、命令输出和 TeX 原始错误。

## 2. 首次进入：Init、Resume 或 Upload

未选择项目时页面显示三张启动卡（不会自动选中某个项目）：

- **新建研究（Init）**：填写项目名、研究问题和主指标，确认默认 gate-only/Local Docker 策略后创建 DRAFT + Scope Gate；
- **打开已有项目（Resume）**：Start 屏下方列出此内核上的项目，搜索名称或输入完整 project id 后显式选择；根据 status、pending Gate 和 NextAction 回到上次页面；
- **上传 / 接入（Upload）**：打开真实导入向导（ONBOARD-01）——选择目标项目（或新建）、来源标签与目标阶段（brief/survey/idea/baseline/contract/experiment/evidence/writing/review/release，问题清单按阶段裁剪）→ 上传文件（单文件 ≤32MiB，multipart；已 staged 文件可继续/重传——sha256 幂等，或删除后重传）→ 静态安全扫描（clean/quarantined/rejected 与拒因）→ Grill Me 回答必答问题（答案持久化为 human_assertion）→ 生成阶段提案（plan/risks/pre-accept 清单/置信度）→ PI 采用（AdoptionReceipt）或拒绝。每步从服务端投影恢复：刷新或重开页面后向导回到同一会话同一阶段；Overview 面板的 intake_* NextAction 卡可直接继续接入会话。

Upload 可以创建新项目或选择有权限的现有项目。采用前材料只在 Intake quarantine 中；确认 proposal 后也不会声称历史 Gate 已批准、日志是本平台 TerminalLog、结果是 accepted Evidence。冲突必须选择保留当前、采用上传或重命名。服务端已实现:ONBOARD-01 Intake 全链(begin→stage→scan→grill→propose→adopt/reject,pre-accept 零权威写、静态扫描/quarantine、确定性 taxonomy、单事务 Adoption、7 天过期/24h GC);浏览器向导 UI 已接线(2026-08-11,视觉验收未完成——浏览器拖拽/真实上传交互与断点续接观感待人工环境,记 NOT_RUN_MANUAL_PENDING);分块 offset/hash 恢复上传(服务端整文件 staged ≤32MiB,UI 如实不做分块)仍属后续阶段;**研究包 archive 解包扫描与 TeX/CodeSnapshot 采用物化已实现(commit 待定主代理统一提交,详见 research-onboarding.md §4.2/§6.1 注记)——scan 生成展开视图(scan_summary.extracted_entries/extracted_bytes),adopt 后 TeX→项目 TeX document、代码→code workspace+可选 CodeSnapshot,receipt.import_mappings 报告 materialized|gap**。**Agent tool 面已实现(commit 待定主代理统一提交)**——DSH Agent 可经 `research_intake_begin`/`research_intake_stage`(base64 ≤32 MiB)/`research_intake_scan`/`research_intake_answers`/`research_intake_propose` 准备接入(prepare-only,researcher/scholar 角色,错误码稳定文案),但**无 adopt 工具**:research-onboarding.md §2 Agent 无 accept,采用(adopt)只能由 PI 在浏览器/BFF 面完成;v2/BFF accept 面与浏览器向导视觉验收仍属后续(NOT_RUN_MANUAL_PENDING)。不能用普通 Artifact/TeX 上传模拟安全接入。

## 3. 创建项目与 Scope Gate

在 Chat 使用：

~~~text
/research new shift-localization {"problem":"Does uncertainty weighting improve temporal localization?","scope":"public datasets only","primary_metrics":["mAP@0.5"]}
~~~

或点击 New Project。系统创建 DRAFT 项目和 Scope Gate。到 Approvals 检查 target、范围和预算后批准或拒绝。Human UI 不要求填写 actor，身份来自当前登录会话。

## 4. 调研与 Idea

~~~text
/research survey "temporal action localization under domain shift"
/research ideas
~~~

Overview 展示 Corpus、候选 Idea、最近邻、exact delta、falsification 和 MVE。调研来源失败会明确显示，不能把部分失败伪装为完整覆盖。选择 Idea 后在 Approvals 决定 Idea Gate。

## 5. Baseline 与 Contract

先登记代码和数据快照，再提交 Baseline。正式 Job 必须来自 CAS 内容、固定镜像和容器；空命令或 message-only 不能成功。

~~~text
/research reproduce {"repo":"...","commit":"...","expected_metrics":{"mAP@0.5":58.4}}
/research contract {"idea_id":"...","dataset_id":"...","baseline":"...","treatment":"...","primary_metric":"mAP@0.5","seeds":[11,23,47,89,101]}
~~~

PI 在 Contract Gate 检查 Metric direction、Seed、数据 hash、镜像、预算和 AnalysisPlan。批准后合同版本冻结。

## 6. 运行实验与查看终端

> 服务端/SSE 层已完成:Terminal SSE、seq/gap/reconnect、stdout/stderr 分通道与筛选、安全 ANSI 文本渲染、lease fencing 与 job_log_read AuthZ、cancelled/timed_out/exit 权威终态、最终 log Artifact 与截断记账(tests/unit/terminal.test.ts、tests/security/run-terminal-tests.sh)。仍缺(浏览器层,Playwright 类环境不可用,未验收):严格的有界 DOM 渲染、完整日志 Artifact 下载(当前“Download log”只导出浏览器保留窗口,不等同于完整日志 Artifact;长日志和取消/超时结果必须回到 Runs/Artifact 核对)。

~~~text
/research run formal {"contract_id":"...","code_snapshot_id":"..."}
~~~

Runs 显示 queued、running、retryable、succeeded、failed、cancelled。选择一个 Run，点击 Open Terminal 或进入 Terminal Tab：

- All 保持 stdout/stderr 的实际交错顺序；
- stdout/stderr 可单独筛选；
- live 表示正在接收 Runner 输出；
- reconnecting 会自动从最后 seq 续传；
- gap/truncated 表示部分热日志已淘汰，完整或截断日志仍可下载；
- exit code、signal、timeout 和 cancelled 是不同终态；
- Cancel 只有在实际容器停止确认后才显示完成。

终端内容是原始执行数据，不随页面语言翻译。

当前“Download log”只导出浏览器保留窗口，不等同于完整日志 Artifact；长日志和取消/超时结果必须回到 Runs/Artifact 核对。正式使用前必须等待 TERM-01 标为“已验收”。

### 6.1 Interactive Terminal 与 Workspace

目标 UI 的 Workspace 像 VS Code：Explorer 打开 code/manuscript/scratch 文件，使用标签、搜索、Problems、查看图片/PDF/JSON、编辑文本、上传/移动/删除/历史并冻结 Snapshot。并发冲突会显示 base/current/local，不自动覆盖。**Workspace tree client 逻辑层已实现(2026-08-11,commit 待定主代理统一提交)**：More →「工作区」面板(#tab=workspace 深链)——workspace 选择器与工具栏(新建文件/新建目录/上传(≤32 MiB multipart)/刷新/路径搜索框);左侧文件树按目录懒展开(implied 目录由文件路径投影、客户端创建的空目录为虚拟节点、文件行 hover 移动/删除);右侧多标签编辑区——每个 tab 持有 path/version/etag/content/savedContent,dirty 语义与 Manuscript 一致(清空读未保存、恢复已保存读干净),保存带 expected_version/etag CAS(409 冲突 → 横幅提示"重新加载",绝不静默覆盖),二进制节点只读显示 meta + 下载(原始字节 + media type),历史版本列表可回退(旧字节以当前 version/etag 守卫写回);树按 listSince 每 5s 轮询增量刷新(离开该 tab 自动停止,SSE 记后续)。路径搜索为客户端过滤 + 服务端 prefix/glob PATH 搜索;**服务端内容搜索已实现(commit 待定主代理统一提交)**——POST search `{q, mode:'content'}` 线性文本扫描(文本节点/二进制跳过/每文件 20 匹配/50 文件上限/512 KiB 跳过/大小写可选/非法 UTF-8 容错,无全文索引,大数据集性能受限如实注明;客户端搜索框接入内容模式属后续轮)。剩余(浏览器层,Playwright 类环境不可用,记 NOT_RUN_MANUAL_PENDING):文件树渲染/拖拽上传/多标签视觉/窄屏/键盘 a11y 验收;Problems 面板与集成 PTY 入口。

点击 Workspace Terminal 打开独立 PTY，选择受控 Runner profile、根相对 cwd 和 shell preset 后可以输入命令、使用 TUI、resize、发送 INT/TERM/KILL、detach/reconnect/close。PTY 不是正式 Run，输出不能成为 Evidence。服务端已实现:真实 PTY 会话(LocalPtyAdapter,preset 白名单、env 白名单、detach 不杀进程、idle TTL、client_seq 幂等、输出永不进入 Metrics/Evidence/Gate)与通用 Workspace 磁盘 adapter(节点读写/移动/删除/二进制 asset/历史回退/watch/路径搜索+内容搜索,tex-facade 同一契约)。**PTY TUI client 逻辑层已实现(2026-08-11,commit 待定主代理统一提交)**：More →「PTY 终端」面板(#tab=pty 深链)——open 表单(workspace 选择/preset/相对 cwd/cols/rows + 钉定 profile/target)、会话工具栏(resize、INT/TERM/KILL、detach/reconnect、close)、纯文本输出区(gap/retention 截断标记、exit 行)、状态行(会话状态/in-out seq/掩码 lease+过期/generation/字节数)、idle TTL/lease 过期/权限撤销关闭提示与 lease 失效(403)重新打开提示;client_seq 单调幂等、失败重试重发同 seq、断线重连按 after_seq 重放。剩余(浏览器层,Playwright 类环境不可用,记 NOT_RUN_MANUAL_PENDING):真实终端渲染(ANSI/xterm 类)、键盘输入、resize 拖拽、完整日志下载与窄屏/断线观感;SSE 实时流替代轮询(后续轮)。

### 6.2 本机与远端执行

Settings → Execution 选择已经登记的 Local Docker 或 Remote Runner profile。页面只显示 target label、capability、health、resources 和 policy；不输入 SSH credential/hostname/任意命令。远端离线时任务明确失败或等待，不会静默改在本机/subprocess 运行。服务端已实现:RUN-REMOTE-01 wire 协议、RemoteFleetServer(注册/心跳/claim/CAS/frames/artifacts/complete,含 service-token 传输等价实现)与 RemoteRunnerAgentImpl(验签、CAS hash 复算、有界 spool、fail-closed);真实 mTLS 证书链与真实远端 sandbox 验收、跨主机网络分区故障注入、Remote PTY 与浏览器 UI 仍属后续阶段。

runner CLI（`node workers/runner-gateway/lib/bin/runner.js`）已接线三个互斥角色（FLEET-01，用法与互斥规则见 remote-runner-wire.md §9）：默认 `--kernel` 本地 claim 循环（既有行为不变）；`--fleet-server <port>` 启动 Fleet 服务端（`--kernel` 指向 job 来源，plan 签名公钥打印到 stderr 供 agent 配置）；`--agent <fleet-url>` 启动远端代理端（`--fleet-public-key` 验签 plan——缺省任何 plan 拒绝执行；`--key-file` 签名 manifest，显式 `--kernel` 时尽力注册公钥）。`--fleet-server` 与 `--agent` 互斥、fleet 角色与 `--mode` 互斥；本地 wire 用 `--service-token` 鉴权（生产必须 mTLS，见 remote-runner-wire.md §3/§9）。

## 7. Evidence 与 Claim

普通用户或 Agent 可以创建 draft note，但不能创建 accepted Evidence。Analysis Worker 根据合同、匹配 Seed 和 metrics file 生成 Evidence；Evidence 页面显示 provenance、effect、CI、n 和方向。

缺字段、样本不足、CI 跨无效区间或只使用 draft/legacy Evidence 时 Claim 是 inconclusive。contradicted 和 negative result 会保留在稿件限制与结果中。

## 8. TeX Manuscript Workbench

> 当前已有 TeX 文件树、textarea 编辑、expected_version 保存、构建轮询、诊断列表和 PDF embed。dirty 判断已修复（以文件 GET/最近保存内容为基线，清空非空文件会正确显示未保存）；编译冻结可物化字节（快照按 revision 保存文件内容，Runner 编译输入不会被编译期间的编辑改变）；保存冲突（409）会立即终止编译且不创建 Job；构建卡片显示输入 revision 与 stale 标识，可跳转到同一 Job 的实时 Terminal。**打开/ensure 只读或首次创建（P0-3，2026-08-11 修复）**：进入 Manuscript 页先 GET（只读），工作区不存在才 POST 首次生成；render、轮询、locale 切换、保存后 rerender 都不会改写 `paper.tex`/`main.bib` 或推进 revision；显式“♻ 重新生成”按钮需确认，重写前把当前内容冻结为历史 revision（可回退）。**保存触发实时预览（P0-3）**：保存成功后自动调用 preview-builds hook（服务端 debounce），右侧“实时预览”区展示 pending/queued/running/succeeded/failed/cancelled/superseded 状态、stale 标识与最新预览 PDF。仍缺（UI 浏览器层，Playwright 类环境不可用、未验收，记 NOT_RUN_MANUAL_PENDING）：Manuscript 页内嵌实时 Build Terminal DOM、预览链与 regenerate 对话框的浏览器视觉验收、完整 history/move/assets。以下步骤描述目标 v2，TEX-01/TEX-02 未“已验收”前不得把编辑或编译结果当成正式稿件证据。

### 8.1 生成稿件

~~~text
/research write
~~~

系统从 Brief、Corpus、approved Contract、accepted Evidence、Claim、图表和 Venue Template 创建 TexDocument，而不是只返回一个字符串。

### 8.2 编辑

进入 Manuscript：

1. 文件树选择 paper.tex、references.bib 或 figures；
2. 编辑器显示行号和脏状态；
3. Ctrl/Cmd+S 保存；
4. 如果其他页面已修改同一文件，会出现 version conflict，选择 Reload、Copy local 或 Merge，系统不会静默覆盖；
5. History 可查看过去 revision。

### 8.3 编译与实时预览

保存成功后 UI 自动调用一次 `POST /v1/documents/{id}/preview-builds`（服务端 debounce，默认 800ms，快速连续保存合并为一次 preview）；右侧“实时预览”区轮询 `GET preview-builds` 投影，展示 pending/queued/running/succeeded/failed/cancelled/superseded 状态文本、stale 标识（预览 revision 落后于当前文档）与最新成功预览的 PDF embed/下载。点击 Compile 会先保存全部脏文件，冻结 manifest，再创建权威 latex-compile Job（创建即 supersede 全部非终态 preview；preview 不产 Evidence、不参与权威 manifest 链）。保存失败或 409 时不触发 preview/compile（冲突分支直接返回，不会创建构建 Job）。

Diagnostics 将错误整理为 file:line；点击可跳到编辑器。TeX 原始消息保持原文，按钮与诊断类别按页面 locale 翻译。成功后 Preview 显示 PDF。继续编辑源文件时旧 PDF 标记 Stale，直到下一次成功编译。

可以下载 PDF、完整 compile log、sources 和 aux Artifact。HTML 不作为稿件预览。预览/编译状态与 PDF 的同页视觉链（浏览器验收）未执行，记 NOT_RUN_MANUAL_PENDING。

## 9. Trajectory 与 Subagent 拓扑

Overview 的 Research Trajectory 显示权威 Gate/Job/Evidence/Manuscript 事件；Session Trajectory 显示 Agent 的消息和工具过程，后者不是科研事实。打开 Agent Topology 可展开 parent→child、查看 role/mode/running、时长、token/cost 和失败，点击 child 进入其安全 history，并用 breadcrumb 返回。

one-shot child 只读；continuable child 只有 parent 在线且有权限才出现续问框。读取历史不会唤醒 Agent，原始 prompt、工具参数/结果、环境和 secret 默认不展示。服务端已实现:TRAJ-01/SUBAGENT-01 投影与拓扑 API 层(Outbox 只读投影、redaction、10k 事件分页、exact direct-child、breadcrumb、只读 history、followup 记录 message_id 不冒充执行)。**UI 逻辑层已实现（commit 待定主代理统一提交）**：More 导航新增「轨迹」（Trajectory，`#tab=trajectory`）与「拓扑」（Topology，`#tab=topology`）两个面板——轨迹面板双泳道渲染 Research（权威）与 Session（观察）事件，每条泳道可「加载更多」分页（服务端 keyset 游标），条目显示 event_seq/时间/脱敏摘要，点击可展开 allowlisted 详情（聚合引用/来源/会话/状态/条目 ID，原始负载永不展示）；拓扑面板展示项目子代理直系树（点击节点懒加载其直接子项），「进入 child 详情」后顶部 breadcrumb 可逐级返回 parent，详情含状态/模式/类型与只读历史列表，底部为 one-shot 只读 follow-up 输入框（提交后仅返回 message_id，不激活 child）。剩余（浏览器视觉验收，Playwright 类环境不可用，记 NOT_RUN_MANUAL_PENDING）：双 lane 滚动/虚拟化（10k 节点 DOM 有界）、树展开/键盘/ARIA、follow-up 交互观感与 SSE 实时流。

## 10. Review 与 Release

> Review/Bundle:REL-01 已关闭(commit 040e796)——build-bundle.sh 生成自包含 Bundle(manifest runtime 段 + TeX workspace 导出),reproduce.sh 在全新空目录以全新 DB/CAS 重放,拒绝指向原 checkout 的 runtime(bundle-only clean-room),并逐字段比较 manifest/metrics/analysis/RunManifest/TeX 输入与 PDF 结构;tests/security/run-release-bundle-tests.sh 已接入聚合器。尚未绑定 CI job 报告前仍不得据此声明正式可复现性。

~~~text
/research review
/research export
/research release
~~~

Review 检查数字、Claim 状态、引用定位、Artifact hash、TeX 编译、负结果、许可和 AI usage。Export 生成私有自包含 Bundle；clean-room 重跑实验、分析和 PDF。release 只创建 Human Release Gate，不自动上传外部平台。

## 11. Budget、Settings 与下一步

Budget 页面显示模型、API、GPU、存储和并发。超过硬上限时项目进入 BLOCKED_GATE，正在运行的策略按 Job contract 安全停止或完成；只有 Human Budget Gate 可恢复到 payload 允许的状态。

Overview 顶部以结构化卡片（GUIDE-01 `next_actions_v2`）展示下一步：每张卡含 code 徽标、三态标记（ready 可执行 / blocked 受阻 / done 已完成——done 灰显、blocked 因缺失前置条件而禁用、ready 高亮）、原因、需要 Human/Agent/Runner、缺失前置条件列表（点击受阻卡展开）、阻断说明和跳转目标页面的按钮（gates/runs/evidence/manuscript/budget 直达，ideas/contracts/release 收敛到总览）。标签优先按字典翻译，未登记 code 原样显示内核 label；未知状态动作（code='unknown'）只读，不提供猜测的执行按钮。旧内核的 `next_actions: string[]` 仍以列表形式兼容显示。

所有配置集中在 Settings，默认折叠 Essentials、Execution、Workspace、Terminal、LaTeX、Agent/Trajectory、Security & Secrets、Diagnostics。每项显示 effective value、来源 scope/revision/hash、默认/修改和热更新/重启；Secret 只显示引用。修改只影响新 Job/PTY/Build。服务端已实现:canonical Config Registry(CONFIG-01,单一注册表 + parseCli 四二进制接入 + security floor + effective pin/redacted 视图 + 生成物 configs/generated/)与 kernel/standalone 的 x-config-pin 响应头、/v1/config/effective、/v1/config/schema。**Settings UI 已由 /v1/config/schema + /v1/config/effective 动态生成(2026-08-11,只读视图)**:每个 ConfigScope 一组折叠面板(global/project/job 保留/runner-profile/orchestrator/kernel/standalone,覆盖注册表全部键),每字段显示 effective 当前值(secret 只显示"已设置,不显示明文"掩码,明文永不回显)、scope、声明来源、安全基线标记、env 别名、schema 描述与默认;config pin 显示并在变化时提示;热生效/需重启按声明来源推断(注册表尚无 hot_reload 标记——含 http/ui 来源的键"保存后即时生效",仅 cli/env/file 的键"需重启生效",规则见 docs/config-registry.md §6);本版本无配置写接口(kernel 仅提供读取面),提交按钮禁用并注明"当前配置只读,经 CLI/env 提供"——修改配置请用各二进制 CLI flag 或 DSH_* env。/bff/research/config/* 写面、job scope 键与 SecretRef 存储层仍属后续阶段(本地校验与错误回显映射机制已就绪)。

## 12. 常见问题

| 现象 | 说明 |
|---|---|
| container_execution_required | 正式 Job 不能使用 subprocess |
| code_snapshot_required | 先创建真实内容快照 |
| revision_conflict | 项目已被其他动作修改，刷新后重试 |
| document_version_conflict | TeX 文件有并发版本，显式合并 |
| Terminal gap/truncated | 热日志有保留上限；下载最终 log 查看可用内容 |
| Claim inconclusive | Evidence 未 accepted 或缺统计字段 |
| PDF stale | 源文件 revision 晚于 build input，重新 Compile |
| Kernel unreachable | 检查 instance health、dataDir、port 和 sidecar ownership |
| 直接访问 kernel 端口 401 | sidecar 启动的 Kernel（默认 127.0.0.1:17413）受 0600 `<dataDir>/kernel-token` 随机 bearer 保护（env 注入、不出 argv）；除 `/v1|v2/health` 外缺失/错误 token 一律 401。浏览器/BFF 无需关心——BFF 自动带上该 token；仅脚本或 orchestrator 直接访问时需要（`--token` / `--token-file` / `DSH_SCHOLAR_KERNEL_TOKEN`）。`x-service-token` 是内部路由专用层，不能替代普通 bearer |
| 页面部分未翻译 | 缺失 key 会显示 key；这是缺陷，应按 docs 规则补资源和测试 |
| intake/proposal stale | 上传接入期间项目或提案已变化，刷新并重新生成 Proposal |
| target offline | 远端 Runner 不可用；等待/修复或显式创建新 attempt，不会自动本地降级 |
| subagent read-only | one-shot、parent offline 或无 follow-up capability，只能查看 |

## 13. 开发者临时 self-mod

仅调试 DSH/Cordis 运行时行为时，按 test-instance-plan.md 创建隔离 DSH_HOME，并显式加载 research-dev-selfmod overlay。可使用 cordis_inspect、cordis_mount、cordis_unmount；动态插件不持久，不能用于 Gate、正式 Run、Evidence 或发布。需要保留的行为必须转成源码、测试和 Markdown。
