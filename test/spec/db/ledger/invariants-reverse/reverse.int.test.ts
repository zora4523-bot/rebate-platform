import { randomUUID } from 'node:crypto';

import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';

import {
  APP,
  OTHER_APP,
  TIMEOUT,
  account,
  clean,
  detailContains,
  differences,
  pair,
  platform,
  voucher,
  type Row,
} from '../invariants/kit.ts';
import { replacements, scenario } from './kit.ts';

it('[AC-B2-02l#1] 替代登记可解析、指向现存新编号 SQL，旧 03/04 各保留一份', () => {
  expect(replacements().map((row) => row.file)).toContain('03_credit-unique.sql');
});

it(
  '[AC-B2-02l#2] 原单与精确 :REVERSE 跨会计日抵消，03/04 都通过且非空检查',
  async () => {
    await scenario(createTestDatabase, async ({ db, check }) => {
      const a = await account(db);
      const p = await platform(db);
      const key = {
        order_key: 'taobao:paired',
        beneficiary_user_id: a.owner_id,
        role: 'self',
        voucher_kind: 'CREDIT',
      };
      const original = await voucher(db, {
        ...key,
        uniq_key: 'opaque:%_:original',
        accounting_date: '2031-01-01',
      });
      await pair(db, a, p, original, -100n);
      await pair(
        db,
        a,
        p,
        await voucher(db, { ...key, uniq_key: `${original.uniq_key}:REVERSE` }),
        100n,
      );
      // Demonstrate the old false positive, then exercise the replacement over all history.
      differences(await check('03', true), 'global');
      for (const date of ['2031-01-01', '2032-06-15', '2033-01-01']) {
        clean(await check('03', false, date));
        clean(await check('04', false, date));
      }
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-02l#3] 红冲后以新键重记一次合法，第二次未冲入账必须报出',
  async () => {
    await scenario(createTestDatabase, async ({ db, check }) => {
      const a = await account(db);
      const p = await platform(db);
      const key = {
        order_key: 'taobao:rebook',
        beneficiary_user_id: a.owner_id,
        role: 'self',
        voucher_kind: 'CREDIT',
      };
      for (const [uniq_key, amount] of [
        ['old', -500n],
        ['old:REVERSE', 500n],
        ['corrected', -50n],
      ] as const) {
        await pair(db, a, p, await voucher(db, { ...key, uniq_key }), amount);
      }
      clean(await check('03'));
      clean(await check('04'));
      await pair(db, a, p, await voucher(db, { ...key, uniq_key: 'duplicate' }), -1n);
      const rows = await check('03');
      differences(rows, 'global');
      expect(rows).toHaveLength(1);
      expect(rows[0]!.app_id).toBe(APP);
      detailContains(rows, key.order_key, a.owner_id, 'self');
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-02l#4] 回归旧 03：不同金额、不同幂等键的两张有效 CREDIT 仍是重复入账',
  async () => {
    await scenario(createTestDatabase, async ({ db, check }) => {
      const a = await account(db);
      const p = await platform(db);
      const key = {
        order_key: 'taobao:duplicate',
        beneficiary_user_id: a.owner_id,
        role: 'self',
        voucher_kind: 'CREDIT',
      };
      await pair(db, a, p, await voucher(db, { ...key, accounting_date: '2031-01-01' }), -100n);
      await pair(db, a, p, await voucher(db, key), -1n);
      for (const legacy of [true, false]) {
        const rows = await check('03', legacy);
        differences(rows, 'global');
        expect(rows).toHaveLength(1);
        expect(rows[0]!.app_id).toBe(APP);
        detailContains(rows, key.order_key, a.owner_id, 'self');
      }
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-02l#5] 孤立 :REVERSE 即使没有其他有效入账也报全局差异',
  async () => {
    await scenario(createTestDatabase, async ({ db, check }) => {
      const a = await account(db);
      const p = await platform(db);
      const key = {
        order_key: 'taobao:orphan',
        beneficiary_user_id: a.owner_id,
        role: 'self',
        voucher_kind: 'CREDIT',
      };
      await pair(db, a, p, await voucher(db, { ...key, uniq_key: 'missing:REVERSE' }), 100n);
      const rows = await check('03');
      differences(rows, 'global');
      expect(rows).toHaveLength(1);
      expect(rows[0]!.app_id).toBe(APP);
      detailContains(rows, key.order_key, a.owner_id, 'self');
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-02l#6] 同组孤立红冲不能按张数抵消两张未冲原单，配对须精确匹配原键',
  async () => {
    await scenario(createTestDatabase, async ({ db, check }) => {
      const key = {
        order_key: 'taobao:exact-key',
        beneficiary_user_id: randomUUID(),
        role: 'self',
        voucher_kind: 'CREDIT',
      };
      // %/_ are literal key characters, never LIKE wildcards.
      for (const uniq_key of ['literal:abc', 'another', 'literal:%:REVERSE']) {
        await voucher(db, { ...key, uniq_key });
      }
      const rows = await check('03');
      differences(rows, 'global');
      detailContains(rows, key.order_key, key.beneficiary_user_id, 'self');
    });
  },
  TIMEOUT,
);

// Pairing may not cross ANY structured key boundary, even if the text key matches.
it.each<{ label: string; fields: Row }>([
  { label: 'app_id', fields: { app_id: OTHER_APP } },
  { label: 'order_key', fields: { order_key: 'jd:other' } },
  {
    label: 'beneficiary_user_id',
    fields: { beneficiary_user_id: '00000000-0000-4000-8000-000000000001' },
  },
  { label: 'role', fields: { role: 'direct' } },
  { label: 'voucher_kind', fields: { voucher_kind: 'SETTLE_ADJUST' } },
])(
  '[AC-B2-02l#7] $label 不同的红冲不能掩盖原组重复 CREDIT',
  async ({ fields }) => {
    await scenario(createTestDatabase, async ({ db, check }) => {
      const key = {
        order_key: 'taobao:boundaries',
        beneficiary_user_id: randomUUID(),
        role: 'self',
        voucher_kind: 'CREDIT',
      };
      await voucher(db, { ...key, uniq_key: 'base' });
      await voucher(db, { ...key, uniq_key: 'duplicate' });
      await voucher(db, { ...key, uniq_key: 'base:REVERSE', ...fields });
      const rows = await check('03');
      differences(rows, 'global');
      const originalApp = rows.filter((row) => row.app_id === APP);
      expect(originalApp.length).toBeGreaterThan(0);
      detailContains(originalApp, key.order_key, key.beneficiary_user_id, 'self');
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-02l#8] 独立应用、订单、受益人、角色、类型各一笔不误报，键中间 REVERSE 不是红冲',
  async () => {
    await scenario(createTestDatabase, async ({ db, check }) => {
      const key = {
        order_key: 'taobao:grouping',
        beneficiary_user_id: randomUUID(),
        role: 'self',
        voucher_kind: 'CREDIT',
      };
      await voucher(db, { ...key, uniq_key: 'same:REVERSE:middle' });
      for (const fields of [
        { app_id: OTHER_APP, uniq_key: 'same:REVERSE:middle' },
        { order_key: 'jd:grouping' },
        { beneficiary_user_id: randomUUID() },
        { role: 'direct' },
        { voucher_kind: 'SETTLE_ADJUST' },
      ])
        await voucher(db, { ...key, ...fields });
      clean(await check('03'));
      await voucher(db, { ...key, uniq_key: 'another' });
      const rows = await check('03');
      differences(rows, 'global');
      expect(rows).toHaveLength(1);
      expect(rows[0]!.app_id).toBe(APP);
      detailContains(rows, key.order_key, key.beneficiary_user_id, 'self');
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-02l#9] 一张凭证的多条分录不算多次入账，多轮更正后只有一笔有效入账',
  async () => {
    await scenario(createTestDatabase, async ({ db, check }) => {
      const a = await account(db);
      const p = await platform(db);
      const key = {
        order_key: 'taobao:cycles',
        beneficiary_user_id: a.owner_id,
        role: 'self',
        voucher_kind: 'CREDIT',
      };
      for (const [uniq_key, amount] of [
        ['first', -100n],
        ['first:REVERSE', 100n],
        ['second', -100n],
        ['second:REVERSE', 100n],
        ['third', -100n],
      ] as const) {
        const v = await voucher(db, { ...key, uniq_key });
        await pair(db, a, p, v, amount);
        await pair(db, a, p, v, amount, { sub_account: 'frozen', account_version: 2n });
      }
      clean(await check('03'));
      clean(await check('04'));
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-02l#10] 回归旧 04：忽略 CREDIT 红冲会漏掉的一分负净额仍必须报出',
  async () => {
    await scenario(createTestDatabase, async ({ db, check }) => {
      const a = await account(db);
      const p = await platform(db);
      const key = {
        order_key: 'taobao:net-reverse',
        beneficiary_user_id: a.owner_id,
        role: 'self',
      };
      for (const [uniq_key, kind, amount, type] of [
        ['base', 'CREDIT', -100n, 'REBATE_CREDIT'],
        ['base:REVERSE', 'CREDIT', 100n, 'REBATE_CREDIT'],
        ['clawback', 'CLAWBACK', 1n, 'CLAWBACK'],
      ] as const) {
        await pair(db, a, p, await voucher(db, { ...key, uniq_key, voucher_kind: kind }), amount, {
          ledger_type: type,
        });
      }
      clean(await check('03'));
      for (const legacy of [true, false]) {
        const rows = await check('04', legacy);
        differences(rows, 'global');
        expect(rows).toHaveLength(1);
        expect(rows[0]!.app_id).toBe(APP);
        detailContains(rows, key.order_key, a.owner_id, 'self', -1n);
      }
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-02l#11] 扣回红冲恢复净额，随后部分扣回不误报，超出一分仍报负净额',
  async () => {
    await scenario(createTestDatabase, async ({ db, check }) => {
      const a = await account(db);
      const p = await platform(db);
      const key = {
        order_key: 'taobao:clawback-reverse',
        beneficiary_user_id: a.owner_id,
        role: 'self',
      };
      for (const [uniq_key, kind, amount, type] of [
        ['base', 'CREDIT', -100n, 'REBATE_CREDIT'],
        ['clawback', 'CLAWBACK', 100n, 'CLAWBACK'],
        ['clawback:REVERSE', 'CLAWBACK', -100n, 'CLAWBACK'],
        ['partial', 'CLAWBACK', 40n, 'CLAWBACK'],
      ] as const) {
        await pair(db, a, p, await voucher(db, { ...key, uniq_key, voucher_kind: kind }), amount, {
          ledger_type: type,
        });
      }
      clean(await check('04'));
      await pair(db, a, p, await voucher(db, { ...key, voucher_kind: 'CLAWBACK' }), 61n, {
        ledger_type: 'CLAWBACK',
      });
      const rows = await check('04');
      differences(rows, 'global');
      expect(rows).toHaveLength(1);
      detailContains(rows, key.order_key, a.owner_id, -1n);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-02l#12] 配对存在不能替代金额复核：非等额红冲后净额负一分须被 04 抓到',
  async () => {
    await scenario(createTestDatabase, async ({ db, check }) => {
      const a = await account(db);
      const p = await platform(db);
      const key = {
        order_key: 'taobao:unequal',
        beneficiary_user_id: a.owner_id,
        role: 'self',
        voucher_kind: 'CREDIT',
      };
      // Above Number.MAX_SAFE_INTEGER: the one-fen difference must survive exact summation.
      await pair(db, a, p, await voucher(db, { ...key, uniq_key: 'large' }), -9007199254740992n);
      await pair(
        db,
        a,
        p,
        await voucher(db, { ...key, uniq_key: 'large:REVERSE' }),
        9007199254740993n,
      );
      for (const legacy of [true, false]) {
        const rows = await check('04', legacy);
        differences(rows, 'global');
        expect(rows).toHaveLength(1);
        detailContains(rows, key.order_key, a.owner_id, -1n);
      }
    });
  },
  TIMEOUT,
);
