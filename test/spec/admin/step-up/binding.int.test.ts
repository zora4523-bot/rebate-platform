import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import type { AdminPermissionPrincipal } from '../../../../apps/api/src/modules/admin/application/permission-guard.ts';
import { decode } from '../../identity/token/kit.ts';
import { signedIn, totp, useHarness } from '../auth/kit.ts';
import { adminSurface } from '../permissions/expected.ts';
import { lastCode, ok, redisOf, SEND, setup, STEP, type Grant } from './kit.ts';

const h = useHarness();

it.each(['sms', 'totp'] as const)(
  '[AC-F1-06l#30] HTTP 签发的 %s 令牌绑定实际账号与签发会话，错误使用不核销',
  async (tier) => {
    const s = await setup(h);
    let code: string;
    if (tier === 'sms') {
      await ok(await s.send(), SEND);
      code = lastCode(s.f);
    } else {
      s.f.clock.advanceMs(30_000);
      code = totp(s.a.secret, s.f.clock);
    }
    const grant = await ok<Grant>(await s.step(tier, code), STEP);
    const surface = await adminSurface();
    const guard = surface.createAdminPermissionGuard({
      clock: s.f.clock,
      redis: (await redisOf(s.f)).namespace('admin-step-up'),
    });
    const firstSessionId = decode(s.session.admin_token).payload['jti'];
    expect(firstSessionId).toBeTypeOf('string');
    s.f.clock.advanceMs(30_000);
    const second = await signedIn(s.f, s.a);
    const secondSessionId = decode(second.admin_token).payload['jti'];
    expect(secondSessionId).toBeTypeOf('string');
    expect(secondSessionId).not.toBe(firstSessionId);
    const permission = tier === 'sms' ? 'fund.adjust' : 'pii.reveal_phone';
    const principal: AdminPermissionPrincipal = {
      appId: 'couli',
      adminId: s.a.id,
      sessionId: firstSessionId as string,
      isSuper: false,
      permissions: [permission],
      hasVerifyPhone: true,
    };
    const business = vi.fn(async () => ({ statusCode: 200, body: { code: 0 } }));
    const run = (actor: AdminPermissionPrincipal) =>
      guard.run(
        {
          principal: actor,
          permission,
          headers: { 'x-step-up-token': grant.step_up_token },
        },
        business,
      );
    for (const actor of [
      { ...principal, adminId: randomUUID() },
      { ...principal, sessionId: secondSessionId as string },
      { ...principal, appId: 'other' },
    ]) {
      const result = await run(actor).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(result).toMatchObject({ getResponse: expect.any(Function) });
      expect((result as { getResponse(): unknown }).getResponse()).toMatchObject({
        code: 10003,
        data: { tier },
      });
      expect(business).not.toHaveBeenCalled();
    }
    expect(await run(principal)).toEqual({ statusCode: 200, body: { code: 0 } });
    expect(business).toHaveBeenCalledTimes(1);
    const replay = await run(principal).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(replay).toMatchObject({ getResponse: expect.any(Function) });
    expect((replay as { getResponse(): unknown }).getResponse()).toMatchObject({
      code: 10003,
      data: { tier },
    });
    expect(business).toHaveBeenCalledTimes(1);
  },
  30_000,
);
