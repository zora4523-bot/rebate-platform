// B2-09ga judgement rule tests (claude-independent, SPEC_REF 9ab94dc0): 编排裁定 D10-481 ② — the
// initial status of the snapshot is the start, the latest event by event_seq decides, and only a
// latest forfeited event means forfeited. Pure: no database. Expected values are written by hand or
// follow from the sentence above. Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  isShareForfeited,
  type ShareEvent,
  type ShareEventStatus,
  type ShareInitialStatus,
} from '../../../../apps/api/src/modules/commission/application/forfeited-state.ts';

// Through commission's public entry, loaded at run time like the other settlement rule tests do.
const commission = (await import(
  new URL('../../../../apps/api/src/modules/commission/index.ts', import.meta.url).href
)) as { isShareForfeited?: typeof isShareForfeited };

const STATUSES: readonly ShareEventStatus[] = ['active', 'held', 'forfeited'];

/** Events in event_seq order, from 1. */
function events(...statuses: readonly ShareEventStatus[]): ShareEvent[] {
  return statuses.map((status, index) => ({ eventSeq: BigInt(index + 1), status }));
}

it('[AC-B2-09ga#1] D10-481 ② 必钉序列：初始 forfeited + active → 否；初始 forfeited 未恢复 → 是；初始 active → forfeited → 是；forfeited→active→forfeited → 是；从未被剥夺 → 否', () => {
  // Initial forfeited: the snapshot's own first event, then the restore.
  expect(isShareForfeited('forfeited', events('forfeited', 'active'))).toBe(false);
  expect(isShareForfeited('forfeited', events('forfeited'))).toBe(true);
  expect(isShareForfeited('active', events('active', 'forfeited'))).toBe(true);
  expect(isShareForfeited('active', events('active', 'forfeited', 'active', 'forfeited'))).toBe(
    true,
  );
  expect(isShareForfeited('forfeited', events('forfeited', 'active', 'forfeited'))).toBe(true);
  expect(isShareForfeited('active', events('active'))).toBe(false);
  expect(isShareForfeited('active', events('active', 'forfeited', 'active'))).toBe(false);
});

it('[AC-B2-09ga#2] D10-481 ②「以 initial_status 为起点」：一条事件都没有时取快照初始状态；有事件时初始状态不再起作用', () => {
  expect(isShareForfeited('forfeited', [])).toBe(true);
  expect(isShareForfeited('active', [])).toBe(false);
  expect(isShareForfeited('forfeited', events('active'))).toBe(false);
  expect(isShareForfeited('active', events('forfeited'))).toBe(true);
});

it('[AC-B2-09ga#3] D10-481 ②「最新为 forfeited 才算被剥夺」：最新是 held 也不算（BR-CALC-13 暂缓不是没收）', () => {
  expect(isShareForfeited('active', events('active', 'held'))).toBe(false);
  expect(isShareForfeited('active', events('active', 'forfeited', 'held'))).toBe(false);
  expect(isShareForfeited('forfeited', events('forfeited', 'held'))).toBe(false);
  expect(isShareForfeited('active', events('active', 'held', 'forfeited'))).toBe(true);
});

it('[AC-B2-09ga#4] 穷举：两种初始状态 × 三种事件的全部序列（长度 0～5），只看最新事件，空序列看初始状态', () => {
  let sequences: ShareEventStatus[][] = [[]];
  const all: ShareEventStatus[][] = [[]];
  for (let length = 1; length <= 5; length += 1) {
    sequences = sequences.flatMap((seen) => STATUSES.map((status) => [...seen, status]));
    all.push(...sequences);
  }
  expect(all).toHaveLength(364);
  const initials: readonly ShareInitialStatus[] = ['active', 'forfeited'];
  for (const initial of initials) {
    for (const sequence of all) {
      const last = sequence.at(-1);
      const expected = last === undefined ? initial === 'forfeited' : last === 'forfeited';
      expect(isShareForfeited(initial, events(...sequence)), `${initial} ${sequence.join()}`).toBe(
        expected,
      );
    }
  }
});

it('[AC-B2-09ga#5] event_seq 决定最新，不看数组顺序：倒序、打乱都一样；按 bigint 比较：9 < 10（不按字符串），超过安全整数的相邻值不混淆；不改入参', () => {
  const reversed = Object.freeze(events('forfeited', 'active', 'forfeited', 'active').reverse());
  expect(isShareForfeited('active', reversed)).toBe(false);
  expect(reversed.map((event) => event.eventSeq)).toEqual([4n, 3n, 2n, 1n]);
  const shuffled: readonly ShareEvent[] = Object.freeze([
    { eventSeq: 2n, status: 'active' },
    { eventSeq: 3n, status: 'forfeited' },
    { eventSeq: 1n, status: 'active' },
  ]);
  expect(isShareForfeited('active', shuffled)).toBe(true);
  expect(
    isShareForfeited('active', [
      { eventSeq: 10n, status: 'active' },
      { eventSeq: 9n, status: 'forfeited' },
    ]),
  ).toBe(false);
  expect(
    isShareForfeited('active', [
      { eventSeq: 9007199254740993n, status: 'active' },
      { eventSeq: 9007199254740992n, status: 'forfeited' },
    ]),
  ).toBe(false);
  expect(
    isShareForfeited('active', [
      { eventSeq: 9007199254740992n, status: 'active' },
      { eventSeq: 9007199254740993n, status: 'forfeited' },
    ]),
  ).toBe(true);
});

it('[AC-B2-09ga#6] D10-481 ②「经 commission 只读端口导出」：commission/index.ts 公开导出这一处判定', () => {
  expect(commission.isShareForfeited).toBeTypeOf('function');
  expect(commission.isShareForfeited?.('forfeited', events('forfeited', 'active'))).toBe(false);
  expect(commission.isShareForfeited?.('forfeited', [])).toBe(true);
});
