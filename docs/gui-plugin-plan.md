# 需求:DSH Research OS 独立 GUI 插件(已实现)

> 状态:**已实现**(2026-08-07,`packages/dsh-research-ui`)。本文档保留为
> 需求与设计记录;实现与验证见下文「实现记录」。关联设计文档:§4.1 工具面、
> §5.2 Gate 设计(Web 面板)、§8.2 目录(`packages/dsh-research-ui`)、
> §10.3 E7 UI、§13.1 MVP DoD #2。

## 1. 现状(已实现,内嵌)

| 组件 | 实现 | 位置 |
|---|---|---|
| 数据面 | `/research-api/*` 同源代理桥 → Kernel(127.0.0.1:7412),仅 web 组合挂载 | `src/plugin/web-bridge.ts` |
| 面板 | 浏览器 client module(原生 DOM 浮动卡片):阶段、pending gates、最近 runs、预算、counts(ideas/contracts/claims/evidence/artifacts/snapshots)、next actions,8s 轮询 | `src/client-panel.ts` |
| 分发 | 主插件包 `exports["./client"]` + `dshClient` 声明,经 boot manifest 自动加载 | `package.json` |

已满足 13.1 DoD #2 的「看到阶段、预算、Runs、Artifacts、Evidence 和 Gate」。

## 2. 需求:独立 GUI 插件

### 2.1 动机
- 主插件是 **server 插件**(工具/命令/Kernel),前端代码内嵌导致:前端构建链
  与 server 构建耦合;无法按需/独立发布;面板能力受限(无交互、无审批)。
- 独立 GUI 插件使前端可以走 DSH 标准 client-plugin 生命周期(React 槽位、
  RPC、设置、i18n、主题),并可在 Web 之外(未来桌面端/团队端)复用。

### 2.2 目标包
```
packages/dsh-research-ui/        # 独立 client-plugin bundle(platform: web)
├── src/client/                  # 浏览器端(React)
│   ├── panels/phase.tsx         # 阶段时间线 + 状态机图
│   ├── panels/gates.tsx         # Gate 列表 + 批准/驳回交互(经 RPC,记录 actor/reason)
│   ├── panels/budget.tsx        # 预算用量 vs 硬限额;越界提示 BLOCKED_GATE
│   ├── panels/runs.tsx          # Job 表:状态/租约/manifest/失败分类;取消按钮
│   ├── panels/artifacts.tsx     # CAS artifact 清单 + 哈希 + 预览(SVG 图表内嵌)
│   ├── panels/evidence.tsx      # Claim↔Evidence 绑定视图 + 冲突标记
│   └── slots.ts                 # 槽位注册(conversation.sidebar / workspace 页)
├── src/host/                    # host 半:注册 RPC 域(research.*)+ projection
├── package.json                 # exports["./client"]、dshClient、peer 声明
└── tsdown.config.ts             # 前端 bundle 构建
```

### 2.3 功能范围(P0)
1. **阶段面板**:17 态状态机可视化、当前阶段、revision、历史迁移、next actions。
2. **Gate 面板**:pending gates 列表;批准/驳回/修改(**必须**记录 actor、reason、
   diff 到 Kernel Decision;与 `research_gate` 工具同一数据面);BLOCKED_GATE 的
   预算 Gate 显示 resume 目标。
3. **Runs 面板**:job 状态、lease/heartbeat、RunManifest 摘要、失败分类、
   取消(operator 角色);artifact 哈希可点击预览。
4. **Evidence 面板**:Claim 状态(proposed/supported/contradicted/inconclusive)、
   绑定 EvidenceItem、CI/效应量、图表(SVG artifact 直接渲染)。
5. **RPC 域**:注册 `research.*` RPC(projection/gate-decision/job-cancel/
   manuscript-build),经现有 `/research-api` 桥或独立 host 代理访问 Kernel;
   Gate 决策事件同步进 SessionEvent(tool call 记录)。

### 2.4 非目标(本期不做)
- 不替代 Kernel 权限模型:面板决策仍写 Decision 账本,`research_gate` 工具
  与面板共用 `decideGate` 的 CAS 原子路径。
- 不做 Team/Cluster 版多租户 UI(依赖 §9.2 部署演进)。

### 2.5 拆分方式(保持向后兼容)
1. 保留 `src/plugin/web-bridge.ts`(数据面)与 `src/client-panel.ts`(轻量兜底
   面板)——独立插件发布后,内嵌面板仍可用或由配置关闭。
2. 新包以 `@dsh-scholar/research-ui` 为名,加入本仓库 workspace;主插件
   `dshClient` 声明移除,改由独立包声明。
3. 复用 Kernel API 契约(§8.3)与 `/research-api` 桥;新增 RPC 仅在独立包内。

### 2.6 验收标准
- [ ] Web 会话中可看到完整阶段时间线与 pending gates;
- [ ] 面板批准 Gate 后,Kernel Decision 账本 + SessionEvent 同时可追溯;
- [ ] Runs/Artifacts/Evidence 面板全部数据来自 Kernel 投影/API(无重复状态);
- [ ] 图表(SVG artifact)在面板内渲染,数字与 analysis artifact 一致;
- [ ] 独立包可单独构建/发布;卸载后主插件功能不受影响;
- [ ] headless 模式不受影响(无 httpServer 时面板/桥自动跳过)。

## 3. 实现记录(2026-08-07,已完成 M1-M3 务实版)

| 里程碑 | 实现 | 验证 |
|---|---|---|
| M1 骨架+构建+面板 | `packages/dsh-research-ui`:host 半(独立 kernel sidecar + `/research-ui-api` 桥)+ client(标签页:Phase/Gates/Runs/Artifacts/Evidence/Budget),tsdown 打包 `lib/client.js` + bundle verify | 构建 ✓,boot manifest 自动加载 ✓ |
| M2 全量面板 | 六个标签页全部由 Kernel 投影/API 驱动;项目下拉选择;8s 轮询 | 测试实例实测 ✓ |
| M3 Gate 交互 | 面板内 Approve/Reject 按钮 → `decideGate`(CAS 原子,actor=web-user,reason 可追溯) | 实测:approve→SCOPED、reject 记录 ✓ |

**双插件共存**:主插件(kernel :17412,/research-api)与 UI 包(独立 kernel
:17413,/research-ui-api)在测试实例同时安装运行,互不冲突;sidecar 有
"复用健康 kernel"逻辑,配置同端口时可共享。

**依赖**:UI 包独立可用(自带 kernel+桥);推荐与主插件同装以使用工具/命令面。
面板决策写入 Kernel Decision 账本 + 事件 outbox;SessionEvent 层面的同步
通过会话内工具调用完成(面板本身是 Web 交互,不经 agent loop)。

## 4. 后续增强(登记)
- React + `ctx.slots` 槽位集成(替换原生 DOM 面板,进入 conversation 布局);
- 主题/i18n;Runs 面板取消按钮;artifact 预览(SVG 图表内嵌)。

## 5. 排期建议(已并入实现)
| 里程碑 | 内容 |
|---|---|
| M1 | 独立包骨架 + tsdown 构建 + 槽位注册 + phase/gates 面板 |
| M2 | budget/runs/artifacts/evidence 面板 + RPC 域 |
| M3 | Gate 交互 + SessionEvent 同步 + 主题/i18n + 验收 |
