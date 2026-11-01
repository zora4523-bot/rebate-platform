// B2-15k 接线（claude-independent，SPEC_REF deb521c2）：任务书 9.1（payment.module 用 createPayChannelSet 替换
// payChannelSetFor）、9.4（pay-refund-query.ts 从退款单传入原交易号；缺了支付宝退款查询永远 unknown，钱卡在 PROCESSING，
// BR-PAY-06 ④）。不连库：Kysely 接一个按表名应答的内存驱动，只看发给通道的参数。
import { readFile } from 'node:fs/promises';
import type { DB } from '@couli/db';
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type Dialect,
  type QueryResult,
} from 'kysely';
import { expect, it } from 'vitest';
import type { PayRefundQueryResult } from '../../../../apps/api/src/modules/payment/application/pay-channel.ts';
import {
  runRefundQuery,
  type PayRefundQueryDeps,
} from '../../../../apps/api/src/modules/payment/application/pay-refund-query.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/clock.ts';
import { NOW, ROOT, captureLogger } from './kit.ts';

type Rows = Readonly<Record<string, readonly unknown[]>>;

/** 按 from "<表>" 应答；其余语句（事务里的插入）没有行。 */
function memoryDb(rows: Rows): Kysely<DB> {
  const connection: DatabaseConnection = {
    executeQuery: <R>(compiled: CompiledQuery): Promise<QueryResult<R>> => {
      const table = Object.keys(rows).find((name) => compiled.sql.includes(`from "${name}"`));
      return Promise.resolve({ rows: (table === undefined ? [] : (rows[table] ?? [])) as R[] });
    },
    // 这条路径不会走到，只为满足接口。
    streamQuery: <R>(): AsyncIterableIterator<QueryResult<R>> => {
      throw new Error('memoryDb does not stream');
    },
  };
  const dialect: Dialect = {
    createAdapter: () => new PostgresAdapter(),
    createQueryCompiler: () => new PostgresQueryCompiler(),
    createIntrospector: (db) => new PostgresIntrospector(db),
    createDriver: () => ({
      init: () => Promise.resolve(),
      acquireConnection: () => Promise.resolve(connection),
      beginTransaction: () => Promise.resolve(),
      commitTransaction: () => Promise.resolve(),
      rollbackTransaction: () => Promise.resolve(),
      releaseConnection: () => Promise.resolve(),
      destroy: () => Promise.resolve(),
    }),
  };
  return new Kysely<DB>({ dialect });
}

const APP = 'couli-app-test';
const REFUND_ROW = {
  id: 'refund-1',
  app_id: APP,
  out_refund_no: 'R1',
  status: 'PROCESSING',
  created_at: NOW,
};

async function queriedWith(rows: Rows): Promise<readonly unknown[][]> {
  const calls: unknown[][] = [];
  const answer: PayRefundQueryResult = { kind: 'unknown', reason: 'test_unknown' };
  const deps = {
    db: memoryDb(rows),
    clock: new FixedClock(NOW),
    logger: captureLogger([]),
    queue: { send: () => Promise.resolve(null) },
    channels: {
      of: () => ({
        refundQuery: (...args: unknown[]) => {
          calls.push(args);
          return Promise.resolve(answer);
        },
      }),
    },
  } as unknown as PayRefundQueryDeps;
  await runRefundQuery(deps, { app_id: APP, pay_refund_id: 'refund-1' });
  return calls;
}

it('[AC-B2-15k#1901] 退款对象是支付单：refund.query 把支付单的 out_trade_no、channel_trade_no 传给 refundQuery', async () => {
  const calls = await queriedWith({
    pay_refunds: [{ ...REFUND_ROW, target_type: 'pay_order', target_id: 'order-1' }],
    pay_orders: [
      {
        id: 'order-1',
        app_id: APP,
        pay_channel: 'alipay',
        out_trade_no: 'P1',
        channel_trade_no: 'T1',
      },
    ],
  });
  expect(calls).toEqual([['R1', { outTradeNo: 'P1', channelTradeNo: 'T1' }]]);
});

it('[AC-B2-15k#1902] 退款对象是异常收款：传它的 out_trade_no（可能为空）与 channel_trade_no', async () => {
  const calls = await queriedWith({
    pay_refunds: [{ ...REFUND_ROW, target_type: 'pay_anomaly', target_id: 'anomaly-1' }],
    pay_anomalies: [
      {
        id: 'anomaly-1',
        app_id: APP,
        pay_channel: 'alipay',
        out_trade_no: null,
        channel_trade_no: 'T2',
      },
    ],
  });
  expect(calls).toEqual([['R1', { outTradeNo: null, channelTradeNo: 'T2' }]]);
});

it('[AC-B2-15k#1903] payment.module 经 createPayChannelSet 装配通道集合，不再按 APP_ENV 直接选假通道', async () => {
  const source = await readFile(
    new URL('apps/api/src/modules/payment/payment.module.ts', ROOT),
    'utf8',
  );
  expect(source).toMatch(/createPayChannelSet\(/);
  expect(source).not.toMatch(/payChannelSetFor\(config\.appEnv\)/);
});
