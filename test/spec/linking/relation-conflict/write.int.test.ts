import { randomUUID } from 'node:crypto';
import { acquireTestRedis, createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { ACCOUNT_NAME, RELATION, suite } from '../bindings/kit.ts';
import { client, web } from '../bindings/client.ts';
import { binding, bindings, scenario, state } from '../bindings/records.ts';
import { rejected } from '../bindings/assertions.ts';
import { conflicts, TIMEOUT } from './records.ts';

const use = suite(createTestDatabase, acquireTestRedis);

it.each([
  { ownerStatus: 'active', kind: 'occupied', own: false },
  { ownerStatus: 'invalid', kind: 'occupied', own: false },
  { ownerStatus: 'blocked', kind: 'occupied', own: false },
  { ownerStatus: 'released', kind: 'cooling', own: false },
  { ownerStatus: 'invalid', kind: 'rebind', own: true },
  { ownerStatus: 'active', kind: 'rebind', own: true },
])(
  '[AC-B1-06z#1] $kind / $ownerStatus / own=$own：每次 30151 写一行，重放不重复',
  async ({ ownerStatus, kind, own }) => {
    const f = use();
    const { c, accountId } = await scenario(f);
    const owner = own ? c : await client(f, { appId: c.appId });
    await binding(f, owner, accountId, {
      status: ownerStatus,
      relation_id: own ? 'synthetic-original-relation' : RELATION,
    });
    const original = await bindings(f, c);
    const s = await state(f, c);
    const key = randomUUID();
    const response = await c.post(web(s.state), { key });
    await rejected(response, 30151);
    for (const value of [ACCOUNT_NAME, RELATION, owner.uid, accountId]) {
      expect(response.payload).not.toContain(value);
    }
    expect(await bindings(f, c)).toEqual(original);
    const rows = await conflicts(f.db, c.appId);
    const alreadyActive = own && ownerStatus === 'active';
    expect(rows).toEqual([
      expect.objectContaining({
        id: expect.any(String),
        app_id: c.appId,
        user_id: c.uid,
        platform: 'taobao',
        union_account_id: accountId,
        kind,
        occurred_at: f.clock.now(),
        resolved_at: alreadyActive ? f.clock.now() : null,
        resolution: alreadyActive ? 'already_active' : null,
      }),
    ]);
    expect(f.lines.join('\n')).not.toContain('linking.bindings.relation_conflict');
    f.clock.advanceMs(1000);
    const replay = await c.post(web(s.state), { key });
    expect(replay.json()).toEqual(response.json());
    expect(await conflicts(f.db, c.appId)).toEqual(rows);
    expect(f.exchange).toHaveBeenCalledOnce();

    // A distinct authorization is a distinct event, even if its conflict category is identical.
    const next = await state(f, c);
    await rejected(await c.post(web(next.state)), 30151);
    const after = await conflicts(f.db, c.appId);
    expect(after).toHaveLength(2);
    expect(after.find((row) => row.id !== rows[0]!.id)).toMatchObject({
      kind,
      occurred_at: f.clock.now(),
      resolved_at: alreadyActive ? f.clock.now() : null,
      resolution: alreadyActive ? 'already_active' : null,
    });
  },
  TIMEOUT,
);

it(
  '[AC-B1-06z#2] 他人占用时本人已有 active：occupied 也写入即解决，仍拦截授权',
  async () => {
    const f = use();
    const { c, accountId } = await scenario(f);
    const owner = await client(f, { appId: c.appId });
    await binding(f, owner, accountId);
    await binding(f, c, accountId, { relation_id: 'synthetic-own-active-relation' });
    const before = await bindings(f, c);
    const s = await state(f, c);
    await rejected(await c.post(web(s.state)), 30151);
    expect(await conflicts(f.db, c.appId)).toEqual([
      expect.objectContaining({
        user_id: c.uid,
        union_account_id: accountId,
        kind: 'occupied',
        occurred_at: f.clock.now(),
        resolved_at: f.clock.now(),
        resolution: 'already_active',
      }),
    ]);
    expect(await bindings(f, c)).toEqual(before);
  },
  TIMEOUT,
);
