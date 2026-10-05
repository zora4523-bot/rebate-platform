# ops/evidence/：证据文件

每个 PR 带一份 `ops/evidence/<任务编号>.json`，只记结论、哈希和测试编号（规划仓库 `规划/11` §3.2）。评审意见全文、blocked 根因放私有库，不放这里。

现状：本目录还没有任何证据文件，也还没有生成器；检查器已经有了。

- TODO(规划/11 §3.2): 证据文件生成器（放 `tools/ops/`） — blocked on B2-01a（10-04 试跑跑通一轮循环后定字段；字段的形状已由检查器固定，见下表）
- CI 必过检查 `evidence-check`（`tools/ci/evidence-check.ts`，`.github/workflows/evidence.yml`）：改动路径按可信副本的 `ops/risk-map.yaml` 算出 RV2 的 PR，必须带本文件且全部字段过检（例外见下面的负责人豁免）；RV0 / RV1 的 PR 直接通过（有证据文件时照样校验）。本地可跑：`node tools/ci/evidence-check.ts --pr <检出> --base <基线提交> --head <头提交> --head-ref task/<编号>`。生成器落地前，RV2 的首次合并由编排者按下表手写一份并用这条命令自检。
- 负责人豁免（负责人 2026-10-02 决定，`ops/approvals.yaml` 第 12 条）：分支不是 `task/<编号>` 的 RV2 PR（测试改动、门禁改动这类），带有效负责人批准标签 `owner-approved-<头提交前 12 位>`（由仓库所有者账号添加，判断与 `protected-paths` 检查相同，实现在 `tools/guard/lib/owner-approval.mjs`）时不要求证据文件——**前提是**没有改动资金与归属实现路径：`packages/money/src/**`、`packages/domain/src/**`、`apps/api/src/modules/{ledger,commission,settlement,payout,withdrawals,reconciliation,orders,linking,union}/**`、`db/migrations/**`（检查器里的 `MONEY_PATHS`）。改到其中任何一处，照旧必须带证据文件，标签不起作用。`task/` 分支不受影响。CI 传 `--pr-number`，检查器只在标签能改变结论时才查 GitHub。
- TODO(规划/11 §3.2): 资金路径 `run_attempt` 不大于 1（不许重跑到绿） — blocked on GitHub remote

证据文件只由脚本生成，不手写、不手改（生成器落地前的例外见上）。

## 格式（11 §3.2）

| 字段 | 含义 | 来源 |
| --- | --- | --- |
| `task` | 任务编号 | `ops/tasks/<编号>.yaml` |
| `spec_ref` | 写规则测试和实现时对应的规划版本 | 仓库根 `SPEC_REF` |
| `spec_commit` | 规则测试提交号；之后规则测试不得改动。CI 的 guard-git 也读它：核对它是头提交的祖先、基线的后代后，路径守卫从它起算，它之前的提交按规则测试作者的路径检查（`tools/README.md`「任务分支按 spec_commit 分段」，`ops/approvals.yaml` 第 14 条） | `couli-runs/state/<编号>.json` |
| `red_tests` | 规则测试先红时的测试名列表（红的原因必须是断言失败、属性反例或骨架的 `NotImplemented`） | `tools/guard/red-check.ts --json` 的 `red` |
| `runs[]` | 每一次沙箱外验证：`commit`、`tree`、`prop_seed`、`exit_code`、`mode`（`container`、`host` 或 `ci`）、起止时间。检查器要求至少一条 `mode: container`、`exit_code: 0` 且 `tree` 等于头提交去掉本证据文件后的树哈希（验证在写证据之前跑，证据文件不可能在它描述的树里） | `couli-runs/<编号>/verify/<n>/result.json`，由 `tools/ops/verify-container.sh` 写出，字段同名（`verify-fast/<n>/` 是实现子代理自己跑的，不进证据） |
| `reviews[]` | 每家评审的结论：`reviewer`（`claude` / `codex`）、`verdict`、未关闭的 S0 / S1 数、资金清单是否齐全 | 评审输出（`tools/agent/schemas/review.schema.json`） |
| `trees` | 受保护代码目录的树哈希：路径 → `git rev-parse HEAD:<路径>` | git |
| `longrun` | 长跑属性测试：次数、种子、结果、对应的资金目录树哈希 | 长跑运行 |

示意（字段名在生成器落地时以它为准）：

```json
{
  "task": "B2-01a",
  "spec_ref": "<40 位提交号>",
  "spec_commit": "<提交号>",
  "red_tests": ["money: mulDivFloor 向下取整"],
  "runs": [
    { "mode": "container", "exit_code": 0, "commit": "<提交号>", "tree": "<树哈希>", "prop_seed": 20261001 }
  ],
  "reviews": [
    { "reviewer": "claude", "verdict": "pass", "open_s0_s1": 0 },
    { "reviewer": "codex", "verdict": "pass", "open_s0_s1": 0, "checklist_complete": true }
  ],
  "trees": { "packages/money": "<树哈希>" },
  "longrun": { "runs": 1000000, "seed": 20261001, "passed": true, "tree": "<树哈希>" }
}
```

`mode: ci`（规划评审 RO2-05、RO3-01，2026-10-05）：暂时只能在 CI 跑的检查（浏览器测试）。它是容器那一条之外的补充，不能代替；每一条 CI 运行都要绑定：`commit` 是被测提交的完整 SHA，必须是头提交或它的祖先，且两者去掉本任务证据文件后的树哈希相同（证据入库产生的新提交不影响；源码、测试、配置有任何变化须重新跑）；`spec_commit` 等于本证据的 `spec_commit`；`run_attempt` 为 1、`conclusion` 为 `success`、`skipped` 为 0、`exit_code` 为 0。不是「被测提交必须等于头提交」。

合并规则：RV2 不接受 `runs[].mode` 为 `host` 的结果（11 §2.3 第 7 步）；长跑结果绑定树哈希，不绑定提交号（11 §3.2）。检查器逐项核对：`task` 等于分支 `task/<编号>` 的编号；`spec_ref` 等于头提交的 `SPEC_REF`；`spec_commit` 是头提交的祖先，且此后第一类测试资产只增未改；`reviews[]` 里 `claude` 与 `codex` 都是 `pass`、`open_s0_s1` 为 0、`codex` 的 `checklist_complete` 为 true；`trees` 里每条路径的树哈希等于 `git rev-parse <头提交>:<路径>`；`longrun.passed` 为 true 且 `longrun.tree` 是 `trees` 里的某个值。
