import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import type { JdPddIdentity } from '../../../../apps/api/src/modules/linking/application/link-open-conversion.ts';
import { databaseFixture } from './database.ts';
import { fixture, outcome, service } from './kit.ts';
import { noConversion, response, success } from './assertions.ts';

const database = databaseFixture(createTestDatabase);

const cases = (['absent', 'invalid', 'pending_auth', 'blocked'] as const).flatMap((binding) =>
  (['auth_failed', undefined] as const).map((reason) => ({ binding, reason })),
);

it.each(cases)(
  '[AC-B1-06v#15] $binding no_rebate，客户端 $reason：跳过查询，日志原因由服务端判',
  async ({ binding, reason }) => {
    const f = await fixture(database(), { binding, query: false, scene: 'share' });
    const before = await f.bindings();
    const open = service(f);
    const request = f.request({
      noRebate: true,
      ...(reason === undefined ? {} : { noRebateReason: reason }),
    });
    const originalRequest = { ...request };
    const result = await outcome(() => open.open(request));
    await success(result);
    expect(f.query).not.toHaveBeenCalled();
    expect(await f.bindings()).toEqual(before);
    expect(await f.sessions()).toEqual([]);
    expect(f.convert).toHaveBeenCalledTimes(1);
    const converted = f.convert.mock.calls[0]![1] as JdPddIdentity;
    expect(converted.claims).toMatchObject({
      promotionSlot: 'current-pdd-self_buy',
      userId: 'no_rebate',
    });
    expect(converted.custom_parameters).toEqual({ app: 'n', sc: 'self_buy' });
    expect(converted.custom_parameters).not.toHaveProperty('uid');
    expect(await f.logs()).toEqual([
      expect.objectContaining({
        result_code: 0,
        no_rebate: true,
        no_rebate_reason: binding === 'blocked' ? 'binding_blocked' : (reason ?? 'auth_declined'),
      }),
    ]);
    // The server override is only a log field; it must not mutate the idempotency body.
    expect(request).toEqual(originalRequest);
    expect(await outcome(() => open.open({ ...originalRequest }))).toEqual(result);
    expect(await f.logs()).toHaveLength(1);
    expect(await f.attempts()).toHaveLength(1);
    expect(f.convert).toHaveBeenCalledTimes(1);
  },
  60_000,
);

it.each(['absent', 'active', 'blocked'] as const)(
  '[AC-B1-06v#16] no_rebate 跳过绑定阻断，但 %s 所用站长授权 expired 仍 maintenance',
  async (binding) => {
    const f = await fixture(database(), { binding, query: false });
    await f.expire();
    const before = await f.bindings();
    const open = service(f);
    const result = await response(
      await outcome(() => open.open(f.request({ noRebate: true }))),
      50301,
      503,
    );
    expect(result.envelope.data).toEqual({ reason: 'maintenance' });
    expect(f.query).not.toHaveBeenCalled();
    expect(await f.bindings()).toEqual(before);
    expect(await f.sessions()).toEqual([]);
    await noConversion(f);
  },
  60_000,
);
