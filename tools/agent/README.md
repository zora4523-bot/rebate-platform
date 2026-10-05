# tools/agent：Codex 调用包装与派工

这里是本仓库调用 Codex 的唯一入口，也写明 Claude 实现子代理怎么派。规则出处：规划仓库 `规划/11_开发协作与自主推进.md` §1.1、§2.2–§2.5、§3.1、§3.3、§4.3、§9.3。本目录属于保护路径第三类（门禁与规则），改动要负责人确认。

一句话：`codex-run.sh` 把 Codex 关在固定的沙箱参数里跑一次，跑完告诉编排者「有没有可用产出」；任务做没做对，不看它，只看沙箱外的 `pnpm verify`。

**默认分工（负责人 2026-10-05，`ops/approvals.yaml` 第 19 条；规划/11 §1.1）：Opus 实现、Codex 写测试与评审。**

| 谁 | 做什么 | 经什么 |
| --- | --- | --- |
| Claude Opus 5.5 子代理（`claude-opus-5-5`） | 主实现，所有区域 | 编排会话用 Claude Code 的 Agent 能力起，见 §10 |
| Codex | 实现前写规则 / 验收测试和只抛 `NotImplemented` 的骨架，先红 | `codex-run.sh impl <id> --phase test`（`dispatch.sh <id>`） |
| Codex 新只读会话 | 对抗评审（所有区域） | `codex-run.sh review <id>` |
| Claude 新子代理（不是实现那个） | RV2 的第二家评审；规则测试过审（spec-test） | §11 |
| Codex（换家，一次） | Opus 超限后的 RV0 / RV1 实现 | `dispatch.sh <id> --handover`（`codex-run.sh impl --phase handover`） |

**执行边界**（规划第 2 轮评审 RO2-01/04）：Codex 沙箱里只做不执行测试的静态检查（类型检查、lint）；任何运行测试的命令都由编排者在隔离容器（`tools/ops/verify-container.sh`）或 CI 里跑；Codex 生成的任何可执行内容（规则测试、骨架、换家实现）都不在宿主上运行。Opus 实现子代理跑测试也只经 `verify-container.sh <id> --fast`，因为里面有 Codex 写的测试。`verify-container.sh` 没有宿主回退（CR-01）：Docker 用不了就停下，交给 CI。

**谁实现的就不评审谁**：台账 `tester` 不是 `claude` 时（Codex 写的或读不到作者）`codex-run.sh review --review-type spec-test` 一律拒绝（CR-08）；换家后（在途状态 `implementer: codex`，或运行目录里有 `phase: handover` 的调用）Codex 的代码评审一律拒绝，改由 Claude 新子代理按 §11 的做法评审（CR-09）。`codex-run.sh impl` 核对任务书「本轮阶段」与 `--phase` 一致，不一致拒绝（CR-14）。

## 1. 文件

| 文件 | 作用 |
| --- | --- |
| `codex-run.sh` | 包装脚本：`impl`（`--phase test` 写测试 / `--phase handover` 换家实现）、`review`、`selfcheck` |
| `supervise.pl` | 进程组监管：硬超时、无活动看门狗、整组击杀、确认组内无存活进程 |
| `dispatch.sh` | 派工前检查 + 后台启动一次 Codex 写测试（或 `--handover` 换家实现） |
| `post-run.sh` | Codex 运行结束后：先跑守卫，再给出下一步动作 |
| `next-action.ts` | `post-run.sh` 的判定表（纯函数，有单测） |
| `validate-output.ts` | 产出校验：schema（Ajv2020 strict）+ 评审规则 + 资金清单；规则测试评审的范围外条目移进 `out_of_scope`、重算结论、追加到 `out-of-scope.md` |
| `meta.ts` | 给 bash 用的 JSON 读写小工具、事件流解析 |
| `common.sh` | 三个脚本共用的路径解析与进程组函数 |
| `schemas/impl.schema.json`、`schemas/review.schema.json` | 结构化产出的 schema（每个 object 都是 `additionalProperties:false` + 全字段必填）；评审产出另有 `out_of_scope`（任务 refs 以外的问题，不计入结论） |
| `prompts/review-{money,general,contract,spec-test}.md` | 四种评审提示词；`spec-test` 现由 Claude 新子代理使用（§11），其余三种 Codex 与 RV2 的 Claude 评审子代理共用 |
| `testing/` | 测试用假 `codex`（`couli-fake-codex.sh`）和夹具；不连模型、不耗额度 |

## 2. 命令

```bash
# Codex 写规则测试（默认 --phase test）或换家实现（--phase handover，只限 RV0 / RV1）
# 任务书必须已在 <runs>/<id>/brief.md（brief.ts --phase test|handover）
tools/agent/codex-run.sh impl <id> [--phase test|handover] [--worktree <dir>] [--timeout-min <n>] [--dry-run]

# 评审（只读沙箱）
tools/agent/codex-run.sh review <id> [--worktree <dir>] \
  [--review-type money|general|contract|spec-test] [--base <ref>] [--timeout-min <n>] [--dry-run]

# 自检：不发起任何 Codex 回合，不耗额度
tools/agent/codex-run.sh selfcheck

# 派工（后台）与收尾：默认是 Codex 写测试；--handover 是换家实现
tools/agent/dispatch.sh <id> [--handover]
tools/agent/post-run.sh <id>

# 单独校验一份产出
node tools/agent/validate-output.ts --schema <schema> --file <json> [--money] [--refs <BR-…,BR-…>] [--allowed-paths <glob,glob>] [--rewrite] [--out-of-scope-log <md>] [--diff-base <ref> --cwd <worktree>] [--json]
```

- `<id>` 是台账编号（如 `B2-03a`）。`<runs>` 默认是仓库旁边的 `couli-runs/`，worktree 默认 `<runs>/worktrees/<id>`。
- `--review-type` 不传时按任务的风险级定：RV2 → `money`（资金清单强制），其余 `general`。RV2 任务不接受 `general`。台账 `tester: codex` 的任务不接受 `--review-type spec-test`（退出 2）：Codex 不评审自己写的规则测试，规则测试过审交 Claude 新子代理（§11）。
- `--phase` 只用于 `impl`，不传是 `test`；写进 `meta.json` 的 `phase`，`tools/ops/state.ts` 据此把这次调用记在 `test` 或 `handover` 计数器上，不记进实现次数（RO-07）。`handover` 只接受可信副本 `task.ts show` 算出 RV0 / RV1 的任务。
- `--base` 不传时取 `HEAD` 与 `origin/main`（没有则 `main`）的分叉点。
- `--timeout-min` 只能调小：实现上限 30 分钟、评审 15 分钟（规划/11 §2.2）。超时的任务要拆小，不是加时间。
- `--dry-run` 把将要执行的 argv 一行一个打印出来（参数里的换行显示为 `\n`），不启动 Codex、不写任何文件。

## 3. 包装脚本保证什么

1. **命令固定**。实现与评审的 argv 就是规划/11 §2.4 那两条，写死在脚本里；调用方传不进任何 Codex 参数。评审提示词后面追加的「Review context」一段（任务编号、基线、任务 refs、改动文件列表、任务书）是包装脚本自己加的，§2.4 原命令里没有。
2. **stdin 关闭**（`/dev/null`），带 `COULI_CODEX_WRAPPER=1`。
3. **位置断言**。启动前：worktree、它的 git 目录、`<runs>`、可信副本都不在 `/tmp`、`/private/tmp`、`$TMPDIR` 下，否则退出 12；脚本自身或 `COULI_TRUSTED_ROOT` 位于 `couli-runs/worktrees/<编号>` 下（任务 worktree）一律拒绝，退出 2。结束后：HEAD、当前分支、分支列表、`refs/stash`、暂存区、本地 git 配置（不含 `branch.*`）、`.git/hooks` 与启动前一致，否则退出 12，产出作废。分支列表里只放过一种变化：**别的任务的分支**（`refs/heads/task/<别的编号>`）新增、移动或删除，因为编排者会在本次运行期间给别的任务建 worktree、提交规则测试；这种变化只记进 `meta.json` 的 `other_task_branches_changed`。
4. **超时杀整组**。Codex 在独立进程组里跑；硬超时或无活动时对整组先 TERM、等 `COULI_KILL_GRACE_SECS`（默认 5 秒，上限 5，只能调小）、再 KILL，确认组内没有存活进程后才去看 `-o` 文件。「无活动」= 事件文件没有新内容 **且** 这次运行的进程没有消耗 CPU（实现 5 分钟 / 评审 12 分钟；每秒扫一次进程表，CPU 时间在窗口内增长不到窗口的 5% 算静止）：沙箱里一条跑很久、不打事件的 `pnpm test` 不会被误杀。监管脚本还记住组长的全部后代（含用 `setsid` 脱离进程组的；靠继承的一个文件描述符在收尾时再找一遍，Linux 用 `/proc`，macOS 用 `lsof`），收尾时一并结束。包装脚本自己被 TERM / INT / HUP 时同样杀整组。Codex 正常退出但留下后台进程（`stragglers_killed`）或有后代脱离了进程组（`escaped_killed`）的，进程被清掉，这一次按**无产出**处理（退出 10，`-o` 改名 `.rejected`）：被强制清理过的运行里写出来的东西不当作模型的回答。
5. **旧产出不会被当成新产出**。每次调用前把上一次同模式的产出挪进 `attempts/<n>/`，并确认 `-o` 文件不存在；本次没被接受的 `-o`（包括击杀之后才写出来的）改名为 `*.rejected`。
6. **成败判定**（规划/11 §2.4）。四条同时成立才算有产出：Codex 退出码 0、事件流最后一条是 `turn.completed`、`-o` 存在、通过可信副本里的 `validate-output.ts`。
7. **门禁从可信副本读**。schema、提示词、校验器、`usage.ts`、守卫都取自 `COULI_TRUSTED_ROOT`（默认：`<runs>/trusted/rebate-platform` 存在就用它，否则脚本所在的主检出），不读任务 worktree：脚本从 `couli-runs/worktrees/<编号>` 下运行、或 `COULI_TRUSTED_ROOT` 指到那里，直接拒绝（退出 2），没有静默回退。
9. **真正的 codex**。只用 `command -v codex`（垫片算数，它会转给真正的二进制），且它的物理路径不能在仓库、worktree、`couli-runs` 或临时目录下。`COULI_CODEX_BIN` 只给测试夹具用：必须同时设 `COULI_AGENT_TEST=1`，且运行目录位于某个 `.tmp` 目录下，否则拒绝（退出 2）。
10. **评审范围只到任务的 refs**（负责人 2026-10-02 决定，`ops/approvals.yaml` 第 13 条）。包装脚本从可信副本的 `task.ts show` 取任务的 `refs`，写进评审上下文一行「In-scope rules (the task's refs)」。规则测试评审（spec-test）只对照这些 BR 的条款；一跳引用的规则只作理解用；关于 refs 以外规则的问题写进 `out_of_scope`，不计入 `verdict`。资金评审提示词带同样的范围说明（仓库硬规则与七项清单始终在范围内）。spec-test 评审校验时带 `--refs`：`findings` 里只引用 refs 以外 BR 编号的条目记一条警告（进 `meta.json` 的 `validation_messages`），不算 S0 / S1——「pass 带 S0 / S1」的矛盾检查不数它，只因它而 `fail` 的另记一条「范围内是 pass」的警告。
12. **规则测试评审还以任务 `paths` 为界**（负责人 2026-10-02 决定，`ops/approvals.yaml` 第 14 条）。spec-test 评审的上下文多一行「Allowed paths」（任务 `paths`，取自可信副本的 `task.ts show`），校验时带 `--allowed-paths`；规则测试目录（可信副本 `tools/guard/protected-paths.json` 第一类）自动算在范围内。下面几种 `findings` 条目算范围外：只引用 refs 以外的 BR；`file` 在任务 `paths` 与规则测试目录之外；正文引用的仓库路径全在其外；`rule` 以评审方的范围标记 `[out-of-scope]` 开头。校验带 `--rewrite`：通过校验后把这些条目移进 `-o` 文件的 `out_of_scope`，`verdict` 只按范围内的 S0 / S1 重算（有就 `fail`，没有就 `pass`），每条移动与结论改变都记一条警告进 `validation_messages`；再带 `--out-of-scope-log <runs>/<id>/out-of-scope.md`：把全部 `out_of_scope` 条目（评审方自己写的和移进来的）按 `key` 去重追加进这个文件（不存在就建），留给后续任务写规则测试。校验不过的产出不改写、不追加。资金评审不变。
11. **评审类型跟着风险级**。`--review-type` 不传时，可信副本的 `tools/ops/task.ts show <id>` 算出 RV2 就用 `money`（强制资金清单），否则 `general`；RV2 任务显式传 `general` 被拒绝（`contract`、`spec-test` 仍可用）。评审产出里 `verdict: pass` 却带 S0 / S1 发现的，按无产出处理（退出 10）。
8. **每次调用都记账并结算轮次**：结束后调用 `tools/ops/usage.ts record`（规划/11 §1.3；只记 token 用量，额度不设限制，记账失败只记警告、不改退出码），再调用 `tools/ops/state.ts settle <id> --meta <meta.<mode>.json>`：没有产出就结束的调用（见 §4）把派发前计上的那一轮还回去；它的 `meta.<mode>.json` 照样留在运行目录，仍计入每任务 10 次与「连续 3 次无产出」两道失败熔断（`state.ts taskCalls`）。`settle` 按调用的 `started_at` 去重，重复执行不会多还；没有在途状态文件时什么都不做；它失败只记警告，这一轮按已计处理。

有产出不等于任务成功。Codex 说「测试通过」不算数，成败只看 `tools/ops/verify-container.sh` 的退出码。

## 4. 退出码

| 退出码 | 含义 | 编排者怎么处理 |
| --- | --- | --- |
| 0 | 有可用产出 | `post-run.sh` → 守卫 → 沙箱外验证 |
| 10 | 没有可用产出（退出码非 0、缺 `turn.completed`、缺 `-o`、校验不过、被中止） | 退避重试。没拿到回答（`validation` 为 `not-run`：缺 `-o`、`turn.failed`、退出码非 0、被中止、留下进程）不计轮次；拿到回答但校验不过（`validation: failed`）计一轮 |
| 11 | 模型容量错误（`Selected model is at capacity`） | 退避重试，不计轮次，仍计入每任务 10 次；不计入连续无产出 |
| 12 | 位置断言失败 | 按越界处理：不执行、不提交这个 worktree 里的任何东西，先人工看 `meta.json` 的 `position_changed` |
| 124 | 硬超时或无活动被击杀 | 不计轮次，仍计入每任务 10 次与连续无产出；反复超时说明任务要拆小 |

「计不计轮次」由 `tools/ops/state.ts settle` 判定（规划/11 §2.5，负责人 2026-10-02 决定）；位置断言失败（12）照计。
| 2 | 用法错误，或参数被拒绝 | 修正调用；Codex 没有被启动 |

`selfcheck`：0 通过，1 有检查项失败。

## 5. 运行目录 `<runs>/<id>/`

| 文件 | 内容 |
| --- | --- |
| `brief.md` | 任务书（`pnpm ops:brief <id>` 生成），实现与评审共用 |
| `impl.json`、`events.jsonl`、`err.txt` | 实现的结构化产出、事件流、stderr |
| `review-codex.json`、`review-events.jsonl`、`review-err.txt` | 评审的同三样 |
| `meta.json` | 最近一次调用的结果；`meta.impl.json` / `meta.review.json` 是按模式各留的一份 |
| `*.rejected` | 没被接受的 `-o` 文件，留作排查 |
| `wrapper-impl/`、`wrapper-review/` | 包装脚本的工作文件：实际发给 Codex 的提示词（`prompt.md`）、进程组号、监管结果、前后位置快照、校验信息 |
| `attempts/<n>/` | 之前各次调用的产出，`n` 按调用先后递增（不是 attempts 计数），每个目录带当次的 `meta.json` |
| `dispatch.log` | `dispatch.sh` 后台启动的那次包装脚本的输出 |
| `post-run/` | `post-run.sh` 取到的状态与守卫输出 |
| `verify/<n>/` | 沙箱外验证的日志与结果（`tools/ops/verify-container.sh` 写） |
| `out-of-scope.md` | 规则测试评审范围以外的条目，按 `key` 去重累积追加（`validate-output.ts --out-of-scope-log` 写，不随 `attempts/` 归档）；编排者据此给后续任务写规则测试 |

`meta.json` 字段：`mode`、`phase`（只 `impl` 有：`test` / `handover`）、`task`、`worktree`、`run`、`started_at`、`finished_at`、`exit_code`、`codex_exit`、`timed_out`、`idle_killed`、`aborted`、`has_output`、`capacity_error`、`head_before`、`head_after`、`thread_id`、`codex_version`、`model`、`last_event`、`pgid`、`group_gone`、`stragglers_killed`、`validation`、`validation_messages`、`position_changed`、`other_task_branches_changed`、`timeout_secs`、`idle_secs`、`wrapper_pid`、`output_file`、`events_file`，评审另有 `review_type`、`base`。`has_output` 只表示产出通过了校验；位置断言失败时 `exit_code` 仍是 12。

## 6. 禁止的用法（规划/11 §2.4 禁用）

- 不经本脚本直接跑 `codex exec`；不带 `-s` 或不带 `--ignore-rules` 的 `codex exec`。
- `--dangerously-bypass-approvals-and-sandbox`、`danger-full-access`。
- `sandbox_workspace_write.network_access=true`（一开就同时放开 Docker、本机数据库和外网）。
- 独立的 `CODEX_HOME`（会丢登录）。环境里设了非默认的 `CODEX_HOME`，脚本直接拒绝。
- Codex 自带的 `--worktree`、`--add-dir`、`resume`、任何 `sandbox_mode` 覆盖。
- `exclude_tmpdir_env_var`、服务档位、`--ephemeral`：脚本不会加，也传不进去。

调用方的参数里只要出现 `network_access`、`sandbox_mode`、`--add-dir`、`--dangerously-bypass-approvals-and-sandbox`、`--worktree`（本脚本自己的 `--worktree <目录>` 除外）、`danger-full-access`、`resume`、`CODEX_HOME`，或任何脚本不认识的参数，一律退出 2。

## 7. 派工与收尾

`dispatch.sh` 只派 Codex 的 `impl` 模式运行，分两种（`ops/approvals.yaml` 第 19 条）：

| 调用 | 阶段 | 计数器 | 任务书 | 前提 |
| --- | --- | --- | --- | --- |
| `dispatch.sh <id>` | `test`：Codex 写规则测试与骨架 | `attempts.test`（3 次） | `brief.ts --phase test` | 在途状态没有 `spec_commit`（有了就停，`spec-commit-exists`：测试已冻结，实现交 Opus，§10） |
| `dispatch.sh <id> --handover` | `handover`：Opus 超限后 Codex 实现一次 | `attempts.handover`（1 次） | `brief.ts --phase handover` | 可信副本算出 RV0 / RV1；RV2 停（`handover-refused`，规划/11 §2.5） |

已有的 `brief.md` 只在它的「本轮阶段」行与这次阶段相同时复用；否则重新生成，免得把写测试的任务书交给实现、或反过来。

`dispatch.sh <id>` 先用 `mkdir <runs>/<id>/dispatch.lock` 取一把只在本次派工期间存在的锁（10 分钟没清掉的视为残留），再按顺序检查，任何一步不过就停（没有额度闸门）：认领任务（owner 是 `COULI_SESSION`，不设则本进程唯一；只有认领已被同一 owner 持有时才 `--renew`）→ 上一次派工记录的 pid 还活着就停（`run-in-progress`）→ 阶段前提（上表）→ **先把这一阶段的尝试次数加一**（每次都加；上一次调用若没有产出就结束，包装脚本结束时已经把那一轮还回去了；该任务的失败熔断打开时 `bump-attempt` 退出 3，派工输出 `{"action":"stopped","reason":"task-breaker",…}` 并以 3 退出，只停这个任务）→ 任务书在不在（不在就生成）→ worktree 与 `node_modules` 在不在（依赖由编排者在沙箱外装，这里绝不安装）。然后在独立会话里后台启动 `codex-run.sh impl <id>`（有 `caffeinate` 就套上防睡眠），登记 pid 与开始时间，输出一行 `{"action":"dispatched","pid":…,"run":"…"}`。

三处细节：

- **没有额度闸门**。负责人 2026-10-02 说 Codex 额度不设限制（`ops/approvals.yaml` 第 15 条）：`dispatch.sh` 不调 `usage.ts`、不按风险级改派；只有失败类熔断（每任务 10 次调用、同一任务连续 3 次无产出，`state.ts bump-attempt` 里检查）停任务。
- **重派一定重新生成任务书**。第 2 次尝试起（在途状态的 `attempts.impl` ≥ 2），不管 `brief.md` 在不在都重新跑 `brief.ts`：任务书里的「第 n 次尝试」和「上一轮失败输出」取自在途状态，沿用旧任务书就丢了上一轮的失败输出（规划/11 §2.3「重试不用 resume」）。所以重派前编排者要先 `node tools/ops/state.ts set <id> --last-error <失败输出文件>`。
- **停掉一次在跑的派工**：对输出里的 `pid` 发整组信号，`kill -TERM -- -<pid>`（负号表示整组）。包装脚本收到后把 Codex 进程组整组结束、写完 `meta.json` 再退出。只杀单个 pid 可能留下还在跑的包装脚本。

评审不经 `dispatch.sh`：编排者先 `node tools/ops/state.ts bump-attempt <id> review --review-type <类型>`，再前台或后台跑 `codex-run.sh review <id> --review-type <同一类型> …`。轮次按评审类型分开计（规划/11 §2.5）：规则测试评审（`spec-test`）最多 2 轮，代码评审（`money`、`general`、`contract` 共用一个计数）最多 3 轮（负责人 2026-10-02，`ops/approvals.yaml` 第 17 条）；没有产出就结束的调用由包装脚本还回那一轮。评审前的 `bump-attempt` 同样先查失败熔断，打开就退出 3，这个任务停下并报告。

`post-run.sh <id>` 只读文件，不执行任务代码、不动 git、不动 worktree，输出一行 JSON：

| `action` | 什么时候 |
| --- | --- |
| `verify` | 换家实现（或 2026-10-05 前的 Codex 实现）有产出、路径守卫与保护路径守卫都过。附 `revert_first`（`ops/`、`docs/` 下要先还原的越界改动）和 `outside_needed`（要在沙箱外跑的命令） |
| `red-check` | Codex 写测试（`phase: test`）有产出、守卫都过。不验证（测试本来就该红）：编排者跑 `tools/ops/verify-container.sh <id> --red`（隔离容器里只跑本任务 `test_paths` 内新写的测试文件，导出 Vitest JSON 报告，`red-check.ts` 逐个文件对账，退出码就是它的），过了才提交 `test(spec): …`、`state.ts set --spec-commit`，把 `red/<n>/result.json` 记进证据；RV2 再交 Claude 新子代理过审（§11），然后派 Opus 实现（§10） |
| `retry` | 失败的一次尝试（无产出、超时、越界、自称没做完、孤儿）。附 `backoff_min`：第 1 次后 15 分钟，第 2 次后 30 分钟；超时与无产出另附 `counts_as_attempt`（`false` = 包装脚本已还回这一轮）。孤儿（包装脚本没写完 `meta.json`）没有结算，照计一次 |
| `blocked` | 三次用完、位置断言失败、要装依赖（`deps-needed`）、实现者自报受阻、守卫出错 |
| `ask` | 改动碰了保护路径第二、三类，交负责人确认 |
| `capacity-retry` | 模型容量错误，不计次数 |
| `none`（退出码 1） | 这次运行还没结束 |

守卫（`tools/guard/path-guard.ts`、`protected-paths.ts`）一律从可信副本运行，基线取规则测试提交（`spec_commit`），没有就取分叉点。写测试的运行（`phase: test`）从分叉点算，路径守卫带 `--author`：只许规则测试资产（第一类保护路径，只新增）与任务 `paths` 内含 `NotImplemented` 的骨架，`ops/`、`docs/` 越界照旧只报告；计数器取 `attempts.test`（换家取 `attempts.handover`，没有 `phase` 的旧运行取 `attempts.impl`）。包装脚本已死但 Codex 进程组还活着时，`post-run.sh` 会把整组结束掉，再按孤儿计一次失败。

## 8. 首次真实自检（由编排者做）

规划/11 §2.4 的三组参数各自实测过，写进同一条命令后还没有真实跑过；进程组击杀也只用 `sleep` 验证过。骨架期所有测试都用假 `codex`。第一次真实调用按下面做，结果回写规划/11 §9.3：

```bash
# 1. 不耗额度：核对参数名、进程组击杀、schema、提示词
tools/agent/codex-run.sh selfcheck

# 2. 真实实现一次（耗一次额度）。先准备一个不在 /tmp 下的任务 worktree 和一份很小的任务书
tools/agent/codex-run.sh impl <id> --dry-run      # 先看 argv
tools/agent/codex-run.sh impl <id> --timeout-min 10
#    期望：退出 0；meta.json 里 has_output=true、position_changed=[]、last_event=turn.completed
#    再核对会话文件 ~/.codex/sessions/…/rollout-*-<thread_id>.jsonl：
#    turn_context.model 是 gpt-6-astra、effort 是 high；没有 skill 段；/tmp 下写不进去

# 3. 真实评审一次（耗一次额度）
tools/agent/codex-run.sh review <id> --review-type general --base <基线提交>

# 4. 回合中途击杀：给一份需要跑很久的任务书，把超时压到 60 秒
COULI_CODEX_TIMEOUT_SECS=60 tools/agent/codex-run.sh impl <id>
#    期望：退出 124；meta.json 里 group_gone=true；ps 里没有残留的 codex 进程；
#    之后几分钟内 impl.json 不会再出现（若出现的是 impl.json.rejected 之外的文件，就是缺陷）
```

TODO(规划/11 §2.4, §9.3)：上面第 2–4 步尚未执行 — blocked on 编排者首跑（骨架期禁止调用真实 codex；每一步耗一次额度，并会往 `~/.codex/config.toml` 写一条信任记录）。

## 9. 环境变量

| 变量 | 作用 |
| --- | --- |
| `COULI_RUNS`、`COULI_TRUSTED_ROOT`、`COULI_SPEC_REPO` | 运行目录、可信副本、规划仓库的位置 |
| `COULI_CODEX_BIN` | 换一个 `codex` 可执行文件；只在 `COULI_AGENT_TEST=1` 且运行目录在 `.tmp` 下时接受（测试夹具用），否则拒绝 |
| `COULI_SESSION` | 编排会话名；`dispatch.sh` 用它作认领的 owner，同名会话才能续期自己的认领。不设时每次派工用一个唯一名字，仍被占着的认领不会被续期 |
| `COULI_KILL_GRACE_SECS` | TERM 到 KILL 的等待秒数，默认 5，上限 5 |
| `COULI_CODEX_TIMEOUT_SECS`、`COULI_CODEX_IDLE_SECS` | 把硬超时、无活动阈值调小（测试与首次自检用）；调不大。这两个变量是本目录自己加的，根 `.env.example` 末尾有注释说明 |
| `COULI_CODEX_WRAPPER=1` | 只由本脚本设置，`codex` 垫片据此放行 |

## 10. Claude Opus 实现子代理怎么派

实现子代理不经脚本起：编排会话用 Claude Code 的 Agent 能力起一个新子代理（规划/11 §2.3 第 5 步）。每次都按下面做：

1. **前提**：在途状态已有 `spec_commit`（Codex 写的规则测试已提交、`verify-container.sh <id> --red` 已通过；RV2 还要 §11 的过审通过），worktree `<runs>/worktrees/<id>` 的依赖已由编排者在沙箱外装好。每一轮起之前给它取一个运行编号（例如 Agent 任务编号或 `opus-<时间>`），第 7 步结算要用。
2. **计数**：起之前 `node <可信副本>/tools/ops/state.ts bump-attempt <id> impl`（Opus 实现 3 次；退出 3 = 失败熔断打开，停）。
3. **任务书**：`node <可信副本>/tools/ops/brief.ts <id> --phase impl --out <runs>/<id>/brief.md`。实现阶段的任务书写明规则测试已冻结、测试只经可信容器入口跑；不要把写测试阶段的任务书交给实现子代理。
4. **起子代理**：模型指定 `claude-opus-5-5`（Agent 调用的模型参数选 opus，并在提示词里写明模型锁定）；工作目录就是 `<runs>/worktrees/<id>`（独立 worktree，不用主检出，不在 `/tmp` 下）；提示词 = 任务书全文 + 下面几条硬约束：不提交、不建分支、不 `git add` / `stash` / `reset`、不装依赖、不改 `ops/` 与 `docs/`、不改规则测试与保护路径；跑测试只用 `<runs>/trusted/rebate-platform/tools/ops/verify-container.sh <id> --fast`（断网容器里的 `pnpm verify:fast`，结果在 `<runs>/<id>/verify-fast/<n>/`；Docker 不可用时停下报告，不在宿主直跑测试）；结束时按任务书第 8 节的 JSON 结构回报。子代理在后台跑（规划/11 §2.2），编排会话在等待期间不碰这个 worktree。
5. **硬超时与取消**（RO-08）：硬超时沿用 30 分钟（规划/11 §2.2，和 Codex 写入型相同；超时的任务要拆小，不加时间）。到点或要放弃时，用 Agent 能力停掉这个子代理（TaskStop），然后**确认它已经停了**再做任何事：子代理的任务状态显示已结束；`verify-container.sh` 起的容器没有残留（`docker ps --filter label=couli.task=<id>` 为空，有就 `docker rm -f`）；worktree 在之后 1 分钟内不再有文件变化。确认之前不重派、不跑守卫、不在这个 worktree 上起新的实现。
6. **结束后核对**（位置断言，规划/11 §2.4）：起之前记下 `git -C <wt> rev-parse HEAD`、`git -C <wt> for-each-ref refs/heads`、`git -C <wt> diff --cached --name-only`；结束后三者都要不变（暂存区为空），变了按越界处理：这个 worktree 里的东西一律不运行、不提交，先人工看。
7. **守卫与记录**：从可信副本跑 `path-guard.ts --task <id> --base <spec_commit> --cwd <wt> --json` 与 `protected-paths.ts --base <spec_commit> --cwd <wt> --json`（先守卫、后执行）；再把这一轮结算：`state.ts opus-run <id> --run-id <运行编号> --outcome ok|no-output|timeout|capacity --risk <RV>`。没有结果（无产出、超时、容量或额度错误）的一轮把第 2 步计上的 `attempts.impl` 还回去（和 Codex 无产出一样，按运行编号去重，重复结算不多还，CR-07），同时计入 Opus 失败；连续 3 次或累计 5 次时输出 `next: handover`（RV0 / RV1：`dispatch.sh <id> --handover`）或 `next: blocked`（RV2：标 blocked，不换家）（RO2-03）。有结果的照常进沙箱外验证：`verify-container.sh <id>`（完整 `pnpm verify`）。

`verify-container.sh` 的 `--fast` 是为这一步加的（`tools/ops/README.md`）：只跑 `pnpm run verify:fast`，不起 PostgreSQL、容器 `--network none`，结果放 `verify-fast/<n>/`，与决定任务成败的 `verify/<n>/` 分开。

## 11. 规则测试过审（spec-test）交 Claude 新子代理

Codex 写的规则测试由另一家过审（规划/11 §2.3 第 4 步，RV2 必做）：

1. `codex-run.sh review --review-type spec-test` 只接受可信台账写明 `tester: claude` 的旧任务；`tester: codex`、`none`、台账读不到都拒绝（退出 2，CR-08）。
2. 换家实现（`dispatch.sh --handover`）之后的代码评审也按本节的做法交 Claude 新子代理，提示词换成对应的 `review-general.md` / `review-money.md` / `review-contract.md`，产出写 `review-claude-<类型>.json`，计数用 `bump-attempt <id> review --review-type <类型>`（CR-09）。
3. 计数：`state.ts bump-attempt <id> review --review-type spec-test`（最多 2 轮，计数器不变）。
4. 起一个新的 Claude 子代理（不是本任务的实现子代理，也不是别的评审子代理），只读：提示词 = 可信副本的 `prompts/review-spec-test.md` + 一段上下文（任务编号、基线 = 分叉点、`spec_commit`、任务 refs、任务 paths、`git diff --name-only <基线> <spec_commit>`）+ `brief.ts <id> --phase review` 生成的任务书。它不运行测试（变异清单靠推演；要跑就由编排者在容器里跑）。
5. 产出按 `schemas/review.schema.json` 写到 `<runs>/<id>/review-claude-spec-test.json`，编排者校验：`node <可信副本>/tools/agent/validate-output.ts --schema <可信副本>/tools/agent/schemas/review.schema.json --file <产出> --refs <refs> --allowed-paths <paths> --rewrite --out-of-scope-log <runs>/<id>/out-of-scope.md --diff-base <基线> --cwd <wt>`。校验不过算一轮、没有结论；`verdict: fail`（范围内有 S0 / S1）就退回 Codex 改测试（`dispatch.sh <id>` 前先 `state.ts set --spec-commit none`，在途状态的 `last_error` 指向这份评审）。

## 12. 私有库（`rebate-private`）里的 Codex 写入

Agent 评测集与注入集放私有库（规划/11 §1.1）。读脚本的结论（没有真的调用 Codex）：

- `codex-run.sh impl <id> --worktree <目录>` 对 `<目录>` 只要求是一个 git 工作树的根、有 HEAD、它和它的 git 目录都不在 `/tmp`、`$TMPDIR` 下；不要求是 `rebate-platform`。所以 `--worktree /Users/zhixing/我的项目/rebate-private` 能跑，位置断言照常核对那个仓库的 HEAD、分支、暂存区。
- **不建议直接用私有库主检出**：Codex 的写范围是整个 `-C` 目录，会直接改私有库的工作区。做法是先给私有库建一个 worktree，再把它交给包装脚本，例如 `git -C /Users/zhixing/我的项目/rebate-private worktree add ../couli-runs/worktrees/<id>-private -b task/<id>`，然后 `tools/agent/codex-run.sh impl <id> --phase test --worktree <runs>/worktrees/<id>-private`（linked worktree 的 gitdir 在私有库 `.git` 里，不在沙箱可写根内）。
- 限制：任务书仍来自本仓库的台账（`<runs>/<id>/brief.md`），台账的 `repo` 只能是本仓库与三个原生仓库，`paths` 按本仓库的风险表算级；`dispatch.sh` 固定用 `<runs>/worktrees/<id>` 且要求有 `node_modules`，所以私有库的写入只能由编排者直接调 `codex-run.sh impl --worktree`；`post-run.sh` 的守卫按本仓库的保护路径清单看私有库的改动，结论只作参考，私有库的改动由编排者人工过目后提交。这些行为本次没有改。

## 13. 已知未验证与限制

- 规划/11 §9.3「仍未测的要点」里 Codex 那一条全部仍未测：两条命令全部参数写在一起的首跑、真实回合中途的进程组击杀、其他模型 id、如何避免往 `~/.codex/config.toml` 写信任记录（每个 worktree 路径会被写一条，负责人已选 A：不动全局配置）、Linux 上的沙箱。
- 事件名（`thread.started`、`turn.completed`、`turn.failed`、`error`）与容量错误出现在哪个事件里，是按验证日的记录写的，假 `codex` 也照这个造；真实事件流首跑时要核对一次。
- 活性看事件文件的修改时间和进程 CPU（见 §3 第 4 条），没有看 rollout 文件；CPU 的判定是启发式的（窗口内增长不到窗口的 5% 算静止），一条既不打事件又几乎不耗 CPU 的长命令（纯等待网络）仍会被当成无活动。
- 脱离进程组的后代靠两条线索找回：进程表里的父子关系（每秒扫一次，被 init 收养前）和继承的文件描述符（收尾时）。主动关掉所有描述符再 `setsid` 的进程两条都躲得过，只能靠守卫和容器验证兜底。
- 位置断言对分支列表的放宽只限「别的任务的分支」（见 §3 第 3 条），这是相对规划/11 §2.4 原文「分支列表未变」的一处偏离：照原文做，几个任务并行时编排者一建分支，在跑的任务就会被判 12。本地 `main` 移动、出现非 `task/` 开头的新分支、本任务分支被动过，仍然判 12。所以 Codex 运行期间编排者不要移动本地 `main`（新任务分支从 `origin/main` 建），也不要在这个仓库里 `git stash`。
- 资金清单的「引用行在 diff 里」按 `git diff -U3 <基线>` 的块范围判断（含上下文行）；新文件整份算在内。
- 评审产出里发现的 `key` 被校验成固定格式 `<文件>#<函数或符号>#<规则编号>`（不含空白，开头与 `file` 字段相同）。格式不对整份评审按无产出处理（退出 10），会多耗一轮评审；首次真实评审后看模型是否稳定按这个格式写，不稳就放宽 `validate-output.ts` 里的 `KEY_PATTERN`。
- 本目录的测试要用 `bash`、`perl`、`git`，并在 `REPO/.tmp/` 下建一次性 git 仓库（verify 镜像已装 git）。全部用例本机约 30–90 秒（看机器负载）；孤儿进程要靠 1 号进程回收，容器须带 `--init`（`verify-container.sh` 已带）。2026-10-02 已在 verify 镜像里按同样的加固参数（只读根、断网、`/work` tmpfs、离线装依赖、仓库根没有 `.git`）跑过本目录全部用例：66 条通过，约 25 秒（Linux bash 5.2、perl 5.36、git 2.39）。
- Codex 沙箱内（`pnpm verify:fast`）能否正常运行这些测试（进程组信号、`.tmp` 下的 `.git`）未测。
- 2026-10-05 的分工切换（`ops/approvals.yaml` 第 19 条）只改了派工、计数与守卫，还没有真实跑过一轮「Codex 写测试 → 先红 → Claude 过审 → Opus 实现」。§10、§11 的子代理步骤靠编排会话照做，没有脚本强制；位置断言与守卫是事后关口。
- 隔离红测（`verify-container.sh --red`）只跑项目表里的 Vitest 文件；`db/invariants/**` 的 SQL 不是测试文件，不在对账清单里。浏览器测试（Playwright）的红测还没有入口；CI 证据归档接入前，证据里的 `mode: ci` 记录一律拒绝（CR2-06），所以浏览器测试暂时进不了 RV2 证据。
- 骨架检查（`tools/guard/lib/skeleton.ts`，CR-05、CR2-01）用 Node 自带的 `stripTypeScriptTypes`（实验特性）把 TypeScript 转成 JavaScript 后逐条看新增或改动的顶层语句：只许 import、export 列表与转出、类型、函数声明（函数体只有 `void <参数>;` 与最后的 NotImplemented 抛出）和只含这类方法、无初始值字段的类；其余可执行语句（含 `export const x = f()`、`= Math.floor`、字面量常量）一律拒绝。旧代码豁免绑定符号名与完整声明文本，同样的函数体换个名字不算旧代码。TSX 与装饰器转换不了，按「不是骨架」处理。
- 台账 `test_paths`：只有 `tools/guard/legacy-tasks.json` 列出的、切换基线 `dec8a3d` 时已有的台账可以没有（提交守卫对它们沿用全部第一类路径）；之后的新任务只要有测试作者就必须写，`task.ts check` 与提交守卫都拒绝缺字段（CR2-02）。
- 隔离红测用可信的 Vitest reporter（`tools/ops/verify-image/red-reporter.mjs`，只读挂进容器）保留失败的 cause 链：fast-check 把属性里抛出的错误只放在 `cause` 里，Vitest 自带的 JSON reporter 会丢掉它。red-check 以最内层 cause 判定：`AssertionError` 或骨架的 `NotImplemented` 才算有效红；属性只「返回 false」不算（属性的先红必须在属性里用 `expect` 断言，失败报告才显示底层断言）；看不出原因一律不算（CR2-03）。
- 每个应跑的文件由可信项目表 `tools/ops/verify-image/red-projects.json`（与 `test/`、`packages/testing/` 的 Vitest 配置逐条核对，见 `tools/ops/red-plan.test.ts`）分到 `spec-unit`、`spec-int`（含 `acceptance/**`，起一次性 PG）或 `testing-unit`；没有项目收的文件（如 `test/replay/**`）让红测直接失败（CR2-04）。
