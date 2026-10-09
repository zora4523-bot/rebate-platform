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
| `red_tests` | 规则测试先红时的测试名列表（红的原因必须是断言失败、断言型的属性反例或骨架的 `NotImplemented`） | `verify-container.sh --red` 的 `red/<n>/result.json` 的 `red_tests` |
| `runs[]` | 每一次沙箱外运行：`mode`（`container`；`host` 一律拒绝，`ci` 暂不接受）、`script`（`verify` 或 `red`）、`commit`、`tree`、`prop_seed`、`exit_code`、起止时间。2026-10-06 起（`ops/approvals.yaml` 第 21 条）完整验证看 PR 头提交上的必过 CI 检查，检查器不再要求容器 `verify` 记录；列出的容器 `verify` 记录须 `exit_code: 0` 且 `tree` 等于头提交树（不含本证据文件）；`runs` 可为空列表，先红要求见下 | `couli-runs/<编号>/{verify,red}/<n>/result.json`，由 `tools/ops/verify-container.sh` 写出，字段同名 |
| `reviews[]` | 每条评审的结论：`reviewer`（`codex`；台账 `impl: codex` 的任务另有 `claude`）、`verdict`、未关闭的 S0 / S1 数、资金清单是否齐全 | 评审输出（`tools/agent/schemas/review.schema.json`） |
| `handover` | 只在超限换家时有（规划/11 §2.5）：`implementer`（`codex`）、`commit`（换家实现提交）、`note`（原因）。换家时 Claude 评审条目另写 `commit`（评审对象：换家实现提交或其后、头提交的祖先），见下面的合并规则 | 编排者 |
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
    { "reviewer": "codex", "verdict": "pass", "open_s0_s1": 0, "checklist_complete": true }
  ],
  "trees": { "packages/money": "<树哈希>" },
  "longrun": { "runs": 1000000, "seed": 20261001, "passed": true, "tree": "<树哈希>" }
}
```

`mode: ci`：**暂不接受**（Codex 评审 CR2-06，2026-10-05）。CI 证据归档 `rebate-private/ci-evidence/<run_id>/` 还没接入，检查器核对不了运行、报告内容（实际跑了哪些测试、失败原因、跳过数）和浏览器 job 身份，所以任何 `mode: ci` 记录都报「CI 证据归档未接入，暂不接受」。接入后的口径见规划/11 §3.2（运行链接与 `run_id`、`run_attempt=1`、工作流与 job、被测提交与树哈希、报告 sha256；红测绑定 `spec_commit` 的树，绿测为头提交的祖先且只差本任务证据文件）。

红测（Codex 评审 CR2-05、CR3-03）：除了台账 `tester: none` 的任务和 `tools/guard/legacy-tasks.json` 里的旧台账，其余任务，证据必须有一条有效的容器红测记录：`script: red`、`exit_code: 0`（red-check 通过）、`tree` 等于 `spec_commit` 的树、`expected` 覆盖本任务在 `test_paths` 内新增的每个规则测试文件（基线到 `spec_commit`）、每个文件在 `red_tests` 里至少有一条；缺了就拒绝。台账读不到也拒绝。

合并规则：`runs[].mode` 为 `host` 的结果一律不接受（11 §2.3 第 7 步；宿主回退已取消），完整验证以 PR 头提交上的必过 CI 检查为准（`ops/approvals.yaml` 第 21 条，2026-10-06 起），证据文件里的容器 `verify` 记录可选；长跑结果绑定树哈希，不绑定提交号（11 §3.2）。检查器逐项核对：`task` 等于分支 `task/<编号>` 的编号；`spec_ref` 等于头提交的 `SPEC_REF`；`spec_commit` 是头提交的祖先，且此后第一类测试资产只增未改；`reviews[]` 里 `codex` 是 `pass`、`open_s0_s1` 为 0、`checklist_complete` 为 true；2026-10-09 起（`ops/approvals.yaml` 第 27 条）Claude 写的实现只由 Codex 新只读会话对抗评审，不再要求 `claude` 条目，有 `claude` 条目时照样要 `pass`、`open_s0_s1` 为 0；台账 `impl: codex`（第 23 条，Codex 实现）或台账读不到的任务仍要求 `claude` 条目（实现方不评审自己）（换家例外见下段）；`trees` 里每条路径的树哈希等于 `git rev-parse <头提交>:<路径>`；`longrun.passed` 为 true 且 `longrun.tree` 是 `trees` 里的某个值。

换家（规划/11 §2.5，CR-09）：Opus 实现轮次用完、Codex 实现一次之后，Codex 不评审自己的实现，证据写 `handover`，只要求 Claude 评审通过。检查器只在这些条件都满足时接受：

- 台账（可信副本，没有才读头提交）的 `paths` 按风险图算出低于 RV2；PR 没改资金与归属实现路径（`MONEY_PATHS`）；除第一类规则测试资产、本任务台账与证据文件、`docs/**` 之外的改动也低于 RV2——RV2 不换家。
- `handover.commit` 是 `spec_commit` 之后、头提交祖先上的单亲提交，标题带 `(handover, Codex)`，至少改了一条台账 `paths` 内的文件，且只改台账 `paths` 与 `ops/tasks/<编号>.yaml`。
- 至少有一条 `claude` 条目的 `commit` 是换家实现提交或其后、头提交的祖先（spec-test 评审不算）；这样的条目全部 `pass`、`open_s0_s1` 为 0、`checklist_complete` 为 true；评审提交到头提交之间只改了本任务证据与台账文件。

任一条不满足，换家记录不算数，照旧按上面的合并规则要求评审（这时要去掉 `handover`、补齐评审）。路径守卫（guard-git）另外保证所有改动都在台账 `paths` 内。
