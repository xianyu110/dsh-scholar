# DSH Scholar 使用指南

> 目标版本 2.5。浏览器 UI 仅支持 standalone，产品仍在开发中。本指南同时描述目标使用流程和当前限制；任何能力只有在 hardening-v0.2-status.md 标为“已验收”并绑定当前 CI 证据后才能用于正式科研。

## 1. 启动

~~~bash
bash scripts/start-standalone-ui.sh
~~~

访问 http://127.0.0.1:18610，输入启动脚本打印的 Token。DSH Web 不再注入 Scholar 页面。打开页面后可以在 Settings → Language 选择中文或 English。没有手动选择时，系统先读 dsh.locale，再匹配浏览器语言，最后使用中文。切换语言不会翻译项目名、论文、命令输出和 TeX 原始错误。

### 1.1 把页面停靠在右侧或底部

选择项目后，Chat、Overview、Approvals、Runs、Artifacts、Evidence、Budget、Manuscript、Run Terminal、Trajectory、Topology、Workspace 和 Interactive Terminal 等每个当前页面标题区都有“停靠到右侧”和“停靠到底部”。Dock 顶部的页面选择器可以直接换页，“打开到主区”把当前 Dock 页面恢复为全页，“关闭”只关闭 Dock，不关闭项目。

同一页面只会存在一个活实例：把正在主区显示的 Chat/Terminal/Workspace/Manuscript 放入 Dock 时，主区自动切换到其他安全页面；从 Dock 打开到主区时也不会复制第二份实例。右侧和底部之间切换的是同一个已挂载页面，因此草稿、选中文件、滚动位置和实时连接应保持。主区与 Dock 之间移动流式页面时，会从最后消费的序号安全重连。

拖动主区与 Dock 之间的分隔条可调整尺寸；聚焦分隔条后可用方向键微调、Home/End 跳到最小/最大。小于 720 px 时，右侧首选位置会临时显示在底部；回到宽屏后恢复右侧。打开页面、首选位置和两种尺寸只保存在当前浏览器，是展示偏好，不是项目配置或 Kernel config pin，也不会跨设备同步。

实验环境在 Settings → 实验环境（Experiment environments）中配置，分为本机进程、本机 Docker 和远程 SSH。正式实验应使用本机 Docker 或满足同一容器/快照合同的远程机器；本机进程只面向明确受信的开发/冒烟任务。项目、实验和复现只选择 Target/Profile 名称与 ID；SSH 私钥、known-host 和真实 endpoint 只由服务端 SecretRef 管理。远程机器离线、能力不匹配或 host key 校验失败时任务会阻断/重试，不会自动改成本机执行。当前代码已实现持久 Target Registry、revision CAS、PI/Operator 写权限、Settings 中英写面、Job/ExecutionPlan target revision/hash pin、target-aware claim，以及受控 SSH → RemoteRunnerAgent 引导；真实 Docker/SSH 主机、host-key 轮换、网络分区和生产 mTLS 仍为人工验收项，未验收前不得用于正式科研。

## 2. 首次进入：Init、Resume 或 Upload

未选择项目时页面显示三张启动卡（不会自动选中某个项目）：

- **新建研究（Init）**：只填写项目名，创建 `DRAFT/brief_status=collecting` 空壳并进入项目 Chat；Grill Me 每次只问一个问题，答完后预览 Brief，PI 确认才创建 Scope Gate；
- **打开已有项目（Resume）**：Start 屏下方列出此内核上的项目，搜索名称或输入完整 project id 后显式选择（不会自动选中某个项目）；选中后进入项目总览（当前不按 status/pending Gate/NextAction 自动跳转页面，tab 恢复只恢复上次使用的面板）；
- **上传 / 接入（Upload）**：选择目标项目与阶段，批量加入材料；独立页面默认按 8 MiB 分块，可暂停/刷新/恢复，每个文件显示 hash/scan/OCR 状态，单 Intake 默认总量 2 GiB（管理员最多配置到 10 GiB）。静态扫描与 Grill 后生成 proposal，PI 采用或拒绝；刷新后从服务端投影继续。

Upload 可以创建新项目或选择有权限的现有项目。采用前材料只在 Intake quarantine 中；确认 proposal 后也不会声称历史 Gate 已批准、日志是本平台 TerminalLog、结果是 accepted Evidence。冲突必须选择保留当前、采用上传或重命名。服务端已实现:ONBOARD-01 Intake 全链(begin→stage→scan→grill→propose→adopt/reject,pre-accept 零权威写、静态扫描/quarantine、确定性 taxonomy、单事务 Adoption、7 天过期/24h GC);浏览器向导 UI 已接线(2026-08-11,视觉验收未完成——浏览器拖拽/真实上传交互与断点续接观感待人工环境,记 NOT_RUN_MANUAL_PENDING);**批量分块上传已实现(2026-08-12,CHUNK-01)**——每文件独立队列状态(hashing/queued/uploading/paused/scanning/needs-input/ready/quarantined/failed),默认 8 MiB chunk、单 Intake 默认 2 GiB(管理员可配置,硬上限 10 GiB);断线/刷新从服务端 committed offset 续传,相同 chunk 幂等重放,错误 hash/gap/overlap 稳定 409/422;finalize 由服务端流式重算整体 size/SHA-256,不一致不产生 IntakeArtifact;扫描前字节只在隔离 staging,不进项目 Artifact;**研究包 archive 解包扫描与 TeX/CodeSnapshot 采用物化已实现(commit 98243ff,详见 research-onboarding.md §4.2/§6.1 注记)——scan 生成展开视图(scan_summary.extracted_entries/extracted_bytes),adopt 后 TeX→项目 TeX document、代码→code workspace+可选 CodeSnapshot,receipt.import_mappings 报告 materialized|gap**。**Agent tool 面已实现(commit 98243ff)**——DSH Agent 可经 `research_intake_begin`/`research_intake_stage`(base64 ≤32 MiB)/`research_intake_scan`/`research_intake_answers`/`research_intake_propose` 准备接入(prepare-only,researcher/scholar 角色,错误码稳定文案),但**无 adopt 工具**:research-onboarding.md §2 Agent 无 accept,采用(adopt)只能由 PI 在浏览器/BFF 面完成;v2/BFF accept 面与浏览器向导视觉验收仍属后续(NOT_RUN_MANUAL_PENDING)。不能用普通 Artifact/TeX 上传模拟安全接入。

## 3. 创建项目与 Scope Gate

点击 New Project，只输入项目名。系统进入 Chat，逐题询问研究问题、范围、指标、输出、约束和已有材料；你可以回答、编辑、跳过或标记 unknown。确认 Brief 预览后才出现 Scope Gate。

**创建后自动进入 Chat 引导（2026-08-12 已实现）**：创建成功即跳转到 Chat 页面，输入框上方显示引导卡「完善研究 Brief」，按固定 7 题顺序逐题作答（提交 / 跳过 / 标记未知），答完后卡片出现 Brief 预览与「确认 Brief」按钮（等价于 `/confirm-brief`）；项目确认后引导卡消失，Chat 顶部出现一次「项目已就绪」提示。刷新页面后引导卡从服务端投影继续（不依赖 localStorage）。

Chat 对话属于当前项目。切换项目时，会话列表、当前会话、消息、草稿、引用回复和附件也随项目切换；返回原项目才恢复原对话。项目 A 中仍在执行的命令或上传即使晚于切换完成，也只能回写 A，不能出现在项目 B。当前修复状态以 hardening 的 `CHAT-SCOPE-01` 为准。

Chat 同时支持普通自然语言和一级 slash command。直接输入“现在进展怎么样”“看看审批”“有哪些想法”“查看运行任务”会按当前项目投影路由到对应只读操作；明确输入“调研 <主题>”可路由到 survey。显式 `/status`、`/gates`、`/ideas`、`/jobs`、`/survey ...` 仍是完全确定性的高级入口。Init Grill 尚有当前问题时，普通文本仍回答该问题；Brief confirmed 后才作为自由对话处理。系统会在回答后给出当前阶段的一项下一步建议，但不会自动替你批准 Gate、确认 Brief、adopt 导入或决定发布。未知或参数不足时只给候选，不执行副作用。

在 DSH 的 `dsh Scholar` 页签内，当 Scholar 使用与 Host 不同 origin 的 loopback standalone 时，开放问题会使用 Harness 当前可用的模型回答；模型不持有 Scholar 工具，也不能直接执行命令。它生成的非 Human-only 一级 slash command 会以“使用命令”按钮出现，点击后只填入输入框，你可以修改并再次发送。状态查询等确定性只读意图可以自动调用对应 canonical command；当前仅权威投影 ready 的 `survey_run` 可自动触发 Agent write，其他 write 只预填，人工审批及 blocked/歧义动作始终只解释和引导。独立新页面、远程 HTTPS 工作台或 Host 模型暂不可用时会退回基于当前阶段的确定性回答，核心 slash command 仍可正常使用。

对话在底部时会随新消息保持到底部；向上查看历史后，刷新和新消息不会把内容拉回顶部或强制到底部，使用“跳到最新”恢复跟随。项目、Chat session、主区与 Dock 分别保存自己的查看位置。

Chat 使用直接一级 slash command；不要添加聚合前缀：

~~~text
/new shift-localization
~~~

随后直接在 Chat 回答每个问题；Brief 完整后由 PI 输入 `/confirm-brief`。Scope Gate 创建后到 Approvals 检查 target、范围和预算。Human UI 不要求填写 actor，身份来自当前登录会话。

Chat 输入框支持附件按钮、拖拽和粘贴。一次可以给出多篇论文、代码、数据、图片或历史结果；附件先进入当前 active Intake 的分块上传、静态扫描与 OCR 队列，Chat 只保存引用。scan/OCR 和 Human adoption 完成前，它们不是 Project Artifact、Run、TerminalLog 或 accepted Evidence。

## 4. 调研与 Idea

~~~text
/survey "temporal action localization under domain shift"
/ideas
~~~

Scope 审批后，Overview 的 `survey_run` 主 CTA 会打开当前项目 Chat，并从 Brief problem 预填 `/survey ...`；检查或修改 query 后按 Enter 才开始外部检索。它不是 Runner Job，因此不会把你带到空的 Runs 列表。成功后 Corpus Snapshot 与项目进入 SURVEYING 一起提交，刷新后的主 CTA 变为 `idea_generate`。

SURVEYING 是阶段码，不是“当前有调研任务正在跑”。在快照已冻结且下一步为 `idea_generate` 时，中文页面显示“调研已就绪”；Runs 仍可以是 0，因为这里只记录实验 Job/Run。此时 Runs 空态会说明“调研已完成，尚未创建实验运行”，点击“前往总览”回到权威 NextAction。页面不会为了填充 Runs 而伪造调研任务。

Overview 展示阶段流水线、Brief（问题与主指标）、NextAction 卡、候选 Idea（点击/双击/右键打开详情弹窗，内含 hypothesis、exact delta、falsification、MVE、novelty audit 与评分）、最近 Contract、预算摘要和审计历史（默认最近 10 条，可展开全部）。Corpus 目前只在项目详情弹窗与 Budget 面板以快照计数展示，最近邻（nearest_prior_works）尚未在 UI 展示。调研来源失败在 connector 层以 `source_status` 记录（api-contracts），不会把部分失败伪装成完整覆盖；当前聊天输出只汇总成功去重后的数量，不逐来源列出失败。选择 Idea 后在 Approvals 决定 Idea Gate。

## 5. Baseline 与 Contract

先登记代码和数据快照，再提交 Baseline。正式 Job 必须来自 CAS 内容、固定镜像和容器；空命令或 message-only 不能成功。

~~~text
/reproduce 10.48550/arXiv.2401.12345
/reproduce arXiv:2401.12345 {"code_snapshot_id":"...","claims":[{"claim_ref":"primary"}],"runner_profile_id":"profile_local_docker_cpu_v1","target_id":"...","metric_comparators":[{"metric_id":"m1","name":"mAP@0.5","expected":58.4,"unit":"%","tolerance":{"absolute":0.5,"relative":0.01}}]}
/reproduce sha256:abcd...   (已扫描 PDF Artifact id)
/contract {"idea_id":"...","dataset_id":"...","baseline":"...","treatment":"...","primary_metric":"mAP@0.5","seeds":[11,23,47,89,101]}
~~~

`/reproduce <doi|arxiv|paper-artifact-id>` 创建或恢复持久化 `PaperReproductionSpec`（spec_id + NextAction），打开 Chat 驱动的复现向导：解析论文标识/上传 PDF → 关联官方或用户上传代码（Git 来源必须固定 exact commit；最终物化为不可变 CodeSnapshot）→ 固定数据（Artifact/hash；无字节时 acquisition recipe + expected hash，clean-room 无法满足即 blocked，不静默跳过）与环境（digest-pinned image、runner profile/target、hash）→ 提取待复现声明 → Human 确认复现计划/合同 → 在选定 Runner 执行 attempt → 比较论文声明目标（先）与 clean-room vs 原正式 Run（单独比较组，两种比较绝不合并为一个 tolerance）→ 生成不可变 ReproducibilityReport（JSON+CAS）。进程 exit 0 只表示执行完成；只有持久化 Report 的所有 required checks pass，`baseline_reproduce` 才能判 done——out-of-tolerance 是 fail/inconclusive，不伪装 code_error。PI 在 Contract Gate 检查 Metric direction、Seed、数据 hash、镜像、预算和 AnalysisPlan。批准后合同版本冻结。

## 6. 运行实验与查看终端

> 服务端/SSE 层已完成:Terminal SSE、seq/gap/reconnect、stdout/stderr 分通道与筛选、安全 ANSI 文本渲染、lease fencing 与 job_log_read AuthZ、cancelled/timed_out/exit 权威终态、最终 log Artifact 与截断记账(tests/unit/terminal.test.ts、tests/security/run-terminal-tests.sh)。仍缺(浏览器层,Playwright 类环境不可用,未验收):严格的有界 DOM 渲染、完整日志 Artifact 下载(当前“Download log”只导出浏览器保留窗口,不等同于完整日志 Artifact;长日志和取消/超时结果必须回到 Runs/Artifact 核对)。

~~~text
/run formal {"contract_id":"...","code_snapshot_id":"...","runner_profile_id":"...","target_id":"..."}
~~~

Runs 显示 queued、running、retryable、succeeded、failed、cancelled。选择一个 Run，点击 Open Terminal 或进入 Terminal Tab：

- All 保持 stdout/stderr 的实际交错顺序；
- stdout/stderr 可单独筛选；
- live 表示正在接收 Runner 输出；
- reconnecting 会自动从最后 seq 续传；
- gap/truncated 表示部分热日志已淘汰，完整或截断日志仍可下载；
- exit code、signal、timeout 和 cancelled 是不同终态；
- Cancel 只有在实际容器停止确认后才显示完成。

页面默认每 8 秒刷新项目投影。聚焦 Chat、搜索框、Workspace/TeX 编辑器或 Interactive Terminal 时，背景刷新不会抢走焦点；编辑控件的刷新会延迟到离开焦点，必要重绘则恢复光标与选区。Terminal/PTY 的实时流不因此停止。若仍观察到焦点或未保存文本丢失，应按 `ui-refresh-focus-stability` 记录页面、控件、时间与是否刚好跨过轮询周期。

Manuscript workspace 在通用 Workspace 页面中应可直接打开 `paper.tex`/`.bib`；文件树能看到但点击 404、出现“文件读取失败”或 `NaN undefined` 都是缺陷。节点大小缺失时安全显示 `0 B`，不会影响打开内容。

终端内容是原始执行数据，不随页面语言翻译。

Run Terminal 可停靠到右侧或底部并继续接收同一 Run 的输出。仅在主区与 Dock 之间移动时，客户端会关闭旧宿主的流并从 `after_seq` 续接；右侧与底部互换不会关闭连接。Run Terminal 仍然只读，能输入命令的是独立的 Interactive Terminal。

当前“Download log”只导出浏览器保留窗口，不等同于完整日志 Artifact；长日志和取消/超时结果必须回到 Runs/Artifact 核对。正式使用前必须等待 TERM-01 标为“已验收”。

### 6.1 Interactive Terminal 与 Workspace

目标 UI 的 Workspace 像 VS Code：Explorer 打开 code/manuscript/scratch 文件，使用标签、搜索、Problems、查看图片/PDF/JSON、编辑文本、上传/移动/删除/历史并冻结 Snapshot。并发冲突会显示 base/current/local，不自动覆盖。**Workspace tree client 逻辑层已实现(2026-08-11,commit 98243ff)**：More →「工作区」面板(#tab=workspace 深链)——workspace 选择器与工具栏(新建文件/新建目录/上传(≤32 MiB multipart)/刷新/路径搜索框);左侧文件树按目录懒展开(implied 目录由文件路径投影、客户端创建的空目录为虚拟节点、文件行 hover 移动/删除);右侧多标签编辑区——每个 tab 持有 path/version/etag/content/savedContent,dirty 语义与 Manuscript 一致(清空读未保存、恢复已保存读干净),保存带 expected_version/etag CAS(409 冲突 → 横幅提示"重新加载",绝不静默覆盖),二进制节点只读显示 meta + 下载(原始字节 + media type),历史版本列表可回退(旧字节以当前 version/etag 守卫写回);树经 workspace watch SSE 流(`…/workspaces/{wid}/watch/stream?after_revision=`)实时增量刷新,流不可用时回退 listSince 每 5s 轮询(离开该 tab 自动停止)。搜索框为客户端路径过滤,尚未接线服务端查询;**服务端已实现路径搜索(prefix/glob)与内容搜索(commit 98243ff)**——POST search `{q, mode:'content'}` 线性文本扫描(文本节点/二进制跳过/每文件 20 匹配/50 文件上限/512 KiB 跳过/大小写可选/非法 UTF-8 容错,无全文索引,大数据集性能受限如实注明;客户端搜索框接入服务端路径/内容模式属后续轮)。剩余(浏览器层,Playwright 类环境不可用,记 NOT_RUN_MANUAL_PENDING):文件树渲染/拖拽上传/多标签视觉/窄屏/键盘 a11y 验收;Problems 面板与集成 PTY 入口。

点击 Workspace Terminal 打开独立 PTY，选择受控 Runner profile、根相对 cwd 和 shell preset。Interactive Terminal 已使用 xterm-compatible emulator 接到真实 LocalPtyAdapter：聚焦后可输入/粘贴，支持 ANSI/VT/TUI、IME 与自动 fit/resize，输出按 server_seq 增量追加而不因刷新重复。PTY 不是正式 Run，输出不能成为 Evidence。服务端 session context/multi-PTY 绑定、Remote PTY、完整日志下载以及真实浏览器 `WEBTERM_OK`/Unicode/vim/top/Dock/窄屏验收仍分别受 PTY-SESSION-02 与人工队列约束。

Workspace 与 Interactive Terminal 都可以独立停靠；Dock 不改变 Workspace 的 version/etag、编辑 tab 或 PTY 的 session/context。关闭 Dock 等同离开该页面：Workspace watch 会停止，PTY 服务端进程是否继续由 detach/close 与 lease 语义决定，不能用关闭面板代替显式关闭 PTY。

### 6.2 本机与远端执行

执行 target 经项目配置 `execution.runner_target_id`/`execution.runner_profile_id` 选择。先进入 Settings →“实验环境”创建或编辑 target（label、kind、capability、enabled/draining 与 remote SecretRef metadata），再在同一折叠组的“当前项目默认实验环境”选择器保存；页面不输入 SSH 明文、hostname 或任意命令。只覆盖一次运行时，在 `/run` 或 `/reproduce` 的 JSON 中加入 `"runner_target_id":"target_remote_lab_a"`，它优先于项目默认。远端离线时任务明确失败或等待，不会静默改在本机/subprocess 运行。服务端已实现 RUN-REMOTE-01 wire、RemoteFleetServer、RemoteRunnerAgentImpl、持久 Target Registry 和 target-aware claim；真实 mTLS 证书链、跨主机 sandbox/网络分区、Remote PTY 与浏览器视觉验收仍属后续人工阶段。

runner CLI（`node workers/runner-gateway/lib/bin/runner.js`）已接线四个互斥角色（FLEET-01，用法与互斥规则见 remote-runner-wire.md §9）：默认 `--kernel` 本地 claim 循环；`--fleet-server <port>` 启动 Fleet 服务端；`--agent <fleet-url>` 启动已在远端机器上的 Agent；`--agent <fleet-url> --ssh-bootstrap-target <id>` 从受控 SecretRef 通过 SSH 引导远端 Agent。fleet/SSH 角色与本地 `--mode` 互斥；开发 wire 用 `--service-token` 鉴权，生产必须 mTLS。

受控 SSH 引导（开发/人工验收）在 Fleet 服务端已经可达且其 plan 公钥已保存后运行：

~~~bash
node workers/runner-gateway/lib/bin/runner.js \
  --kernel http://127.0.0.1:7412 \
  --agent https://fleet.example \
  --ssh-bootstrap-target lab-gpu-01 \
  --secret-root /srv/dsh-scholar/secrets \
  --fleet-public-key /srv/dsh-scholar/fleet-public.pem
~~~

`lab-gpu-01` 必须是已登记且启用的 `remote-ssh` target；三个 file SecretRef 分别解析 endpoint JSON（只允许 `host/port/user`）、0600 credential 和预固定 known_hosts。适配器固定 `BatchMode`、`StrictHostKeyChecking=yes`、`IdentitiesOnly=yes`，只启动 `dsh-scholar-runner`，不接受 ProxyCommand、项目 argv 或任意远端 shell。远端主机必须已安装该 runner，并通过受控环境提供 Fleet service token；bootstrap 会先在中央 Kernel 注册 manifest 公钥，再通过加密 SSH stdin 下发临时 plan 公钥/manifest key，退出时删除。生产仍必须把 HTTP service-token 链路升级为 mTLS。

## 7. Evidence 与 Claim

普通用户或 Agent 可以创建 draft note，但不能创建 accepted Evidence。Analysis Worker 根据合同、匹配 Seed 和 metrics file 生成 Evidence；Evidence 页面显示 provenance、effect、CI、n 和方向。

缺字段、样本不足、CI 跨无效区间或只使用 draft/legacy Evidence 时 Claim 是 inconclusive。contradicted 和 negative result 会保留在稿件限制与结果中。

## 8. TeX Manuscript Workbench

> 当前已有 TeX 文件树、textarea 编辑、expected_version 保存、构建轮询、诊断列表和 PDF embed。dirty 判断已修复（以文件 GET/最近保存内容为基线，清空非空文件会正确显示未保存）；编译冻结可物化字节（快照按 revision 保存文件内容，Runner 编译输入不会被编译期间的编辑改变）；保存冲突（409）会立即终止编译且不创建 Job；构建卡片显示输入 revision 与 stale 标识，可跳转到同一 Job 的实时 Terminal。**打开/ensure 只读或首次创建（P0-3，2026-08-11 修复）**：进入 Manuscript 页先 GET（只读），工作区不存在才 POST 首次生成；render、轮询、locale 切换、保存后 rerender 都不会改写 `paper.tex`/`main.bib` 或推进 revision；显式“♻ 重新生成”按钮需确认，重写前把当前内容冻结为历史 revision（可回退）。**保存触发实时预览（P0-3）**：保存成功后自动调用 preview-builds hook（服务端 debounce），右侧“实时预览”区展示 pending/queued/running/succeeded/failed/cancelled/superseded 状态、stale 标识与最新预览 PDF。仍缺（UI 浏览器层，Playwright 类环境不可用、未验收，记 NOT_RUN_MANUAL_PENDING）：Manuscript 页内嵌实时 Build Terminal DOM、预览链与 regenerate 对话框的浏览器视觉验收、完整 history/move/assets。以下步骤描述目标 v2，TEX-01/TEX-02 未“已验收”前不得把编辑或编译结果当成正式稿件证据。

### 8.1 生成稿件

~~~text
/write
~~~

系统从 Brief、Corpus 快照、approved Contract、accepted Evidence、Claim 与图表 Artifact 生成 markdown 稿件（含 BibTeX 与图表引用），保存为 paper Artifact 并登记 manuscript 记录；`/write` 默认产出 markdown（`format='latex'` 的 LaTeX 输出同样可用）。TeX 正式编辑与编译请走 Manuscript 工作台（§8.2）。

### 8.2 编辑

进入 Manuscript：

1. 文件树选择 paper.tex、references.bib 或 figures；
2. 编辑器为受控 textarea（显示脏状态；行号/高亮/查找替换属目标编辑器能力，尚未提供）；
3. Ctrl/Cmd+S 保存；
4. 如果其他页面已修改同一文件，会出现 version conflict——冲突横幅提示"重新加载"，系统不会静默覆盖（当前无 Copy local / Merge 三方合并交互）；
5. History 可查看过去 revision。

### 8.3 编译与实时预览

保存成功后 UI 自动调用一次 `POST /v1/documents/{id}/preview-builds`（服务端 debounce，默认 800ms，快速连续保存合并为一次 preview）；右侧“实时预览”区轮询 `GET preview-builds` 投影，展示 pending/queued/running/succeeded/failed/cancelled/superseded 状态文本、stale 标识（预览 revision 落后于当前文档）与最新成功预览的 PDF embed/下载。点击 Compile 会先保存全部脏文件，冻结 manifest，再创建权威 latex-compile Job（创建即 supersede 全部非终态 preview；preview 不产 Evidence、不参与权威 manifest 链）。保存失败或 409 时不触发 preview/compile（冲突分支直接返回，不会创建构建 Job）。

Diagnostics 按 error/warning/info 分级着色展示（服务端 tex-diagnostics 解析出 file/line 定位字段，当前 UI 只显示 level+message 文本，"点击跳到编辑器"未接线）。TeX 原始消息保持原文，按钮与诊断类别按页面 locale 翻译。成功后 Preview 显示 PDF。继续编辑源文件时旧 PDF 标记 Stale，直到下一次成功编译。

可以下载 PDF、完整 compile log、sources 和 aux Artifact。HTML 不作为稿件预览。预览/编译状态与 PDF 的同页视觉链（浏览器验收）未执行，记 NOT_RUN_MANUAL_PENDING。

Manuscript 可停靠在右侧或底部；右侧/底部互换不重新创建编辑器或 Preview。离开主区进入 Dock 后仍使用同一文档 revision、dirty 状态与构建投影，关闭 Dock 前应显式保存需要保留的编辑。

## 9. Trajectory 与 Subagent 拓扑

Overview 的 Research Trajectory 显示权威 Gate/Job/Evidence/Manuscript 事件；Session Trajectory 显示 Agent 的消息和工具过程，后者不是科研事实。打开 Agent Topology 可展开 parent→child 直系树并点击进入 child，查看详情（状态/模式/类型/摘要/起止时间/子项数；role、时长、token/cost 与失败等字段尚未在 UI 展示），用 breadcrumb 返回。

one-shot child 只读；follow-up 输入框对子项常显（one-shot 只读，提交后仅返回 message_id，不激活 child；"仅 parent 在线且有权限才出现"的 capability 校验属后续）。读取历史不会唤醒 Agent，原始 prompt、工具参数/结果、环境和 secret 默认不展示。服务端已实现:TRAJ-01/SUBAGENT-01 投影与拓扑 API 层(Outbox 只读投影、redaction、10k 事件分页、exact direct-child、breadcrumb、只读 history、followup 记录 message_id 不冒充执行)。**UI 逻辑层已实现（commit 98243ff）**：More 导航新增「轨迹」（Trajectory，`#tab=trajectory`）与「拓扑」（Topology，`#tab=topology`）两个面板——轨迹面板双泳道渲染 Research（权威）与 Session（观察）事件，每条泳道可「加载更多」分页（服务端 keyset 游标），条目显示 event_seq/时间/脱敏摘要，点击可展开 allowlisted 详情（聚合引用/来源/会话/状态/条目 ID，原始负载永不展示）；轨迹增量经 `…/trajectory/stream?after_seq=&lane=` SSE 流消费（commit d01d415，lane 过滤、entry_id 去重、断线从最后 seq 续传，离开 tab 关闭流），流失败回退 keyset 分页；拓扑面板展示项目子代理直系树（点击节点懒加载其直接子项），「进入 child 详情」后顶部 breadcrumb 可逐级返回 parent，详情含状态/模式/类型与只读历史列表，底部为 one-shot 只读 follow-up 输入框（提交后仅返回 message_id，不激活 child）。剩余（浏览器视觉验收，Playwright 类环境不可用，记 NOT_RUN_MANUAL_PENDING）：双 lane 滚动/虚拟化（10k 节点 DOM 有界）、树展开/键盘/ARIA、follow-up 交互观感。

Trajectory 与 Topology 均可停靠。Trajectory 从主区移动到 Dock 时按最后事件序号续接，右侧与底部互换不重开双泳道流；进入 child 后的 breadcrumb 与展开状态应保持。

## 10. Review 与 Release

> Review/Bundle:REL-01 已关闭(commit 040e796)——build-bundle.sh 生成自包含 Bundle(manifest runtime 段 + TeX workspace 导出),reproduce.sh 在全新空目录以全新 DB/CAS 重放,拒绝指向原 checkout 的 runtime(bundle-only clean-room),并逐字段比较 manifest/metrics/analysis/RunManifest/TeX 输入与 PDF 结构;tests/security/run-release-bundle-tests.sh 已接入聚合器。尚未绑定 CI job 报告前仍不得据此声明正式可复现性。

~~~text
/review
/release-bundle
/release
~~~

Review 检查数字、Claim 状态、引用定位、Artifact hash、TeX 编译、负结果、许可和 AI usage。`/release-bundle` 生成私有自包含 Bundle（`/export` 保留给 DSH Web 下载 Session 日志）；clean-room 重跑实验、分析和 PDF。release 只创建 Human Release Gate，不自动上传外部平台。

## 11. Budget、Settings 与下一步

Budget 页面显示模型费用、GPU 小时与 API 请求用量，以及项目内容计数（corpus 快照/Idea/Contract/Claim/Evidence/Artifact）与详情弹窗中的约束和策略（数据集、并发上限、执行 profile、网络与完整性要求；内核记账的存储用量字段当前未在 UI 展示）。超过硬上限时项目进入 BLOCKED_GATE，正在运行的策略按 Job contract 安全停止或完成；只有 Human Budget Gate 可恢复到 payload 允许的状态。

Overview 顶部以结构化卡片（GUIDE-01 `next_actions_v2`）展示下一步：每张卡含 code 徽标、三态标记（ready 可执行 / blocked 受阻 / done 已完成——done 灰显、blocked 因缺失前置条件而禁用、ready 高亮）、原因、需要 Human/Agent/Runner 徽标（内核 `required_by` 未声明时不显示）、缺失前置条件列表（点击受阻卡展开）、阻断说明和进入可完成动作界面的按钮（chat/gates/runs/evidence/manuscript/budget 直达，ideas/contracts/release 收敛到总览）。其中 `survey_run` 打开项目 Chat 并预填命令，不自动发送。标签优先按字典翻译，未登记 code 原样显示内核 label；未知状态动作（code='unknown'）只读，不提供猜测的执行按钮。旧内核的 `next_actions: string[]` 仍以列表形式兼容显示。

所有配置集中在 Settings，首次进入时所有分组默认折叠：静态分组为 连接 / 外观 / 偏好 / runner / workspace / terminal / TeX / agent / config provenance（runner、workspace、terminal、TeX、agent 五组在 registry 数据可用时由动态 ConfigScope 分组替换），另按 ConfigScope 动态生成 global/project/job（保留，无键）/runner-profile/orchestrator/kernel/standalone 七组折叠面板（覆盖注册表全部键）。每字段显示 effective 当前值（secret 只显示"已设置，不显示明文"掩码，明文永不回显）、scope、声明来源、安全基线标记、env 别名、schema 描述与默认；config pin 显示并在变化时提示；热生效/需重启按声明来源推断（注册表尚无 hot_reload 标记——含 http/ui 来源的键"保存后即时生效"，仅 cli/env/file 的键"需重启生效"，规则见 docs/config-registry.md §6）；per-key revision/hash 与"已修改"标记未展示（只有全局 pin）。修改只影响新 Job/PTY/Build。服务端已实现:canonical Config Registry(CONFIG-01,单一注册表 + parseCli 四二进制接入 + security floor + effective pin/redacted 视图 + 生成物 configs/generated/)与 kernel/standalone 的 x-config-pin 响应头、/v1/config/effective、/v1/config/schema。**Settings UI 已由 /v1/config/schema + /v1/config/effective 动态生成(2026-08-11,只读视图)**；本版本无配置写接口(kernel 仅提供读取面),提交按钮禁用并注明"当前配置只读,经 CLI/env 提供"——修改配置请用各二进制 CLI flag 或 DSH_* env。/bff/research/config/* 写面与 SecretRef 存储层仍属后续阶段(本地校验与错误回显映射机制已就绪)。

Panel Dock 的打开页面、首选位置与尺寸通过页面上的 Dock 控件即时配置并只保存在当前浏览器；它们不改变任何 Job/PTY/Build 的 config hash，也不出现在 Settings 的 Kernel Config Registry/config pin 中。

## 11.1 Models & OCR（Model Provider 与项目绑定）

Settings 的「Models & OCR」组管理 instance/global Model Provider：列表、新建、编辑、禁用、SecretRef 可用状态、能力（chat/vision/ocr/embedding）与模型目录。创建/编辑 Provider 时只填写引用元数据（`SecretRef`：scheme + name + version/scope），**不接受任何 secret value**——提交 `value`/`token`/`password`/`credential` 字段会被拒绝（`secret_value_forbidden`）；浏览器只显示 SecretRef 元数据与 available 布尔，不返回 secret 值。自定义 base URL 由服务端校验：仅 https（loopback http 需显式白名单）、拒绝 URL 内嵌 userinfo、拒绝私有/保留网段与未白名单主机（SSRF fail closed）；真实连接期的 redirect/DNS-rebinding 复检随模型客户端落地（当前无真实模型服务，`NOT_RUN_MANUAL_PENDING`）。

项目设置只提供 provider/model ID 选择器（purpose + provider_id + model_id）：内核校验 provider 存在且启用、模型在 provider 目录、能力匹配，并快照 provider revision + config hash（运行中的 OCR/Job/PTY/Build 固定创建时的 revision/hash）。OCR 只有显式选择启用的 ocr/vision 模型后才创建请求；没有匹配模型时稳定失败并提示配置，禁止静默回退。OCR 成功结果以 `observed_unverified` 保存（带来源/页码/置信度），OCR 文本是不可信外部内容：不执行其中指令、不访问 secret、不自动成为 Human answer、Gate Decision、verified Evidence 或 supported Claim。

服务端已实现:MODEL-01 Provider 注册表(`/v1/providers*` CRUD + revision CAS)与项目绑定(`/v1/projects/{id}/model-binding`);浏览器「Models & OCR」组视觉、真实 Provider/OCR 服务调用记 `NOT_RUN_MANUAL_PENDING`(manual-acceptance.md §6)。

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
| 直接访问 kernel 端口 401 | sidecar 启动的 Kernel（默认 127.0.0.1:17413）受 0600 `<dataDir>/kernel-token` 随机 bearer 保护（env 注入、不出 argv）；除 `/v1|v2/health` 外缺失/错误 token 一律 401。浏览器/BFF 无需关心——BFF 自动带上该 token；仅脚本或 orchestrator 直接访问时需要（kernel 用 `--token` 或 `DSH_SCHOLAR_KERNEL_TOKEN`；orchestrator 用 `--token-file` 读取同一 0600 文件）。`x-service-token` 是内部路由专用层，不能替代普通 bearer |
| 页面部分未翻译 | 缺失 key 会显示 key；这是缺陷，应按 docs 规则补资源和测试 |
| intake/proposal stale | 上传接入期间项目或提案已变化，刷新并重新生成 Proposal |
| chunk_gap / chunk_offset_conflict | 分块上传乱序或与已提交 offset 冲突；客户端队列会按 committed offset 顺序续传，刷新后从服务端 offset 继续 |
| upload_quota_exceeded | 单 Intake 预留总量超限（默认 2 GiB、硬上限 10 GiB）；删除/abort 部分上传后重试 |
| secret_value_forbidden | SecretRef 只接受引用元数据；secret 值由服务端解析，绝不提交 |
| provider_url_ssrf_rejected | Provider base URL 命中私有网段或未白名单主机；联系管理员加入 allowlist |
| target offline | 远端 Runner 不可用；等待/修复或显式创建新 attempt，不会自动本地降级 |
| subagent read-only | one-shot、parent offline 或无 follow-up capability，只能查看 |

## 13. 开发者临时 self-mod

仅调试 DSH/Cordis 运行时行为时，按 test-instance-plan.md 创建隔离 DSH_HOME，并显式加载 research-dev-selfmod overlay。可使用 cordis_inspect、cordis_mount、cordis_unmount；动态插件不持久，不能用于 Gate、正式 Run、Evidence 或发布。需要保留的行为必须转成源码、测试和 Markdown。
