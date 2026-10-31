// B2-09ga read rule tests (claude-independent, SPEC_REF 9ab94dc0): 编排裁定 D10-481 ② over the rows
// snapshot-store really writes (one first event per beneficiary) — the two public reads of commission
// answer one state of a share: forfeited events only while the latest event of that (user, role) is
// forfeited; beneficiaries[].initial_status stays the snapshot's value (BR-CALC-10). Real pieces:
// commission's writer and reads, PostgreSQL as couli_app. Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  appendShareEvent,
  attributionOf,
  fixture,
  forfeitedOf,
  judged,
  seedShareOrder,
  shareEvents,
  suite,
  threePeople,
  writtenSnapshot,
} from './kit.ts';

const s = suite();

const ACTIVE = { status: 'active', reason: null } as const;
const HELD = { status: 'held', reason: null } as const;
const BANNED = { status: 'forfeited', reason: 'banned' } as const;
const DELETED = { status: 'forfeited', reason: 'deleted' } as const;

it('[AC-B2-09ga#7] 快照写入同时写初始事件：initial_status=forfeited（banned）经真实写入后是一条 forfeited 初始事件，判定为被剥夺、两个读取都列出；追加 active 后不再被剥夺、不再列出，beneficiaries 的 initialStatus 与 forfeitReason 仍是快照值', async () => {
  const f = await fixture(s);
  const { orderId, owner, direct } = await writtenSnapshot(f, 'banned');

  const written = await shareEvents(f, orderId);
  expect(written.map((e) => [e.user_id, e.role, e.status, e.reason])).toEqual([
    [owner, 'self', 'active', null],
    [direct, 'direct', 'forfeited', 'banned'],
  ]);
  expect(await judged(f, orderId, direct, 'direct')).toBe(true);
  expect(await judged(f, orderId, owner, 'self')).toBe(false);
  expect(await forfeitedOf(f, orderId)).toEqual([
    { eventSeq: written[1]!.event_seq, userId: direct, role: 'direct', reason: 'banned' },
  ]);

  await appendShareEvent(f, orderId, direct, 'direct', ACTIVE);

  expect(await judged(f, orderId, direct, 'direct')).toBe(false);
  expect(await forfeitedOf(f, orderId)).toEqual([]);
  const { beneficiaries } = await attributionOf(f, orderId);
  expect(beneficiaries.find((b) => b.role === 'direct')).toMatchObject({
    userId: direct,
    initialStatus: 'forfeited',
    forfeitReason: 'banned',
  });
});

it('[AC-B2-09ga#8] 初始 forfeited → active → forfeited：再次被剥夺，两个读取只列最新一条及其原因；初始那条不再列出', async () => {
  const f = await fixture(s);
  const order = await seedShareOrder(f, {
    status: 'WAITING',
    people: threePeople({ initial: 'banned' }),
  });
  const direct = order.user('direct');
  await appendShareEvent(f, order.orderId, direct, 'direct', ACTIVE);
  await appendShareEvent(f, order.orderId, direct, 'direct', DELETED);

  expect(await judged(f, order.orderId, direct, 'direct')).toBe(true);
  const last = (await shareEvents(f, order.orderId)).at(-1)!;
  expect(await forfeitedOf(f, order.orderId)).toEqual([
    { eventSeq: last.event_seq, userId: direct, role: 'direct', reason: 'deleted' },
  ]);
});

it('[AC-B2-09ga#9] 最新事件是 held：不算被剥夺，两个读取不列出之前的 forfeited；held 之后再 forfeited 才列出', async () => {
  const f = await fixture(s);
  const order = await seedShareOrder(f, { status: 'WAITING', people: threePeople({}) });
  const direct = order.user('direct');
  await appendShareEvent(f, order.orderId, direct, 'direct', BANNED);
  await appendShareEvent(f, order.orderId, direct, 'direct', HELD);

  expect(await judged(f, order.orderId, direct, 'direct')).toBe(false);
  expect(await forfeitedOf(f, order.orderId)).toEqual([]);

  await appendShareEvent(f, order.orderId, direct, 'direct', BANNED);

  expect(await judged(f, order.orderId, direct, 'direct')).toBe(true);
  const last = (await shareEvents(f, order.orderId)).at(-1)!;
  expect(await forfeitedOf(f, order.orderId)).toEqual([
    { eventSeq: last.event_seq, userId: direct, role: 'direct', reason: 'banned' },
  ]);
});

it('[AC-B2-09ga#10] 判定按 (order, user, role) 各算各的：同一会员的另一角色、同单别的会员、别的订单上的同一份额都不受这次恢复影响', async () => {
  const f = await fixture(s);
  const order = await seedShareOrder(f, {
    status: 'WAITING',
    people: [
      { role: 'self', ratioBp: 5000, initial: 'banned' },
      { role: 'direct', ratioBp: 1000, initial: 'banned' },
      { role: 'indirect', ratioBp: 500 },
    ],
  });
  const direct = order.user('direct');
  const sameMember = await seedShareOrder(f, {
    status: 'WAITING',
    people: [
      { role: 'share', ratioBp: 5000, initial: 'banned', userId: direct },
      { role: 'direct', ratioBp: 1000, initial: 'banned', userId: direct },
    ],
  });
  const sibling = await seedShareOrder(f, {
    status: 'WAITING',
    people: threePeople({ userId: direct, initial: 'banned' }),
  });

  await appendShareEvent(f, order.orderId, direct, 'direct', ACTIVE);
  await appendShareEvent(f, sameMember.orderId, direct, 'direct', ACTIVE);

  expect(await judged(f, order.orderId, direct, 'direct')).toBe(false);
  expect(await judged(f, order.orderId, order.user('self'), 'self')).toBe(true);
  expect(await judged(f, sameMember.orderId, direct, 'direct')).toBe(false);
  expect(await judged(f, sameMember.orderId, direct, 'share')).toBe(true);
  expect(await judged(f, sibling.orderId, direct, 'direct')).toBe(true);
  expect((await forfeitedOf(f, order.orderId)).map((e) => e.role)).toEqual(['self']);
  expect((await forfeitedOf(f, sameMember.orderId)).map((e) => e.role)).toEqual(['share']);
  expect((await forfeitedOf(f, sibling.orderId)).map((e) => e.role)).toEqual(['direct']);
});
