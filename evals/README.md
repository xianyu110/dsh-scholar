# 评测体系(design §11.3 / §11.4)

| 脚本 | 对应门槛 | 覆盖 | 结果(最近一次) |
|---|---|---|---|
| `fault-stress.sh [N]` | §11.4 恢复:100 次故障注入无重复/丢失 | 每轮:建项目→提交 job→kill -9→重启→幂等重提交→Gate 决策→校验 | **100/100 clean** |
| `survey-eval.sh [--live]` | §11.3 Survey:recall@K、去重率、引用解析 | 离线:DOI/arXiv/标题指纹去重;live:OpenAlex/Crossref/arXiv 真实检索 recall@20(Attention/BERT/ResNet) | 3/3 + dedup 2/3 |
| `clean-room-rerun.sh` | §13.1 DoD#9 / §4.8.6:空环境重跑 | 重建 bundle→销毁 DB→新 kernel+runner 重跑→容差对比 | 7/7 |
| `tests/unit/security.test.ts` | §11.4 安全:越权/注入/路径穿越/SSRF 面 | patch/快照路径逃逸、注入即数据、metrics 抗干扰、env 精简、连接器无 URL 参数 | 10/10 |
| `tests/fault-injection/*` | §11.2 P0 恢复用例 | kill -9、租约恢复、幂等、跨进程并发 Gate CAS | 6/6 |
| `tests/e2e/golden-path.sh` | §13.3 黄金路径 | 全生命周期含分析/图表/BibTeX | 15/15 |
| `docker-eval.sh` | §4.6.1 Runner 安全合同 | 真实 docker:非 root/禁网/1g 内存 OOM 强制/容器内失败分类/孤儿容器清理 | 11/11 |
| `baseline-eval.sh` | §11.3 Baseline | 复现容差内接受、容差外阻止比较 | 3/3 |
| `experiment-eval.sh` | §11.3 Experiment | 7 场景失败分类、成功率、预算硬停止 | 11/11 |

## 环境限制(已记录)

- **容器运行时**:已在本机安装 docker 29.1.3 并完成 `--mode docker` 实测
  (`evals/docker-eval.sh` 11/11,含 1g 内存 OOM 强制与孤儿容器清理)。
- **live 连接器评测**依赖外网;离线模式覆盖去重与指纹。

## 运行全部

```bash
pnpm test                                # 41 单元(含安全)
bash tests/fault-injection/run-fault-tests.sh
bash tests/e2e/golden-path.sh
bash evals/fault-stress.sh 100
bash evals/clean-room-rerun.sh
bash evals/survey-eval.sh --live         # 需外网
```

## Golden Path v2(design §19.3,真实执行)

`evals/golden-path-v2/run-golden-v2.sh` 是 v2 的端到端"真实执行"黄金路径:
不使用 LLM、不注入手工指标、无 message fallback。小型自包含 fixture 仓库
(`evals/golden-path-v2/fixture-repo/`:`train.js` / `baseline.js` /
`data/seed-data.json`,纯 Node,确定性)在 runner 的 `--mode docker` 路径下由
容器内真实 `node` 执行:

1. fixture-repo 打成确定性 tar,注册为 `kind='code'` CAS artifact 并做
   GET 完整性回读校验;
2. baseline 作业(`kind=baseline`,seed 0,容器内真实执行);
3. 3 个 formal 作业(`kind=formal`,seeds 1/2/3,容器内真实执行);
4. 每次运行在容器内写出 §12.5 固定 schema 的 `metrics.json`
   (`/tmp/metrics.json`,`/work` 只读且 runner 尚未物化 CAS),并从 run log
   校验该记录的每个字段;同时按当前 runner 机制打印 stdout JSON 行,两个
   通道的值必须一致;
5. 断言提取值与脚本自行计算的确定性预期一致、metric 随 seed 严格单调
   (证明真实计算而非伪造)、`n_samples` 来自数据文件;
6. `POST /v1/projects/{id}/analysis` 聚合真实 run,断言 mean / baseline_value
   / effect_size / seeds 与手工预期一致。

最近一次:`18/18`(两次连续运行一致;fixture tar 确定性 hash
`36cbd753…d65b67`,可重复)。

真实代码进容器的机制(已在 `workers/runner-gateway/src/index.ts`
`runDocker` 验证):runner 把 job workDir 挂到 `/work:ro` 并原样执行
`job.command`,但只有 smoke+script 会向 workDir 写文件;因此 baseline/formal
作业把 fixture 代码内联进 command(`sh -c` 用 heredoc 物化到容器可写的
`/tmp` 后执行 node)。依赖 docker(`docker info` 不可用则 exit 2)。

```bash
bash evals/golden-path-v2/run-golden-v2.sh
```

