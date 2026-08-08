# Research UI、实时终端与 TeX 工作台规范

> 规范性文档。文件名为兼容旧链接保留；内容是目标 UI 规范，不是未来计划。

## 1. 运行形态

同一个客户端核心支持：

1. DSH 嵌入模式：通过 dshClient 和 ctx.slots 注册到 DSH Web；使用宿主 LocaleFace、主题和会话能力。
2. 独立模式：本地 HTTP host、同源 BFF、全屏 UI、独立 Token 解锁；内置 locale/theme adapter。

两种模式使用相同页面、状态模型、翻译 key、ResearchClient 和组件。不得维护“主插件轻面板”和“独立完整面板”两套逻辑。Shadow DOM 可以用于样式隔离，但不能阻止 DSH slots、locale 和主题注入。

## 2. 布局

### 2.1 全屏

- 左侧 230 px Workspace sidebar，可折叠到 44 px；
- 主区包含全局 header、项目 header、分组 tabs 和当前页面；
- 小于 720 px 时 sidebar 变抽屉、tabs 横向滚动、编辑器改上下分屏；
- 小于 640 px 时占满 viewport，不使用浮动阴影。

Sidebar：搜索、All/Active/Done/Archived、收藏、状态、创建、重命名、归档、恢复、详情、复制 ID。支持键盘和右键菜单，批量归档不能包含 running project。

Header：Kernel 状态、Human Gate 数、命令面板、快捷键、活动通知、语言、密度、主题、刷新。Kernel 不可用时显示持续 banner 和 Retry；不能只用 toast。

### 2.2 页面

| 分组 | Tab | 说明 |
|---|---|---|
| Research | Chat | /research 命令、结果卡、会话与搜索 |
| Research | Overview | 状态流水线、Brief、下一步、Idea、Contract、历史 |
| Execution | Approvals | Gate 筛选、Human Decision、理由和审计 |
| Execution | Runs | Job 列表、状态、Manifest、取消 |
| Execution | Terminal | 选择 Run，查看 stdout/stderr 实时流 |
| Review | Artifacts | 项目产物搜索、预览、下载 |
| Review | Evidence | Claim–Evidence、CI、效应量、限制 |
| Review | Manuscript | TeX 文件树、编辑、编译、诊断、PDF |
| Operations | Budget | 用量、限制、策略和项目内容计数 |

Tab 可收藏，Alt+1…9 切换。URL 或持久 UI state 保存 active project/tab，但不能把 Token 放 URL。

## 3. 数据与刷新

- 项目投影默认每 8 秒刷新；页面隐藏时暂停，恢复可见立即刷新；
- 活动 Terminal 使用 SSE，不能由 8 秒轮询或本地逐字动画模拟；
- TeX save 使用 expected_version，build 使用 expected_document_revision；
- 请求可取消，页面切换时清理 listener、Blob URL 和 stream；
- 401 只允许一次 session refresh 重试；之后回到解锁/登录，不无限循环；
- UI 不保存权威业务状态，只缓存选择、布局、草稿和 lastSeq。

## 4. Chat

支持会话新建、切换、重命名、固定、复制、归档、搜索、导出 JSON/Markdown 和最多 200 条本地 transcript。模型文本和服务器错误原样显示；UI chrome 翻译。

内置命令：help、new、list、status、survey、ideas、gates、jobs、reproduce、contract、run、evidence、claims、write、review、export、release。命令结果使用结构化卡，可跳转到对应页面。Composer 支持命令补全、Shift+Enter 换行、历史、引用和安全 Markdown；不渲染任意 HTML。

Chat 中的“运行中”只代表 HTTP 命令未完成。真正命令执行输出必须链接到 Run/Terminal，不在聊天中伪造流。

## 5. Overview

- 显示 14 个主路径阶段和 Block/Stop/Fail/Archive 状态；
- 当前阶段、完成比例、revision 和 status pill；
- Brief 问题、主指标、范围；
- next_actions 卡，空态明确是否等待 Gate；
- Idea 与 Contract 最近版本，点击详情；
- Budget 摘要与快速跳转；
- Project history 默认最近 10 条，可展开全部。

未知服务器状态原样显示为中性色，不能丢失或硬翻译成错误状态。

## 6. Approvals

列表分 pending 和 decided，支持 type/status/search。Pending card 显示 Gate target 类型、ID、版本、summary、请求者、时间和 policy。

Approve/Reject/Revise 通过 Human BFF。UI 不发送 actor；BFF 从登录身份注入 Principal。Reject/Revise 强制 reason。Budget Gate 的 resume_to 来自 Gate payload 允许集合，不硬编码 EXPERIMENTING。提交期间禁用重复按钮，409 时刷新并显示已经决定者。

批量决定默认关闭；若启用，每个 Gate 独立确认且失败不伪装原子批量。

## 7. Runs

按 queued、running、retryable、succeeded、failed、cancelled 筛选。每行显示 kind、contract、snapshot、status、attempt、lease heartbeat、failure class、时间和 id。详情显示 JobSpec、RunManifest、Artifact refs、资源、签名状态和审计。

Cancel 仅对 queued/running/retryable 可见，要求 reason 并通过 BFF。UI 显示“取消请求中”直到 Runner 确认实际进程/容器停止；HTTP 返回不能提前伪装 cancelled。

每个 Run 有“打开终端”动作；running Run 可自动打开，历史 Run 可重放。

## 8. Terminal

### 8.1 视图

- 左侧或顶部 Run 选择器，默认活动 Run；
- All、stdout、stderr 三个通道；
- monospace、ANSI 白名单颜色、横向滚动、默认不软换行；
- 状态栏显示 connecting/live/reconnecting/exited、cwd display、总字节、截断、exit code 或 signal；
- auto-scroll 可暂停，用户向上滚动自动暂停并显示 Jump to latest；
- copy visible、copy all retained、download full log；
- 搜索、行号可选、最大渲染行数，展开不会无限占内存；
- cancel 与 Runs 共享同一操作；
- 键盘和屏幕阅读器可读取状态变化，不逐字符朗读高频输出。

### 8.2 流与恢复

打开时读取本地 lastSeq 并连接 Terminal SSE。chunk 按 seq 去重和排序；断线指数退避，恢复携带 after_seq。收到 gap 显示永久警告和 dropped bytes；收到 truncated 显示最终日志不完整。exit frame 或权威 Job 终态才结束 running 状态。

切换 Run 关闭旧 stream；隐藏页面可以保留轻量连接或关闭后恢复，策略必须有界。Terminal 输出通过 text nodes 或安全 ANSI parser 渲染，绝不使用 innerHTML。

## 9. Artifacts

按 kind、名称、ID 和 metadata 搜索，显示 media type、大小、hash、时间和 provenance。预览规则：

| 类型 | 行为 |
|---|---|
| text/json/log/tex/bib | textContent，截断，可下载 |
| PDF | Blob URL embed，application/pdf，下载/新窗口 |
| raster image | Blob URL img |
| SVG | sanitizer 后 img，禁止 inline script |
| HTML | 不预览，只下载 |
| binary/model | 元数据和下载 |

所有读取路径包含 project_id。关闭 modal 时 revoke Blob URL。独立代理必须保持二进制，禁止先 text()。

## 10. Evidence

Claim 列表显示 statement、status、confidence、supporting Evidence、analysis artifact、limitations 和 history。Evidence 显示 provenance_status，不得把所有行固定标为 verified。

Effect 图明确 0 基线、方向、CI、n、adjusted p 和 metric unit。只读页面不能让普通用户直接把 draft 转 accepted。原始动态 statement、server error、论文文本不翻译。

## 11. Manuscript Workbench

### 11.1 布局

桌面三栏：文件树 220 px、编辑器弹性宽度、Preview/Diagnostics 360–45% 可调整。小屏为 Editor、Preview、Diagnostics 子 tabs。

Header 显示 document、revision、保存状态、当前 build、PDF freshness、Compile、Review、Download PDF、Export Sources。

### 11.2 文件树

- 支持 .tex、.bib、.sty、.cls、图片和 generated figures；
- 新建、重命名、删除、上传、下载和历史；
- 路径显示根相对形式，拒绝绝对路径和 ..；
- 未保存、冲突、构建输入、generated/readonly 使用不同标识；
- 引用的 Artifact 图表可“添加到 figures/”，产生新 workspace revision。

### 11.3 编辑器

首版可以使用受控 textarea/code editor；后续可接 Monaco/CodeMirror，但接口不变。必须支持行号、定位行列、查找替换、撤销重做、Tab、TeX/BibTeX 基本高亮、脏状态和 Ctrl/Cmd+S。

保存携带 expected_version。409 冲突展示 base/current/local 三方信息，允许复制、重新加载或显式合并；禁止静默覆盖。离开未保存文件需确认。自动保存若启用使用 debounce 且仍执行 version CAS。

### 11.4 编译

Compile 先保存所有脏文件，再冻结 workspace manifest 并提交 latex-compile Job。按钮显示 queued/running/succeeded/failed/cancelled。Build terminal 复用 Terminal 组件并默认 stderr/all。

诊断按 error/warning/info 分组，显示 file:line:column、pass 和消息；点击定位编辑器。诊断 parser 的本地 code 可翻译，TeX 原始消息保留。undefined citation、missing file、overfull box 和 shell-escape 拒绝有专门类型。

### 11.5 PDF

成功后以安全 Blob URL 预览 PDF，显示页数可选、下载和新窗口。Preview 顶部显示 build input revision；源文件改变后显示 stale banner，仍允许查看旧 PDF，但不能标记最新。切换 build history 可比较不同 PDF/log。

## 12. Budget

显示模型费用、GPU 小时、API 请求、存储和并发。低于 80% 用正常色，80–100% 警告，超过 100% 错误。越限说明 BLOCKED_GATE 和恢复 Gate，而不是只显示红条。

详情显示数据策略、网络、Runner、完整性、签名和 clean-room 要求。

## 13. i18n 硬约束

### 13.1 语言与资源

首发 locale：zh、en。资源目录必须为：

~~~text
packages/dsh-research-ui/src/client/i18n/locales/
  common.ts
  shell.ts
  overview.ts
  approvals.ts
  runs.ts
  terminal.ts
  artifacts.ts
  evidence.ts
  manuscript.ts
  budget.ts
  standalone.ts
~~~

每个 namespace 导出 zh 字典，keyof zh 作为 key 类型，en 必须精确完整。Key 使用语义点号，如 terminal.status.reconnecting、manuscript.build.stale、common.action.cancel。禁止使用英文原句作为 key。

所有用户可见 chrome 都必须来自 t(key, params)：标题、Tab、按钮、placeholder、aria-label、tooltip、空态、错误摘要、toast、状态 label、设置、快捷键、独立解锁页和 `<html lang>`。动态项目名、Gate title/summary、论文内容、命令输出、TeX 原始诊断、模型文本和 wire error 原样显示。

### 13.2 查找与切换

查找顺序：当前 namespace active locale、当前 namespace zh、common active/zh、原 key。缺失 key 原样显示且开发模式记录一次 warning，不能返回空字符串。

选择顺序：有效 localStorage dsh.locale、navigator.languages、navigator.language、zh。支持 zh-CN/zh-Hans 映射 zh、en-US/en-GB 映射 en。设置中可手动切换；setLocale 持久化并增加 revision，所有已挂载页面、modal、aria 和通知 chrome 立即重渲染。

DSH 模式使用宿主 LocaleFace；独立模式实现 bind、getSnapshot、subscribe、setLocale 的兼容 adapter。二次安装 locale face 是 assembly error。

### 13.3 插值、复数和格式

插值只使用 {name}，未提供参数保留 placeholder。复数使用显式 .one/.other key 和调用点分支，不假设 ICU。

日期、时间、数字、货币、百分比、文件大小和相对时间必须显式传 active locale 给 Intl formatter 或使用翻译单位 key；禁止 toLocaleString(undefined) 导致切换后混合语言。状态 enum 映射翻译 key，未知值回退原字符串。

### 13.4 i18n 验收

- 静态检查阻止 JSX/DOM 中新增硬编码 chrome；
- zh/en key 集完全一致；
- persisted locale 优先于浏览器，regional locale 映射正确，storage 失败不阻断；
- 切换 locale 后所有已打开 modal、Terminal 状态、TeX 诊断 chrome 和 aria 更新；
- standalone 解锁页在首次渲染前选择 locale；
- 动态研究内容和 Terminal 字节不被翻译；
- 所有页面在 zh/en 下无溢出、截断和不可点击控件。

## 14. 主题与偏好

支持 light/dark/system、accent、radius、texture、density、sidebar collapsed、favorite tabs/projects、auto refresh、locale。DSH 模式跟随宿主 ThemeFace 和 LocaleFace，独立模式使用兼容 adapter。Token 与普通偏好分开存储；Reset preferences 不删除认证 Token，除非用户明确选择 Sign out。

## 15. 可访问性

- Dialog 有 role=dialog、aria-modal、标题、focus trap、Escape 和焦点恢复；
- Tabs、menu、listbox、tree、editor、terminal 使用正确语义；
- 所有 icon button 有翻译后的 aria-label；
- 颜色不是唯一状态标识；
- 键盘可完成创建项目、Gate、Run、Terminal、编辑保存、编译和下载；
- reduced-motion 禁用本地渐进 reveal 和非必要动画；
- toast 使用 aria-live polite，致命连接错误使用 assertive 但不重复刷屏。

## 16. 安全与性能

- 禁止 innerHTML；Markdown、ANSI、SVG 分别走白名单 renderer；
- 每个列表虚拟化或设置有界窗口；
- Terminal、Transcript 和日志有最大内存；
- 搜索 debounce，异步响应用 request identity 防止旧结果覆盖；
- Modal、SSE、interval、event listener、Blob URL 全部在卸载时释放；
- BFF Token、CSRF 和 Project AuthZ 规则见 security-baseline.md。
