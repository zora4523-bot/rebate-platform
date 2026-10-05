# tools/

编排与门禁脚本。规则出处：规划仓库 `规划/11_开发协作与自主推进.md`（下称 11）。整个目录是保护路径第三类（11 §4.4）：改动要负责人确认。

## 约定

- 运行方式：`node tools/<目录>/<名称>.ts`（Node 24 直接运行 TypeScript，只用可擦除语法；相对引用带 `.ts` 后缀），或 bash / perl。只用 Node 内置模块和 `ajv`，不引用任何 workspace 包。
- 退出码：`0` 通过；`1` 检查不通过或发现违规；`2` 用法错误或内部错误。个别脚本另有约定的退出码，在各自文件头写明（如 `codex-run.sh` 的 10 / 11 / 12 / 124，垫片的 126 / 127）。
- 输出：`--json` 时标准输出只有一个 JSON 文档；给人看的文字走标准错误。不带 `--json` 时标准输出是一行结论（`PASS …` / `FAIL …` / `SKIP …`）。
- 两个根目录（11 §2.4）：
  - **被检查的目录**：`--cwd <目录>`；不给时取当前目录所在 git 仓库的根，不在仓库里就取当前目录。
  - **可信根** `trustedRoot()`：门禁用的数据从这里读（任务的 `paths`、保护路径清单、风险表、禁用词、批准记录），被测分支削弱不了卡它自己的关口。取值顺序：环境变量 `COULI_TRUSTED_ROOT`，`couli-runs/trusted/rebate-platform`（存在时），当前检出——但当前检出是任务 worktree（`couli-runs/worktrees/<编号>`）时直接报错，`COULI_TRUSTED_ROOT` 指到 worktree 也报错；没有静默回退。
- 环境变量：`COULI_RUNS`（默认 `<仓库>/../couli-runs`）、`COULI_SPEC_REPO`（默认 `<仓库>/../couli`）、`COULI_TRUSTED_ROOT`。脚本位于 `couli-runs/worktrees/<编号>` 或 `couli-runs/trusted/<名称>` 下时，默认值按所在的 `couli-runs` 推算。
- 测试：`pnpm --filter @couli/tools exec vitest run <子目录>`。用到 git 的夹具仓库建在 `<仓库>/.tmp/` 下，不放系统临时目录（那里是 Codex 沙箱的可写根，11 §0）。

## 目录

| 目录 | 内容 | 负责的规则 |
| --- | --- | --- |
| `lib/` | 共用库：`yaml-lite.ts`（严格的 YAML 子集）、`glob.ts`、`paths.ts`、`git.ts`（只读）、`fsx.ts`（原子写）、`task-file.ts`（任务台账文件的形状校验） | 11 §2.1 |
| `guard/` | 门禁守卫，见下表；`hooks/` 是 Claude 会话的 PreToolUse 拦截钩子，`shim/` 是 `codex` 垫片（两者都只是文件，安装步骤在各自的 `INSTALL.md`） | 11 §1.2、§2.3、§2.4、§4、§5.5、§8 |
| `ops/` | 任务台账检查、在途状态与失败熔断、用量账本（只记账）、看板、任务书、交接、verify 容器 | 11 §1.3、§2、§5.3 |
| `agent/` | Codex 包装脚本 `codex-run.sh`、输出 schema、评审提示词、派工与回收 | 11 §2.4、§3.3 |
| `ci/` | CI 工作流用到的脚本：`check-workflows.ts`（工作流与规则集的静态检查）、`evidence-check.ts`（必过检查 `evidence-check`，从基线副本运行；非 `task/` 分支带有效负责人批准标签且没碰资金与归属实现路径时免证据文件）、`oasdiff-base.ts`（契约工作流的 oasdiff 前处理：基线契约去掉 `x-implementation: planned` 的 operation 再比较，尚无路由与调用方的接口不算破坏兼容） | 11 §3.2、§4.4 |

## guard/ 各守卫

| 命令 | 检查什么 | 出处 |
| --- | --- | --- |
| `risk-of-paths.ts [--json] [--stdin \| <路径>…]`；`risk-of-paths.ts --sets` | 按 `ops/risk-map.yaml` 算风险级（默认 RV2，先匹配先得）和保护路径类别。`--sets`：标准输入是 JSON 数组的数组（多组路径），输出 JSON 报告数组，每组一份、与单独调用相同；`tools/ops/task.ts check` 与看板用它一次算完整本台账（`batchRisk`）。输入可以是改动文件，也可以是任务的 glob；glob 必须整体落在某条白名单规则内才不是 RV2。类别只按路径判断（`package.json` 一律报第二类），是否真的动了 `scripts` 由 `protected-paths.ts` 看差异决定 | 11 §1.2 |
| `path-guard.ts (--task <编号> \| --paths <glob,glob>) --base <提交> [--author] [--cwd] [--json]` | 相对 `--base` 的全部改动（含未跟踪文件、改名的两侧）必须落在任务 `paths` 内；`ops/`、`docs/` 下的越界改动单独列出、不算失败。`--author`：Codex 写规则测试那一轮的工作区（`tools/agent/post-run.sh` 在 `phase: test` 时用）：只许台账 `test_paths`（没有就整轮失败，CR-06）与任务 `paths` 内的 `NotImplemented` 骨架；骨架按新增或改动的函数体逐个检查（`guard/lib/skeleton.ts`，CR-05）。CI 的 path-guard-author（基线到 `spec_commit`）同样按函数体检查，台账有 `test_paths` 时只认它，2026-10-05 前的旧台账仍用全部第一类 | 11 §2.3 第 3、6 步 |
| `protected-paths.ts --base <提交> [--cwd] [--task-type <类型>] [--json]` | 第一类：已有文件被改、删、改名；第二、三类：任何改动；`package.json` 只比较 `scripts`；`deps` 任务可改 `pnpm-lock.yaml`。匹配不分大小写 | 11 §4.4 |
| `test-guard.ts [--base <提交>] [--cwd] [--json]` | 测试文件、vitest 配置、package scripts 里不得有 skip / only / todo / retry / passWithNoTests（retry 的口径见下文「retry 怎么查」）；单元测试不得引用 `pg`、`pg-boss`、`testcontainers`、`@couli/db/testing`，不得 `listen`；测试文件不得读 `TEST_PG_ADMIN_URL`；`test/spec`、`test/properties` 不用 `describe`、不 mock 资金核心；`test/acceptance` 标题带 `[AC-…]`。带 `--base` 时加第一类「只增不改」 | 11 §2.3 第 5 步、§4.1–§4.3 |
| `schema-lint.ts [--cwd] [文件…]` | `tools/agent/schemas/*.json` 每个 object 有 `additionalProperties:false`、全部字段进 `required`，只用约定的关键字 | 11 §2.4 |
| `banned-terms.ts (--spec \| --file <路径>…)` | 禁用词：`--spec` 扫 `SPEC_REF` 版本的 `规划/**`（只经 `git show`），`--file` 扫任务书 | 11 §5.5 |
| `red-check.ts --task <编号> --report <JSON>[,<JSON>] (--expected-list <文件> \| --cwd <目录> --base <提交>) [--root <目录>] [--json]`；`--print-expected` 只列应跑的文件 | 规则测试先红且红得对：应跑的文件 = 本任务在台账 `test_paths` 内新增或改动的 `*.test.ts`，与报告逐个对账，缺文件、没跑任何测试、跳过、待办都失败（CR-10）；每条测试都失败，原因是断言失败、断言型的 fast-check 反例或骨架的 `NotImplemented`；找不到模块、`TypeError`、连不上库、迁移或夹具失败、服务没起、构建失败都不算，包在 fast-check 或钩子报错里也不算（CR-11）。`--json` 时标准输出只有一份 JSON（CR-16）。适用范围：台账 `tester` 不是 `none` 的任务，**不分风险级**（2026-10-05 起 RV0 / RV1 有测试作者的任务也先写先红，`ops/approvals.yaml` 第 19 条）；`tester: none` 输出 `SKIP`、退出 0。报告由编排者在隔离容器里跑规则测试得到（Codex 写的测试不在宿主跑）；`--root` 是报告里文件名的前缀，默认容器里的 `/work/repo` | 11 §2.3 第 3 步 |
| `approvals.ts --require <编号>` | `ops/approvals.yaml` 里该条为 `granted: true` 才返回 0 | 11 §3.2、§7.3 |
| `spec-ref.ts` | `SPEC_REF` 是 40 位提交号，且是规划仓库 `origin/main` 的祖先 | 11 §5.3 |
| `agents-pair.ts` | 每个 `AGENTS.md` 配一个内容只有 `@AGENTS.md` 的 `CLAUDE.md`；根 ≤150 行，嵌套 ≤60 行 | 11 §5.1、§5.5 |
| `risk-map-coverage.ts` | `apps/api/src/modules/*`、`packages/*` 的每个目录都在 `ops/risk-map.yaml` 里点名出现 | 11 §1.2 |
| `agents-table.ts --write \| --check` | 根 `AGENTS.md` 里 `<!-- risk-table:begin -->` 与 `<!-- risk-table:end -->` 之间的分工表由 `ops/risk-map.yaml` 生成 | 11 §1.2 |
| `protected-sync.ts` | `protected-paths.json` 与 `lib/owner-approval.mjs` 各自和 `.github/workflows/protected-paths.yml` 里内嵌的副本一致 | 11 §4.4 |
| `hidden-unicode.ts` | 文本文件里没有双向控制符和零宽字符 | 11 §4.1 |
| `lib/lockfile.ts`（在 `run.ts static` 里） | `pnpm-lock.yaml` 里的每个 URL 都是 `https://registry.npmjs.org/` 下、不带查询串与凭据；gitleaks 的默认配置不扫锁文件，这条补上 | 11 §8 |
| `run.ts static` | 依次跑：schema-lint、agents-pair、risk-map-coverage、agents-table、protected-sync、test-guard、hidden-unicode、lockfile-urls、spec-ref、banned-terms。不需要 git 历史；没有 `.git` 时（verify 容器）改为遍历目录，并跳过需要规划仓库的两项 | `pnpm guard:static` |
| `run.ts git --base <提交> [--task <编号>] [--cwd] [--pr-number <PR 号>]` | 依次跑：path-guard（给了任务时，台账见下文「任务分支自带的台账」；有可用的 `spec_commit` 时另加 path-guard-author，见下文「任务分支按 spec_commit 分段」）、protected-paths、test-guard。只在宿主或 CI 跑。带 `--pr-number`（CI 的 guard-git）且 protected-paths 或 test-guard 的「只增不改」有问题时，按负责人批准标签查一次（见下文「负责人批准标签」）：批准有效，这两类问题改为警告照样打印、不算失败；其余问题（path-guard、skip / only 等）照旧失败；没有有效标签时行为不变 | `pnpm guard:git` |

负责人批准标签（11 §4.4；负责人 2026-10-02 决定，`ops/approvals.yaml` 第 12 条）：PR 上的标签 `owner-approved-<头提交前 12 位>`，且 PR 时间线显示最后一次加这个标签的是仓库所有者账号，才算批准；标签对应的不是当前头提交（比如推了新提交）就不算。唯一实现是 `guard/lib/owner-approval.mjs`（纯 JavaScript，`protected-paths` 工作流不能检出仓库，所以内嵌一份逐字副本，由 `protected-sync` 核对）；`run.ts git` 与 `ci/evidence-check.ts` 从基线副本导入同一个文件。CI 守卫一律跑基线分支的脚本，所以改这套逻辑的 PR 自己合并前用不上新逻辑。

任务分支按 spec_commit 分段（11 §2.3 第 3、6 步；负责人 2026-10-02 决定，`ops/approvals.yaml` 第 14 条）：`run.ts git --task <编号>`（CI 的 guard-git 对 `task/<编号>` 分支就这样调用）先读头提交里的 `ops/evidence/<编号>.json`，`task` 必须是这个编号，`spec_commit` 必须解析成提交、是头提交的祖先、是 `--base` 的后代（实现在 `guard/lib/spec-base.ts`，`ci/evidence-check.ts` 共用其中的祖先判断）。成立时分两段查：

- **path-guard**：`spec_commit` 到工作区（含未跟踪文件）的改动必须落在任务 `paths` 内，`ops/`、`docs/` 越界照旧只报告——这是实现者的部分；
- **path-guard-author**：`--base` 到 `spec_commit` 的提交是规则测试作者的，只许三类路径：规则测试资产（可信副本 `protected-paths.json` 第一类，如 `test/spec/**`、`test/properties/**`、`packages/testing/**`）、台账 `ops/tasks/**`、任务 `paths` 内的骨架（文件在 `spec_commit` 里必须含 `NotImplemented`）；任务 `paths` 内被删或改名移走的文件、不含 `NotImplemented` 的实现、其余任何路径都失败。

没有证据文件、JSON 不对、`task` 不符、`spec_commit` 不是提交或不在基线与头提交之间时，path-guard 照旧从 `--base` 算（规则测试会被判越界，即失败关闭），并在提示里写明原因。protected-paths 与 test-guard 不受影响，始终从 `--base` 算。基线前进后任务分支要变基到新基线，证据文件的 `spec_commit` 随之更新，否则不是基线的后代。

任务分支自带的台账（负责人 2026-10-02 决定，`ops/approvals.yaml` 第 17 条）：`run.ts git --task <编号>` 的台账照旧从可信根读；只有可信根没有 `ops/tasks/<编号>.yaml`、而 PR 自己新增了它（`--base` 里没有、`--cwd` 的头提交里有，未提交的不算）时，才从头提交读，并在 path-guard 的提示里写明。编号只来自 `task/<编号>` 分支名，所以一个分支只能带上自己任务的台账，改不了基线上已有的台账；protected-paths、test-guard 与其余数据仍从可信根读。基线上已有这份台账而可信根没有（可信副本过期）时直接报错。实现是 `guard/lib/checks.ts` 的 `guardTask`。台账目录 `ops/tasks/**` 在 `ops/risk-map.yaml` 里是 RV0，只改台账的 PR 不需要证据文件。

retry 怎么查（`guard/lib/test-guard.ts`；编排会话 2026-10-03 按 `ops/approvals.yaml` 第 16 条收窄，原先把测试文件里任何一行 `retry:` 都当成 Vitest 的重试选项，被测接口的字段叫 `retry` 也会被拦）：

- vitest 配置文件与 package scripts：不变，`retry` 只能是 0，脚本不得带 `--retry`。
- 资金与归属测试文件（`isFundsTestFile`：`packages/money`、`packages/domain`、`apps/api/src/modules/` 下资金与归属模块（按词干匹配，覆盖 `tools/ci/evidence-check.ts` 的 MONEY_PATHS）、`test/spec` 与 `test/properties` 下目录或文件名带这些词干的、`test/acceptance`、`test/replay`、`db/`）：不变，任何一行出现非 0 的 `retry:` 或简写 `{ retry }` 都失败（规划/11 §4.2）。
- 其他测试文件：只拦 Vitest 的重试选项，即 `it` / `test` / `describe` / `suite`（含 `.concurrent`、`.each(…)`、`.for(…)`、`.skipIf(…)` 等修饰链，以及本文件里 `const x = test.extend(…)` 得到的 `x`）第二个参数（选项对象）里非 0 的 `retry`（含简写与带引号的键），跨行也查；选项写成本文件里的对象常量时读那个常量，读不到（导入的、成员表达式、展开 `...`）一律失败；形如「标题字面量、含 `retry` 的对象、函数字面量」的其他调用（比如从别的文件导入的自定义测试函数）同样失败。`retry` 作普通字段名、参数名不再报。

数据文件：`ops/risk-map.yaml`；`guard/protected-paths.json`（11 §4.4 的唯一来源）；`guard/banned-terms.txt` 与 `guard/banned-terms.allow.txt`（每行「路径 glob、制表符、正则」，只放禁止句和历史对照句）；`guard/hooks/prod-hosts.txt`。

已知限制：

- 路径守卫和保护路径守卫看的是 `git diff` 加未跟踪文件，被 `.gitignore` 忽略的文件（`node_modules`、`dist`、`.turbo`、`.tmp`、`*.tsbuildinfo`、`.env`）不在其中。所以验证一侧不能使用 worktree 里的这些文件：verify 容器自己装依赖、自己构建（11 §2.3 第 7 步）。
- `test-guard.ts` 基本是按行的文本检查；只有非资金测试文件的 retry 检查会跨行读调用的参数（不是完整的语法解析，见「retry 怎么查」）。它和根 `eslint.config.js` 的同类规则互为补充。
- 拦截钩子按 codex-cli 0.154.0 的参数表写的（`codex --help`、`codex exec --help`）；升级 Codex 后要重新对照一遍参数表。

## 还没有的守卫

| 守卫 | 出处 | 说明 |
| --- | --- | --- |
| 浏览器测试的隔离红测 | 11 §2.3 第 3 步 | `verify-container.sh --red` 只跑 Vitest；Playwright 没有入口，证据的 `mode: ci` 在归档接入前一律拒绝 |
| CI 证据归档核验 | 11 §3.2、§4.5 | `evidence-check` 暂拒所有 `mode: ci` 记录（CR2-06），归档 `rebate-private/ci-evidence` 接入后再核对运行与报告内容 |
| `sm-diff.ts` | 11 §4.2 | 状态机双份盲录逐行比对 |
| `records-check` | 11 §4.5 | 验收记录只能由脚本生成 |
| mapper 字段检查 | 11 §4.5 | 联盟 mapper 引用的字段都出现在 probe 录制里 |
| BR / AC 编号存在性、错误码与枚举对照 | 11 §5.5 | 依赖规格索引 `ops/spec-index.json` |
| 时钟守卫（禁 `new Date(`、SQL `now()` 等） | 11 §4.2 | TS 部分已由根 `eslint.config.js` 覆盖 `packages/money`、`packages/domain`；资金模块与 SQL 部分待建 |
| 越界 `ops/`、`docs/` 改动的自动还原 | 11 §2.3 第 6 步 | `path-guard.ts` 现在只报告 |

任务文件 40 行上限的检查在 `tools/ops`（`task.ts check`），不在这里。
