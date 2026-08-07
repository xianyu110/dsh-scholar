# 需求:独立 DSH 测试实例(与生产 GUI 隔离)

> 状态:**需求已登记并实现**(2026-08-07)。本文件定义并记录独立测试实例的
> 动机、隔离边界、配置、启动方法与验证清单。

## 1. 动机

当前 DSH Web GUI 运行在 `127.0.0.1:3080`(`$DSH_HOME=/home/dev/.dsh`,
profile `web`),是日常生产面。直接在它上面测试科研插件存在相互影响:

| 风险 | 说明 |
|---|---|
| 会话/项目污染 | 测试产生的 research projects、jobs、gates 混入生产 sessions |
| Kernel 数据混用 | 生产与测试共享 `$DSH_HOME/research-kernel/kernel.db` |
| 插件版本覆盖 | 测试中装卸/降级插件影响生产 GUI 下次启动 |
| 端口/租约冲突 | kernel sidecar 固定 7412;runner lease 归属混淆 |

因此:**另起一个独立 DSH 实例专用于测试 dsh-scholar 项目**。

## 2. 隔离边界

| 维度 | 生产实例 | 测试实例 |
|---|---|---|
| DSH_HOME | `/home/dev/.dsh` | `~/.dsh-scholar-test`(可经 `DSH_SCHOLAR_TEST_HOME` 覆盖) |
| Web 端口 | 3080 | **3081**(可经 `DSH_SCHOLAR_TEST_PORT` 覆盖) |
| Kernel 端口 | 7412 | **17412**(profile patch 配置,防 sidecar 复用生产 kernel) |
| profile | `web` | `web`(**必须同名**:`dsh web` 是 `--profile web` 的别名,不会解析其他 profile 名) |
| 会话/项目 | 生产数据 | 测试数据,可随时删除重建 |
| Runner | 生产 runner(如有) | 测试 job 走同一 runner 但 kernel 不同,租约互不干扰 |

## 3. 一键启动

```bash
bash scripts/start-test-dsh.sh            # 首次自动初始化 profile + 安装插件
# 环境变量覆盖:
#   DSH_SCHOLAR_TEST_HOME=~/.dsh-scholar-test
#   DSH_SCHOLAR_TEST_PORT=3081
#   DSH_SCHOLAR_TEST_KERNEL_PORT=17412
```

脚本行为(幂等):
1. 创建 `$TEST_HOME` 与 profile `test-web`(不存在时);
2. `dsh plugin --profile web add <本仓库>`(未安装时),bundles 含
   `@dsh-scholar/research-plugin`;
3. 写入 profile `cordis.patch.yml`,id-targeted 覆盖
   `research-plugin.config.kernel.port` 为测试 kernel 端口;
4. 以 `DSH_HOME=$TEST_HOME` 启动 `dsh web --port $PORT`;
5. 打印访问地址与验证命令。

## 4. 验证清单(每次启动后)

- [ ] `http://127.0.0.1:3081` 返回 200;
- [ ] 测试 kernel 健康:`curl http://127.0.0.1:17412/v1/health`(注意:不是 7412);
- [ ] `/research-api` 桥经测试实例可达:`curl http://127.0.0.1:3081/research-api/v1/health`;
- [ ] client bundle 可加载:`curl -s http://127.0.0.1:3081/plugins/@dsh-scholar/research-plugin/client.js | head`;
- [ ] 生产实例(3080)不受影响;两实例 kernel 数据目录不同。

## 5. 清理

```bash
# 停止测试实例(按 pid):
#    pkill -f 'lib/bin.js web --host 127.0.0.1 --port 3081'
# 删除测试数据(整个实例重置):
#    rm -rf ~/.dsh-scholar-test
```

## 6. 已知坑(已解决,记录在案)

- **`dsh web` 固定解析 profile `web`**:早期版本脚本创建 `test-web` profile,
  结果 `dsh web` 自动初始化了**空的 web profile**(无插件),表现为"web 起来
  了但插件/kernel/桥/面板全部缺失"。修复:独立 home 内的 profile 必须命名为
  `web`。排查结论:组合树(dump-config)与运行时加载可能不一致——以运行时
  探活为准(bridge / kernel 端口 / boot manifest entries)。
- **Kernel 端口必须显式覆盖**:sidecar 默认 7412;测试实例若不覆盖会复用
  (或冲突)生产 kernel。patch 用 id-targeted 行替换 config(insert 重复行
  无效)。

## 7. 后续演进(登记)

- 测试实例接入自动化:每次 push 后重建测试实例并跑 `evals/*` 冒烟;
- 可选:测试实例挂 `--dev` 支持前端 HMR(需要 `pnpm run dev:web`);
- 可选:多实例矩阵(不同 DSH snapshot / 插件版本)验证兼容性。
