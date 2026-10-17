import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  AMOUNTS,
  EVENTS,
  SPLITS,
  TOTALS,
  TABLES,
  TIMEOUT,
  AT,
  close,
  columns,
  fixture,
  insert,
  open,
  ready,
  row,
  sqlState,
  stored,
  type Harness,
  type Table,
} from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, TIMEOUT);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

it('[AC-B2-01g#1] BR-CALC-10/27 四表保存完整快照、版本金额、状态事件和四段金额', async () => {
  await ready(h.app);
  const shapes: Record<Table, Record<string, string>> = {
    [SPLITS]: {
      rule_version_id: 'uuid',
      order_type: 'text',
      activity_type: 'text',
      rebate_mode: 'text',
      paid_at: 'timestamptz',
      paid_at_source: 'text',
      raw_n_fen: 'int8',
      subsidy_commission_fen: 'int8',
      reserve_bp: 'int2',
      reserve_fen: 'int8',
      tlj_deduct_fen: 'int8',
      base_fen: 'int8',
      platform_retain_fen: 'int8',
      beneficiaries: 'jsonb',
    },
    [AMOUNTS]: {
      commission_version: 'int4',
      user_id: 'uuid',
      role: 'text',
      base_fen: 'int8',
      amount_fen: 'int8',
    },
    [EVENTS]: { user_id: 'uuid', role: 'text', status: 'text', reason: 'text' },
    [TOTALS]: {
      commission_version: 'int4',
      n_total_fen: 'int8',
      pre_base_deduct_fen: 'int8',
      base_fen: 'int8',
      user_share_total_fen: 'int8',
      tlj_redpacket_fen: 'int8',
      platform_est_profit_fen: 'int8',
    },
  };
  for (const table of TABLES) {
    const found = await columns(h.app, table);
    for (const [name, type] of Object.entries({
      app_id: 'text',
      order_id: 'uuid',
      created_at: 'timestamptz',
      ...shapes[table],
    })) {
      expect(found, `${table}.${name}`).toContainEqual(expect.objectContaining({ name, type }));
    }
    for (const column of found.filter(({ name }) => name.endsWith('_fen'))) {
      expect(column.type, `${table}.${column.name}`).toBe('int8');
    }
  }
});

for (const table of TABLES) {
  it(`[AC-B2-01g#2] ${table} 必填字段拒绝 NULL，created_at 可由数据库填充`, async () => {
    await ready(h.app);
    const f = await fixture(h.app);
    const valid = row(table, f);
    const optional = [
      'rebate_mode',
      'activity_type',
      'reason',
      'tlj_redpacket_fen',
      'platform_est_profit_fen',
    ];
    for (const field of Object.keys(valid).filter((name) => !optional.includes(name))) {
      expect(await sqlState(insert(h.app, table, { ...valid, [field]: null })), field).toBe(
        '23502',
      );
    }
    delete valid['created_at'];
    expect(await sqlState(insert(h.app, table, valid))).toBe('ok');
    expect((await stored(h.app, table, f.orderId))[0]?.['created_at']).toBeInstanceOf(Date);
  });
}

for (const [table, fields] of [
  [SPLITS, ['reserve_fen', 'tlj_deduct_fen', 'base_fen', 'platform_retain_fen']],
  [AMOUNTS, ['base_fen', 'amount_fen']],
  [TOTALS, ['base_fen']],
] as const) {
  it(`[AC-B2-01g#3] ${table} 非负金额拒绝 -1，接受零`, async () => {
    await ready(h.app);
    const f = await fixture(h.app);
    for (const field of fields) {
      expect(await sqlState(insert(h.app, table, row(table, f, { [field]: -1n }))), field).toBe(
        '23514',
      );
    }
    const zero = Object.fromEntries(fields.map((field) => [field, 0n]));
    // A coherent zero-base version also has zero user shares and retain.
    const values =
      table === TOTALS
        ? {
            ...zero,
            user_share_total_fen: 0n,
            n_total_fen: 0n,
            pre_base_deduct_fen: 0n,
            platform_est_profit_fen: 0n,
          }
        : zero;
    expect(await sqlState(insert(h.app, table, row(table, f, values)))).toBe('ok');
  });
}

for (const reserveBp of [-1, 0, 10000, 10001]) {
  it(`[AC-B2-01g#4] reserve_bp=${String(reserveBp)} 的闭区间边界`, async () => {
    await ready(h.app);
    const f = await fixture(h.app);
    const reserve = reserveBp === 10000 ? 1000n : 0n;
    const base = reserveBp === 10000 ? 0n : 1000n;
    expect(
      await sqlState(
        insert(
          h.app,
          SPLITS,
          row(SPLITS, f, {
            reserve_bp: reserveBp,
            reserve_fen: reserve,
            base_fen: base,
            platform_retain_fen: base,
          }),
        ),
      ),
    ).toBe(reserveBp < 0 || reserveBp > 10000 ? '23514' : 'ok');
  });
}

for (const [table, field, allowed] of [
  [SPLITS, 'order_type', ['self', 'share']],
  [SPLITS, 'paid_at_source', ['platform', 'platform_modified', 'observed']],
  [SPLITS, 'rebate_mode', [null, 'none', 'normal']],
  [AMOUNTS, 'role', ['self', 'share', 'direct', 'indirect']],
  [EVENTS, 'role', ['self', 'share', 'direct', 'indirect']],
  [EVENTS, 'status', ['active', 'held', 'forfeited']],
] as const) {
  it(`[AC-B2-01g#5] ${table}.${field} 接受规定枚举并拒绝越界`, async () => {
    await ready(h.app);
    const f = await fixture(h.app);
    for (const value of ['', 'unknown', 'ACTIVE', 'self ', ' self']) {
      expect(await sqlState(insert(h.app, table, row(table, f, { [field]: value }))), value).toBe(
        '23514',
      );
    }
    for (const value of allowed) {
      const next = await fixture(h.app);
      expect(
        await sqlState(insert(h.app, table, row(table, next, { [field]: value }))),
        String(value),
      ).toBe('ok');
    }
  });
}

it('[AC-B2-01g#6] 受益人 JSON 必须为非空数组，保留应用提供的快照字段', async () => {
  await ready(h.app);
  const f = await fixture(h.app);
  for (const beneficiaries of ['{}', 'null', '"self"', '1', 'true', '[]']) {
    expect(
      await sqlState(insert(h.app, SPLITS, row(SPLITS, f, { beneficiaries }))),
      beneficiaries,
    ).toBe('23514');
  }
  const valid = row(SPLITS, f);
  expect(await sqlState(insert(h.app, SPLITS, valid))).toBe('ok');
  expect((await stored(h.app, SPLITS, f.orderId))[0]).toEqual(
    expect.objectContaining({
      paid_at: AT,
      reserve_bp: 1500,
      raw_n_fen: 1000n,
      beneficiaries: [
        {
          user_id: f.userId,
          role: 'self',
          ratio_bp: 5000,
          level: 'L1',
          initial_status: 'active',
          forfeit_reason: null,
        },
      ],
    }),
  );
});

for (const table of [AMOUNTS, TOTALS] as const) {
  it(`[AC-B2-01g#7] ${table} commission_version 拒绝零和负数，接受 1 和后续版本`, async () => {
    await ready(h.app);
    const f = await fixture(h.app);
    for (const commission_version of [-1, 0, 1, 2]) {
      expect(await sqlState(insert(h.app, table, row(table, f, { commission_version })))).toBe(
        commission_version < 1 ? '23514' : 'ok',
      );
    }
    expect(await stored(h.app, table, f.orderId)).toHaveLength(2);
  });
}

it('[AC-B2-01g#8] 负联盟原值、负四段金额与负利润可以无损存储', async () => {
  await ready(h.app);
  const f = await fixture(h.app);
  expect(
    await sqlState(
      insert(
        h.app,
        SPLITS,
        row(SPLITS, f, {
          raw_n_fen: -320n,
          reserve_fen: 0n,
          base_fen: 0n,
          platform_retain_fen: 0n,
        }),
      ),
    ),
  ).toBe('ok');
  expect(
    await sqlState(
      insert(
        h.app,
        TOTALS,
        row(TOTALS, f, {
          n_total_fen: -320n,
          pre_base_deduct_fen: -320n,
          base_fen: 0n,
          user_share_total_fen: 0n,
          platform_est_profit_fen: -320n,
        }),
      ),
    ),
  ).toBe('ok');
  expect((await stored(h.app, SPLITS, f.orderId))[0]?.['raw_n_fen']).toBe(-320n);
  expect((await stored(h.app, TOTALS, f.orderId))[0]).toEqual(
    expect.objectContaining({
      n_total_fen: -320n,
      pre_base_deduct_fen: -320n,
      platform_est_profit_fen: -320n,
    }),
  );
});

it('[AC-B2-01g#9] BR-CALC-27 红包待核的 NULL 与已知零利润可区分', async () => {
  await ready(h.app);
  const f = await fixture(h.app);
  expect(
    await sqlState(
      insert(
        h.app,
        TOTALS,
        row(TOTALS, f, {
          tlj_redpacket_fen: null,
          platform_est_profit_fen: null,
        }),
      ),
    ),
  ).toBe('ok');
  expect(
    await sqlState(
      insert(
        h.app,
        TOTALS,
        row(TOTALS, f, {
          commission_version: 2,
          n_total_fen: 0n,
          pre_base_deduct_fen: 0n,
          base_fen: 0n,
          user_share_total_fen: 0n,
          tlj_redpacket_fen: 0n,
          platform_est_profit_fen: 0n,
        }),
      ),
    ),
  ).toBe('ok');
  expect(await stored(h.app, TOTALS, f.orderId)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        commission_version: 1,
        tlj_redpacket_fen: null,
        platform_est_profit_fen: null,
      }),
      expect.objectContaining({
        commission_version: 2,
        tlj_redpacket_fen: 0n,
        platform_est_profit_fen: 0n,
      }),
    ]),
  );
});

it('[AC-B2-01g#10] 金额超过 Number 安全整数仍以 bigint 原值往返', async () => {
  await ready(h.app);
  const f = await fixture(h.app);
  const large = 9007199254740993n;
  const values = {
    [SPLITS]: {
      raw_n_fen: large,
      reserve_bp: 0,
      reserve_fen: 0n,
      base_fen: large,
      platform_retain_fen: 0n,
    },
    [AMOUNTS]: { base_fen: large, amount_fen: large },
    [TOTALS]: {
      n_total_fen: large,
      pre_base_deduct_fen: 0n,
      base_fen: large,
      user_share_total_fen: large,
      platform_est_profit_fen: 0n,
    },
  };
  for (const table of [SPLITS, AMOUNTS, TOTALS] as const) {
    expect(await sqlState(insert(h.app, table, row(table, f, values[table])))).toBe('ok');
    expect((await stored(h.app, table, f.orderId))[0]).toEqual(
      expect.objectContaining(values[table]),
    );
  }
});
