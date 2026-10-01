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
| `ops/` | 任务台账检查、在途状态、额度账本与熔断、看板、任务书、交接、verify 容器 | 11 §1.3、§2、§5.3 |
| `agent/` | Codex 包装脚本 `codex-run.sh`、输出 schema、评审提示词、派工与回收 | 11 §2.4、§3.3 |
| `ci/` | CI 工作流用到的脚本：`check-workflows.ts`（工作流与规则集的静态检查）、`evidence-check.ts`（必过检查 `evidence-check`，从基线副本运行） | 11 §3.2、§4.4 |

## guard/ 各守卫

| 命令 | 检查什么 | 出处 |
| --- | --- | --- |
| `risk-of-paths.ts [--json] [--stdin \| <路径>…]` | 按 `ops/risk-map.yaml` 算风险级（默认 RV2，先匹配先得）和保护路径类别。输入可以是改动文件，也可以是任务的 glob；glob 必须整体落在某条白名单规则内才不是 RV2。类别只按路径判断（`package.json` 一律报第二类），是否真的动了 `scripts` 由 `protected-paths.ts` 看差异决定 | 11 §1.2 |
| `path-guard.ts (--task <编号> \| --paths <glob,glob>) --base <提交> [--cwd] [--json]` | 相对 `--base` 的全部改动（含未跟踪文件、改名的两侧）必须落在任务 `paths` 内；`ops/`、`docs/` 下的越界改动单独列出、不算失败 | 11 §2.3 第 6 步 |
| `protected-paths.ts --base <提交> [--cwd] [--task-type <类型>] [--json]` | 第一类：已有文件被改、删、改名；第二、三类：任何改动；`package.json` 只比较 `scripts`；`deps` 任务可改 `pnpm-lock.yaml`。匹配不分大小写 | 11 §4.4 |
| `test-guard.ts [--base <提交>] [--cwd] [--json]` | 测试文件、vitest 配置、package scripts 里不得有 skip / only / todo / retry / passWithNoTests；单元测试不得引用 `pg`、`pg-boss`、`testcontainers`、`@couli/db/testing`，不得 `listen`；测试文件不得读 `TEST_PG_ADMIN_URL`；`test/spec`、`test/properties` 不用 `describe`、不 mock 资金核心；`test/acceptance` 标题带 `[AC-…]`。带 `--base` 时加第一类「只增不改」 | 11 §2.3 第 5 步、§4.1–§4.3 |
| `schema-lint.ts [--cwd] [文件…]` | `tools/agent/schemas/*.json` 每个 object 有 `additionalProperties:false`、全部字段进 `required`，只用约定的关键字 | 11 §2.4 |
| `banned-terms.ts (--spec \| --file <路径>…)` | 禁用词：`--spec` 扫 `SPEC_REF` 版本的 `规划/**`（只经 `git show`），`--file` 扫任务书 | 11 §5.5 |
| `approvals.ts --require <编号>` | `ops/approvals.yaml` 里该条为 `granted: true` 才返回 0 | 11 §3.2、§7.3 |
| `spec-ref.ts` | `SPEC_REF` 是 40 位提交号，且是规划仓库 `origin/main` 的祖先 | 11 §5.3 |
| `agents-pair.ts` | 每个 `AGENTS.md` 配一个内容只有 `@AGENTS.md` 的 `CLAUDE.md`；根 ≤150 行，嵌套 ≤60 行 | 11 §5.1、§5.5 |
| `risk-map-coverage.ts` | `apps/api/src/modules/*`、`packages/*` 的每个目录都在 `ops/risk-map.yaml` 里点名出现 | 11 §1.2 |
| `agents-table.ts --write \| --check` | 根 `AGENTS.md` 里 `<!-- risk-table:begin -->` 与 `<!-- risk-table:end -->` 之间的分工表由 `ops/risk-map.yaml` 生成 | 11 §1.2 |
| `protected-sync.ts` | `protected-paths.json` 与 `.github/workflows/protected-paths.yml` 里内嵌的副本一致 | 11 §4.4 |
| `hidden-unicode.ts` | 文本文件里没有双向控制符和零宽字符 | 11 §4.1 |
| `lib/lockfile.ts`（在 `run.ts static` 里） | `pnpm-lock.yaml` 里的每个 URL 都是 `https://registry.npmjs.org/` 下、不带查询串与凭据；gitleaks 的默认配置不扫锁文件，这条补上 | 11 §8 |
| `run.ts static` | 依次跑：schema-lint、agents-pair、risk-map-coverage、agents-table、protected-sync、test-guard、hidden-unicode、lockfile-urls、spec-ref、banned-terms。不需要 git 历史；没有 `.git` 时（verify 容器）改为遍历目录，并跳过需要规划仓库的两项 | `pnpm guard:static` |
| `run.ts git --base <提交> [--task <编号>] [--cwd]` | 依次跑：path-guard（给了任务时）、protected-paths、test-guard。只在宿主或 CI 跑 | `pnpm guard:git` |

数据文件：`ops/risk-map.yaml`；`guard/protected-paths.json`（11 §4.4 的唯一来源）；`guard/banned-terms.txt` 与 `guard/banned-terms.allow.txt`（每行「路径 glob、制表符、正则」，只放禁止句和历史对照句）；`guard/hooks/prod-hosts.txt`。

已知限制：

- 路径守卫和保护路径守卫看的是 `git diff` 加未跟踪文件，被 `.gitignore` 忽略的文件（`node_modules`、`dist`、`.turbo`、`.tmp`、`*.tsbuildinfo`、`.env`）不在其中。所以验证一侧不能使用 worktree 里的这些文件：verify 容器自己装依赖、自己构建（11 §2.3 第 7 步）。
- `test-guard.ts` 是按行的文本检查，不解析语法；它和根 `eslint.config.js` 的同类规则互为补充。
- 拦截钩子按 codex-cli 0.154.0 的参数表写的（`codex --help`、`codex exec --help`）；升级 Codex 后要重新对照一遍参数表。

## 还没有的守卫

| 守卫 | 出处 | 说明 |
| --- | --- | --- |
| `red-check.ts` | 11 §2.3 第 3 步 | 规则测试必须因断言失败或属性反例而红 |
| `sm-diff.ts` | 11 §4.2 | 状态机双份盲录逐行比对 |
| `records-check` | 11 §4.5 | 验收记录只能由脚本生成 |
| mapper 字段检查 | 11 §4.5 | 联盟 mapper 引用的字段都出现在 probe 录制里 |
| BR / AC 编号存在性、错误码与枚举对照 | 11 §5.5 | 依赖规格索引 `ops/spec-index.json` |
| 时钟守卫（禁 `new Date(`、SQL `now()` 等） | 11 §4.2 | TS 部分已由根 `eslint.config.js` 覆盖 `packages/money`、`packages/domain`；资金模块与 SQL 部分待建 |
| 越界 `ops/`、`docs/` 改动的自动还原 | 11 §2.3 第 6 步 | `path-guard.ts` 现在只报告 |

任务文件 40 行上限的检查在 `tools/ops`（`task.ts check`），不在这里。
