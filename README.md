# rebate-platform（凑狸代码仓库）

凑狸返利 App 的代码仓库：接口契约、后端、数据库迁移、共享包，以及让 Claude 调度 Codex 干活用的脚本和门禁。H5、后台和三端原生工程以后再加。

规划和业务规则不在这里，在旁边的规划仓库 `../couli`。本仓库对应规划的哪个版本，写在根目录的 `SPEC_REF` 文件里（一行提交号）。

## 现在的状态（2026-10-01 骨架）

- **只在本机**：还没有 GitHub 远端，没有推送过。`.github/` 里的 CI 工作流和 `ops/branch-protection.json` 都是写好待用，没有在 GitHub 上跑过或应用过。
- **钩子和垫片没装**：拦截危险命令的钩子与 `codex` 垫片只是 `tools/guard/` 下的文件，没有装进 `~/.claude` 或 `PATH`；安装你已同意过一次（规划/11 §7.3 第 5 项），步骤见 `tools/README.md`。
- **提交前密钥检查**：本仓库的 `.githooks/pre-commit` 会用 gitleaks 扫描要提交的内容。这台电脑上已经启用；新克隆一份要先运行一次 `git config core.hooksPath .githooks`（这是本机 git 设置，不随仓库走），CI 里的 `gitleaks` 检查仍是真正的门禁。
- **没有业务功能**：后端只有能启动的空壳和健康检查；数据库只有基础表；金额、分佣、订单这些都还没写。

## 你可能看到的四条命令

| 命令 | 作用 |
| --- | --- |
| `pnpm dev:stack` | 在本机启动开发用的数据库和缓存（需要 Docker），并建好表 |
| `pnpm verify:fast` | 快速自检：类型、代码规范、单元测试，不需要数据库 |
| `pnpm verify` | 完整自检：在快速自检之上，加连真实数据库的测试 |
| `pnpm ops:status` | 看板：有哪些任务在做、卡在哪、哪个任务被失败熔断停了、今天调了多少次 Codex（只记账） |

第一次用之前先运行 `pnpm install --frozen-lockfile` 和 `git config core.hooksPath .githooks`。这些命令平时由 Claude 运行，你不需要自己敲。

## 规则在哪里

| 内容 | 位置 |
| --- | --- |
| 谁实现、谁评审、怎么合并、什么时候停下问你 | 规划仓库 `规划/11_开发协作与自主推进.md` |
| 技术栈和数据库规则（已锁定） | 规划仓库 `docs/adr/0001-技术栈基线.md` |
| 给代理看的规则摘要 | 本仓库 `AGENTS.md` |
| 你确认过的事项 | 本仓库 `ops/approvals.yaml`（对应规划/11 §7.3） |
| 任务清单 | 本仓库 `ops/tasks/` |

## 故意还没做的

- GitHub 远端仓库、分支保护规则、Actions 策略、推送保护：等建远端那天一起做并实测（规划/11 §3.2、§9.3）。
- 自动心跳和排队合并脚本（`tick.sh`、`push.sh`、`merge.sh`）：依赖 GitHub 远端和上面的钩子。
- 门禁脚本的可信副本 `couli-runs/trusted/rebate-platform`：要跟随远端的 main，远端建好后再建。
- H5（`apps/h5`）、后台（`apps/admin`）、三端代码生成、带密钥的平台探测脚本。
- 本地栈里的对象存储、接口模拟和平台报文模拟服务；变异测试；错误监控。
- 业务模块与真实的金额计算：从 `packages/money` 的试跑任务开始（规划/11 §9.2）。

更细的指针见 `docs/README.md`。
