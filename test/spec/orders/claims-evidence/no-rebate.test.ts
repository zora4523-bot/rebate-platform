import { it } from 'vitest';
import type { ClaimEvidenceInput } from '../../../../apps/api/src/modules/orders/index.ts';
import { at, ATTR, check, log } from './kit.ts';

const active = [{ status: 'active', bound_at: at('2027-10-23T00:00:00.000Z'), released_at: null }];
it.each(['auth_declined', 'auth_failed'])(
  '[AC-B1-10c#20] BR-ATTR-18无返利例：%s事后淘宝active，同商品strong',
  async (no_rebate_reason) => {
    await check(
      { logs: [log({ no_rebate: true, no_rebate_reason })], bindings: active },
      'strong',
      ['101'],
    );
  },
);
it.each(['relation_conflict', 'binding_blocked', null, '', 'other'])(
  '[AC-B1-10c#21] 原因为%s的无返利记录永久不计，即使当前已授权',
  async (no_rebate_reason) => {
    await check(
      { logs: [log({ no_rebate: true, no_rebate_reason })], bindings: active },
      'none',
      [],
    );
  },
);
it.each(['absent', 'unbound', 'pending_auth', 'invalid', 'released', 'blocked'])(
  '[AC-B1-10c#22] 当前绑定%s不满足授权，auth_declined不计',
  async (status) => {
    await check(
      {
        logs: [log({ no_rebate: true, no_rebate_reason: 'auth_declined' })],
        bindings: status === 'absent' ? [] : [{ status, bound_at: null, released_at: null }],
      },
      'none',
      [],
    );
  },
);
const conflicts: [string, ClaimEvidenceInput['conflicts'], 'strong' | 'none'][] = [
  ['尚未解决', [{ occurred_at: at('2027-10-19T00:00:00.000Z'), resolved_at: null }], 'none'],
  [
    '付款之后才解决',
    [{ occurred_at: at('2027-10-19T00:00:00.000Z'), resolved_at: at('2027-10-23T00:00:00.000Z') }],
    'none',
  ],
  [
    '付款前解决',
    [{ occurred_at: at('2027-10-19T00:00:00.000Z'), resolved_at: at('2027-10-20T11:59:59.999Z') }],
    'strong',
  ],
  [
    '恰好付款时解决',
    [{ occurred_at: at('2027-10-19T00:00:00.000Z'), resolved_at: at(ATTR) }],
    'strong',
  ],
  ['恰好付款时发生', [{ occurred_at: at(ATTR), resolved_at: null }], 'none'],
  ['付款后才发生', [{ occurred_at: at('2027-10-20T12:00:00.001Z'), resolved_at: null }], 'strong'],
];
it.each(conflicts)('[AC-B1-10c#23] 30151冲突按attr_at判断：%s', async (_name, rows, level) => {
  await check(
    {
      logs: [log({ no_rebate: true, no_rebate_reason: 'auth_failed' })],
      bindings: active,
      conflicts: rows,
    },
    level,
    level === 'strong' ? ['101'] : [],
  );
});
it('[AC-B1-10c#24] 存在一条已解决冲突不能遮蔽另一条付款时未解决冲突', async () => {
  await check(
    {
      logs: [log({ no_rebate: true, no_rebate_reason: 'auth_failed' })],
      bindings: active,
      conflicts: [
        {
          occurred_at: at('2027-10-18T00:00:00.000Z'),
          resolved_at: at('2027-10-19T00:00:00.000Z'),
        },
        { occurred_at: at('2027-10-19T01:00:00.000Z'), resolved_at: null },
      ],
    },
    'none',
    [],
  );
});
it('[AC-B1-10c#25] 拼多多备案active允许授权类无返利证据', async () => {
  await check(
    {
      platform: 'pdd',
      productKey: 'pdd:123',
      bindings: active,
      logs: [
        log({
          platform: 'pdd',
          product_key: 'pdd:123',
          no_rebate: true,
          no_rebate_reason: 'auth_failed',
        }),
      ],
    },
    'strong',
    ['101'],
  );
});
it('[AC-B1-10c#26] 京东等未定义授权形态的平台无返利日志不计', async () => {
  await check(
    {
      platform: 'jd',
      productKey: 'jd:123',
      bindings: active,
      logs: [
        log({
          platform: 'jd',
          product_key: 'jd:123',
          no_rebate: true,
          no_rebate_reason: 'auth_failed',
        }),
      ],
    },
    'none',
    [],
  );
});
it('[AC-B1-10c#27] 普通日志不受无返利授权门槛影响', async () => {
  await check(
    {
      bindings: [{ status: 'blocked', bound_at: null, released_at: null }],
      conflicts: [{ occurred_at: at(ATTR), resolved_at: null }],
    },
    'strong',
    ['101'],
  );
});
it('[AC-B1-10c#28] 合格无返利同店他品也能weak', async () => {
  await check(
    {
      bindings: active,
      logs: [log({ product_key: 'tb:456', no_rebate: true, no_rebate_reason: 'auth_declined' })],
    },
    'weak',
    ['101'],
  );
});
