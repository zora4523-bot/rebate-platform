import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Insertable, Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { fixture } from './db-kit.ts';
import { ago, HOUR, MINUTE } from './kit.ts';

let database: TestDatabase | undefined;
let db: Kysely<DB>;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 4 });
}, 180_000);
afterAll(async () => {
  try {
    if (db) await destroyDb(db);
  } finally {
    await database?.drop();
  }
}, 30_000);

it('[AC-B1-10h#110] AC-S1-25② 真实日志过滤失败/预计算/注册/分享/未来，均不挡住旧有效记录', async () => {
  const patches: Partial<Insertable<DB['link_logs']>>[] = [
    { event: 'precompute' },
    { event: 'register' },
    { result_code: 30151 },
    { pid_scene: 'share' },
    { created_at: ago(-1) },
  ];
  for (const patch of patches) {
    const f = await fixture(db);
    await f.log();
    await f.log({ created_at: ago(10 * MINUTE), ...patch });
    const q = await f.queries();
    expect((await q.list(f.subject, { scope: 'self' })).claim_entry_pinned).toBe(true);
  }
});

it('[AC-B1-10h#111] AC-S1-25② 本人发起看opener优先，convert回退快照用户；无scene也算', async () => {
  const f = await fixture(db);
  const other = await f.user();
  await f.log({ user_id: other, pid_scene: null });
  await f.log({ opener_user_id: other, created_at: ago(10 * MINUTE) });
  const q = await f.queries();
  expect((await q.list(f.subject, { scope: 'self' })).claim_entry_pinned).toBe(true);
  await f.log({ event: 'convert', opener_user_id: null, created_at: ago(10 * MINUTE) });
  expect((await q.list(f.subject, { scope: 'self' })).claim_entry_pinned).toBe(false);
});

it('[AC-B1-10h#112] AC-S1-25② 真实读口授权判断：淘宝/pdd两种授权原因，记录之后或同时绑定', async () => {
  for (const platform of ['taobao', 'pdd']) {
    for (const reason of ['auth_failed', 'auth_declined']) {
      for (const age of [HOUR, HOUR - 1]) {
        const f = await fixture(db);
        await f.log({ platform, no_rebate: true, no_rebate_reason: reason });
        await f.binding({
          platform,
          bound_at: ago(age),
          relation_id: platform === 'pdd' ? null : 'r'.repeat(32),
        });
        const q = await f.queries();
        expect((await q.list(f.subject, { scope: 'self' })).claim_entry_pinned).toBe(true);
      }
    }
  }
});

it('[AC-B1-10h#113] AC-S1-25② 真实读口忽略未授权、旧授权、非active、无有效淘宝relation_id', async () => {
  const patches: (Partial<Insertable<DB['union_bindings']>> | null)[] = [
    null,
    { bound_at: ago(HOUR + 1) },
    { bound_at: null },
    { status: 'invalid' },
    { status: 'blocked' },
    { relation_id: null },
    { relation_id: '' },
    { relation_id: 'r'.repeat(33) },
    { platform: 'pdd' },
  ];
  for (const patch of patches) {
    const f = await fixture(db);
    await f.log({ no_rebate: true, no_rebate_reason: 'auth_failed' });
    if (patch !== null) await f.binding(patch);
    const q = await f.queries();
    expect((await q.list(f.subject, { scope: 'self' })).claim_entry_pinned).toBe(false);
    await f.log({ created_at: ago(2 * HOUR) });
    expect((await q.list(f.subject, { scope: 'self' })).claim_entry_pinned).toBe(true);
  }
});

it('[AC-B1-10h#114] AC-S1-25② 真实读口忽略非授权原因无返利，不能过滤后错误地选最近原始行', async () => {
  for (const reason of ['relation_conflict', 'binding_blocked', null]) {
    const f = await fixture(db);
    await f.log({ no_rebate: true, no_rebate_reason: reason });
    await f.binding();
    const q = await f.queries();
    expect((await q.list(f.subject, { scope: 'self' })).claim_entry_pinned).toBe(false);
    await f.log({ created_at: ago(2 * HOUR) });
    expect((await q.list(f.subject, { scope: 'self' })).claim_entry_pinned).toBe(true);
  }
});
