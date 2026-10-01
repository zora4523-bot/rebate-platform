# ops/：任务台账与门禁数据

这里放「机器要读、负责人要认」的几份数据。规则出处是规划仓库 `规划/11_开发协作与自主推进.md`（下称 11）。在途状态、额度账本、任务书、交接都**不在**这里，它们在仓库外的 `couli-runs/`，不入库。

| 文件 | 是什么 | 谁能改 | 出处 |
| --- | --- | --- | --- |
| `tasks/<编号>.yaml` | 任务台账，一任务一文件，每个不超过 40 行。入库的 `status` 只有 `todo` 和 `done`；`done` 在该任务自己的 PR 里改。风险级不写在文件里，由 `tools/guard/risk-of-paths.ts` 按 `paths` 算。格式见规划仓库 `docs/templates/task-ledger.md` | 编排会话（Claude 主会话）。实现代理不能改 `ops/` 下任何文件 | 11 §2.1 |
| `tasks/archive/<年月>/` | `done` 满 30 天的任务文件移到这里；看板和开场必读不含归档 | 编排会话 | 11 §2.1 |
| `evidence/<编号>.json` | 每个 PR 的证据文件：只记结论、哈希和测试编号。格式见 `evidence/README.md` | 只由脚本生成（生成器还没有） | 11 §3.2 |
| `risk-map.yaml` | 路径 → 风险级与分工的白名单；没列到的路径一律 RV2。根 `AGENTS.md` 的分工表由它生成 | 保护路径第三类：改动要负责人看过中文前后对比并确认 | 11 §1.2、§4.4 |
| `approvals.yaml` | 负责人确认过什么的机器可读副本，与 11 §7.3 批准栏逐行对应。「负责人已同意」只认这一份 | 保护路径第三类；负责人在对话里答复的当轮由编排会话写入并提交 | 11 §5.2、§7.2、§7.3 |
| `branch-protection.json` | GitHub 规则集的导出件；每晚与线上设置比对 | 保护路径第三类 | 11 §3.2、§5.4 |

常用命令：

| 用途 | 命令 |
| --- | --- |
| 校验台账 | `pnpm ops:task:check` |
| 看板 | `pnpm ops:status` |
| 生成任务书 | `pnpm ops:brief <编号>` |
| 算 `refs_hash` | `node tools/ops/task.ts hash <编号>` |

新任务入账的做法：照模板写 `tasks/<编号>.yaml`（编号沿用 05 的原编号，拆分加小写字母后缀），`refs_hash` 先随便填，跑 `node tools/ops/task.ts hash <编号>` 把输出粘回去，再跑 `pnpm ops:task:check`。规划原文变了导致哈希对不上时，检查会报「task is stale」：先开同步任务，不要直接改哈希。

现有任务：`tasks/B2-01a.yaml` 是 10-04 试跑整个循环用的第一个真实任务（11 §9.2），从 05 的 B2-01 里拆出 `packages/money` 这一块。
