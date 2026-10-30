// 规则测试（B1-22t；编排裁定 D10-434 ①；08 BR-ID-24 ②，SPEC_REF 37808a5）：发送抛错发生在本次领取上时，
// 行照常退回 queued（row_version 0），交付 reject 让队列重试，记一条 warn（不含号码明文、不记 error）；下一次
// 交付恰好发送一次，最后落定 success。比对用的是领取时写入的标识，不是落定时的时钟：领取与抛错之间时钟推进
// 也照样命中。同一用例里有一次旧领取的迟到抛错作对照：它不得退回当前领取，而当前领取（恢复所得）的抛错要退回。
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { databaseFixture } from '../../linking/open-pdd-auth/database.ts';
import { expectSendsOfTheRow, harness, RECOVER_MS, STEP_MS, until } from './kit.ts';

const database = databaseFixture(createTestDatabase);

for (const query of [true, false]) {
  for (const advance of [0, STEP_MS]) {
    const mode = query ? '恢复先查询得 not_sent' : '发送器无 query、恢复即重发';
    const gap = advance === 0 ? '领取与抛错同一时刻' : '领取与抛错之间时钟推进 1 分钟';
    it(`[AC-B1-22t#5] 本次领取发送抛错（${mode}，${gap}）：行退回 queued、交付 reject、一条 warn，下一次交付恰好发送一次；旧领取迟到抛错不退回当前领取，当前领取（恢复所得）抛错照常退回；最后落定 success`, async () => {
      const h = await harness(database(), { query });
      const queued = { dedupe_key: h.key, status: 'queued', sent_at: null, row_version: 0 };

      // 单次领取：发送抛错 → 退回 queued，交付 reject。
      const first = h.deliver();
      await until(() => h.sms.sends.length === 1, 'first send');
      await h.claimed(h.clock.now());
      h.clock.advanceMs(advance);
      let from = h.mark();
      h.sms.sends[0]!.reject(new Error('synthetic-transport-failure'));
      await until(() => first.state !== 'pending', 'first delivery ends');
      expect(first.state, 'a row handed back: the queue retries').toBe('rejected');
      expect(await h.row(), 'the current claim is handed back').toMatchObject(queued);
      h.expectOneWarn(from, 'current claim throws');

      // 下一次交付恰好发送一次（排队行，不查询），然后挂起超 10 分钟；恢复领取后在发送中。
      h.clock.advanceMs(STEP_MS);
      const second = h.deliver();
      await until(() => h.sms.sends.length === 2, 'the next delivery sends');
      expect(h.sms.queries, 'a queued row is sent, not queried').toHaveLength(0);
      await h.claimed(h.clock.now());
      h.clock.advanceMs(RECOVER_MS);
      const claimThird = h.clock.now();
      const third = h.deliver();
      if (query) {
        await until(() => h.sms.queries.length === 1, 'the recovery queries');
        h.sms.queries[0]!.resolve('not_sent');
      }
      await until(() => h.sms.sends.length === 3, 'the recovery sends');
      expectSendsOfTheRow(h);
      const snapshot = await h.claimed(claimThird);

      // 旧领取迟到抛错：不退回当前领取。
      h.clock.advanceMs(STEP_MS);
      from = h.mark();
      h.sms.sends[1]!.reject(new Error('synthetic-transport-failure'));
      await until(() => second.state !== 'pending', 'the superseded delivery ends');
      expect(await h.row(), 'a superseded throw leaves the current claim').toEqual(snapshot);
      expect(second.state, 'nothing was handed back: no retry asked').toBe('resolved');
      h.expectOneWarn(from, 'superseded claim throws');

      // 当前领取（恢复所得，领取后时钟已推进）发送抛错：照常退回 queued。
      h.clock.advanceMs(STEP_MS);
      from = h.mark();
      h.sms.sends[2]!.reject(new Error('synthetic-transport-failure'));
      await until(() => third.state !== 'pending', 'the current delivery ends');
      expect(third.state, 'a row handed back: the queue retries').toBe('rejected');
      expect(await h.row(), 'the current claim is handed back').toMatchObject(queued);
      h.expectOneWarn(from, 'recovered claim throws');

      // 再交付恰好发送一次并落定 success；此后不再发送。
      h.clock.advanceMs(STEP_MS);
      const last = h.deliver();
      await until(() => h.sms.sends.length === 4, 'the retry sends');
      await h.claimed(h.clock.now());
      h.clock.advanceMs(STEP_MS);
      h.sms.sends[3]!.resolve('accepted');
      await until(() => last.state !== 'pending', 'the retry ends');
      expect(last.state).toBe('resolved');
      await h.succeeded(h.clock.now());
      await h.expectQuiet('after the retry');
      expect(h.sms.sends).toHaveLength(4);
      expect(h.sms.queries).toHaveLength(query ? 1 : 0);
      expectSendsOfTheRow(h);
      h.expectNoPlainPhone();
    });
  }
}
