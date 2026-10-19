import { it } from 'vitest';
import { check, log, at } from './kit.ts';

it('[AC-B1-10c#15] strong只引用同商品有效记录，不混入同店或失败日志', async () => {
  await check(
    {
      logs: [
        log({ id: '101', product_key: 'tb:other' }),
        log({ id: '102', result_code: 30151 }),
        log({ id: '103', created_at: at('2027-10-13T01:00:00.000Z') }),
        log({ id: '104' }),
      ],
    },
    'strong',
    ['103', '104'],
  );
});
it('[AC-B1-10c#16] weak优先引用同店记录，不混入同平台异店日志', async () => {
  await check(
    {
      productKey: 'tb:absent',
      logs: [log({ id: '101', shop_id: 'other' }), log({ id: '102' }), log({ id: '103' })],
    },
    'weak',
    ['103', '102'],
  );
});
it.each([null, '', 'absent'])(
  '[AC-B1-10c#17] weak无同店匹配%s则引用所有有效记录',
  async (shopId) => {
    await check(
      { productKey: 'tb:absent', shopId, logs: [log({ id: '9' }), log({ id: '10' })] },
      'weak',
      ['10', '9'],
    );
  },
);
it.each(['strong', 'weak'] as const)(
  '[AC-B1-10c#18] %s引用按时间倒序、同刻bigint id倒序，最多20条',
  async (level) => {
    // Decimal ids deliberately exceed JS safe integers; adjacent ids must not collapse.
    const ids = Array.from({ length: 22 }, (_, i) => String(9007199254740992n + BigInt(i)));
    const logs = ids.map((id) => log({ id }));
    logs.push(log({ id: '1', created_at: at('2027-10-13T00:00:00.000Z') }));
    await check({ productKey: level === 'strong' ? 'tb:123' : 'tb:other', logs }, level, [
      '1',
      ...ids.toReversed().slice(0, 19),
    ]);
  },
);
it('[AC-B1-10c#19] 先筛选strong再取20条，不能被更新的weak淹没', async () => {
  const weak = Array.from({ length: 25 }, (_, i) =>
    log({
      id: String(i + 200),
      product_key: 'tb:other',
      created_at: at('2027-10-19T00:00:00.000Z'),
    }),
  );
  await check({ logs: [...weak, log()] }, 'strong', ['101']);
});
