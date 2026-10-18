import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import { authorization } from './authorization-kit.ts';
import { setup, binding, accepted, rejected, REASON, snapshot, current } from './kit.ts';

const h = useHarness();

it.each(['taobao', 'pdd'])(
  '[AC-F1-07c#17] %s 重置再授权的新行承接本用户本平台历史最大版本，旧值不能命中新行',
  async (platform) => {
    const s = await setup(h);
    const row = await binding(s, { platform });
    const history = await binding(s, {
      platform,
      status: 'released',
      row_version: 101,
      union_account_id: row.union_account_id,
      created_at: new Date('2026-09-01T00:00:00Z'),
      updated_at: new Date('2026-09-02T00:00:00Z'),
    });
    await binding(s, {
      platform: platform === 'taobao' ? 'pdd' : 'taobao',
      status: 'released',
      row_version: 900,
    });
    const other = await setup(h, { appId: s.appId });
    await binding(other, { platform, row_version: 1000 });
    await accepted(
      await s.post(
        'reset',
        { reason: REASON, expected_row_version: row.row_version },
        { platform },
      ),
    );
    const oldRows = await s.rows();
    const auth = await authorization(s, row.union_account_id);
    if (platform === 'taobao') {
      expect(await auth.bind()).toMatchObject({ status: 200, envelope: { code: 0 } });
    } else expect(await auth.pdd()).toMatchObject({ kind: 'active' });
    const rows = await s.rows();
    const fresh = rows.find((r) => r.platform === platform && r.status === 'active');
    expect(fresh).toBeDefined();
    expect(fresh!.id).not.toBe(row.id);
    expect(fresh!.id).not.toBe(history.id);
    expect(fresh!.row_version).toBe(102);
    for (const old of oldRows) expect(await current(s, old.id)).toEqual(old);
    const before = await snapshot(s);
    for (const stale of [row.row_version, history.row_version, row.row_version + 1]) {
      await rejected(
        await s.post('disable', { reason: REASON, expected_row_version: stale }, { platform }),
        20902,
        { resource: 'union_binding' },
      );
      expect(await snapshot(s)).toEqual(before);
    }
    await accepted(
      await s.post(
        'disable',
        { reason: REASON, expected_row_version: fresh!.row_version },
        { platform },
      ),
    );
    expect(await current(s, fresh!.id)).toMatchObject({
      status: 'blocked',
      blocked_reason: 'admin_disable',
    });
  },
);
