import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it, vi, type Mock } from 'vitest';
import * as walletQuery from '../../../../apps/api/src/modules/ledger/application/wallet-summary.ts';
import { WalletSummaryController } from '../../../../apps/api/src/modules/ledger/http/public/wallet-summary.controller.ts';
import * as readEntry from '../../../../apps/api/src/modules/ledger/read.ts';
import {
  FixedClock,
  createRootLogger,
  loadConfig,
  type PlatformOptions,
} from '../../../../apps/api/src/modules/platform/index.ts';
import * as pendingEarnings from '../../../../apps/api/src/modules/settlement/reads/pending-earnings.ts';
import { account, balance } from '../../db/ledger/invariants/kit.ts';
import { scope, seed, type Scope } from '../../settlement/pending-earnings/fixtures.ts';
import { open, close, TIMEOUT, type Harness } from '../order-nets/kit.ts';
import { apiRequire, ROOT, validateSummary, ZERO } from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, TIMEOUT);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

interface CompiledModule {
  get<T>(token: new (...args: never[]) => T, options: { strict: false }): T;
  close(): Promise<void>;
}

// 使用正式 AppModule 的全部 provider，不在测试中手工连接钱包查询、预估来源或控制器。
// 只编译依赖图并调用取出的控制器；不启动队列、不监听端口。
async function withController(run: (controller: WalletSummaryController) => Promise<void>) {
  apiRequire('reflect-metadata');
  const { Test } = apiRequire('@nestjs/testing') as {
    Test: {
      createTestingModule(input: { imports: unknown[] }): {
        compile(): Promise<CompiledModule>;
      };
    };
  };
  const { AppModule } = (await import(new URL('apps/api/src/app.module.ts', ROOT).href)) as {
    AppModule: { forEntry(options: PlatformOptions): unknown };
  };
  const module = await Test.createTestingModule({
    imports: [
      AppModule.forEntry({
        entry: 'api',
        config: loadConfig({ APP_ENV: 'test' }),
        clock: new FixedClock('2026-10-23T04:00:00.000Z'),
        logger: createRootLogger({ level: 'silent', entry: 'api', appEnv: 'test' }, { write() {} }),
        dbHandles: { db: h.db, dbRead: null, close: async () => undefined },
      }),
    ],
  }).compile();
  try {
    // 骨架尚未挂载控制器时必须是断言失败，不能以 Nest 找不到 provider 的异常充当先红。
    expect(() => module.get(WalletSummaryController, { strict: false })).not.toThrow();
    await run(module.get(WalletSummaryController, { strict: false }));
  } finally {
    await module.close();
  }
}

async function configuration(f: Scope) {
  await h.db
    .withSchema('app')
    .insertInto('config_items')
    .values(
      [
        ['credit.enabled.taobao', true],
        ['withdraw.enabled', true],
        ['settle.bill_day', 24],
        ['settle.statement.grace_days', 10],
        ['settle.period_offset_months.taobao', 1],
      ].map(([key, value]) => ({
        app_id: f.appId,
        key: String(key),
        value,
        updated_by: 'synthetic-wallet-assembly',
      })),
    )
    .execute();
}

function request(f: Scope) {
  return {
    id: randomUUID(),
    principal: {
      app_id: f.appId,
      uid: f.userId,
      sid: randomUUID(),
      device_id: randomUUID(),
      scp: 'full' as const,
    },
  };
}

it(
  '[AC-B2-04y#16] BR-FUND-18 正式组装使用 settlement 真实预估来源与 read.ts 同一查询，响应逐字段一致',
  async () => {
    const f = await scope(h.db);
    await configuration(f);
    const user = await account(h.db, { app_id: f.appId, owner_id: f.userId });
    await balance(h.db, user, -400n, 19n);
    // 快照初始佣金为 1000，当前结算佣金为 2001：扣 15% 预留后 1700，再取 50% = 850。
    // 两个 WAITING 各为 425，其中一个 hold；人工期望合计 1700，不复用生产算法算期望。
    await seed(h.db, f, { order: { est_commission_fen: 9999n, settle_commission_fen: 2001n } });
    await seed(h.db, f, {
      order: { rebate_status: 'WAITING', platform_status: 'RECEIVED', settle_period: '2026-10' },
    });
    await seed(h.db, f, {
      order: {
        rebate_status: 'WAITING',
        platform_status: 'RECEIVED',
        settle_period: '2026-10',
        hold: true,
      },
    });

    expect(readEntry.getWalletSummary).toBe(walletQuery.getWalletSummary);
    // 观察原函数及真实来源，所有 spy 均透传；不替换业务结果或注入测试收益端口。
    const query = vi.spyOn(walletQuery, 'getWalletSummary');
    const original = pendingEarnings.createPendingEarningsSource;
    const reads: Mock<pendingEarnings.PendingEarningsSource['forUser']>[] = [];
    const factory = vi
      .spyOn(pendingEarnings, 'createPendingEarningsSource')
      .mockImplementation((deps) => {
        const source = original(deps);
        reads.push(vi.spyOn(source, 'forUser'));
        return source;
      });
    try {
      await withController(async (controller) => {
        const req = request(f);
        const body = await controller.summary(req);
        expect(body).toEqual({
          code: 0,
          msg: '',
          trace_id: req.id,
          data: {
            ...ZERO,
            available_fen: -400,
            negative_fen: 400,
            frozen_fen: 19,
            estimated_total_fen: 1700,
            estimated_fen: 850,
            pending_credit_fen: 850,
            pending_credit_paused_fen: 425,
            next_credit_period: '2026-11',
          },
        });
        expect(query).toHaveBeenCalledExactlyOnceWith(
          expect.anything(),
          { appId: f.appId, userId: f.userId },
          expect.anything(),
        );
        expect(body.data).toEqual(await query.mock.results[0]!.value);
        expect(factory).toHaveBeenCalled();
        expect(reads.flatMap((read) => read.mock.calls)).toContainEqual([
          expect.anything(),
          expect.objectContaining({ appId: f.appId, userId: f.userId }),
        ]);
        await validateSummary(body, true);
      });
    } finally {
      for (const read of reads) read.mockRestore();
      factory.mockRestore();
      query.mockRestore();
    }
  },
  TIMEOUT,
);

it(
  '[AC-B2-04y#17] BR-FUND-18 登录用户尚无账户行时余额为零，订单预估收益仍保留',
  async () => {
    const f = await scope(h.db);
    await configuration(f);
    await seed(h.db, f);
    // 第 10 节 S2 允许零余额或明确报错；按 BR-FUND-18 分开读取余额与预估的口径，
    // 采用零余额的保守响应，不创建账户、不把已存在的订单收益也清零。
    const accounts = () =>
      h.db
        .withSchema('app')
        .selectFrom('ledger_accounts')
        .select('id')
        .where('app_id', '=', f.appId)
        .where('owner_id', '=', f.userId)
        .execute();
    expect(await accounts()).toEqual([]);
    await withController(async (controller) => {
      const req = request(f);
      const body = await controller.summary(req);
      expect(body).toEqual({
        code: 0,
        msg: '',
        trace_id: req.id,
        data: { ...ZERO, estimated_total_fen: 425, estimated_fen: 425 },
      });
      await validateSummary(body, true);
      expect(await accounts()).toEqual([]);
    });
  },
  TIMEOUT,
);
