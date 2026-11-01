// B2-15k 接线（claude-independent，SPEC_REF deb521c2）：任务书 9.1（payment.module 用 createPayChannelSet 替换
// payChannelSetFor）、9.4（pay-refund-query.ts 从退款单传入原交易号；缺了支付宝退款查询永远 unknown，钱卡在 PROCESSING，
// BR-PAY-06 ④）。不连库：Kysely 接一个按表名应答的内存驱动，只看发给通道的参数。
// 第 2 轮（任务书第 13 节）：入口名传给 loadConfig（BR-PAY-08 ①）、staging compose 与环境示例。
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

function repositoryFile(path: string): Promise<string> {
  return readFile(new URL(path, ROOT), 'utf8');
}

/** 去掉注释行：bootstrap.ts 的文档注释里也写着一参调用，不算代码。 */
function codeOf(source: string): string {
  return source
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
    .join('\n');
}

it('[AC-B2-15k#1904] BR-PAY-08 ①：bootstrap.ts、entry.ts 把入口名传给 loadConfig；tracing/boot.ts 仍是一参（不读收款配置，不改它）', async () => {
  // 不传入口名：api、worker、admin 拿不到 payChannels，每次下单都是 50306。
  for (const file of ['apps/api/src/bootstrap.ts', 'apps/api/src/entry.ts']) {
    const source = codeOf(await repositoryFile(file));
    expect(source, file).toMatch(/loadConfig\(\s*process\.env\s*,\s*entry\s*\)/);
    expect(source, file).not.toMatch(/loadConfig\(\s*process\.env\s*\)/);
  }
  const boot = await repositoryFile('apps/api/src/modules/platform/tracing/boot.ts');
  expect(boot).toMatch(/loadConfig\(process\.env\)/);
});

/** compose 的 services 下每个服务的正文（两格缩进的键开头，顶格的键结束）。 */
function composeServices(text: string): Map<string, string> {
  const services = new Map<string, string>();
  let current: string | null = null;
  for (const line of text.split('\n')) {
    const head = /^ {2}([a-z][\w-]*):\s*$/.exec(line)?.[1];
    if (head !== undefined) {
      current = head;
      services.set(current, '');
    } else if (/^[^\s#]/.test(line)) {
      current = null;
    } else if (current !== null) {
      services.set(current, `${services.get(current) ?? ''}${line}\n`);
    }
  }
  return services;
}

it('[AC-B2-15k#1905] D10-549 ⑥：staging compose 的 api、worker、admin 配 PAY_CHANNEL_IMPL: fake；stream、payout 不配任何 PAY_*（BR-PAY-08 ①）', async () => {
  const services = composeServices(await repositoryFile('infra/staging/compose.yaml'));
  for (const service of ['api', 'worker', 'admin']) {
    expect(services.get(service) ?? '', service).toMatch(
      /^\s+PAY_CHANNEL_IMPL:\s*['"]?fake['"]?\s*(#.*)?$/m,
    );
  }
  for (const service of ['stream', 'payout']) {
    expect(services.has(service), service).toBe(true);
    expect(services.get(service) ?? '', service).not.toMatch(/^\s+PAY_/m);
  }
});

const ENV_EXAMPLE_NAMES = [
  'PAY_APP_ID',
  'PAY_CHANNEL_IMPL',
  'PAY_NOTIFY_BASE_URL',
  'PAY_WECHAT_APPID',
  'PAY_WECHAT_MCHID',
  'PAY_WECHAT_MERCHANT_SERIAL',
  'PAY_WECHAT_PRIVATE_KEY_FILE',
  'PAY_WECHAT_APIV3_KEY_FILE',
  'PAY_WECHAT_PUBLIC_KEY_FILE',
  'PAY_WECHAT_PUBLIC_KEY_ID',
  'PAY_WECHAT_TEST_MERCHANT',
  'PAY_ALIPAY_APPID',
  'PAY_ALIPAY_SELLER_ID',
  'PAY_ALIPAY_PRIVATE_KEY_FILE',
  'PAY_ALIPAY_PUBLIC_KEY_FILE',
  'PAY_ALIPAY_APP_CERT_FILE',
  'PAY_ALIPAY_PUBLIC_CERT_FILE',
  'PAY_ALIPAY_ROOT_CERT_FILE',
  'PAY_ALIPAY_GATEWAY',
];

it.each(ENV_EXAMPLE_NAMES)(
  '[AC-B2-15k#1906] 环境示例只列注释掉的变量名 %s，不提供任何值（做法同 test/spec/union/*-live-wiring/config.test.ts）',
  async (name) => {
    const example = await repositoryFile('.env.example');
    const declarations = example
      .split('\n')
      .filter((line) => new RegExp(`^\\s*#?\\s*${name}(?:\\s|=|$)`).test(line));
    expect(declarations.length).toBeGreaterThan(0);
    for (const line of declarations) {
      expect(line).toMatch(/^\s*#/);
      expect(line).not.toMatch(new RegExp(`${name}\\s*=\\s*[^\\s#]`));
    }
  },
);
