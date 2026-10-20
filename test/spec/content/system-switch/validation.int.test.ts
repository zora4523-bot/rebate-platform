import type { DB } from '@couli/db';
import { createTestDatabase } from '@couli/db/testing';
import type { Transaction } from 'kysely';
import { expect, it } from 'vitest';
import type { SystemSwitchInput } from '../../../../apps/api/src/modules/content/index.ts';
import { KEY, alerts, databaseHarness, fixture, seedRow, snapshot } from './kit.ts';

const h = databaseHarness(createTestDatabase);

it('[AC-F1-02zk#7] 根 db 不能冒充调用方事务：查询前拒绝，零写入、零告警', async () => {
  const f = fixture();
  await seedRow(h.db, f.input.appId, true);
  const before = await snapshot(h.db, f.input.appId);
  const queries: string[] = [];
  const db = h.db.withPlugin({
    transformQuery(args) {
      queries.push(args.node.kind);
      return args.node;
    },
    async transformResult(args) {
      return args.result;
    },
  });
  await expect(async () => f.writer.turnOff(db as Transaction<DB>, f.input)).rejects.toThrow();
  expect(queries).toEqual([]);
  expect(await snapshot(h.db, f.input.appId)).toEqual(before);
  expect(alerts(f.lines)).toEqual([]);
});

it.each([
  { key: 'payout.queue_paused' },
  { key: 'payout.channel_paused.alipay' },
  { key: 'withdraw.enabled' },
  { key: 'settle.auto.enabled.extra' },
  { key: 'unknown.enabled' },
  { key: '__proto__' },
  { source: '' },
  { source: 'Daily_check' },
  { source: 'daily-check' },
  { source: 'daily.check' },
  { source: 'daily check' },
  { source: 'daily_check\n' },
  { source: 'a'.repeat(33) },
  { reason: '' },
  { source: 'src', reason: 'a'.repeat(197) },
])('[AC-F1-02zk#8] 非法参数 %j 在查询前拒绝：不触碰任何配置、历史与审计', async (override) => {
  const f = fixture();
  await seedRow(h.db, f.input.appId, true);
  const before = await snapshot(h.db, f.input.appId);
  const queries: string[] = [];
  await h.db.transaction().execute(async (trx) => {
    const checked = trx.withPlugin({
      transformQuery(args) {
        queries.push(args.node.kind);
        return args.node;
      },
      async transformResult(args) {
        return args.result;
      },
    });
    const invalid = { ...f.input, ...override } as SystemSwitchInput;
    // Catch inside the transaction so an implementation that writes then rejects cannot
    // hide those writes behind an automatic transaction rollback.
    await expect(async () => f.writer.turnOff(checked, invalid)).rejects.toThrow();
  });
  expect(queries).toEqual([]);
  expect(await snapshot(h.db, f.input.appId)).toEqual(before);
  expect(alerts(f.lines)).toEqual([]);
});

it.each([
  ['src', 'a'.repeat(196)],
  ['a'.repeat(32), 'b'.repeat(167)],
  ['daily_check', '全局差异'],
])(
  '[AC-F1-02zk#9] 合法来源与原因边界 source=%s：组合最多 200 字、来源最多 32 字，原样记历史',
  async (source, reason) => {
    const f = fixture();
    const input = { ...f.input, source, reason };
    const result = await h.db.transaction().execute((trx) => f.writer.turnOff(trx, input));
    expect(result).toEqual({ key: KEY, changed: true, version: 1, fromValue: null });
    const after = await snapshot(h.db, input.appId);
    expect(after.versions).toHaveLength(1);
    expect(after.versions[0]?.reason).toBe(`${source}:${reason}`);
  },
);

it('[AC-F1-02zk#10] 系统端口不接受打开方向：夹带 value=true 也绝不能打开开关', async () => {
  const f = fixture();
  await seedRow(h.db, f.input.appId, false);
  const before = await snapshot(h.db, f.input.appId);
  // The public type has no value parameter. Simulate an untyped caller: either reject the
  // extra field or ignore it, but never store true or emit a change alert.
  await h.db.transaction().execute(async (trx) => {
    try {
      await f.writer.turnOff(trx, { ...f.input, value: true } as SystemSwitchInput);
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
    }
  });
  expect(await snapshot(h.db, f.input.appId)).toEqual(before);
  expect(alerts(f.lines)).toEqual([]);
});
