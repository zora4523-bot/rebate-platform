# tools/ops：编排脚本

编排会话（Claude 主会话）用来推进任务的脚本：台账、在途状态与失败熔断、用量账本（只记账）、看板、任务书、交接、沙箱外验证。规则出处是规划仓库 `规划/11_开发协作与自主推进.md`（下称 11），本文件只写用法和现状。

本目录是保护路径第三类（11 §4.4）：改动要负责人确认。脚本一律从可信副本运行（11 §2.4），可信副本建好前就是主检出；从 `couli-runs/worktrees/<编号>` 下运行一律拒绝。

## 1. 已有的脚本

全部是 `node tools/ops/<名>.ts`（Node 24 直接跑 TypeScript）或 bash / perl。退出码：0 正常，1 检查没过，2 用法或内部错误；另有约定的单独写明。`--json` 时标准输出只有一份 JSON，给人看的文字走标准错误。

| 脚本 | 做什么 | 出处 |
| --- | --- | --- |
| `task.ts check [编号…]` | 校验 `ops/tasks/*.yaml`：字段、文件名、≤40 行、编号前缀在 05 里存在、`refs` 存在且 `refs_hash` 与规划原文一致、依赖存在、RV2 的实现与规则测试作者不是同一家。`pnpm ops:task:check` | 11 §2.1 |
| `task.ts show <编号> --json` | 任务字段（平铺）加算出的 `risk`、`ask`、`risk_paths` | 11 §1.2 |
| `task.ts hash <编号>` | 打印可直接粘贴的 `refs_hash` 段 | 11 §5.3 |
| `state.ts get\|set\|claim\|release\|bump-attempt\|settle\|migrate <编号>` | 在途状态 `couli-runs/state/<编号>.json`（先写临时文件再改名）；领任务 `couli-runs/claims/<编号>/`，租约 20 分钟，`claim --renew` 续期，过期才能被别的会话接手。轮次与失败熔断见下文「轮次怎么计」「失败熔断」；`bump-attempt` 在熔断打开时退出 3 | 11 §2.1、§2.2、§2.5 |
| `lock.ts`（只有函数） | 编排锁 `couli-runs/lock/orchestrator/`：取锁、心跳、释放；心跳停 20 分钟才允许接管。心跳与释放也在接管闸门 `<锁目录>.takeover` 里做，自己的租约已过期就不再续（返回 false，持有者必须停下） | 11 §2.2 |
| `usage.ts record\|summary` | 用量账本 `couli-runs/usage.jsonl`（只追加），只记每次调用的 token 与结果，不拦任何调用；读不出的行跳过并计数。`pnpm ops:usage summary` | 11 §1.3 |
| `status.ts [--json]` | 看板，每次现算，不落盘。`pnpm ops:status` | 11 §2.1、§5.2、§7.2 |
| `brief.ts <编号> [--attempt n] [--out 文件]` | 任务书，写到 `couli-runs/<编号>/brief.md`；超过 24KB 或命中禁用词就不写文件、退出码 1。`pnpm ops:brief <编号>` | 11 §2.3 第 2 步、§5.3 |
| `handoff.ts [--out 文件] [--session 名]` | 交接，写 `couli-runs/handoff/CURRENT.md` 和带时间戳的副本，≤40 行。`pnpm ops:handoff` | 11 §5.1 |
| `verify-container.sh <编号> [--worktree 路径] [--host]` | 沙箱外验证：断网容器里跑 `pnpm verify`，退出码就是验证结果（124 = 超时）。结果在 `couli-runs/<编号>/verify/<n>/` | 11 §2.3 第 7 步、§9.3 #6 |
| `verify-container.selftest.sh` | 上一个脚本的端到端自测，要 Docker 和网络，手动跑 | — |
| `timeout-group.pl` | `--host` 模式用的超时器：到点杀整个进程组 | 11 §2.4「超时」 |
| `spec.ts`、`overlap.ts`、`cli.ts` | 供上面脚本用的库：按 `SPEC_REF` 读规则原文与条目哈希、路径是否可能相交、公共小函数 | 11 §5.3 |

### 轮次怎么计（`state.ts`）

规划/11 §2.5；负责人 2026-10-02 决定（`ops/approvals.yaml` 第 13 条）。

- 三个计数器各有上限：实现 `impl` 3 次；规则测试评审 `spec-test` 2 轮；代码评审 `code` 2 轮（`money`、`general`、`contract` 共用）。原来是一个评审计数器共 2 轮。
- `bump-attempt <编号> impl`（`dispatch.sh` 调）或 `bump-attempt <编号> review --review-type <类型>`（编排者在评审前调）在**派发前**计数并落盘；用完了退出码 1、不写文件。
- `settle <编号> --meta <meta.json>`（`codex-run.sh` 每次调用结束后调）：没有产出就结束的调用把那一轮还回去，记进状态文件的 `uncounted_calls`（`kind`、`started_at`、`exit_code`、`reason`）；按 `kind` + `started_at` 去重，重复执行不多还。「没有产出」指：硬超时或无活动击杀（124）、模型容量错误（11）、或退出 10 且校验没跑（缺 `-o`、`turn.failed`、退出码非 0、被中止、留下进程）。拿到回答但校验不过（`validation: failed`）、位置断言失败（12）、孤儿（包装脚本没写完 `meta.json`）照计。
- 不计轮次的调用照样计入每任务 10 次与连续无产出（见下一节）。
- `migrate <编号> [--unattributed-review spec-test|code] [--dry-run]`：把旧形状 `attempts: {impl, review}` 的状态文件换成新形状。评审轮次按 `<runs>/<编号>/` 下各次调用的 `meta.json`（`meta.<模式>.json` 与 `attempts/<n>/meta.json`）归到各自类型，没有产出的调用移进 `uncounted_calls`；实现次数减去没有产出的实现调用；其余字段（`state`、`last_error` …）不动。旧计数比留下的评审 `meta.json` 多时，必须用 `--unattributed-review` 说明多出的轮次归哪类，否则拒绝。旧形状的文件不经迁移读不进来（`get`、看板都会报错并提示这条命令）。

### 失败熔断（`state.ts`），没有额度闸门

负责人 2026-10-02：「codex 额度是无限的，请你不要设置无意义的限制」（`ops/approvals.yaml` 第 15 条）。所以没有周额度估算、档位、校准，也没有每天的调用上限；`usage.ts` 只记账。只留下面这些针对失败的保护：

- 轮次上限照旧（上一节）。
- 每任务最多 10 次 Codex 调用（防失控循环）：该任务运行目录里每一次已结束的调用都算（`meta.<模式>.json` 与 `attempts/<n>/meta.json`），没有产出、还回了轮次的也算，模型容量错误也算。
- 同一任务连续 3 次调用没有产出（超时、无活动击杀、缺 `-o`、`turn.failed` 等，即 `settle` 会还回轮次的那些）就停这个任务；模型容量错误既不延长也不打断这个计数，拿到回答但校验不过的算有产出。
- 两道熔断按「再派一次会不会越线」判断，由 `bump-attempt` 在计数前检查：打开时退出 3、不写文件，`dispatch.sh` 输出 `{"action":"stopped","reason":"task-breaker",…}`。只停这个任务，其余任务照常；编排者把它标 `blocked` 并报告。看板列出所有打开的熔断。

### 沙箱外验证（`verify-container.sh`）

- 镜像定义在 `verify-image/`：`node:24-bookworm-slim` + 与根 `packageManager` 完全一致的 pnpm（不用 corepack）+ PGDG 的 `postgresql-client-18` + git 与 procps（`tools/` 的单元测试要建夹具仓库、要 `ps`），非 root。镜像标签由 `verify-image/` 的内容和 pnpm 版本算出，改了就自动重建。
- 依赖走离线 store：数据卷按 `pnpm-lock.yaml` 的 sha256 命名，没有时联网 `pnpm fetch` 一次（只挂锁文件和 `pnpm-workspace.yaml`）。
- 快照：先把 worktree 的 git 树（含未提交改动，不含被 `.gitignore` 忽略的任何东西：`node_modules`、`dist`、`.env*`、`*.key`、`coverage/`、`reports/` …）用 `git archive` 导出到 `couli-runs/<编号>/verify/<n>/src/`，`result.json` 的 `tree` 就是这份快照的树哈希；之后容器和 host 模式都只看这份快照，worktree 在镜像构建、填 store 期间被改动也影响不了结果。快照用完即删。不是 git 仓库顶层的目录按同一套排除规则用 tar 复制，`tree` 为 null。
- 每次运行：新建 `--internal` 网；一次性 PG（`pgvector/pgvector:0.8.6-pg18-trixie`，随机密码）只接这个网；验证容器根文件系统只读、快照只读挂 `/src`、store 只读、`/work` 与 `/tmp` 是 tmpfs；容器里先把 `/src` 拷到 `/work/repo`，`pnpm install --offline --frozen-lockfile`，再限时跑 `pnpm verify`。结束后容器和网络一律清掉。
- 规划原文：把规划仓库在 `SPEC_REF` 那一个提交做成只读快照（`couli-runs/spec-snapshots/<提交号>.git`）挂到 `/spec`，容器里 `COULI_SPEC_REPO=/spec`。容器看不到规划仓库的工作区和配置。快照没有历史，所以「`SPEC_REF` 在规划仓库 main 上」由本脚本在宿主对真实仓库核对，通过了才给快照写上 `origin/main`，容器里的 `spec-ref` 守卫据此通过。
- `result.json`：`mode`（`container` / `host`）、`exit_code`、`commit`、`tree`（含未提交改动的工作区树哈希）、`prop_seed`、起止时间。基础设施出错（Docker 起不来、镜像构建失败）退出码 2，不写 `result.json`。
- `--host`：Docker 不可用时的退路，在快照目录里 `pnpm install --offline --frozen-lockfile --store-dir <宿主 store>` 后 `env -i HOME=<运行目录>/home PATH=… pnpm verify`，记 `mode: host`；绝不复用 worktree 自己的 `node_modules`、`dist` 等被忽略的路径（沙箱内写进去的东西在守卫和评审里都看不见）。RV2 不接受 host 结果合并（11 §2.3）。脚本不会自己降级，必须显式传 `--host`。
- worktree 在 `/tmp`、`/private/tmp`、`$TMPDIR` 下一律拒绝（那里是 Codex 沙箱的可写根，11 §0）。
- 可调环境变量：`COULI_VERIFY_TIMEOUT_SECS`（默认与上限 1200，只能调小）、`COULI_KILL_GRACE_SECS`（host 模式，1–5）、`COULI_VERIFY_PREFIX`（容器、网络、数据卷的名字前缀，默认 `couli-verify`）、`PROP_SEED`、`PROP_RUNS`。

实测（2026-10-02，M2 Max，Docker Desktop 28.0.1；当时机器同时在跑别的任务，数字偏慢）：

| 项 | 耗时 |
| --- | --- |
| 镜像无缓存构建（之后有缓存，不再构建） | 34–62 秒 |
| 自测用的小 workspace（1 个依赖）每次运行，其中起 PG 2–5 秒 | 4–21 秒 |
| 骨架期整仓库（482 个包）首次联网填 store | 6–75 秒 |
| 整仓库 `verify:fast` 段（类型检查、lint、格式、依赖方向、全部单元测试、契约、守卫） | 42–116 秒 |
| 整仓库 `typecheck + test:int + db:check` 段（24 条连库集成测试、快照与类型漂移比对，全部通过） | 30 秒（整次 65 秒） |

容器里的 Node 是镜像 `node:24-bookworm-slim` 当时的版本（实测 24.21.0），宿主是 24.15.0；都在 `engines` 范围内。完整的 `pnpm verify` 一次跑通留给集成步骤，届时把耗时回填到这里。

### 任务书（`brief.ts`）

- 八节与固定句照规划仓库 `docs/templates/task-brief.md`。规则原文只经 `git show $SPEC_REF:<路径>` 读，表格行去掉「影响面」一列；一跳引用只带表格行。
- 第 4 节只列与本任务相关的保护路径：伸进允许路径里的，以及验收用的规则测试所在的；其余只给清单文件的位置（它们本来就在允许路径之外，路径守卫会拦）。
- 第 5 节内嵌从仓库根到 `paths` 这条链上、以及 `paths` 之下的各级 `AGENTS.md` 全文，根在最前。
- 第 2 次尝试起，第 7 节附上一轮失败输出的末 200 行（最多 8KB，单行截到 400 字符）；任务书快到 24KB 时自动只留放得下的最后几行，剩余空间不足 1KB 就按超限处理。失败输出的路径取在途状态的 `last_error`。
- 超过 24KB 不写文件、退出码 1，并打印各节字节数，方便判断该怎么拆。骨架期实测：根 `AGENTS.md` 加模块 `AGENTS.md` 约占 11KB，留给规则原文的只有约 11KB。

## 2. 还没有的（不要当成已经有）

下面每一项都没有文件，也没有占位脚本。格式统一为 `TODO(规划/11 §<节>): <内容> — blocked on <原因>`，方便全仓检索。

- TODO(规划/11 §2.2): `tick.sh`（取编排锁、回收已结束的运行、算就绪任务、输出下一步动作的 JSON）与每 30 分钟的定时心跳 — blocked on owner（拦截钩子与 `codex` 垫片装好后才启用心跳，§7.3 第 5 项）。锁、认领、就绪计算的函数已在 `lock.ts`、`state.ts`、`status.ts`
- TODO(规划/11 §2.3 第 9 步、§3.2、§8): `push.sh`、`merge.sh`（gitleaks、私有指纹比对、只暂存 `paths`、排队合并、写 `longrun-props` 状态、核对 `couli-runs/approvals/<PR>`） — blocked on GitHub remote（另需私有库 `rebate-private`）
- TODO(规划/11 §3.2): 证据文件生成器（写 `ops/evidence/<编号>.json`） — blocked on B2-01a（10-04 试跑跑通一轮循环后定字段）
- CI 的 `evidence-check` 已有最小实现（`tools/ci/evidence-check.ts`，工作流 `.github/workflows/evidence.yml`，必过项已写进 `ops/branch-protection.json`）；未在 GitHub 上跑过。它检查的字段见 `ops/evidence/README.md`。TODO(规划/11 §3.2): 资金路径 `run_attempt` 不大于 1 — blocked on GitHub remote
- TODO(规划/11 §4.5): `records-from-junit.ts`（由 CI 的 JUnit 生成验收记录，并归档到私有库） — blocked on GitHub remote
- TODO(规划/11 §4.2): `examples-blind.ts`（分账算例两家盲算比对） — blocked on B2-03（排在 10-04~05，代表例要负责人确认）
- TODO(规划/11 §5.3): 规格索引生成器（`ops/spec-index.json`）与每晚推进 `SPEC_REF`、把受影响任务标 `stale` — blocked on B2-01a（排在 10-04~05；条目哈希的算法已在 `spec.ts`，`task.ts check` 已用它核对 `refs_hash`）
- TODO(规划/11 §0): 可信副本同步（`couli-runs/trusted/rebate-platform` 只跟随 `origin/main`） — blocked on GitHub remote。建好前 `trustedRoot()` 就是主检出（任务 worktree 永远不算）
- TODO(规划/11 §2.1): 看板里的未合并 PR 与 CI 状态 — blocked on GitHub remote。现在固定输出「PR/CI: 未接入」，不调用 `gh`
- TODO(规划/11 §5.1): 交接、日志、备忘写进私有库 `rebate-private/ops-state/` — blocked on GitHub remote（私有库未建）。交接现在写在 `couli-runs/handoff/`
- TODO(规划/11 §2.5): 重派退避（15、30、60 分钟）与超限后换家 / `blocked` 的处理 — blocked on `tick.sh`。`state.ts bump-attempt` / `settle` 只负责计数、结算与上限

### 现在怎么手动走一轮（`tick.sh` 之前）

1. `pnpm ops:status` 看就绪任务与失败熔断。
2. 建 worktree `../couli-runs/worktrees/<编号>`（分支 `task/<编号>`）并在沙箱外 `pnpm install --frozen-lockfile`。
3. `tools/agent/dispatch.sh <编号>`（内部依次：`state.ts claim` → `state.ts bump-attempt`（含失败熔断） → `brief.ts` → 后台 `codex-run.sh`），结束后 `tools/agent/post-run.sh <编号>` 过路径守卫。
4. `tools/ops/verify-container.sh <编号>`；任务成败只看它的退出码。
5. 失败要重派时：先 `node tools/ops/state.ts set <编号> --last-error <verify/<n>/log.txt 的路径>`，然后回到第 3 步。`dispatch.sh` 先计数再生成任务书，从第 2 次尝试起每次都重新生成，所以新任务书会写「第 n 次尝试」并带上一轮失败输出的末尾。`last_error` 目前没有脚本自动写，漏了这一步新任务书就没有失败输出。

## 3. 测试

- 单元测试：`pnpm --filter @couli/tools exec vitest run ops`。夹具放 `<仓库>/.tmp/ops-tests/`，`COULI_RUNS` 指到那里，不碰真实的 `couli-runs`。
- 一部分用例读真实的规划仓库（按 `SPEC_REF`）和真实的台账 `ops/tasks/`（取当时的第一个未完成任务，不写死编号，任务完成或归档后用例不用改），所以需要 git 和规划仓库；验证容器里由 `/spec` 快照提供。其中「真实台账通过 `task.ts check`」这条用例让台账校验进了 `pnpm verify`：`refs_hash` 过期会让验证失败。
- GitHub CI 上没有规划仓库：`.github/workflows/ci.yml` 的 `verify-fast` 把公开的规划仓库带完整历史检出到 `.tmp/spec-repo` 并设 `COULI_SPEC_REPO`，否则这些用例和 `spec-ref`、`banned-terms` 守卫都会失败。这一步还没在 GitHub 上跑过。TODO(规划/11 §5.3): 在真实 runner 上验证规划仓库检出 — blocked on GitHub remote
- `verify-container.sh` 的容器路径不在单元测试里（要 Docker 和网络），改了验证配方后手动跑 `bash tools/ops/verify-container.selftest.sh`。
