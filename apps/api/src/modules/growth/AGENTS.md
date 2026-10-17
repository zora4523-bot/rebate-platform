# apps/api/src/modules/growth（成长：邀请关系与等级）

邀请关系（上级关系 `parent_id`）、用户等级（`users.level`）、两者的只插入变更日志，以及按时点回放（`levelAt` / `parentAt`）。后续由任务加入邀请码、绑定、补填与邀请落地页。

## 谁能改

- 风险级 RV2（归属：上级关系与等级日志，同 linking，`ops/risk-map.yaml`）。主实现 Claude Opus 5.5 子代理；规则测试作者 Codex（实现前先写、先红）；Codex 新只读会话对抗评审，无未关闭的 S0 / S1 才合并（`ops/approvals.yaml` 第 19、27 条）。
- 实现者只写 `src/**/*.test.ts` 单元测试；规则测试在 `test/spec/` 下，实现任务不能改删。

## 依据（只写指针，取值与规则只在 08）

| 要查什么 | 看哪里 |
| --- | --- |
| 邀请关系、等级、变更日志、按时点回放 | 08 BR-INV-* |
| 模块职责、拥有的表、依赖 | 规划/02 §4.1 `growth` 行 |
| 表结构 | `db/schema.sql` |
| 本线拆分与待裁定 | `couli-runs/IDENTITY-tips/wave2-plan.md`（不入库） |

## 硬规则

1. 上级关系（`parent_id`）与等级（`users.level`）只由本模块写（BR-INV-11、BR-INV-14）；别的模块要改只经本模块端口。
2. 每次变更在同一事务内写只插入的 `level_change_logs` / `relation_change_logs`；日志不更新、不删除。
3. 读历史时点的等级与上级只用 `levelAt` / `parentAt`，不读当前值代替。
4. identity 不 import growth；需要的能力经 `app.module` 注入端口。
5. 时间只读注入的 `Clock`，不用 SQL 时钟或 `Date.now()`。
6. 只读写本模块的表；别的模块的数据只经对方 `index.ts` 导出的端口。
7. 日志只用 pino，不打手机号等个人信息。
