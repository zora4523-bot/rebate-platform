// resolveRoute 的属性测试：BR-AI-14「路由中的厂商 ⊆ 同意清单」、线上只用千问、跨厂商兜底关闭；
// BR-AI-21 只在已签字评测的条目之间选择。对任意路由表、任意选择、任意同意清单：
// 每个 attempt 都是千问、在同意清单内、型号是日期快照且不含 latest、评测已签字、不在 crossVendor 槽位里，
// 主位条目是 Flash 档、备位条目是 Plus 档，顺序是选择里的主、备的子序列，同一条目不会尝试两次（含主备 id 相同的选择）；每个被选中的 id 要么在 attempts 里，要么在 dropped 里。
// 参照条件只按 08 原文在本文件独立写，不调用被测函数以外的实现。属性体只返回布尔。
import { propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import {
  resolveRoute,
  type RouteEntry,
  type RouteSelection,
  type RouteTable,
} from '../../../../apps/api/src/modules/agent/model-gateway/routing/index.ts';

const PINNED_QWEN = /^qwen[\w.-]*-\d{4}-\d{2}-\d{2}$/;

const arbEntry = (id: string): fc.Arbitrary<RouteEntry> =>
  fc.record({
    id: fc.constant(id),
    vendor: fc.constantFrom('qwen' as const, 'glm' as const),
    tier: fc.constantFrom('flash' as const, 'plus' as const),
    model: fc.constantFrom(
      'qwen-flash-2026-09-01',
      'qwen-plus-2026-09-15',
      'qwen-flash-latest',
      'qwen-plus',
      'glm-synthetic-2026-09-01',
    ),
    evaluation: fc.option(
      fc.record({ report: fc.constant('reports/r.md'), signed: fc.boolean() }),
      {
        nil: null,
      },
    ),
  });

const ids = ['a', 'b', 'c', 'x1', 'x2'];
const arbTable: fc.Arbitrary<RouteTable> = fc.record({
  entries: fc.subarray(ids).chain((chosen) => fc.tuple(...chosen.map(arbEntry))),
  crossVendor: fc.subarray(['x1', 'x2']),
});
const arbSelection: fc.Arbitrary<RouteSelection> = fc.oneof(
  fc.constant({ mode: 'no_model' as const }),
  fc.record({
    mode: fc.constant('models' as const),
    primary: fc.constantFrom('a', 'b', 'c', 'missing'),
    backup: fc.option(fc.constantFrom('a', 'b', 'c', 'missing'), { nil: null }),
  }),
);
const arbConsent = fc.subarray(['qwen', 'glm']);

function holds(table: RouteTable, selection: RouteSelection, consent: string[]): boolean {
  let got;
  try {
    got = resolveRoute(table, selection, { consentVendors: consent });
  } catch {
    return false;
  }
  if (selection.mode === 'no_model') return got.mode === 'no_model' && got.attempts.length === 0;
  const wanted =
    selection.backup === null ? [selection.primary] : [selection.primary, selection.backup];
  const attemptIds = got.attempts.map((a) => a.id);
  const distinct = new Set(attemptIds).size === attemptIds.length;
  const ordered = attemptIds.every(
    (id, i) =>
      wanted.indexOf(id) >= 0 &&
      (i === 0 || wanted.indexOf(id) > wanted.indexOf(attemptIds[i - 1] ?? '')),
  );
  const accounted = wanted.every(
    (id) => attemptIds.includes(id) || got.dropped.some((d) => d.id === id),
  );
  const safe = got.attempts.every(
    (a) =>
      a.vendor === 'qwen' &&
      consent.includes(a.vendor) &&
      PINNED_QWEN.test(a.model) &&
      !/latest/i.test(a.model) &&
      a.evaluation !== null &&
      a.evaluation.signed &&
      !table.crossVendor.includes(a.id) &&
      a.tier === (a.id === selection.primary ? 'flash' : 'plus'),
  );
  return got.mode === 'models' && distinct && ordered && accounted && safe;
}

it('[BR-AI-14 厂商 ⊆ 同意清单] 任意路由表、选择与同意清单：attempts 只含同意的、锁定快照的、已签字评测的千问条目', () => {
  expect(() =>
    fc.assert(fc.property(arbTable, arbSelection, arbConsent, holds), propParams()),
  ).not.toThrow();
}, 900_000);
