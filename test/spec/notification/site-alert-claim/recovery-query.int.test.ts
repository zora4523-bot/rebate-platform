// 规则测试（B1-22t；编排裁定 D10-434 ①；08 BR-ID-24 ②，SPEC_REF 37808a5）：未决恢复的查询结果落在本次领取
// 上。A 领取后发送挂起；超 10 分钟 B 恢复领取并查询，查询挂起 1 分钟（比对用领取标识，不用落定时的时钟）：
// sent → 行落定 success（sent_at 是落定时刻），不再发送；unknown → 领取保留、不发送，再超 10 分钟 C 恢复，查得
// sent 落定 success。A 迟到的 accepted 不改行（B 的结果或 B 的领取），只记一条 warn。全程只有 A 一次发送调用。
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { databaseFixture } from '../../linking/open-pdd-auth/database.ts';
import { expectSendsOfTheRow, harness, RECOVER_MS, STEP_MS, until } from './kit.ts';

const database = databaseFixture(createTestDatabase);

it('[AC-B1-22t#7] A 挂起超 10 分钟、B 恢复领取，查询 1 分钟后得 sent：行落定 success（sent_at 是 B 落定时刻）、不再发送；A 迟到 accepted 不改结果，只记一条 warn', async () => {
  const h = await harness(database(), { query: true });
  const a = h.deliver();
  await until(() => h.sms.sends.length === 1, 'A sends');
  await h.claimed(h.clock.now());

  h.clock.advanceMs(RECOVER_MS);
  const claimB = h.clock.now();
  const b = h.deliver();
  await until(() => h.sms.queries.length === 1, 'B queries the unconfirmed claim');
  await h.claimed(claimB);

  h.clock.advanceMs(STEP_MS);
  h.sms.queries[0]!.resolve('sent');
  await until(() => b.state !== 'pending' || h.sms.sends.length > 1, 'B ends');
  expect(h.sms.sends, 'sent: nothing is sent again').toHaveLength(1);
  expect(b.state).toBe('resolved');
  const done = await h.succeeded(h.clock.now());
  await h.expectQuiet('after B');

  h.clock.advanceMs(STEP_MS);
  const from = h.mark();
  h.sms.sends[0]!.resolve('accepted');
  await until(() => a.state !== 'pending', 'A ends');
  expect(await h.row(), "A's late result leaves B's outcome as it was").toEqual(done);
  expect(a.state).toBe('resolved');
  h.expectOneWarn(from, 'A late accepted');

  await h.expectQuiet('after A');
  expect(h.sms.sends).toHaveLength(1);
  expect(h.sms.queries).toHaveLength(1);
  expectSendsOfTheRow(h);
  h.expectNoPlainPhone();
});

it('[AC-B1-22t#7] A 挂起超 10 分钟、B 恢复领取，查询 1 分钟后得 unknown：领取保留、不发送；A 迟到 accepted 不改 B 的领取，只记一条 warn；再超 10 分钟 C 恢复查得 sent 落定 success，全程不再发送', async () => {
  const h = await harness(database(), { query: true });
  const a = h.deliver();
  await until(() => h.sms.sends.length === 1, 'A sends');
  await h.claimed(h.clock.now());

  h.clock.advanceMs(RECOVER_MS);
  const claimB = h.clock.now();
  const b = h.deliver();
  await until(() => h.sms.queries.length === 1, 'B queries the unconfirmed claim');
  await h.claimed(claimB);

  h.clock.advanceMs(STEP_MS);
  h.sms.queries[0]!.resolve('unknown');
  await until(() => b.state !== 'pending' || h.sms.sends.length > 1, 'B ends');
  expect(h.sms.sends, 'unknown: nothing is sent').toHaveLength(1);
  expect(b.state).toBe('resolved');
  const kept = await h.row();
  expect(kept, 'unknown: the claim is kept').toMatchObject({
    dedupe_key: h.key,
    status: 'failed',
    sent_at: null,
    row_version: 1,
  });

  h.clock.advanceMs(STEP_MS);
  const from = h.mark();
  h.sms.sends[0]!.resolve('accepted');
  await until(() => a.state !== 'pending', 'A ends');
  expect(await h.row(), "A's late result leaves B's claim as it was").toEqual(kept);
  expect(a.state).toBe('resolved');
  h.expectOneWarn(from, 'A late accepted');

  h.clock.advanceMs(RECOVER_MS);
  const c = h.deliver();
  await until(() => h.sms.queries.length === 2, 'C queries the unconfirmed claim');
  await h.claimed(h.clock.now());
  h.clock.advanceMs(STEP_MS);
  h.sms.queries[1]!.resolve('sent');
  await until(() => c.state !== 'pending' || h.sms.sends.length > 1, 'C ends');
  expect(h.sms.sends, 'sent: nothing is sent again').toHaveLength(1);
  expect(c.state).toBe('resolved');
  await h.succeeded(h.clock.now());

  await h.expectQuiet('after C');
  expect(h.sms.sends).toHaveLength(1);
  expect(h.sms.queries).toHaveLength(2);
  expectSendsOfTheRow(h);
  h.expectNoPlainPhone();
});
