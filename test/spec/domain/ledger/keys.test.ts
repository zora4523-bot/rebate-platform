import { orderKey, uniqKey, type UniqKeyInput } from '@couli/domain';
import { expect, it } from 'vitest';

it('[AC-B2-01h#1] BR-FUND-05：平台命名空间保留同号订单，字符串大号与前导零不丢失', () => {
  expect(['taobao', 'jd', 'pdd'].map((platform) => orderKey(platform, '1234567'))).toEqual([
    'taobao:1234567',
    'jd:1234567',
    'pdd:1234567',
  ]);
  expect(orderKey('taobao', '0009007199254740993')).toBe('taobao:0009007199254740993');
});

it.each([
  ['', '123'],
  ['taobao', ''],
  ['tao:bao', '123'],
  ['taobao', '12:3'],
  [null, '123'],
  ['taobao', 123],
  [undefined, '123'],
])('[AC-B2-01h#2] orderKey 非法分量 %j / %j 拒绝', (platform, id) => {
  expect(() => orderKey(platform as string, id as string)).toThrow(RangeError);
});

const keyCases: readonly { input: UniqKeyInput; expected: string }[] = [
  ...(['self', 'share', 'direct', 'indirect'] as const).map((role) => ({
    input: { kind: 'CREDIT' as const, order_key: 'taobao:1234567', user_id: '42', role },
    expected: `taobao:1234567:42:${role}:CREDIT`,
  })),
  {
    input: { kind: 'PLATFORM_CREDIT', order_key: 'jd:1234567' },
    expected: 'jd:1234567:PLATFORM:CREDIT',
  },
  {
    input: { kind: 'PLATFORM_FORFEIT', order_key: 'taobao:1234567', user_id: '42', role: 'share' },
    expected: 'taobao:1234567:PLATFORM:FORFEIT:42:share',
  },
  {
    input: {
      kind: 'PLATFORM_FORFEIT',
      order_key: 'taobao:1234567',
      user_id: '42',
      role: 'direct',
      reassign_id: 'r-2',
    },
    expected: 'taobao:1234567:PLATFORM:FORFEIT:42:direct:REASSIGN:r-2',
  },
  {
    input: {
      kind: 'CLAWBACK',
      order_key: 'pdd:1234567',
      user_id: '42',
      role: 'self',
      rights_event_id: 'rights-1',
    },
    expected: 'pdd:1234567:42:self:CLAWBACK:rights-1',
  },
  {
    input: { kind: 'PLATFORM_CLAWBACK', order_key: 'pdd:1234567', rights_event_id: 'rights-1' },
    expected: 'pdd:1234567:PLATFORM:CLAWBACK:rights-1',
  },
  {
    input: { kind: 'REVERSE', original_uniq_key: 'taobao:1234567:42:self:CREDIT' },
    expected: 'taobao:1234567:42:self:CREDIT:REVERSE',
  },
  { input: { kind: 'REVERSE', original_uniq_key: 'ADJ:9001' }, expected: 'ADJ:9001:REVERSE' },
];

it.each(keyCases)(
  '[AC-B2-01h#3] 08 已给格式：$expected，重复构造保持一致',
  ({ input, expected }) => {
    Object.freeze(input);
    expect(uniqKey(input)).toBe(expected);
    expect(uniqKey(input)).toBe(expected);
  },
);

it('[AC-B2-01h#4] 受益人、角色、平台、维权事件及改派事件分别区分幂等键', () => {
  const keys = [
    ...['taobao:123', 'jd:123'].flatMap((order_key) =>
      ['42', '43'].flatMap((user_id) =>
        (['self', 'share', 'direct', 'indirect'] as const).map((role) =>
          uniqKey({ kind: 'CREDIT', order_key, user_id, role }),
        ),
      ),
    ),
    ...['event-1', 'event-2'].flatMap((rights_event_id) => [
      uniqKey({
        kind: 'CLAWBACK',
        order_key: 'taobao:123',
        user_id: '42',
        role: 'self',
        rights_event_id,
      }),
      uniqKey({ kind: 'PLATFORM_CLAWBACK', order_key: 'taobao:123', rights_event_id }),
    ]),
    ...['r-1', 'r-2'].map((reassign_id) =>
      uniqKey({
        kind: 'PLATFORM_FORFEIT',
        order_key: 'taobao:123',
        user_id: '42',
        role: 'self',
        reassign_id,
      }),
    ),
  ];
  expect(new Set(keys).size).toBe(22);
});

const badKeys: readonly unknown[] = [
  ...keyCases.flatMap(({ input }) => {
    if (input.kind === 'REVERSE') return [];
    return [
      { ...input, order_key: 'taobao:123:extra' },
      ...('user_id' in input
        ? [
            { ...input, user_id: '42:43' },
            { ...input, role: 'parent_direct' },
          ]
        : []),
    ];
  }),
  ...['', '123', ':123', 'taobao:', 'taobao:123:extra'].map((order_key) => ({
    kind: 'PLATFORM_CREDIT',
    order_key,
  })),
  ...['', '42:share', 42, null].map((user_id) => ({
    kind: 'CREDIT',
    order_key: 'taobao:123',
    user_id,
    role: 'self',
  })),
  ...['', 'parent_direct', 'SELF', 'direct:CREDIT'].map((role) => ({
    kind: 'CREDIT',
    order_key: 'taobao:123',
    user_id: '42',
    role,
  })),
  ...['', 'e:1', null, undefined].flatMap((rights_event_id) => [
    { kind: 'CLAWBACK', order_key: 'taobao:123', user_id: '42', role: 'self', rights_event_id },
    { kind: 'PLATFORM_CLAWBACK', order_key: 'taobao:123', rights_event_id },
  ]),
  ...['', 'r:1', null].map((reassign_id) => ({
    kind: 'PLATFORM_FORFEIT',
    order_key: 'taobao:123',
    user_id: '42',
    role: 'self',
    reassign_id,
  })),
  ...['', 'ADJ:9001:REVERSE', 'taobao:123:42:self:CREDIT:REVERSE'].map((original_uniq_key) => ({
    kind: 'REVERSE',
    original_uniq_key,
  })),
  { kind: 'RESTORE', order_key: 'taobao:123' },
  null,
];

it.each(badKeys)('[AC-B2-01h#5] 非法键分量、未支持格式与二次红冲拒绝：%j', (input) => {
  expect(() => uniqKey(input as UniqKeyInput)).toThrow(RangeError);
});
