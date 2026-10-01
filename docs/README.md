# docs/

本目录只放本仓库自己的说明。规则正文不在这里：

| 要找什么 | 在哪里 |
| --- | --- |
| 技术决定（ADR） | 规划仓库 `../couli/docs/adr/`（现有 `0001-技术栈基线.md`）；改基线须新 ADR |
| 模板（`AGENTS.md`、任务书、交接、台账） | 规划仓库 `../couli/docs/templates/` |
| 协作规则（分工、评审、合并、测试标准、记忆） | 规划仓库 `../couli/规划/11_开发协作与自主推进.md` |
| 待负责人问题、备忘、日志、交接、评审全文 | 私有库 `rebate-private`（不进本仓库，规划/11 §5.1、§7.2） |
| 调研材料（不可信） | `docs/research/`，见该目录的 README |

读规划仓库的内容一律按根目录 `SPEC_REF` 的提交号读（`git -C ../couli show $(cat SPEC_REF):<路径>`），不读它的工作区。

## 每类信息只有一个来源（规划/11 §5.4）

| 信息 | 唯一来源 |
| --- | --- |
| 业务取值与含义 | 规划仓库 `规划/08_业务规则/`（BR） |
| 错误码与枚举值 | `contracts/error-codes.yaml`、`contracts/enums/*.yaml`（CT-01 合并后） |
| 表结构 | `db/schema.sql`（生成物） |
| 接口 | `contracts/openapi.yaml` |
| 技术栈与版本 | ADR-0001 和锁文件 `pnpm-lock.yaml` |
| 协作规则 | 规划/11；根 `AGENTS.md` 只写摘要与命令 |
| 风险级与门禁 | `ops/risk-map.yaml`、`ops/branch-protection.json` |
| 保护路径清单 | `tools/guard/protected-paths.json`（`.github/workflows/protected-paths.yml` 内嵌同一份，由守卫比对） |
| 负责人确认过什么 | `ops/approvals.yaml`（对应规划/11 §7.3 批准栏） |

技术实现以 ADR 为准，业务取值以 08 为准；两者冲突时停下开同步任务，不自行取舍。

## 还没生效的门禁（本仓库目前只在本机，没有 GitHub 远端）

- `ops/branch-protection.json` 是按 GitHub 文档写的规则集导出，**还没有应用到任何仓库**。
  TODO(规划/11 §3.2, §9.3 #4): 远端建好当天应用规则集并实测 `current_user_can_bypass=never`、`gh pr merge --admin` 被拒、直推 main 被拒 — blocked on GitHub remote。
  其中 `strict_required_status_checks_policy=false`（不强制分支先追平 main）是骨架的取值，规划/11 没有规定，应用前再定。
- `.github/workflows/*.yml` 五个工作流都没有在 GitHub 上跑过；动作的提交号、gitleaks 与 oasdiff 的校验和已核对，其余行为是文档结论。
  TODO(规划/11 §9.3 #10): 首次 CI 跑通后回填耗时 — blocked on GitHub remote。
- `protected-paths` 工作流用 `pull_request_target` 触发：公开仓库默认禁用它，要先建一条只放行这个工作流文件的 Actions 策略。
  TODO(规划/11 §4.4): 建 Actions 策略；负责人批准后的放行方式（现用标签 `owner-approved-<头提交前 12 位>`）仍待定 — blocked on GitHub remote 与负责人决定。
- `longrun-props` 现在由工作流上报；规划/11 §3.2 写的是由 `merge.sh` 从本机写提交状态。
  TODO(规划/11 §3.2): `merge.sh` 建好时二选一 — blocked on GitHub remote 与 tools/ops/merge.sh。
- 每晚用 `gh api` 把 `ops/risk-map.yaml`、`ops/branch-protection.json` 与线上设置比对的任务还没有。
  TODO(规划/11 §5.4): 夜间比对 — blocked on GitHub remote。

工作流与规则集的静态检查：`node tools/ci/check-workflows.ts`（也在 `pnpm test` 里跑）。
