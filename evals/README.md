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
