import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import {
  MIN,
  NOW_MS,
  iso,
  ok,
  rejected,
  setup,
  unionAccount,
  windows,
  type Created,
  type Scenario,
} from './kit.ts';

const h = useHarness();
const FROM_MS = NOW_MS - 120 * MIN;
const WINDOW = { platform: 'pdd', from: iso(FROM_MS), to: iso(FROM_MS + 50 * MIN) };
const ORDER_NOS = { platform: 'pdd', order_nos: ['231006-1234567891'] };

async function refused(s: Scenario) {
  for (const body of [WINDOW, ORDER_NOS]) {
    await rejected(await s.post(body), 'create', 30156, { platform: 'pdd' });
  }
  expect(await s.rows()).toEqual([]);
  expect(s.jobs()).toEqual([]);
}

it('[AC-B1-09i#22] 站长授权失效（auth_status=expired）期间该平台手动同步 → 30156 data.platform，不建请求不投递', async () => {
  const s = await setup(h);
  await unionAccount(s, 'pdd', { auth_status: 'expired' });
  await refused(s);
});

it('[AC-B1-09i#23] auth_expires_at 已到（按注入时钟）同样暂停；未到期照常受理', async () => {
  const s = await setup(h);
  const acc = await unionAccount(s, 'pdd', { auth_expires_at: iso(NOW_MS) });
  await refused(s);
  await h.db
    .updateTable('union_accounts')
    .set({ auth_expires_at: iso(NOW_MS + MIN) })
    .where('id', '=', acc.id)
    .execute();
  const created = await ok<Created>(await s.post(WINDOW), 'create');
  expect(created).toMatchObject({ status: 'queued', reused: false });
});

it('[AC-B1-09i#24] 重新授权后受理，按 from 起切分投递（暂停期间没有留下任何请求或任务）', async () => {
  const s = await setup(h);
  const acc = await unionAccount(s, 'pdd', { auth_status: 'expired' });
  await refused(s);
  await h.db
    .updateTable('union_accounts')
    .set({ auth_status: 'active', auth_expires_at: null })
    .where('id', '=', acc.id)
    .execute();
  const created = await ok<Created>(await s.post(WINDOW), 'create');
  expect(created.reused).toBe(false);
  expect(windows(s.jobs()).map((job) => [job.start, job.end])).toEqual([
    [FROM_MS, FROM_MS + 30 * MIN],
    [FROM_MS + 30 * MIN, FROM_MS + 50 * MIN],
  ]);
  expect((await s.rows()).map((row) => row.id)).toEqual([created.sync_id]);
});
