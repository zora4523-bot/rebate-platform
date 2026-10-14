import { afterAll, beforeAll, expect, it } from 'vitest';
import { phone } from '../../identity/sms-codes/kit.ts';
import { accepted } from '../../identity/session/http-kit.ts';
import { TOKEN_SERVICE } from '../../../../apps/api/src/modules/identity/application/tokens.ts';
import type { TokenService } from '../../../../apps/api/src/modules/identity/application/access-tokens.ts';
import {
  openSuite,
  closeSuite,
  openApp,
  device,
  account,
  login,
  loginBody,
  seedToken,
  token,
  assertBound,
  snapshot,
  withTokenWriteFailure,
  type Suite,
} from './assembled-kit.ts';

let suite: Suite;
beforeAll(async () => {
  suite = await openSuite();
}, 180_000);
afterAll(async () => {
  await closeSuite(suite);
}, 30_000);

for (const kind of ['new', 'existing'] as const) {
  it(`[BR-ID-07][AC-S1-76#6] 真实短信${kind}账号登录绑定已有令牌，同设备换账号更新代际`, async () => {
    const f = await openApp(suite);
    try {
      const d = await device(f);
      const id = await seedToken(f, d);
      const before = await token(f, id);
      const firstPhone = kind === 'new' ? phone() : (await account(f)).number;
      const first = await login(f, d, firstPhone);
      await assertBound(f, d, id, first);
      const other = await account(f);
      const second = await login(f, d, other.number);
      expect(second.uid).toBe(other.uid);
      expect(second.uid).not.toBe(first.uid);
      expect(second.sid).not.toBe(first.sid);
      await assertBound(f, d, id, second);
      expect(await token(f, id)).toMatchObject({
        token: before.token,
        token_set_at: before.token_set_at,
      });
    } finally {
      await f.close();
    }
  });
}

it('[BR-ID-07][AC-S1-76#15] 真实登录在冻结期内不绑定，到冻结边界的新登录才绑定', async () => {
  const f = await openApp(suite);
  try {
    const d = await device(f);
    const user = await account(f);
    const id = await seedToken(f, d, undefined, new Date('2026-10-08T05:00:00.000Z'));
    const before = await token(f, id);
    const frozen = await login(f, d, user.number);
    expect(await token(f, id)).toEqual(before);
    expect(
      await f.db
        .selectFrom('devices')
        .select('last_login_sid')
        .where('id', '=', d.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ last_login_sid: frozen.sid });
    // loginBody advances 61 seconds; this login therefore lands exactly on frozen_until.
    f.clock.set(new Date('2026-10-08T04:58:59.000Z'));
    const current = await login(f, d, user.number);
    expect(f.clock.now()).toEqual(new Date('2026-10-08T05:00:00.000Z'));
    await assertBound(f, d, id, current);
  } finally {
    await f.close();
  }
});

it('[BR-ID-07][AC-S1-76#6] S1登录后S2再次登录，S1正常HTTP刷新不得抢回S2绑定', async () => {
  const f = await openApp(suite);
  try {
    const d = await device(f);
    const user = await account(f);
    const id = await seedToken(f, d);
    const s1 = await login(f, d, user.number);
    const s2 = await login(f, d, user.number);
    await assertBound(f, d, id, s2);
    const before = await token(f, id);
    const deviceBefore = await f.db
      .selectFrom('devices')
      .selectAll()
      .where('id', '=', d.id)
      .executeTakeFirstOrThrow();
    const pair = await accepted(
      await d.post('/v1/auth/refresh', { refresh_token: s1.refresh_token }),
    );
    expect(
      await f.app.get<TokenService>(TOKEN_SERVICE).verifyAccess(pair.access_token),
    ).toMatchObject({ sid: s1.sid });
    expect(await token(f, id)).toEqual(before);
    expect(
      await f.db.selectFrom('devices').selectAll().where('id', '=', d.id).executeTakeFirstOrThrow(),
    ).toEqual(deviceBefore);
    await assertBound(f, d, id, s2);
  } finally {
    await f.close();
  }
});

it('[BR-ID-07][AC-S1-76#6] 真实登录绑定遇到PG写失败，设备代际、会话、refresh一起回滚', async () => {
  const f = await openApp(suite);
  try {
    const d = await device(f);
    const user = await account(f);
    const id = await seedToken(f, d);
    const body = await loginBody(f, d, user.number);
    const before = await snapshot(f);
    await withTokenWriteFailure(f, id, async () => {
      const response = await d.post('/v1/auth/login/sms', body);
      expect(response.statusCode).toBe(500);
      expect(response.json()).toMatchObject({ code: 50001 });
      expect(await snapshot(f)).toEqual(before);
    });
    // A swallowed NotImplemented/other startup error cannot satisfy the whole case.
    const recovered = await login(f, d, user.number);
    await assertBound(f, d, id, recovered);
  } finally {
    await f.close();
  }
});
