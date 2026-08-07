# DSH Research OS(`@dsh-scholar/research-plugin`)

> ⚠️ **Security Alpha / Architecture Prototype(v0.2 整改中)**
>
> 按 `DSH_Scholar_v2.0.md` 整改路线推进:正式实验强制容器执行、Human Gate
> 不可被模型绕过、正式 Evidence 仅由 Analysis Worker 生成、Release Bundle
> 只能私有导出。**禁止作为无人值守正式科研系统发布**;`full-auto` 仅限
> fixture 评测项目。当前分支:`hardening/v0.2`。

一个可作为 **DSH(DeepSeek Harness)插件**使用的全自动科研系统:从领域论文调研、
Idea 生成、Baseline 复现、实验预注册与隔离执行,到 Claim-Evidence 账本、
论文与私有复现包生成。设计依据
`DSH_fully_automated_scientific_research_plugin_execution_design_document.md`。

## 安装

前置:DSH dev checkout(提供 `dsh` profile/plugin 命令),以及本仓库:

```bash
# 安装到 DSH 的 web profile(或任意 profile)
./scripts/dsh-dev plugin --profile web add /home/dev/Desktop/dsh-scholar
# 或从 GitHub 安装:
# ./scripts/dsh-dev plugin --profile web add github:lzszq/dsh-scholar#main
```

> 📖 **完整使用教程见 [`docs/USAGE_GUIDE.md`](docs/USAGE_GUIDE.md)**(安装、专属
> GUI 面板、Gate 审批、从项目创建到复现包的 10 步流程、常见问题)。

## 启动与使用

```bash
# 启动 DSH Web(插件会自动拉起 Research Kernel sidecar,:7412)
./scripts/dsh-dev --profile web
```

在 Web 会话中:

```bash
/research new my-study '{"problem":"...","scope":"...","primary_metrics":["macro_f1"]}'   # 创建项目 + Scope Gate
/research status                                                                          # 阶段/预算/Runs/证据/Gate
/research survey "temporal action localization"                                           # 文献调研 → Corpus 快照
/research ideas                                                                           # 查看候选 Idea
/research contract '{"idea_id":"...","dataset_id":"...","baseline":"...","treatment":"...","primary_metric":"..."}'
/research run formal                                                                      # 提交隔离实验作业
/research write                                                                            # 从证据账本生成论文草稿
/research review / export / release                                                        # 评审 / 私有复现包 / Release Gate(人工)
```

- 研究编排(Gate 批准、Idea 生成、实验设计等)由模型通过 `research_*` 工具完成;
  关键 Gate(Idea/Contract/预算/发布)由**人类批准**。
- 无头模式(CI/无人值守):`./scripts/dsh-dev --profile research-headless "<task>"`
- 独立测试实例(与生产 GUI 隔离):`bash scripts/start-test-dsh.sh` → `http://127.0.0.1:3081`

## 可选组件

- **独立 GUI 面板**:`dsh plugin --profile web add packages/dsh-research-ui`
  (标签页:Phase/Gates/Runs/Artifacts/Evidence/Budget,面板内 Gate 审批)

## 文档

- 设计与需求记录:`docs/design-notes.md`、`docs/security-baseline.md`、
  `docs/gui-plugin-plan.md`、`docs/test-instance-plan.md`
- 评测与测试:`evals/`、`tests/`(单元、故障注入、黄金路径 e2e、docker 隔离实测)

## 状态

- **Security Alpha**(整改中):P0 安全项(宿主执行、假实验、Gate 绕过、
  Evidence 伪造、Web 认证)为当前阻断项;正式实验仅限容器执行。
- 接口未冻结;`main` 不作发布分支,开发在 `hardening/v0.2`。
- 已有 Evidence 标记为 `legacy_unverified`,不得进入对外稿件。
