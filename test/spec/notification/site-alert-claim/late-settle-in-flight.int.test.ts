// 规则测试（B1-22t；编排裁定 D10-434 ①；08 BR-ID-24 ②，SPEC_REF 37808a5）：A 挂起超过 10 分钟、B 恢复领取
// 并仍在发送中时，A 迟到的 rejected / unknown 同样只按 A 自己的领取标识比对：命不中就不把 B 的行落定为失败、
// 也不改成 success，只记一条 warn（不记 error），A 的交付正常结束。之后 B 的结果照常落在自己的领取上：
// accepted → success；抛错 → 退回 queued、交付 reject，再交付恰好发送一次并落定 success。
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { databaseFixture } from '../../linking/open-pdd-auth/database.ts';
import { expectSendsOfTheRow, harness, STEP_MS, supersede, until } from './kit.ts';

const database = databaseFixture(createTestDatabase);

for (const query of [true, false]) {
  for (const late of ['rejected', 'unknown'] as const) {
    const mode = query ? '恢复先查询得 not_sent' : '发送器无 query、恢复即重发';
    it(`[AC-B1-22t#6] A 挂起超 10 分钟、B 恢复领取并在发送中（${mode}）：A 迟到 ${late} 不改 B 的领取，只记一条 warn、不记 error；B 随后 accepted 落定 success，之后不再发送`, async () => {
      const h = await harness(database(), { query });
      const { a, b, claimB } = await supersede(h);
      const snapshot = await h.claimed(claimB);

      h.clock.advanceMs(STEP_MS);
      const from = h.mark();
      h.sms.sends[0]!.resolve(late);
      await until(() => a.state !== 'pending', 'A ends');
      expect(await h.row(), "A's late result leaves B's claim as it was").toEqual(snapshot);
      expect(a.state).toBe('resolved');
      h.expectOneWarn(from, `A late ${late}`);

      h.clock.advanceMs(STEP_MS);
      h.sms.sends[1]!.resolve('accepted');
      await until(() => b.state !== 'pending', 'B ends');
      expect(b.state).toBe('resolved');
      await h.succeeded(h.clock.now());
      await h.expectQuiet('after B');
      expect(h.sms.sends).toHaveLength(2);
      expectSendsOfTheRow(h);
      h.expectNoPlainPhone();
    });

    it(`[AC-B1-22t#6] A 挂起超 10 分钟、B 恢复领取并在发送中（${mode}）：A 迟到 ${late} 不改 B 的领取，只记一条 warn、不记 error；B 随后发送抛错照常退回 queued、交付 reject，再交付恰好发送一次落定 success`, async () => {
      const h = await harness(database(), { query });
      const { a, b, claimB } = await supersede(h);
      const snapshot = await h.claimed(claimB);

      h.clock.advanceMs(STEP_MS);
      let from = h.mark();
      h.sms.sends[0]!.resolve(late);
      await until(() => a.state !== 'pending', 'A ends');
      expect(await h.row(), "A's late result leaves B's claim as it was").toEqual(snapshot);
      expect(a.state).toBe('resolved');
      h.expectOneWarn(from, `A late ${late}`);

      h.clock.advanceMs(STEP_MS);
      from = h.mark();
      h.sms.sends[1]!.reject(new Error('synthetic-transport-failure'));
      await until(() => b.state !== 'pending', 'B ends');
      expect(b.state, "B's row handed back: the queue retries").toBe('rejected');
      expect(await h.row(), "B's claim is handed back").toMatchObject({
        dedupe_key: h.key,
        status: 'queued',
        sent_at: null,
        row_version: 0,
      });
      h.expectOneWarn(from, 'B throws');

      h.clock.advanceMs(STEP_MS);
      const c = h.deliver();
      await until(() => h.sms.sends.length === 3, 'the retry sends');
      await h.claimed(h.clock.now());
      h.clock.advanceMs(STEP_MS);
      h.sms.sends[2]!.resolve('accepted');
      await until(() => c.state !== 'pending', 'the retry ends');
      expect(c.state).toBe('resolved');
      await h.succeeded(h.clock.now());
      await h.expectQuiet('after the retry');
      expect(h.sms.sends).toHaveLength(3);
      expect(h.sms.queries).toHaveLength(query ? 1 : 0);
      expectSendsOfTheRow(h);
      h.expectNoPlainPhone();
    });
  }
}
