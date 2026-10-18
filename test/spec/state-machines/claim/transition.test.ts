import { expect, it } from 'vitest';
import { ENTRIES, SPECS, transitionFunction } from './kit.ts';

// 合法迁移共 9 + 3 个；期望行不依赖待测文件。
const LEGAL_CASES = SPECS.flatMap((spec) =>
  spec.legal.map((row) => ({ spec, row, testId: `${spec.testPrefix}-${row.id}` })),
);

it.each(LEGAL_CASES)(
  '[$testId] $row.from + $row.event 返回目标、行号且不是 noop',
  ({ spec, row }) => {
    for (const entry of ENTRIES) {
      expect(transitionFunction(entry.load(spec), spec)(row.from, row.event)).toEqual({
        ok: true,
        to: row.to,
        id: row.id,
        noop: false,
      });
    }
  },
);

// claim: 7 个起点 × 6 事件，剔除 9 个合法组合后剩 33 个；
// claim-item: 4 个起点 × 3 事件，剔除 3 个合法组合后剩 9 个。
// 覆盖 submitted 直接结案、重复 SUBMIT、审核态互转、所有终态再迁移。
const ILLEGAL_CASES = SPECS.flatMap((spec) =>
  [null, ...spec.states].flatMap((from) =>
    spec.events
      .filter((event) => !spec.legal.some((row) => row.from === from && row.event === event))
      .map((event) => ({ spec, from, event })),
  ),
);

it.each(ILLEGAL_CASES)(
  '[CT-04e#4] $spec.name 的 $from + $event 必须 illegal',
  ({ spec, from, event }) => {
    for (const entry of ENTRIES) {
      expect(transitionFunction(entry.load(spec), spec)(from, event)).toEqual({
        ok: false,
        reason: 'illegal',
        id: null,
      });
    }
  },
);
