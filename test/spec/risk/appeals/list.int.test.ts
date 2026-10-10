import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { seedUser } from '../../identity/registration/kit.ts';
import { publicAppeal } from './service-kit.ts';
import { client, listed, openHttp, PATH, rejected, type Client, type Fixture } from './http-kit.ts';

let f: Fixture;
beforeAll(async () => {
  f = await openHttp();
}, 180_000);
afterAll(async () => {
  await f?.close();
});

async function seed(
  c: Client,
  options: {
    id?: string;
    appId?: string;
    uid?: string;
    type?: 'account' | 'order' | 'blocked_request';
    status?: 'processing' | 'upheld' | 'revoked';
    created?: Date;
  } = {},
) {
  const id = options.id ?? randomUUID();
  const type = options.type ?? 'order';
  const status = options.status ?? 'upheld';
  const uid = options.uid ?? c.uid;
  const created = options.created ?? f.clock.now();
  const row = {
    id,
    app_id: options.appId ?? c.appId,
    user_id: uid,
    target_type: type,
    target_id: type === 'account' ? uid : randomUUID(),
    status,
    content: `原文-${id}`,
    prev_risk_state: type === 'account' ? 'banned' : null,
    deadline_at: new Date('2026-11-05T16:00:00.000Z'),
    handler_id: status === 'processing' ? null : 'private-handler',
    closed_at: status === 'processing' ? null : f.clock.now(),
    request_type: type === 'blocked_request' ? 'withdraw' : null,
    created_at: created,
    updated_at: created,
  };
  await f.db.withSchema('app').insertInto('appeals').values(row).execute();
  return row;
}

it('[AC-B1-03i#22] 仅本人本 app 的 account/order；混合状态、同刻 id 倒序分页，无内部字段', async () => {
  const c = await client(f);
  const older = new Date(f.clock.now().getTime() - 86400_000);
  const rows = [
    await seed(c, {
      id: '019a0000-0000-7000-8000-000000000003',
      type: 'account',
      status: 'processing',
    }),
    await seed(c, { id: '019a0000-0000-7000-8000-000000000002', status: 'revoked' }),
    await seed(c, { id: '019a0000-0000-7000-8000-000000000001', status: 'upheld' }),
    await seed(c, { created: older }),
  ];
  const other = await seedUser(f.db, c.appId);
  await seed(c, { uid: other });
  await seed(c, { appId: `${c.appId}_other` }); // same uid, different tenant
  await seed(c, { type: 'blocked_request' });
  const first = await listed(await c.send('GET', `${PATH}?limit=2`));
  expect(first.items.map((row) => row.appeal_id)).toEqual(rows.slice(0, 2).map((row) => row.id));
  expect(first.next_cursor).toEqual(expect.any(String));
  expect(first.next_cursor).not.toBe('');
  // Newer insert between pages must neither repeat nor displace older records.
  await seed(c, { created: new Date(f.clock.now().getTime() + 1) });
  const second = await listed(
    await c.send('GET', `${PATH}?limit=2&cursor=${encodeURIComponent(first.next_cursor!)}`),
  );
  expect(second.items.map((row) => row.appeal_id)).toEqual(rows.slice(2).map((row) => row.id));
  expect(second.next_cursor).toBeNull();
  const combined = [...first.items, ...second.items];
  for (const item of combined) publicAppeal(item);
  expect(combined).toEqual(
    rows.map((row) => ({
      appeal_id: row.id,
      target_type: row.target_type,
      target_id: row.target_id,
      status: row.status,
      content: row.content,
      created_at: expect.any(String),
      closed_at: row.closed_at === null ? null : expect.any(String),
    })),
  );
  for (const [index, item] of combined.entries()) {
    expect(new Date(item.created_at)).toEqual(rows[index]!.created_at);
    expect(item.closed_at === null ? null : new Date(item.closed_at)).toEqual(
      rows[index]!.closed_at,
    );
  }
});

it('[AC-B1-03i#23] 列表默认 20、最大 50，空页 next_cursor=null', async () => {
  const c = await client(f);
  const rows = [];
  for (let n = 0; n < 21; n += 1) {
    rows.push(await seed(c, { created: new Date(f.clock.now().getTime() - n * 1000) }));
  }
  const first = await listed(await c.send('GET', PATH));
  expect(first.items.map((row) => row.appeal_id)).toEqual(rows.slice(0, 20).map((row) => row.id));
  expect(first.next_cursor).toEqual(expect.any(String));
  const last = await listed(
    await c.send('GET', `${PATH}?cursor=${encodeURIComponent(first.next_cursor!)}`),
  );
  expect(last.items.map((row) => row.appeal_id)).toEqual([rows[20]!.id]);
  expect(last.next_cursor).toBeNull();
  const all = await listed(await c.send('GET', `${PATH}?limit=50`));
  expect(all.items).toHaveLength(21);
  expect(all.next_cursor).toBeNull();
  const empty = await client(f);
  expect(await listed(await empty.send('GET', PATH))).toEqual({ items: [], next_cursor: null });
});

for (const limit of ['0', '51', '1.5', 'invalid']) {
  it(`[AC-B1-03i#24] 列表 limit=${limit} 按契约拒绝`, async () => {
    const c = await client(f);
    expect(await listed(await c.send('GET', PATH))).toEqual({ items: [], next_cursor: null });
    await rejected(await c.send('GET', `${PATH}?limit=${limit}`), 400, 20001);
  });
}
