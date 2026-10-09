// B3-03g: the ending is what the run row holds; cancel and the decision UPDATE under one run row
// lock, first commit wins; the cancel endpoint's deadline is judged after the row lock (BR-AI-23
// 细则「崩溃不改变结果」「取消」, owner 2026-10-08; design §3.3, §5.2, §13 S2-2/S2-3, §7.2 r4-2;
// inherited B3-09b S1 BR-AI-23-cancel-first-commit and BR-AI-23-cancel-deadline).
import { expect, it } from 'vitest';

import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import {
  APP,
  RECOVERED,
  START,
  START_MS,
  accepted,
  doneFrame,
  draftOf,
  instance,
  limits,
  liveTail,
  member,
  newSession,
  request,
  runRow,
  settled,
  stored,
  usedOn,
  memberKey,
  waitingOnLock,
  usePg,
} from './kit.ts';

const pg = usePg();
const DEADLINE = START_MS + 20_000;
const LOCK_END = START_MS + 50_000;

async function acceptOne(clock?: FixedClock) {
  const a = instance(pg.db, clock ? { clock } : {});
  const user = member();
  const session = await newSession(pg.db);
  const { ticket } = accepted(await a.ports.admission.admit(request(user, session), limits()));
  return { a, user, session, ticket };
}

it('[AC-B3-03g#1] 取消截止按取得 run 行锁后的时刻判断：截止前 1 ms 接受（写 GREATEST(now, accepted_at)），正好截止与截止后 1 ms 为 not_running 且不写', async () => {
  for (const [offset, expected] of [
    [-1, 'accepted'],
    [0, 'not_running'],
    [1, 'not_running'],
  ] as const) {
    const { a, ticket } = await acceptOne();
    a.clock.set(new Date(DEADLINE + offset));
    expect(await a.ports.cancel({ appId: APP, runId: ticket.runId }), String(offset)).toBe(
      expected,
    );
    const row = await runRow(pg.db, ticket.runId);
    expect(row['deadline_at'], 'deadline_at = accepted_at + runMaxMs').toEqual(new Date(DEADLINE));
    expect(row['cancel_requested_at'], String(offset)).toEqual(
      expected === 'accepted' ? new Date(DEADLINE - 1) : null,
    );
  }
});

it('[AC-B3-03g#2] 取消在等 run 行锁时跨过截止：拿到锁后才读时钟 → not_running，cancel_requested_at 仍为空', async () => {
  const { a, ticket } = await acceptOne();
  const b = instance(pg.db, { clock: new FixedClock(new Date(DEADLINE - 1)) });
  a.clock.set(new Date(DEADLINE - 5_000));
  const held = a.hooks.hold('facts');
  const s3 = a.ports.registry.recordFacts(ticket.runId, { ending: null, cardsDelivered: 1 });
  try {
    await held.reached;
    let pid!: (n: number) => void;
    const cancelPid = new Promise<number>((resolve) => (pid = resolve));
    b.hooks.onSql('cancel', (n) => {
      pid(n);
      return Promise.resolve();
    });
    const cancel = b.ports.cancel({ appId: APP, runId: ticket.runId });
    await waitingOnLock(pg.db, await cancelPid);
    b.clock.set(new Date(DEADLINE));
    held.release();
    expect(await cancel).toBe('not_running');
  } finally {
    held.release();
    await settled(s3);
  }
  expect((await runRow(pg.db, ticket.runId))['cancel_requested_at']).toBeNull();
});

it('[AC-B3-03g#3] 重复取消返回 accepted 且不再写入；已有其他终止原因或已结束后取消为 not_running、行不变', async () => {
  const { a, ticket } = await acceptOne();
  a.clock.set(new Date(START_MS + 3_000));
  expect(await a.ports.cancel({ appId: APP, runId: ticket.runId })).toBe('accepted');
  const first = await runRow(pg.db, ticket.runId);
  a.clock.set(new Date(START_MS + 4_000));
  expect(await a.ports.cancel({ appId: APP, runId: ticket.runId })).toBe('accepted');
  expect(await runRow(pg.db, ticket.runId)).toEqual(first);
  await liveTail(a, ticket, 'cancelled');
  expect(await a.ports.cancel({ appId: APP, runId: ticket.runId })).toBe('accepted');

  const other = await acceptOne();
  await other.a.ports.registry.recordEnding(
    other.ticket.runId,
    { ending: 'stop', cardsDelivered: 1 },
    draftOf('stop'),
  );
  const before = await runRow(pg.db, other.ticket.runId);
  expect(await other.a.ports.cancel({ appId: APP, runId: other.ticket.runId })).toBe('not_running');
  expect(await runRow(pg.db, other.ticket.runId)).toEqual(before);
  expect(
    await other.a.ports.cancel({ appId: APP, runId: '019a0000-0000-7000-8000-00000000dead' }),
  ).toBe('not_running');
});

it('[AC-B3-03g#4] 取消先提交、本地超时后选定（Redis 写抛错、读为 false）：S4 落为 cancelled，终止帧 done cancelled，计数不退', async () => {
  const { a, user, ticket } = await acceptOne();
  a.signals.broken = true;
  a.clock.set(new Date(START_MS + 19_000));
  expect(await a.ports.cancel({ appId: APP, runId: ticket.runId })).toBe('accepted');
  a.signals.broken = false;
  a.signals.set.clear();
  a.clock.set(new Date(DEADLINE));
  const tail = await liveTail(a, ticket, 'timeout', 0);
  const row = await runRow(pg.db, ticket.runId);
  expect(row['end_reason']).toBe('cancelled');
  expect(row['end_draft']).toEqual(stored(draftOf('cancelled')));
  expect(row['settle_result']).toBe('counted');
  expect(tail.refunded).toBe(false);
  expect(tail.quotaLeft).toBe(99);
  expect(tail.sent).toEqual(doneFrame('cancelled', 99));
  expect(row['final_event']).toEqual(stored(tail.sent));
  expect(await usedOn(pg.db, memberKey(user), '2026-10-06')).toBe(1);
});

it('[AC-B3-03g#5] 取消已提交、S4 提交前进程崩溃：锁期后恢复为 cancelled、计数不退（不按 50001）', async () => {
  const { a, ticket } = await acceptOne();
  a.clock.set(new Date(START_MS + 19_000));
  expect(await a.ports.cancel({ appId: APP, runId: ticket.runId })).toBe('accepted');
  a.hooks.crashAt('ending', 'before');
  a.clock.set(new Date(DEADLINE));
  await settled(
    a.ports.registry.recordEnding(
      ticket.runId,
      { ending: 'timeout', cardsDelivered: 0 },
      draftOf('timeout'),
    ),
  );
  expect((await runRow(pg.db, ticket.runId))['end_reason']).toBeNull();
  const r = instance(pg.db, { clock: new FixedClock(new Date(LOCK_END)) });
  const outcome = await r.ports.finalizer.finalize(ticket.runId);
  expect(outcome).toMatchObject({ kind: 'final', refunded: false, wrote: true });
  const row = await runRow(pg.db, ticket.runId);
  expect(row['end_reason']).toBe('cancelled');
  expect(row['settle_result']).toBe('counted');
  expect(row['final_event']).toEqual(stored(doneFrame('cancelled', 99)));
});

it('[AC-B3-03g#6] 取消 UPDATE 停在提交前、S4 等同一 run 行锁：放行后 S4 落为 cancelled（RETURNING 告诉活进程）', async () => {
  const { a, ticket } = await acceptOne();
  const c = instance(pg.db, { clock: new FixedClock(new Date(START_MS + 19_000)) });
  const held = c.hooks.hold('cancel');
  const cancel = c.ports.cancel({ appId: APP, runId: ticket.runId });
  let s4!: Promise<unknown>;
  try {
    await held.reached;
    let pid!: (n: number) => void;
    const s4Pid = new Promise<number>((resolve) => (pid = resolve));
    a.hooks.onSql('ending', (n) => {
      pid(n);
      return Promise.resolve();
    });
    a.clock.set(new Date(DEADLINE));
    s4 = a.ports.registry.recordEnding(
      ticket.runId,
      { ending: 'timeout', cardsDelivered: 0 },
      draftOf('timeout'),
    );
    await waitingOnLock(pg.db, await s4Pid);
  } finally {
    held.release();
  }
  expect(await cancel).toBe('accepted');
  await s4;
  expect(await a.ports.registry.facts(ticket.runId)).toEqual({
    ending: 'cancelled',
    cardsDelivered: 0,
  });
  const tail = await liveTail(a, ticket, 'timeout', 0);
  expect(tail.sent).toEqual(doneFrame('cancelled', 99));
  expect((await runRow(pg.db, ticket.runId))['end_reason']).toBe('cancelled');
});

it('[AC-B3-03g#7] 取消事务在提交前失败回滚、S4 正在等锁：S4 按自己的结局落为 timeout，无卡退还', async () => {
  const { a, ticket } = await acceptOne();
  const c = instance(pg.db, { clock: new FixedClock(new Date(START_MS + 19_000)) });
  let pid!: (n: number) => void;
  const s4Pid = new Promise<number>((resolve) => (pid = resolve));
  let s4Waiting!: () => void;
  const waiting = new Promise<void>((resolve) => (s4Waiting = resolve));
  c.hooks.onCommit('cancel', async () => {
    await waiting;
    throw new Error('connection lost before COMMIT');
  });
  a.hooks.onSql('ending', (n) => {
    pid(n);
    return Promise.resolve();
  });
  const cancel = settled(c.ports.cancel({ appId: APP, runId: ticket.runId }));
  a.clock.set(new Date(DEADLINE));
  const s4 = a.ports.registry.recordEnding(
    ticket.runId,
    { ending: 'timeout', cardsDelivered: 0 },
    draftOf('timeout'),
  );
  try {
    await waitingOnLock(pg.db, await s4Pid);
  } finally {
    s4Waiting();
  }
  expect(await cancel).toBeInstanceOf(Error);
  await s4;
  const tail = await liveTail(a, ticket, 'timeout', 0);
  expect(tail.refunded).toBe(true);
  const row = await runRow(pg.db, ticket.runId);
  expect(row['end_reason']).toBe('timeout');
  expect(row['cancel_requested_at']).toBeNull();
  expect(row['settle_result']).toBe('refunded');
});

it('[AC-B3-03g#8] S4 先提交（timeout）后到的取消为 not_running、不写 cancel_requested_at；结果 timeout 无卡退还', async () => {
  const { a, ticket } = await acceptOne();
  a.clock.set(new Date(DEADLINE - 10));
  await a.ports.registry.recordEnding(
    ticket.runId,
    { ending: 'timeout', cardsDelivered: 0 },
    draftOf('timeout'),
  );
  expect(await a.ports.cancel({ appId: APP, runId: ticket.runId })).toBe('not_running');
  expect((await runRow(pg.db, ticket.runId))['cancel_requested_at']).toBeNull();
  const tail = await liveTail(a, ticket, 'timeout', 0);
  expect(tail).toMatchObject({ refunded: true, quotaLeft: 100 });
  expect(tail.sent).toEqual(doneFrame('timeout', 100));
});

it('[AC-B3-03g#9] 截止后取消（锁期内、活进程已崩）：not_running，锁期后恢复为 50001 无卡退还', async () => {
  const { ticket } = await acceptOne();
  const c = instance(pg.db, { clock: new FixedClock(new Date(DEADLINE + 5_000)) });
  expect(await c.ports.cancel({ appId: APP, runId: ticket.runId })).toBe('not_running');
  c.clock.set(new Date(LOCK_END));
  expect(await c.ports.finalizer.finalize(ticket.runId)).toMatchObject({
    kind: 'final',
    frame: RECOVERED,
    refunded: true,
  });
  expect((await runRow(pg.db, ticket.runId))['end_reason']).toBe('server_error');
});

it('[AC-B3-03g#10] 取消时刻单调：受理实例快 400 ms、取消实例慢 400 ms，受理后 100 ms 取消 → accepted，cancel_requested_at = accepted_at，无 23514', async () => {
  const fast = new FixedClock(new Date(START_MS + 400));
  const { ticket } = await acceptOne(fast);
  const slow = instance(pg.db, { clock: new FixedClock(new Date(START_MS - 400 + 100)) });
  expect(await slow.ports.cancel({ appId: APP, runId: ticket.runId })).toBe('accepted');
  const row = await runRow(pg.db, ticket.runId);
  expect(row['cancel_requested_at']).toEqual(row['accepted_at']);
  expect(row['accepted_at']).toEqual(new Date(START_MS + 400));
});

it('[AC-B3-03g#11] Redis 完全不可用（信号端口全抛或缺省）：取消照常 accepted，活进程 S4 照样落为 cancelled', async () => {
  for (const variant of ['broken', 'absent'] as const) {
    const a = instance(pg.db, variant === 'absent' ? { noSignals: true } : {});
    a.signals.broken = variant === 'broken';
    const session = await newSession(pg.db);
    const { ticket } = accepted(
      await a.ports.admission.admit(request(member(), session), limits()),
    );
    a.clock.set(new Date(START_MS + 2_000));
    expect(await a.ports.cancel({ appId: APP, runId: ticket.runId }), variant).toBe('accepted');
    const tail = await liveTail(a, ticket, 'stop', 1);
    expect(tail.sent, variant).toEqual(doneFrame('cancelled', 99));
  }
});

it('[AC-B3-03g#12] 取消接受 ⇒ 最终必为 cancelled；not_running ⇒ 本次未写：随机先后的取消与 S4（I19）', async () => {
  const orders = ['cancel-first', 's4-first'] as const;
  for (const order of orders) {
    for (const ending of [
      'stop',
      'timeout',
      'consent_withdrawn',
      'disabled',
      'server_error',
    ] as const) {
      const { a, ticket } = await acceptOne();
      a.clock.set(new Date(START_MS + 5_000));
      let answer: string;
      if (order === 'cancel-first') {
        answer = await a.ports.cancel({ appId: APP, runId: ticket.runId });
        await a.ports.registry.recordEnding(
          ticket.runId,
          { ending, cardsDelivered: 0 },
          draftOf(ending),
        );
      } else {
        await a.ports.registry.recordEnding(
          ticket.runId,
          { ending, cardsDelivered: 0 },
          draftOf(ending),
        );
        answer = await a.ports.cancel({ appId: APP, runId: ticket.runId });
      }
      const row = await runRow(pg.db, ticket.runId);
      const label = `${order}/${ending}`;
      expect(answer, label).toBe(order === 'cancel-first' ? 'accepted' : 'not_running');
      expect(row['end_reason'], label).toBe(order === 'cancel-first' ? 'cancelled' : ending);
      expect(row['cancel_requested_at'] === null, label).toBe(order !== 'cancel-first');
    }
  }
  void START;
});
