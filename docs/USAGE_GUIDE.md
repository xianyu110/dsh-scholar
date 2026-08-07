# DSH Scholar 完整使用教程

> 适用版本:`hardening/v0.2`(Security Alpha)。核心原则:**Gate 由人类决定、
> 实验真实执行、Evidence 可信**——Agent 只能请求,不能批准。

---

## 1. 环境一览

| 实例 | 地址 | 插件 | 用途 |
|---|---|---|---|
| **生产 GUI** | http://127.0.0.1:3080 | 无(已移除) | 日常 DSH 使用 |
| **测试实例(专属科研 GUI)** | **http://127.0.0.1:3081** | research-plugin + **research-ui(专属面板)** | 科研流程演示/开发 |

## 2. 启动专属科研 GUI

```bash
cd /home/dev/Desktop/dsh-scholar
bash scripts/start-test-dsh.sh        # 幂等:初始化 profile + 安装插件 + 启动
```

启动后浏览器打开 **http://127.0.0.1:3081**。页面右下角会出现 **🧪 Research OS**
浮动面板(GUI 专属面板,自动加载):

- **Phase**:项目当前阶段 + 下一步动作 + 历史
- **Gates**:待审批的 Gate,**Approve/Reject 按钮(人类专属)**——这是 v2 唯一的人类决策入口
- **Runs**:实验作业状态(可取消)
- **Artifacts**:代码/日志/指标/图表(点击预览,SVG 内联渲染)
- **Evidence**:Claims + 可信 Evidence(仅 Analysis Worker 生成)
- **Budget**:预算用量 vs 硬限额

## 3. 完整科研流程(从 0 到复现包)

> 全程约 10 个步骤;Gate 步骤需要你在面板上点按钮。

### 3.1 创建项目
在 Web 会话输入框执行:

```
/research new shift-localization '{"problem":"Does uncertainty weighting improve temporal localization under domain shift?","scope":"THUMOS14, supervised, no new data","primary_metrics":["mAP@0.5"],"resources":"1 GPU, <=20 GPU-hours","baseline_repo":"https://github.com/example/baseline"}'
```

系统创建项目(DRAFT)+ **Scope Gate Request**。查看状态:

```
/research status
```

### 3.2 批准 Scope Gate(人类)
在右侧面板 **Gates** 标签,点击 Scope Gate 的 **✓ Approve**。
→ 项目进入 `SCOPED`(此状态只能经人类 Gate 到达,通用迁移被禁止)。

### 3.3 文献调研
```
/research survey "temporal action localization"
```
多源检索(OpenAlex/Crossref/arXiv)→ 去重 → 冻结 **CorpusSnapshot**(含引用图与段落)。

### 3.4 Idea 生成与新颖性审计
```
/research ideas
```
让模型用 `idea_create` 生成候选 + `novelty_audit` 反查重(每个 Idea 需
falsification 条件、MVE、最近邻)。也可用并行面板:

```
research_panel kind=idea-panel perspectives=[{"label":"skeptic"},{"label":"innovator"}] task="生成 3 个可证伪 IdeaCard"
```

### 3.5 批准 Idea Gate(人类)
面板 Gates → Idea Gate → **Approve** → `IDEA_APPROVED`。

### 3.6 Baseline 真实复现(容器强制)
代码快照归档(真实内容,非清单):

```
research_project action=create ...   # 或复用已有项目
```

用工具链(模型或手动):

```
workspace_snapshot  path=<你的代码目录>
baseline_prepare    repo=<baseline repo> expected_metrics='{"mAP@0.5":58.4}' tolerance=0.05
baseline_verify     expected_metrics='{"mAP@0.5":58.4}' tolerance=0.05
```

> ⚠️ **v2 强制**:baseline/pilot/formal/reproduce 只能在容器执行;空命令或
> message-only 假实验会被拒绝。正式作业必须带 `code_snapshot_id`(真实代码归档)。

### 3.7 实验合同 + Contract Gate(人类)
```
/research contract '{"idea_id":"...","dataset_id":"thumos14","baseline":"baseline_b","treatment":"method_a","primary_metric":"mAP@0.5","seeds":[11,23,47,89,101]}'
```
面板 Gates → Contract Gate → **Approve** → Contract 冻结(`CONTRACT_APPROVED`),
之后任何口径变更需新版本重新审批。

### 3.8 正式实验(多 seed,容器真实执行)
```
/research run formal
```
或由模型按合同提交作业(每个 seed 一个,idempotency key
`formal:{contract}:{code}:{data}:{metric}:{seed}`)。长任务有 Heartbeat,
取消会终止真实容器;Manifest 带 Ed25519 签名 + fencing token。

### 3.9 统计与 Evidence(仅 Analysis Worker 可信)
```
/research evidence '{"analysis_method":"bootstrap_95_mean_difference","result":{"primary_metric":"mAP@0.5","value":61.2,"baseline_value":58.4,"effect_size":2.8,"ci_low":1.1,"ci_high":4.5,"n_seeds":5}}'
```

> 注意:普通 Agent 只能写 `evidence_note_create`(**draft_unverified**);
> 只有确定性 Analysis Worker 能写 **verified** Evidence 支持 Claim。
> Claim 缺 effect/CI/n → **inconclusive**,不可能被误标 supported。

### 3.10 论文、评审、复现包
```
/research write     # 从只读 Evidence Ledger 生成 Markdown/LaTeX + BibTeX + 图表
/research review    # 确定性评审:数字一致性、引用解析、复现要求
/research export    # 自包含 Release Bundle(私有导出,非发布)
/research release   # 创建 Release Gate(人类,默认保持未批准)
```

## 4. Gate 决策入口(人类专属)

| Gate | 触发时机 | 批准入口 |
|---|---|---|
| Scope | 项目创建后 | GUI 面板 Gates → Approve |
| Idea | Idea 候选完成 | GUI 面板 Gates → Approve |
| Contract | Baseline 复现后 | GUI 面板 Gates → Approve(冻结合同) |
| Budget | 预算超限 → BLOCKED_GATE | GUI 面板 Gates → Approve(resume) |
| Release | 复现包完成 | GUI 面板 Gates → Approve(显式发布决策) |

Agent 工具只有 `research_gate_request`(创建/列出);`research_phase` 不能
进入 Gate 控制状态(SCOPED/IDEA_APPROVED/CONTRACT_APPROVED/RELEASED)。

## 5. 无头/CI 模式

```bash
./scripts/dsh-dev --profile research-headless "/research status"
```
无人值守不会阻塞:遇到 Gate 时项目进入 BLOCKED_GATE,等待人类在 GUI 处理。

## 6. 常见问题

| 问题 | 处理 |
|---|---|
| 正式作业失败 "container execution required" | Runner 必须 `--mode docker`(subprocess 仅 smoke/echo) |
| 作业失败 "code_snapshot_required" | 先用 `workspace_snapshot` 归档代码,提交时带 `code_snapshot_id` |
| Gate 无法用工具批准 | 正确——决策仅人类 GUI;用面板按钮 |
| Claim 一直是 inconclusive | Evidence 未 verified 或缺 effect/CI/n_seeds;跑真实 Analysis |
| 预算超限项目卡住 | 面板 Budget/Gates → 批准 Budget Gate 恢复 |
| 想重置测试实例 | `rm -rf ~/.dsh-scholar-test && bash scripts/start-test-dsh.sh` |

## 7. 生产实例启用插件(可选)

```bash
./scripts/dsh-dev plugin --profile web add /home/dev/Desktop/dsh-scholar
./scripts/dsh-dev plugin --profile web add /home/dev/Desktop/dsh-scholar/packages/dsh-research-ui
# 重启生产 GUI 生效;kernel 端口错开(见 docs/test-instance-plan.md)
```
