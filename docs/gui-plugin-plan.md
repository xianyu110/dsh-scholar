# 需求:DSH Research OS 独立 GUI 插件(后续阶段)

> 状态:**需求已登记**(2026-08-07)。当前 MVP 已内嵌一个轻量面板
> (见下「现状」),本文件定义后续将其独立为完整 GUI 插件的需求与路径。
> 关联设计文档:§4.1 工具面、§5.2 Gate 设计(Web 面板)、§8.2 目录
> (`packages/dsh-research-ui`)、§10.3 E7 UI、§13.1 MVP DoD #2。

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

## 3. 排期建议
| 里程碑 | 内容 |
|---|---|
| M1 | 独立包骨架 + tsdown 构建 + 槽位注册 + phase/gates 面板 |
| M2 | budget/runs/artifacts/evidence 面板 + RPC 域 |
| M3 | Gate 交互 + SessionEvent 同步 + 主题/i18n + 验收 |
