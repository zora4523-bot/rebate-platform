import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { SmsLoginOptions } from '../../../../apps/api/src/modules/identity/application/sms-login.ts';
import {
  openKit,
  closeKit,
  fixture,
  rows,
  assertLogin,
  success,
  DEVICE_CONTEXT,
  type Kit,
} from './kit.ts';
import { seedUser } from '../registration/kit.ts';

let kit: Kit;
beforeAll(async () => {
  kit = await openKit();
}, 180_000);
afterAll(async () => {
  await closeKit(kit);
});

it.each([null, 30401, 30403, 30408, 42901, 50001] as const)(
  '[AC-B1-02j#15][BR-INV-06] 建号绑定结果 %s 原样返回，失败不阻止登录',
  async (code) => {
    const outcome =
      code === null ? { result: 'bound' as const, code } : { result: 'failed' as const, code };
    const bind = vi.fn(async () => outcome);
    const f = await fixture(kit, { bindInvite: bind });
    const data = await assertLogin(
      kit,
      f,
      await f.login({ body: { ...f.command.body, invite_code: ' K7Q2MZ ' } }),
      true,
      'full',
    );
    expect(data.invite_bind).toEqual(outcome);
    expect(bind).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      expect.objectContaining({ user_id: data.user_id, invite_code: 'K7Q2MZ' }),
    );
  },
);

it('[AC-B1-02j#16][BR-INV-06] 绑定端口写库后异常，仅回滚绑定写入，账号和登录提交', async () => {
  const f = await fixture(kit, {
    bindInvite: async (trx, input) => {
      await sql`UPDATE app.users SET self_bind_used=true WHERE app_id=${input.app_id} AND id=${input.user_id}`.execute(
        trx,
      );
      throw new Error('binding-write-failed');
    },
  });
  const data = await assertLogin(
    kit,
    f,
    await f.login({ body: { ...f.command.body, invite_code: 'K7Q2MZ' } }),
    true,
    'full',
  );
  expect(data.invite_bind).toEqual({ result: 'failed', code: 50001 });
  expect((await rows(kit, f.appId)).users[0]!.self_bind_used).toBe(false);
});

it.each([undefined, '', '   ', 'BAD'])(
  '[AC-B1-02j#17][BR-ID-04/INV-06] phone_taken 转已有账号，不再次注册或计数，仍写完整登录记录，邀请码=%j',
  async (invite) => {
    const f = await fixture(kit);
    let winner = '';
    f.register.mockImplementation(async () => {
      // Model another committed registration between lookup and our unique conflict.
      winner = await f.account();
      return { outcome: 'phone_taken' };
    });
    const data = await assertLogin(
      kit,
      f,
      await f.login({
        body: { ...f.command.body, ...(invite === undefined ? {} : { invite_code: invite }) },
      }),
      false,
      'full',
    );
    expect(data.user_id).toBe(winner);
    if (invite?.trim())
      expect(data.invite_bind).toEqual({ result: 'ignored_existing_user', code: null });
    else expect(data).not.toHaveProperty('invite_bind');
    expect(f.register).toHaveBeenCalledTimes(1);
    expect((await rows(kit, f.appId)).registrations).toHaveLength(0);
  },
);

it('[AC-B1-02j#18][BR-ID-04] 两个已经过短信校验的首次登录并发，只一个新用户，双方均有会话、日志与同意', async () => {
  const f = await fixture(kit);
  // SMS is an already-verified port here. Real-code concurrency/consumption is tested separately.
  const results = await Promise.all([f.login(), f.login()]);
  const data = results.map(success);
  expect(data.map((item) => item.is_new_user).sort()).toEqual([false, true]);
  expect(new Set(data.map((item) => item.user_id)).size).toBe(1);
  const state = await rows(kit, f.appId);
  expect(state.users).toHaveLength(1);
  expect(state.registrations).toHaveLength(1);
  expect(state.logs).toHaveLength(2);
  expect(state.consents).toHaveLength(4);
  expect(state.sessions).toHaveLength(2);
  expect(state.refresh).toHaveLength(2);
});

it.each([false, true])(
  '[AC-B1-02j#19][BR-ID-04] 会话签发失败回滚全部 PG 登录写入，新号=%s',
  async (newAccount) => {
    const f = await fixture(kit);
    if (!newAccount) await f.account();
    const before = await rows(kit, f.appId);
    const failed = new Error('token-signer-failed');
    // Allow either the service's declared 50001 result or propagation to the HTTP error filter.
    // Never catch the skeleton: NotImplemented must remain red.
    let error: unknown;
    let code: number | undefined;
    try {
      code = (
        await f.login(
          {},
          {
            tokens: {
              ...f.tokens,
              issueAccess: async () => {
                throw failed;
              },
            },
          },
        )
      ).code;
    } catch (caught) {
      if (caught !== failed) throw caught;
      error = caught;
    }
    expect(error === failed || code === 50001).toBe(true);
    expect(await rows(kit, f.appId)).toEqual(before);
  },
);

it.each(['full', 'deletion_only'] as const)(
  '[AC-B1-02j#20][BR-INV-09] landing 首次 App 登录在同事务复核，%s 也执行且第二次不重复',
  async (scope) => {
    const f = await fixture(kit);
    const uid = await f.account();
    const parent = await seedUser(kit.db, f.appId);
    await sql`UPDATE app.users SET parent_id=${parent}, parent_bind_source='landing', self_bind_used=true
    WHERE id=${uid} AND app_id=${f.appId}`.execute(kit.db);
    if (scope === 'deletion_only') f.minimum.mockResolvedValue('3.0.0');
    const review = vi.fn<NonNullable<SmsLoginOptions['firstAppLoginReview']>['review']>(
      async (trx, input) => {
        expect(trx.isTransaction).toBe(true);
        expect(input).toEqual({
          app_id: f.appId,
          user_id: uid,
          device_id_hash: kit.crypto.blindIndex(f.deviceId, DEVICE_CONTEXT),
        });
        // Growth behavior is not implemented here: use one fixture write to prove commit/rollback.
        await sql`UPDATE app.users SET parent_id=NULL WHERE id=${uid} AND app_id=${f.appId}`.execute(
          trx,
        );
      },
    );
    const ports = { firstAppLoginReview: { review } };
    success(await f.login({}, ports));
    success(await f.login({}, ports));
    expect(review).toHaveBeenCalledTimes(1);
    expect((await rows(kit, f.appId)).users.find((u) => u.id === uid)).toMatchObject({
      parent_id: null,
      self_bind_used: true,
    });
  },
);

it('[AC-B1-02j#21][BR-INV-09] 首次 App 复核写入后失败，关系与整段登录事务一起回滚', async () => {
  const f = await fixture(kit);
  const uid = await f.account();
  const parent = await seedUser(kit.db, f.appId);
  await sql`UPDATE app.users SET parent_id=${parent},parent_bind_source='landing',self_bind_used=true WHERE id=${uid}`.execute(
    kit.db,
  );
  const before = await rows(kit, f.appId);
  const fail = new Error('review-write-failed');
  const review = vi.fn<NonNullable<SmsLoginOptions['firstAppLoginReview']>['review']>(
    async (trx) => {
      await sql`UPDATE app.users SET parent_id=NULL WHERE id=${uid}`.execute(trx);
      throw fail;
    },
  );
  let failed = false;
  try {
    failed =
      (
        await f.login(
          {},
          {
            firstAppLoginReview: { review },
          },
        )
      ).code === 50001;
  } catch (error) {
    if (error !== fail) throw error;
    failed = true;
  }
  expect(failed).toBe(true);
  expect(review).toHaveBeenCalledTimes(1);
  expect(await rows(kit, f.appId)).toEqual(before);
});

it.each(['h5', 'admin', 'non_landing', 'already_logged'] as const)(
  '[AC-B1-02j#22][BR-INV-09] %s 不触发首次 App 复核',
  async (kind) => {
    const f = await fixture(kit);
    const uid = await f.account();
    if (kind !== 'non_landing')
      await sql`UPDATE app.users SET parent_bind_source='landing' WHERE id=${uid}`.execute(kit.db);
    if (kind === 'already_logged')
      await sql`INSERT INTO app.login_logs (app_id,user_id,device_id_hash,ip,method,created_at)
    VALUES (${f.appId},${uid},'old-device','192.0.2.1','wechat',${f.clock.now()})`.execute(kit.db);
    const review = vi.fn(async () => undefined);
    const data = success(
      await f.login(kind === 'h5' || kind === 'admin' ? { platform: kind } : {}, {
        firstAppLoginReview: { review },
      }),
    );
    expect(data.user_id).toBe(uid);
    expect(review).not.toHaveBeenCalled();
  },
);
