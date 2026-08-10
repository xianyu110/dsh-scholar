# DSH Scholar 使用指南

> 目标版本 2.3。浏览器 UI 仅支持 standalone，产品仍在开发中。本指南同时描述目标使用流程和当前限制；任何能力只有在 hardening-v0.2-status.md 标为“已验收”并绑定当前 CI 证据后才能用于正式科研。

## 1. 启动

~~~bash
bash scripts/start-standalone-ui.sh
~~~

访问 http://127.0.0.1:18610，输入启动脚本打印的 Token。DSH Web 不再注入 Scholar 页面。打开页面后可以在 Settings → Language 选择中文或 English。没有手动选择时，系统先读 dsh.locale，再匹配浏览器语言，最后使用中文。切换语言不会翻译项目名、论文、命令输出和 TeX 原始错误。

## 2. 首次进入：Init、Resume 或 Upload

未选择项目时：

- **Init**：填写项目名、研究问题和主指标，确认默认 gate-only/Local Docker 策略后创建 DRAFT + Scope Gate；
- **Resume**：选择最近项目，根据 status、pending Gate 和 NextAction 回到上次页面；
- **Upload**：上传外部论文、TeX、代码、数据、日志或结果。系统先 hash/scan，再用 Grill Me 询问缺失的 scope、license、commit、dataset/split/seed、metric direction、Manifest、统计与隐私信息。

Upload 可以创建新项目或合并有权限的现有项目。采用前材料只在 Intake quarantine 中；确认 proposal 后也不会声称历史 Gate 已批准、日志是本平台 TerminalLog、结果是 accepted Evidence。冲突必须选择保留当前、采用上传或重命名。当前代码尚未完整实现 Init/Upload/Grill/Adoption，不能用普通 Artifact/TeX 上传模拟安全接入。

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

> 当前已有 Terminal SSE、seq/gap/reconnect、stdout/stderr 筛选和安全 ANSI 文本渲染。仍缺完整日志 Artifact 下载、严格 Job/Run/lease AuthZ、cwd、cancel/timeout 权威展示和有界 DOM；以下列表含目标 v2 行为，未关闭项不能视为已验收。

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

目标 UI 的 Workspace 像 VS Code：Explorer 打开 code/manuscript/scratch 文件，使用标签、搜索、Problems、查看图片/PDF/JSON、编辑文本、上传/移动/删除/历史并冻结 Snapshot。并发冲突会显示 base/current/local，不自动覆盖。

点击 Workspace Terminal 打开独立 PTY，选择受控 Runner profile、根相对 cwd 和 shell preset 后可以输入命令、使用 TUI、resize、发送 INT/TERM/KILL、detach/reconnect/close。PTY 不是正式 Run，输出不能成为 Evidence。当前代码只有只读 Run Terminal，没有可操作 PTY，也没有通用 Workspace Explorer。

### 6.2 本机与远端执行

Settings → Execution 选择已经登记的 Local Docker 或 Remote Runner profile。页面只显示 target label、capability、health、resources 和 policy；不输入 SSH credential/hostname/任意命令。远端离线时任务明确失败或等待，不会静默改在本机/subprocess 运行。当前代码只支持本机 subprocess/docker，远端 Runner Fleet 未实现。

## 7. Evidence 与 Claim

普通用户或 Agent 可以创建 draft note，但不能创建 accepted Evidence。Analysis Worker 根据合同、匹配 Seed 和 metrics file 生成 Evidence；Evidence 页面显示 provenance、effect、CI、n 和方向。

缺字段、样本不足、CI 跨无效区间或只使用 draft/legacy Evidence 时 Claim 是 inconclusive。contradicted 和 negative result 会保留在稿件限制与结果中。

## 8. TeX Manuscript Workbench

> 当前已有 TeX 文件树、textarea 编辑、expected_version 保存、构建轮询、诊断列表和 PDF embed。dirty 判断已修复（以文件 GET/最近保存内容为基线，清空非空文件会正确显示未保存）；编译冻结可物化字节（快照按 revision 保存文件内容，Runner 编译输入不会被编译期间的编辑改变）；保存冲突（409）会立即终止编译且不创建 Job；构建卡片显示输入 revision 与 stale 标识，可跳转到同一 Job 的实时 Terminal。仍缺（UI 浏览器层，Playwright 类环境不可用、未验收）：Manuscript 页内嵌实时 Build Terminal DOM、PDF freshness 的浏览器验收、完整 history/move/assets。以下步骤描述目标 v2，TEX-01/TEX-02 未“已验收”前不得把编辑或编译结果当成正式稿件证据。

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

目标行为是：每次成功保存后自动 debounce preview，右侧实时显示 pdflatex/bibtex 输出、诊断并刷新 PDF；继续编辑会立即把旧 PDF 标 Stale。点击 Compile 会先保存全部脏文件，冻结 manifest，再创建权威 latex-compile Job。当前 UI 只轮询 build 状态，没有实时 Build Terminal/Preview；保存失败或 409 时必须人工确认没有创建构建 Job。

Diagnostics 将错误整理为 file:line；点击可跳到编辑器。TeX 原始消息保持原文，按钮与诊断类别按页面 locale 翻译。成功后 Preview 显示 PDF。继续编辑源文件时旧 PDF 标记 Stale，直到下一次成功编译。

可以下载 PDF、完整 compile log、sources 和 aux Artifact。HTML 不作为稿件预览。

## 9. Trajectory 与 Subagent 拓扑

Overview 的 Research Trajectory 显示权威 Gate/Job/Evidence/Manuscript 事件；Session Trajectory 显示 Agent 的消息和工具过程，后者不是科研事实。打开 Agent Topology 可展开 parent→child、查看 role/mode/running、时长、token/cost 和失败，点击 child 进入其安全 history，并用 breadcrumb 返回。

one-shot child 只读；continuable child 只有 parent 在线且有权限才出现续问框。读取历史不会唤醒 Agent，原始 prompt、工具参数/结果、环境和 secret 默认不展示。当前 Scholar UI 尚未移植 DSH Web Trajectory/Topology，现有 research_panel 返回 child 结果但没有独立树和进入能力。

## 10. Review 与 Release

> Review/Bundle 当前只有基础清单和脚本。2026-08-09 审阅时 release-bundle 阻断测试为 0/2，clean-room 仍会复用 checkout/CAS/外部 binary，不是 bundle-only；不得据此声明可复现或进入 Release Gate。

~~~text
/research review
/research export
/research release
~~~

Review 检查数字、Claim 状态、引用定位、Artifact hash、TeX 编译、负结果、许可和 AI usage。Export 生成私有自包含 Bundle；clean-room 重跑实验、分析和 PDF。release 只创建 Human Release Gate，不自动上传外部平台。

## 11. Budget、Settings 与下一步

Budget 页面显示模型、API、GPU、存储和并发。超过硬上限时项目进入 BLOCKED_GATE，正在运行的策略按 Job contract 安全停止或完成；只有 Human Budget Gate 可恢复到 payload 允许的状态。

Overview 顶部 NextAction 说明当前一步、原因、需要 Human/Agent/Runner、阻断项和目标页面。未知旧动作只显示原文，不提供猜测的执行按钮。

所有配置集中在 Settings，默认折叠 Essentials、Execution、Workspace、Terminal、LaTeX、Agent/Trajectory、Security & Secrets、Diagnostics。每项显示 effective value、来源 scope/revision/hash、默认/修改和热更新/重启；Secret 只显示引用。修改只影响新 Job/PTY/Build。当前配置仍散落在 Cordis/CLI/env，Config Registry 和完整 Settings 未实现。

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
| 页面部分未翻译 | 缺失 key 会显示 key；这是缺陷，应按 docs 规则补资源和测试 |
| intake/proposal stale | 上传接入期间项目或提案已变化，刷新并重新生成 Proposal |
| target offline | 远端 Runner 不可用；等待/修复或显式创建新 attempt，不会自动本地降级 |
| subagent read-only | one-shot、parent offline 或无 follow-up capability，只能查看 |

## 13. 开发者临时 self-mod

仅调试 DSH/Cordis 运行时行为时，按 test-instance-plan.md 创建隔离 DSH_HOME，并显式加载 research-dev-selfmod overlay。可使用 cordis_inspect、cordis_mount、cordis_unmount；动态插件不持久，不能用于 Gate、正式 Run、Evidence 或发布。需要保留的行为必须转成源码、测试和 Markdown。
