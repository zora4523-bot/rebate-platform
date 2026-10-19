import { expect, it } from 'vitest';
import { FixedClock } from '../../platform/index.ts';
import {
  DEFAULT_CLAIM_WINDOW_HOURS,
  claimCompareValue,
  claimCounterDay,
  claimWindowHours,
  judgeClaimChild,
  judgeClaimChildren,
  secondsUntilNextChinaDay,
  stripClaimSpaces,
  type ClaimChild,
  type ClaimChildContext,
} from './claim-rules.ts';

const at = (iso: string) => new FixedClock(iso).now();
const ATTR = '2028-01-14T16:10:00.000Z'; // 2028-01-15 00:10 +08:00
const applicant = '019c0000-0000-7000-8000-000000000001';
const other = '019c0000-0000-7000-8000-000000000002';

function child(patch: Partial<ClaimChild> = {}): ClaimChild {
  return {
    sub_order_id: 'S1',
    attr_at: at(ATTR),
    rebate_status: 'UNATTRIBUTED',
    user_id: null,
    locked: false,
    ...patch,
  };
}
function context(patch: Partial<ClaimChildContext> = {}): ClaimChildContext {
  return {
    applicant,
    paid_date: '2028-01-15',
    now: at('2028-01-15T04:00:00.000Z'),
    windowHours: DEFAULT_CLAIM_WINDOW_HOURS,
    alreadyClaimed: new Set(),
    ...patch,
  };
}

it('[AC-B1-10b#8] 只删 U+0020，制表符与全角空格保留', () => {
  expect(stripClaimSpaces(' 0 0 12 ')).toBe('0012');
  expect(stripClaimSpaces('\t12　')).toBe('\t12　');
  expect(stripClaimSpaces('   ')).toBe('');
});

it('[AC-B1-10b#11] 拼多多比较值去掉全部连字符，其他平台原样', () => {
  expect(claimCompareValue('pdd', '1-2345--6')).toBe('123456');
  expect(claimCompareValue('taobao', '12-34')).toBe('12-34');
  expect(claimCompareValue('jd', '12-34')).toBe('12-34');
});

it('[AC-B1-10b#18] window_hours 只认正整数，其余按 720', () => {
  expect(claimWindowHours(2)).toBe(2);
  for (const value of [undefined, null, 0, -1, 0.5, '720', true, Number.NaN]) {
    expect(claimWindowHours(value)).toBe(720);
  }
});

it('[AC-B1-10b#16] ④a 按 attr_at 的 +08:00 日期比较，先于其余各项', () => {
  const worst = child({ rebate_status: 'VOID', user_id: other, locked: true });
  expect(judgeClaimChild(worst, context({ paid_date: '2028-01-14' }))).toEqual({
    code: 30202,
    reason: 'FACTOR_MISMATCH',
  });
  expect(judgeClaimChild(child(), context())).toBeNull();
});

it('[AC-B1-10b#17] ④b 绝对 720 小时：边界整点通过，后一毫秒过期', () => {
  const boundary = at('2028-02-13T16:10:00.000Z');
  expect(judgeClaimChild(child(), context({ now: boundary }))).toBeNull();
  expect(judgeClaimChild(child(), context({ now: at('2028-02-13T16:10:00.001Z') }))).toEqual({
    code: 30202,
    reason: 'CLAIM_EXPIRED',
  });
  expect(
    judgeClaimChild(child(), context({ now: at('2028-01-14T18:10:01.000Z'), windowHours: 2 })),
  ).toEqual({ code: 30202, reason: 'CLAIM_EXPIRED' });
});

it('[AC-B1-10b#20] ④ 的 c→d→e→f 依次取第一个失败', () => {
  const claimed = new Set(['S1']);
  expect(judgeClaimChild(child({ rebate_status: 'VOID', user_id: other }), context())).toEqual({
    code: 30202,
    reason: 'ORDER_INVALID',
  });
  expect(
    judgeClaimChild(
      child({ user_id: applicant, locked: true }),
      context({ alreadyClaimed: claimed }),
    ),
  ).toEqual({ code: 30205 });
  expect(judgeClaimChild(child({ user_id: applicant, locked: true }), context())).toEqual({
    code: 30202,
    reason: 'ALREADY_YOURS',
  });
  expect(judgeClaimChild(child({ user_id: other }), context())).toEqual({ code: 30204 });
  expect(judgeClaimChild(child({ locked: true }), context())).toEqual({ code: 30204 });
});

it('[AC-B1-10b#24] 全失败取 JS 字符串升序第一项；部分通过只留通过者且升序', () => {
  const failed = judgeClaimChildren(
    [
      child({ sub_order_id: 'a1', rebate_status: 'VOID' }),
      child({ sub_order_id: 'Z1', locked: true }),
    ],
    context(),
  );
  expect(failed).toEqual({ passed: [], failure: { code: 30204 } });
  const partial = judgeClaimChildren(
    [
      child({ sub_order_id: 'z1' }),
      child({ sub_order_id: 'a1', user_id: applicant }),
      child({ sub_order_id: 'Z1' }),
    ],
    context(),
  );
  expect(partial.failure).toBeNull();
  expect(partial.passed.map((row) => row.sub_order_id)).toEqual(['Z1', 'z1']);
});

it('[AC-B1-10b#27] 计数键按 +08:00 日；TTL 向上取整到次日 00:00 且至少 1 秒', () => {
  expect(claimCounterDay(at('2028-01-15T15:59:59.999Z'))).toBe('20280115');
  expect(claimCounterDay(at('2028-01-15T16:00:00.000Z'))).toBe('20280116');
  expect(secondsUntilNextChinaDay(at('2028-01-15T15:59:58.500Z'))).toBe(2);
  expect(secondsUntilNextChinaDay(at('2028-01-15T15:59:59.999Z'))).toBe(1);
  expect(secondsUntilNextChinaDay(at('2028-01-15T16:00:00.000Z'))).toBe(86_400);
});
