import { randomUUID } from 'node:crypto';

import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  AT,
  IP,
  REASONS,
  SHAPES,
  TABLES,
  VOID_REASONS,
  appId,
  close,
  insert,
  open,
  ready,
  references,
  reward,
  update,
  user,
  type Harness,
  type Row,
} from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open();
});
afterAll(async () => {
  await close(h);
});

it('[AC-CT-25b#5] 新资格允许结果与凭证为空，金额保留零及超过 JS 安全整数的分', async () => {
  await ready(h.app);
  for (const amount_fen of [0n, 9007199254740993n]) {
    const row = await reward(h.app);
    expect(await insert(h.app, 'invite_rewards', { ...row, amount_fen })).toMatchObject({
      ...row,
      amount_fen,
      row_version: 0,
      inviter_result: null,
      invitee_result: null,
      inviter_skip_reason: null,
      invitee_skip_reason: null,
      void_reason: null,
      trigger_order_id: null,
      triggered_at: null,
      inviter_voucher_id: null,
      invitee_voucher_id: null,
      granted_at: null,
    });
  }
});

it('[AC-CT-25b#6] 全部合法来源、状态、两方结果及原因可写入', async () => {
  await ready(h.app);
  for (const bind_source of ['landing', 'register', 'backfill']) {
    const row = await reward(h.app);
    expect(await insert(h.app, 'invite_rewards', { ...row, bind_source })).toMatchObject({
      bind_source,
    });
  }
  for (const status of ['qualified', 'deferred', 'budget_exhausted']) {
    expect(
      await insert(h.app, 'invite_rewards', { ...(await reward(h.app)), status }),
    ).toMatchObject({ status });
  }
  for (const void_reason of VOID_REASONS) {
    expect(
      await insert(h.app, 'invite_rewards', {
        ...(await reward(h.app)),
        status: 'voided',
        void_reason,
      }),
    ).toMatchObject({ status: 'voided', void_reason });
  }
  for (const reason of REASONS) {
    for (const side of ['inviter', 'invitee']) {
      const other = side === 'inviter' ? 'invitee' : 'inviter';
      const changes = {
        status: 'processed',
        [`${side}_result`]: 'skipped',
        [`${side}_skip_reason`]: reason,
        [`${other}_result`]: 'granted',
      };
      expect(
        await insert(h.app, 'invite_rewards', { ...(await reward(h.app)), ...changes }),
      ).toMatchObject(changes);
    }
  }
  for (const result of ['granted', 'skipped']) {
    const changes = {
      status: 'processed',
      inviter_result: result,
      invitee_result: result,
      inviter_skip_reason: result === 'skipped' ? 'same_ip' : null,
      invitee_skip_reason: result === 'skipped' ? 'same_device' : null,
    };
    expect(
      await insert(h.app, 'invite_rewards', { ...(await reward(h.app)), ...changes }),
    ).toMatchObject(changes);
  }
});

it('[AC-CT-25b#7] CHECK 拒绝每个未知编码、负金额和非法 IP HMAC', async () => {
  await ready(h.app);
  const row = await reward(h.app);
  const invalid: Row[] = [
    { amount_fen: -1n },
    ...['unknown', 'QUALIFIED', ''].map((status) => ({ status })),
    ...['admin', 'REGISTER', ''].map((bind_source) => ({ bind_source })),
    ...[IP.toUpperCase(), 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64), ''].map(
      (bind_ip_hmac) => ({ bind_ip_hmac }),
    ),
    ...['unknown', 'RELATION_CHANGED', ''].map((void_reason) => ({
      status: 'voided',
      void_reason,
    })),
  ];
  for (const side of ['inviter', 'invitee']) {
    for (const result of ['unknown', 'GRANTED', '']) invalid.push({ [`${side}_result`]: result });
    for (const reason of ['unknown', 'SAME_IP', ''])
      invalid.push({
        [`${side}_result`]: 'skipped',
        [`${side}_skip_reason`]: reason,
      });
  }
  for (const changes of invalid) {
    await expect(insert(h.app, 'invite_rewards', { ...row, ...changes })).rejects.toMatchObject({
      code: '23514',
    });
  }
});

it('[AC-CT-25b#8] 两方原因与结果联动，包括 NULL 结果不能带原因，processed 不可缺一方', async () => {
  await ready(h.app);
  const row = await reward(h.app);
  const invalid: Row[] = [];
  for (const side of ['inviter', 'invitee']) {
    invalid.push(
      { [`${side}_result`]: 'skipped', [`${side}_skip_reason`]: null },
      { [`${side}_result`]: 'granted', [`${side}_skip_reason`]: 'same_ip' },
      { [`${side}_result`]: null, [`${side}_skip_reason`]: 'same_ip' },
      {
        status: 'processed',
        inviter_result: 'granted',
        invitee_result: 'granted',
        [`${side}_result`]: null,
      },
    );
  }
  invalid.push({ status: 'processed' }, { status: 'voided', void_reason: null });
  for (const status of ['qualified', 'deferred', 'processed', 'budget_exhausted']) {
    invalid.push({
      status,
      void_reason: 'relation_changed',
      inviter_result: 'granted',
      invitee_result: 'granted',
    });
  }
  for (const changes of invalid) {
    await expect(insert(h.app, 'invite_rewards', { ...row, ...changes })).rejects.toMatchObject({
      code: '23514',
    });
  }
  // Same guards must hold on the authorized UPDATE path as well as INSERT.
  await insert(h.app, 'invite_rewards', row);
  for (const changes of invalid) {
    await expect(update(h.app, 'invite_rewards', row['app_id'], changes)).rejects.toMatchObject({
      code: '23514',
    });
  }
});

it('[AC-CT-25b#9] 必填列拒绝 NULL，资格业务时刻不从 SQL 时钟补齐', async () => {
  await ready(h.app);
  const rows = {
    invite_rewards: await reward(h.app),
    invite_reward_budgets: { app_id: appId(), period: 'total', updated_at: AT },
  };
  for (const table of TABLES) {
    for (const [column, [, nullable]] of Object.entries(SHAPES[table])) {
      if (nullable) continue;
      await expect(insert(h.app, table, { ...rows[table], [column]: null })).rejects.toMatchObject({
        code: '23502',
      });
    }
  }
  const omitted = { ...rows.invite_rewards };
  delete omitted['qualified_at'];
  await expect(insert(h.app, 'invite_rewards', omitted)).rejects.toMatchObject({ code: '23502' });
});

it('[AC-CT-25b#10] 同 app 邀请对象只能一条，换邀请人或状态不能绕过且两个并发插入只成一个', async () => {
  await ready(h.app);
  const row = await reward(h.app);
  await insert(h.app, 'invite_rewards', row);
  await expect(
    insert(h.app, 'invite_rewards', {
      ...row,
      inviter_id: await user(h.app, String(row['app_id'])),
      status: 'deferred',
    }),
  ).rejects.toMatchObject({ code: '23505' });
  expect(
    await insert(h.app, 'invite_rewards', {
      ...row,
      invitee_id: await user(h.app, String(row['app_id'])),
    }),
  ).toMatchObject({ inviter_id: row['inviter_id'] });
  const other = await reward(h.app);
  expect(await insert(h.app, 'invite_rewards', other)).toMatchObject(other);
  const race = await reward(h.app);
  const results = await Promise.allSettled([
    insert(h.app, 'invite_rewards', race),
    insert(h.app, 'invite_rewards', race),
  ]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((r) => r.status === 'rejected')).toEqual([
    expect.objectContaining({ reason: expect.objectContaining({ code: '23505' }) }),
  ]);
});

it('[AC-CT-25b#11] 用户、触发订单、两张凭证拒绝不存在与跨 app 引用并接受本 app 引用', async () => {
  await ready(h.app);
  const row = await reward(h.app);
  const otherApp = appId();
  const otherUser = await user(h.app, otherApp);
  const other = await references(h.app, otherApp);
  for (const [column, foreign] of [
    ['invitee_id', otherUser],
    ['inviter_id', otherUser],
    ['trigger_order_id', other.order],
    ['inviter_voucher_id', other.voucher],
    ['invitee_voucher_id', other.voucher],
  ]) {
    for (const id of [randomUUID(), foreign]) {
      await expect(
        insert(h.app, 'invite_rewards', { ...row, [column!]: id }),
      ).rejects.toMatchObject({ code: '23503' });
    }
  }
  const local = await references(h.app, String(row['app_id']));
  const populated = {
    ...row,
    trigger_order_id: local.order,
    triggered_at: AT,
    inviter_voucher_id: local.voucher,
    invitee_voucher_id: local.voucher,
    status: 'processed',
    inviter_result: 'granted',
    invitee_result: 'granted',
    granted_at: AT,
  };
  expect(await insert(h.app, 'invite_rewards', populated)).toMatchObject(populated);
  const saved = await sql`SELECT * FROM app.invite_rewards
    WHERE app_id = ${row['app_id']}`.execute(h.app);
  expect(saved.rows).toHaveLength(1);
});
