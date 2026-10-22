import { randomUUID } from 'node:crypto';
import {
  acquireTestRedis,
  createTestDatabase,
  type TestDatabase,
  type TestRedis,
} from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { listWithdrawalsForUser } from '../../../../apps/api/src/modules/payout/read.ts';
import type { WithdrawalPage } from '../../../../apps/api/src/modules/payout/application/withdrawal-reads.ts';
import {
  account,
  close,
  open,
  privateDataAbsent,
  type Kit,
} from '../../identity/payout-account/kit.ts';
import { client, contractResponse, seedRecord, PATH, TIMEOUT } from './kit.ts';

// Real AppModule, auth, crypto, PG and Redis; no handler/query mock. Database provisioning uses
// @couli/db/testing, and runs only in the orchestrator's isolated container.
let database: TestDatabase;
let redis: TestRedis;
let kit: Kit;
beforeAll(async () => {
  database = await createTestDatabase();
  redis = await acquireTestRedis();
  kit = await open(database, redis);
}, 120_000);
afterAll(async () => {
  try {
    await close(kit);
  } finally {
    try {
      await redis?.stop();
    } finally {
      await database?.drop();
    }
  }
}, TIMEOUT);

it(
  '[AC-B2-05f#20] 同一数据的 HTTP 列表和只读函数逐字段相同，状态与快照不被当前账号替代',
  async () => {
    const c = await client(kit);
    const other = await client(kit, c.subject.appId);
    const otherApp = await client(kit);
    await account(kit, c.owner, '6222029999999999999', { method: 'bank_card' });
    await seedRecord(kit, other.subject);
    await seedRecord(kit, otherApp.subject);
    const states = [
      'PENDING_REVIEW',
      'APPROVED',
      'PAYING',
      'PAID_API',
      'PAID_MANUAL',
      'REJECTED',
      'FAILED',
    ];
    const inserted = [];
    for (const [index, status] of states.entries()) {
      inserted.push(
        await seedRecord(
          kit,
          c.subject,
          {
            status,
            review_mode: index === 0 ? null : index === 1 ? 'auto' : 'manual',
            payout_method: index === 4 ? 'bank_card' : 'alipay',
            created_at: new Date(`2026-10-18T0${index}:00:00.000Z`),
            channel_order_id: `synthetic-${randomUUID()}`,
          },
          index === 4 ? '6222021234567890123' : 'zhangsan@example.com',
        ),
      );
    }
    const before = await kit.db
      .withSchema('app')
      .selectFrom('withdrawals')
      .selectAll()
      .where('app_id', '=', c.subject.appId)
      .orderBy('id')
      .execute();
    const response = await c.get();
    contractResponse(kit, response, false);
    const data = response.json<{ data: WithdrawalPage }>().data;
    const direct = await listWithdrawalsForUser(kit.db, c.subject);
    expect(data).toEqual(direct);
    expect(data.next_cursor).toBeNull();
    expect(data.items).toEqual(
      inserted.toReversed().map((row, index) => ({
        withdrawal_id: row.id,
        status: row.status,
        review_mode: row.review_mode,
        amount_fen: 12300,
        fee_fen: 123,
        tax_fen: 80,
        net_fen: 12097,
        payout_channel: row.payout_channel,
        payout_channel_name: row.payout_channel === 'bank_card' ? '银行卡' : '支付宝',
        masked_account: row.payout_method === 'bank_card' ? '尾号 0123' : 'zh***@example.com',
        reason_code:
          row.status === 'FAILED'
            ? 'PAYEE_NOT_EXIST'
            : row.status === 'REJECTED'
              ? 'USER_REQUEST'
              : null,
        fail_action: row.status === 'FAILED' ? 'change_payout_account' : null,
        created_at: `2026-10-18T${String(14 - index).padStart(2, '0')}:00:00.000+08:00`,
      })),
    );
    for (const item of data.items) {
      const detail = await c.get(`${PATH}/${item.withdrawal_id}`);
      contractResponse(kit, detail, true);
      const source = inserted.find((row) => row.id === item.withdrawal_id)!;
      expect(detail.json<{ data: unknown }>().data).toEqual({
        ...item,
        channel_order_id: ['PAID_API', 'PAID_MANUAL'].includes(item.status)
          ? source.channel_order_id
          : null,
      });
    }
    expect(
      await kit.db
        .withSchema('app')
        .selectFrom('withdrawals')
        .selectAll()
        .where('app_id', '=', c.subject.appId)
        .orderBy('id')
        .execute(),
    ).toEqual(before);
    privateDataAbsent(
      kit,
      [response.json(), direct],
      [
        'zhangsan@example.com',
        '6222021234567890123',
        '6222029999999999999',
        inserted[0]!.payee_account_cipher.toString(),
        inserted[0]!.payee_hmac,
      ],
    );
  },
  TIMEOUT,
);

it(
  '[AC-B2-05f#21] 游标按时间和 id 倒序，等时多单跨页不重不漏，新增头部单不扰乱后续页',
  async () => {
    const c = await client(kit);
    const records = [];
    for (const at of [
      '2026-10-18T01:00:00.000Z',
      '2026-10-18T01:00:00.000Z',
      '2026-10-18T01:00:00.000Z',
      '2026-10-17T23:00:00.000Z',
      '2026-10-17T20:00:00.000Z',
    ])
      records.push(await seedRecord(kit, c.subject, { created_at: new Date(at) }));
    records.sort(
      (a, b) => b.created_at.getTime() - a.created_at.getTime() || (a.id < b.id ? 1 : -1),
    );
    const seen: string[] = [];
    let cursor: string | undefined;
    for (const size of [2, 2, 1]) {
      const url = `${PATH}?limit=2${cursor === undefined ? '' : `&cursor=${encodeURIComponent(cursor)}`}`;
      const response = await c.get(url);
      contractResponse(kit, response, false);
      const page = response.json<{ data: WithdrawalPage }>().data;
      expect(page).toEqual(
        await listWithdrawalsForUser(kit.db, {
          ...c.subject,
          limit: 2,
          ...(cursor === undefined ? {} : { cursor }),
        }),
      );
      expect(page.items).toHaveLength(size);
      seen.push(...page.items.map((item) => item.withdrawal_id));
      if (size === 1) {
        expect(page.next_cursor).toBeNull();
      } else {
        expect(page.next_cursor).toMatch(/^[A-Za-z0-9_-]+$/);
        const decoded = Buffer.from(page.next_cursor!, 'base64url').toString('utf8');
        const split = decoded.lastIndexOf(':');
        const last = page.items.at(-1)!;
        expect(decoded.slice(split + 1)).toBe(last.withdrawal_id);
        expect(Date.parse(decoded.slice(0, split))).toBe(Date.parse(last.created_at));
        cursor = page.next_cursor!;
      }
      if (seen.length === 2)
        await seedRecord(kit, c.subject, { created_at: new Date('2026-10-19T00:00:00Z') });
    }
    expect(seen).toEqual(records.map((row) => row.id));
    expect(new Set(seen).size).toBe(5);
  },
  TIMEOUT,
);

it(
  '[AC-B2-05f#22] 空列表没有游标；默认 20、契约上限 50；完整尾页不制造下一页',
  async () => {
    const c = await client(kit);
    expect(await listWithdrawalsForUser(kit.db, c.subject)).toEqual({
      items: [],
      next_cursor: null,
    });
    const empty = await c.get();
    contractResponse(kit, empty, false);
    expect(empty.json<{ data: unknown }>().data).toEqual({ items: [], next_cursor: null });
    for (let index = 0; index < 50; index++) await seedRecord(kit, c.subject);
    const normal = await c.get();
    contractResponse(kit, normal, false);
    const page = normal.json<{ data: WithdrawalPage }>().data;
    expect(page).toEqual(await listWithdrawalsForUser(kit.db, c.subject));
    expect(page.items).toHaveLength(20);
    expect(page.next_cursor).toEqual(expect.any(String));
    const max = await c.get(`${PATH}?limit=50`);
    contractResponse(kit, max, false);
    const all = max.json<{ data: WithdrawalPage }>().data;
    expect(all).toEqual(await listWithdrawalsForUser(kit.db, { ...c.subject, limit: 50 }));
    expect(all.items).toHaveLength(50);
    expect(all.next_cursor).toBeNull();
  },
  TIMEOUT,
);

it(
  '[AC-B2-05f#23] 他人、跨 app 和不存在的详情同为 30701；只读函数同时限定 app 和用户',
  async () => {
    const c = await client(kit);
    const other = await client(kit, c.subject.appId);
    const otherApp = await client(kit);
    const owned = await seedRecord(kit, c.subject);
    const hidden = await seedRecord(kit, other.subject);
    const foreign = await seedRecord(kit, otherApp.subject);
    const answers = [];
    for (const id of [hidden.id, foreign.id, randomUUID()]) {
      const response = await c.get(`${PATH}/${id}`);
      contractResponse(kit, response, true, 30701);
      const { trace_id: trace, ...body } = response.json<Record<string, unknown>>();
      expect(trace).toEqual(expect.any(String));
      answers.push(body);
      expect(response.body).not.toContain(id);
    }
    expect(answers[1]).toEqual(answers[0]);
    expect(answers[2]).toEqual(answers[0]);
    contractResponse(kit, await otherApp.get(`${PATH}/${owned.id}`), true, 30701);
    expect(
      await listWithdrawalsForUser(kit.db, {
        appId: otherApp.subject.appId,
        userId: c.subject.userId,
      }),
    ).toEqual({ items: [], next_cursor: null });
    const page = await listWithdrawalsForUser(kit.db, c.subject);
    expect(page.items.map((item) => item.withdrawal_id)).toEqual([owned.id]);
    const foreignCursor = Buffer.from(`${foreign.created_at.toISOString()}:${foreign.id}`).toString(
      'base64url',
    );
    const resumed = await listWithdrawalsForUser(kit.db, { ...c.subject, cursor: foreignCursor });
    expect(resumed.items.every((item) => item.withdrawal_id === owned.id)).toBe(true);
  },
  TIMEOUT,
);

it.each(['PAID_API', 'PAID_MANUAL'])(
  '[AC-B2-05f#24] %s 未记录通道流水号时详情返回 null',
  async (status) => {
    const c = await client(kit);
    const row = await seedRecord(kit, c.subject, { status, channel_order_id: null });
    const response = await c.get(`${PATH}/${row.id}`);
    contractResponse(kit, response, true);
    expect(response.json<{ data: Record<string, unknown> }>().data).toMatchObject({
      status,
      channel_order_id: null,
    });
  },
);

it.each(['list', 'detail'])('[AC-B2-05f#25] %s 拒绝 h5_token，错误响应符合契约', async (kind) => {
  const c = await client(kit);
  const row = await seedRecord(kit, c.subject);
  const detail = kind === 'detail';
  const response = await c.get(detail ? `${PATH}/${row.id}` : PATH, 'h5');
  contractResponse(kit, response, detail, 10403);
});

it.each(['0', '51', '1.5', 'abc'])('[AC-B2-05f#26] 契约拒绝非法 limit=%s', async (limit) => {
  const c = await client(kit);
  contractResponse(kit, await c.get(`${PATH}?limit=${limit}`), false, 20001);
});
