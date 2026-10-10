import { expect, it } from 'vitest';
import { GovernanceError } from '../../../../apps/api/src/modules/platform/index.ts';
import { createUnionRegistry } from '../../../../apps/api/src/modules/union/index.ts';
import { outcome } from './kit.ts';
import { ctx, demo, queryOf, TestIdentity } from './port-kit.ts';

it.each([undefined, 'pdd_unauthorized'] as const)(
  '[AC-B1-06v#23] 演示拼多多查询 scenario=%s 返回显式 authorized 值且不污染后续查询',
  async (scenario) => {
    const query = queryOf(demo());
    const identity = new TestIdentity();
    const request = { ...ctx, ...(scenario === undefined ? {} : { scenario }) };
    expect(await outcome(() => query(identity, request))).toEqual({
      authorized: scenario === undefined,
    });
    expect(await outcome(() => query(identity, { ...ctx, scenario: 'pdd_unauthorized' }))).toEqual({
      authorized: false,
    });
    expect(await outcome(() => query(identity, ctx))).toEqual({ authorized: true });
  },
);

it.each([
  ['timeout', 'timeout'],
  ['rate_limit', 'quota_exceeded'],
] as const)('[AC-B1-06v#24] 演示授权查询 %s 返回 GovernanceError %s', async (scenario, code) => {
  const query = queryOf(demo());
  const result = await outcome(() => query(new TestIdentity(), { ...ctx, scenario }));
  expect(result).toMatchObject({ thrown: expect.any(GovernanceError) });
  expect(result).toMatchObject({ thrown: { code } });
});

it.each(['jd', 'taobao'] as const)(
  '[AC-B1-06v#25] pdd_unauthorized 只对拼多多注册，%s 保持未知场景',
  async (platform) => {
    const pdd = queryOf(demo());
    expect(
      await outcome(() => pdd(new TestIdentity(), { ...ctx, scenario: 'pdd_unauthorized' })),
    ).toEqual({ authorized: false });
    const port = demo(platform);
    expect(
      await outcome(() =>
        port.searchItems({ keyword: '演示' }, { ...ctx, scenario: 'pdd_unauthorized' }),
      ),
    ).toMatchObject({ thrown: { code: 'demo_unknown_scenario' } });
  },
);

it('[AC-B1-06v#26] 无选项 registry 保持真实占位，选配查询若存在必须拒绝 adapter_unimplemented', async () => {
  // Same case first establishes the new demo capability, so the frozen registry baseline alone cannot pass red.
  expect(await outcome(() => queryOf(demo())(new TestIdentity(), ctx))).toEqual({
    authorized: true,
  });
  const port = createUnionRegistry().get('pdd');
  const optional: unknown = Reflect.get(port, 'queryPddAuthority');
  if (optional !== undefined) {
    const query = queryOf(port);
    expect(await outcome(() => query(new TestIdentity(), ctx))).toMatchObject({
      thrown: { code: 'adapter_unimplemented' },
    });
  } else {
    expect(optional).toBeUndefined();
  }
});
