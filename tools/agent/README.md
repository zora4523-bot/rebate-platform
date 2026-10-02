# tools/agent：Codex 调用包装

这里是本仓库调用 Codex 的唯一入口。规则出处：规划仓库 `规划/11_开发协作与自主推进.md` §2.2–§2.5、§3.1、§3.3、§4.3、§9.3。本目录属于保护路径第三类（门禁与规则），改动要负责人确认。

一句话：`codex-run.sh` 把 Codex 关在固定的沙箱参数里跑一次，跑完告诉编排者「有没有可用产出」；任务做没做对，不看它，只看沙箱外的 `pnpm verify`。

## 1. 文件

| 文件 | 作用 |
| --- | --- |
| `codex-run.sh` | 包装脚本：`impl`、`review`、`selfcheck` |
| `supervise.pl` | 进程组监管：硬超时、无活动看门狗、整组击杀、确认组内无存活进程 |
| `dispatch.sh` | 派工前检查 + 后台启动一次实现 |
| `post-run.sh` | 实现结束后：先跑守卫，再给出下一步动作 |
| `next-action.ts` | `post-run.sh` 的判定表（纯函数，有单测） |
| `validate-output.ts` | 产出校验：schema（Ajv2020 strict）+ 评审规则 + 资金清单 |
| `meta.ts` | 给 bash 用的 JSON 读写小工具、事件流解析 |
| `common.sh` | 三个脚本共用的路径解析与进程组函数 |
| `schemas/impl.schema.json`、`schemas/review.schema.json` | 结构化产出的 schema（每个 object 都是 `additionalProperties:false` + 全字段必填） |
| `prompts/review-{money,general,contract,spec-test}.md` | 四种评审提示词 |
| `testing/` | 测试用假 `codex`（`couli-fake-codex.sh`）和夹具；不连模型、不耗额度 |

## 2. 命令

```bash
# 实现（任务书必须已在 <runs>/<id>/brief.md）
tools/agent/codex-run.sh impl <id> [--worktree <dir>] [--timeout-min <n>] [--dry-run]

# 评审（只读沙箱）
tools/agent/codex-run.sh review <id> [--worktree <dir>] \
  [--review-type money|general|contract|spec-test] [--base <ref>] [--timeout-min <n>] [--dry-run]

# 自检：不发起任何 Codex 回合，不耗额度
tools/agent/codex-run.sh selfcheck

# 派工（后台）与收尾
tools/agent/dispatch.sh <id>
tools/agent/post-run.sh <id>

# 单独校验一份产出
node tools/agent/validate-output.ts --schema <schema> --file <json> [--money] [--diff-base <ref> --cwd <worktree>] [--json]
```

- `<id>` 是台账编号（如 `B2-03a`）。`<runs>` 默认是仓库旁边的 `couli-runs/`，worktree 默认 `<runs>/worktrees/<id>`。
- `--review-type` 不传时按任务的风险级定：RV2 → `money`（资金清单强制），其余 `general`。RV2 任务不接受 `general`。
- `--base` 不传时取 `HEAD` 与 `origin/main`（没有则 `main`）的分叉点。
- `--timeout-min` 只能调小：实现上限 30 分钟、评审 15 分钟（规划/11 §2.2）。超时的任务要拆小，不是加时间。
- `--dry-run` 把将要执行的 argv 一行一个打印出来（参数里的换行显示为 `\n`），不启动 Codex、不写任何文件。

## 3. 包装脚本保证什么

1. **命令固定**。实现与评审的 argv 就是规划/11 §2.4 那两条，写死在脚本里；调用方传不进任何 Codex 参数。评审提示词后面追加的「Review context」一段（任务编号、基线、改动文件列表、任务书）是包装脚本自己加的，§2.4 原命令里没有。
2. **stdin 关闭**（`/dev/null`），带 `COULI_CODEX_WRAPPER=1`。
3. **位置断言**。启动前：worktree、它的 git 目录、`<runs>`、可信副本都不在 `/tmp`、`/private/tmp`、`$TMPDIR` 下，否则退出 12；脚本自身或 `COULI_TRUSTED_ROOT` 位于 `couli-runs/worktrees/<编号>` 下（任务 worktree）一律拒绝，退出 2。结束后：HEAD、当前分支、分支列表、`refs/stash`、暂存区、本地 git 配置（不含 `branch.*`）、`.git/hooks` 与启动前一致，否则退出 12，产出作废。分支列表里只放过一种变化：**别的任务的分支**（`refs/heads/task/<别的编号>`）新增、移动或删除，因为编排者会在本次运行期间给别的任务建 worktree、提交规则测试；这种变化只记进 `meta.json` 的 `other_task_branches_changed`。
4. **超时杀整组**。Codex 在独立进程组里跑；硬超时或无活动时对整组先 TERM、等 `COULI_KILL_GRACE_SECS`（默认 5 秒，上限 5，只能调小）、再 KILL，确认组内没有存活进程后才去看 `-o` 文件。「无活动」= 事件文件没有新内容 **且** 这次运行的进程没有消耗 CPU（实现 5 分钟 / 评审 12 分钟；每秒扫一次进程表，CPU 时间在窗口内增长不到窗口的 5% 算静止）：沙箱里一条跑很久、不打事件的 `pnpm test` 不会被误杀。监管脚本还记住组长的全部后代（含用 `setsid` 脱离进程组的；靠继承的一个文件描述符在收尾时再找一遍，Linux 用 `/proc`，macOS 用 `lsof`），收尾时一并结束。包装脚本自己被 TERM / INT / HUP 时同样杀整组。Codex 正常退出但留下后台进程（`stragglers_killed`）或有后代脱离了进程组（`escaped_killed`）的，进程被清掉，这一次按**无产出**处理（退出 10，`-o` 改名 `.rejected`）：被强制清理过的运行里写出来的东西不当作模型的回答。
5. **旧产出不会被当成新产出**。每次调用前把上一次同模式的产出挪进 `attempts/<n>/`，并确认 `-o` 文件不存在；本次没被接受的 `-o`（包括击杀之后才写出来的）改名为 `*.rejected`。
6. **成败判定**（规划/11 §2.4）。四条同时成立才算有产出：Codex 退出码 0、事件流最后一条是 `turn.completed`、`-o` 存在、通过可信副本里的 `validate-output.ts`。
7. **门禁从可信副本读**。schema、提示词、校验器、`usage.ts`、守卫都取自 `COULI_TRUSTED_ROOT`（默认：`<runs>/trusted/rebate-platform` 存在就用它，否则脚本所在的主检出），不读任务 worktree：脚本从 `couli-runs/worktrees/<编号>` 下运行、或 `COULI_TRUSTED_ROOT` 指到那里，直接拒绝（退出 2），没有静默回退。
9. **真正的 codex**。只用 `command -v codex`（垫片算数，它会转给真正的二进制），且它的物理路径不能在仓库、worktree、`couli-runs` 或临时目录下。`COULI_CODEX_BIN` 只给测试夹具用：必须同时设 `COULI_AGENT_TEST=1`，且运行目录位于某个 `.tmp` 目录下，否则拒绝（退出 2）。
10. **评审类型跟着风险级**。`--review-type` 不传时，可信副本的 `tools/ops/task.ts show <id>` 算出 RV2 就用 `money`（强制资金清单），否则 `general`；RV2 任务显式传 `general` 被拒绝（`contract`、`spec-test` 仍可用）。评审产出里 `verdict: pass` 却带 S0 / S1 发现的，按无产出处理（退出 10）。
8. **每次调用都记账**：结束后调用 `tools/ops/usage.ts record`（规划/11 §1.3）。

有产出不等于任务成功。Codex 说「测试通过」不算数，成败只看 `tools/ops/verify-container.sh` 的退出码。

## 4. 退出码

| 退出码 | 含义 | 编排者怎么处理 |
| --- | --- | --- |
| 0 | 有可用产出 | `post-run.sh` → 守卫 → 沙箱外验证 |
| 10 | 没有可用产出（退出码非 0、缺 `turn.completed`、缺 `-o`、校验不过、被中止） | 计一次尝试，退避重试 |
| 11 | 模型容量错误（`Selected model is at capacity`） | 退避重试，不计入 attempts，仍计入每天 40 次 |
| 12 | 位置断言失败 | 按越界处理：不执行、不提交这个 worktree 里的任何东西，先人工看 `meta.json` 的 `position_changed` |
| 124 | 硬超时或无活动被击杀 | 计一次尝试；任务要拆小 |
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

`meta.json` 字段：`mode`、`task`、`worktree`、`run`、`started_at`、`finished_at`、`exit_code`、`codex_exit`、`timed_out`、`idle_killed`、`aborted`、`has_output`、`capacity_error`、`head_before`、`head_after`、`thread_id`、`codex_version`、`model`、`last_event`、`pgid`、`group_gone`、`stragglers_killed`、`validation`、`validation_messages`、`position_changed`、`other_task_branches_changed`、`timeout_secs`、`idle_secs`、`wrapper_pid`、`output_file`、`events_file`，评审另有 `review_type`、`base`。`has_output` 只表示产出通过了校验；位置断言失败时 `exit_code` 仍是 12。

## 6. 禁止的用法（规划/11 §2.4 禁用）

- 不经本脚本直接跑 `codex exec`；不带 `-s` 或不带 `--ignore-rules` 的 `codex exec`。
- `--dangerously-bypass-approvals-and-sandbox`、`danger-full-access`。
- `sandbox_workspace_write.network_access=true`（一开就同时放开 Docker、本机数据库和外网）。
- 独立的 `CODEX_HOME`（会丢登录）。环境里设了非默认的 `CODEX_HOME`，脚本直接拒绝。
- Codex 自带的 `--worktree`、`--add-dir`、`resume`、任何 `sandbox_mode` 覆盖。
- `exclude_tmpdir_env_var`、服务档位、`--ephemeral`：脚本不会加，也传不进去。

调用方的参数里只要出现 `network_access`、`sandbox_mode`、`--add-dir`、`--dangerously-bypass-approvals-and-sandbox`、`--worktree`（本脚本自己的 `--worktree <目录>` 除外）、`danger-full-access`、`resume`、`CODEX_HOME`，或任何脚本不认识的参数，一律退出 2。

## 7. 派工与收尾

`dispatch.sh <id>` 先用 `mkdir <runs>/<id>/dispatch.lock` 取一把只在本次派工期间存在的锁（10 分钟没清掉的视为残留），再按顺序检查，任何一步不过就停：额度闸门（`usage.ts gate`，退出 3 即全停）→ 认领任务（owner 是 `COULI_SESSION`，不设则本进程唯一；只有认领已被同一 owner 持有时才 `--renew`）→ 上一次派工记录的 pid 还活着就停（`run-in-progress`）→ **先把尝试次数加一** → 任务书在不在（不在就生成）→ worktree 与 `node_modules` 在不在（依赖由编排者在沙箱外装，这里绝不安装）。然后在独立会话里后台启动 `codex-run.sh impl <id>`（有 `caffeinate` 就套上防睡眠），登记 pid 与开始时间，输出一行 `{"action":"dispatched","pid":…,"run":"…"}`。上一次是容量错误（退出 11）时，这次重派不再加次数。

三处细节：

- **闸门带风险级**。`dispatch.sh` 先用可信副本的 `tools/ops/task.ts show <id> --json` 算出风险级，再调 `usage.ts gate --task <id> --mode impl --risk <RVn>`，这样额度 70%–97% 档「RV0 / RV1 实现改由 Claude」也在这里拦住（规划/11 §1.3）。算不出风险级时只带 `--task`，全局熔断照常生效。
- **重派一定重新生成任务书**。第 2 次尝试起（在途状态的 `attempts.impl` ≥ 2），不管 `brief.md` 在不在都重新跑 `brief.ts`：任务书里的「第 n 次尝试」和「上一轮失败输出」取自在途状态，沿用旧任务书就丢了上一轮的失败输出（规划/11 §2.3「重试不用 resume」）。所以重派前编排者要先 `node tools/ops/state.ts set <id> --last-error <失败输出文件>`。
- **停掉一次在跑的派工**：对输出里的 `pid` 发整组信号，`kill -TERM -- -<pid>`（负号表示整组）。包装脚本收到后把 Codex 进程组整组结束、写完 `meta.json` 再退出。只杀单个 pid 可能留下还在跑的包装脚本。

评审不经 `dispatch.sh`：编排者先 `node tools/ops/state.ts bump-attempt <id> review`，再前台或后台跑 `codex-run.sh review <id> …`（评审最多 2 轮，规划/11 §2.5）。

`post-run.sh <id>` 只读文件，不执行任务代码、不动 git、不动 worktree，输出一行 JSON：

| `action` | 什么时候 |
| --- | --- |
| `verify` | 有产出、路径守卫与保护路径守卫都过。附 `revert_first`（`ops/`、`docs/` 下要先还原的越界改动）和 `outside_needed`（要在沙箱外跑的命令） |
| `retry` | 失败的一次尝试（无产出、超时、越界、自称没做完、孤儿）。附 `backoff_min`：第 1 次后 15 分钟，第 2 次后 30 分钟 |
| `blocked` | 三次用完、位置断言失败、要装依赖（`deps-needed`）、实现者自报受阻、守卫出错 |
| `ask` | 改动碰了保护路径第二、三类，交负责人确认 |
| `capacity-retry` | 模型容量错误，不计次数 |
| `none`（退出码 1） | 这次运行还没结束 |

守卫（`tools/guard/path-guard.ts`、`protected-paths.ts`）一律从可信副本运行，基线取规则测试提交（`spec_commit`），没有就取分叉点。包装脚本已死但 Codex 进程组还活着时，`post-run.sh` 会把整组结束掉，再按孤儿计一次失败。

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

## 10. 已知未验证与限制

- 规划/11 §9.3「仍未测的要点」里 Codex 那一条全部仍未测：两条命令全部参数写在一起的首跑、真实回合中途的进程组击杀、其他模型 id、如何避免往 `~/.codex/config.toml` 写信任记录（每个 worktree 路径会被写一条，负责人已选 A：不动全局配置）、Linux 上的沙箱。
- 事件名（`thread.started`、`turn.completed`、`turn.failed`、`error`）与容量错误出现在哪个事件里，是按验证日的记录写的，假 `codex` 也照这个造；真实事件流首跑时要核对一次。
- 活性看事件文件的修改时间和进程 CPU（见 §3 第 4 条），没有看 rollout 文件；CPU 的判定是启发式的（窗口内增长不到窗口的 5% 算静止），一条既不打事件又几乎不耗 CPU 的长命令（纯等待网络）仍会被当成无活动。
- 脱离进程组的后代靠两条线索找回：进程表里的父子关系（每秒扫一次，被 init 收养前）和继承的文件描述符（收尾时）。主动关掉所有描述符再 `setsid` 的进程两条都躲得过，只能靠守卫和容器验证兜底。
- 位置断言对分支列表的放宽只限「别的任务的分支」（见 §3 第 3 条），这是相对规划/11 §2.4 原文「分支列表未变」的一处偏离：照原文做，几个任务并行时编排者一建分支，在跑的任务就会被判 12。本地 `main` 移动、出现非 `task/` 开头的新分支、本任务分支被动过，仍然判 12。所以 Codex 运行期间编排者不要移动本地 `main`（新任务分支从 `origin/main` 建），也不要在这个仓库里 `git stash`。
- 资金清单的「引用行在 diff 里」按 `git diff -U3 <基线>` 的块范围判断（含上下文行）；新文件整份算在内。
- 评审产出里发现的 `key` 被校验成固定格式 `<文件>#<函数或符号>#<规则编号>`（不含空白，开头与 `file` 字段相同）。格式不对整份评审按无产出处理（退出 10），会多耗一轮评审；首次真实评审后看模型是否稳定按这个格式写，不稳就放宽 `validate-output.ts` 里的 `KEY_PATTERN`。
- 本目录的测试要用 `bash`、`perl`、`git`，并在 `REPO/.tmp/` 下建一次性 git 仓库（verify 镜像已装 git）。全部用例本机约 30–90 秒（看机器负载）；孤儿进程要靠 1 号进程回收，容器须带 `--init`（`verify-container.sh` 已带）。2026-10-02 已在 verify 镜像里按同样的加固参数（只读根、断网、`/work` tmpfs、离线装依赖、仓库根没有 `.git`）跑过本目录全部用例：66 条通过，约 25 秒（Linux bash 5.2、perl 5.36、git 2.39）。
- Codex 沙箱内（`pnpm verify:fast`）能否正常运行这些测试（进程组信号、`.tmp` 下的 `.git`）未测。
