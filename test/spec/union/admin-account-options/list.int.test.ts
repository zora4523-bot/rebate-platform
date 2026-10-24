// B1-22o / CT-24s adminListUnionAccountOptions (D10-243), BR-ATTR-02 细则「后台登记与启停」,
// SPEC_REF ec81e62: every union account of the app (or of one platform), not paged, ordered by
// platform, then account_name, then union_account_id; each row only union_account_id, platform
// and account_name (as GET /admin/v1/union-accounts has them); accounts listed whatever their
// status or authorization state; no credential; a platform outside enum platform is 20001.
import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import {
  ACCOUNT_AUTH,
  PID,
  PLATFORM_ENUM,
  accepted,
  expectedOrders,
  optionOf,
  optionsOf,
  rejected,
  seedAccount,
  seedCredential,
  serialized,
  setup,
  snapshot,
  type AccountRow,
  type Option,
} from './kit.ts';

const h = useHarness();

/** The ids of a list, in list order. */
const ids = (items: readonly Option[]) => items.map((item) => item.union_account_id);

it('[B1-22o][D10-243] 每项只有 union_account_id、platform、account_name 三个字段，取值照存储', async () => {
  const s = await setup(h, { grants: [PID] });
  const row = await seedAccount(s, {
    platform: 'taobao',
    account_name: '凑狸淘宝联盟',
    status: 'active',
    auth_status: 'expiring',
    auth_expires_estimated: true,
    auth_renewed_at: new Date('2026-10-08T02:00:00.000Z'),
    auth_renewed_by: s.a.id,
    alert_stage: 'd14',
    last_probe_ok: false,
    last_probe_error: 'synthetic-probe-timeout',
  });
  const items = await optionsOf(s);
  expect(items).toEqual([
    { union_account_id: row.id, platform: 'taobao', account_name: '凑狸淘宝联盟' },
  ]);
  for (const key of [
    'status',
    'sync_start_at',
    'auth_status',
    'auth_expires_at',
    'auth_expires_estimated',
    'auth_renewed_at',
    'auth_renewed_by',
    'alert_stage',
    'last_probe_at',
    'last_probe_ok',
    'last_probe_error',
    'alert_phones_configured',
    'reauth_mode',
    'row_version',
    'app_id',
    'created_at',
  ]) {
    expect(items[0], key).not.toHaveProperty(key);
  }
  const text = serialized(items);
  for (const value of ['expiring', 'd14', 'synthetic-probe-timeout', s.a.id, s.appId]) {
    expect(text).not.toContain(value);
  }
});

it('[B1-22o][D10-243] 不返回任何凭据：账号有当前凭据时选项里也没有它的明文或密文', async () => {
  const s = await setup(h, { grants: [ACCOUNT_AUTH] });
  const row = await seedAccount(s, { platform: 'jd', account_name: 'alpha' });
  const secret = 'plain-plain-plain-plain';
  const credential = await seedCredential(s, row.id, secret);
  const items = await optionsOf(s);
  expect(items).toEqual([optionOf(row)]);
  const text = serialized(items);
  expect(text).not.toContain(secret);
  expect(text).not.toContain(Buffer.from(secret).toString('hex'));
  expect(text).not.toContain(Buffer.from(secret).toString('base64'));
  expect(text).not.toContain(credential.id);
  expect(text).not.toContain(Buffer.from(credential.access_token_cipher).toString('utf8'));
});

it('[B1-22o][BR-ATTR-02 细则] 账号无论何种状态、授权状态都列出（含 expired、expiring、paused、从未探测）', async () => {
  const s = await setup(h, { grants: [PID] });
  const rows: AccountRow[] = [
    await seedAccount(s, { platform: 'taobao', account_name: 'alpha' }),
    await seedAccount(s, {
      platform: 'taobao',
      account_name: 'bravo',
      auth_status: 'expiring',
      alert_stage: 'd7',
    }),
    await seedAccount(s, {
      platform: 'taobao',
      account_name: 'charlie',
      auth_status: 'expired',
      alert_stage: 'expired',
      auth_expires_at: new Date('2026-10-01T00:00:00.000Z'),
      last_probe_ok: false,
      last_probe_error: 'synthetic-auth-expired',
    }),
    await seedAccount(s, {
      platform: 'taobao',
      account_name: 'delta',
      status: 'paused',
      sync_start_at: null,
      auth_expires_at: null,
      last_probe_at: null,
      last_probe_ok: null,
    }),
    await seedAccount(s, {
      platform: 'taobao',
      account_name: 'echo',
      status: 'paused',
      auth_status: 'expired',
      alert_stage: 'expired',
      auth_expires_at: new Date('2026-09-01T00:00:00.000Z'),
    }),
  ];
  const items = await optionsOf(s);
  expect(items).toEqual(rows.map(optionOf));
  expect(await optionsOf(s, 'taobao')).toEqual(rows.map(optionOf));
});

it('[B1-22o][D10-243] 排序：同平台按 account_name，同名再按 union_account_id；多平台按 platform 分组', async () => {
  const s = await setup(h, { grants: [PID] });
  const rows: AccountRow[] = [];
  const start = s.f.clock.now().getTime();
  // Inserted out of order on purpose, each created earlier than the one before: neither
  // insertion nor creation order is the contract order.
  for (const [platform, name] of [
    ['taobao', 'charlie'],
    ['pdd', 'bravo'],
    ['jd', 'delta'],
    ['taobao', 'alpha'],
    ['pdd', 'alpha'],
    ['taobao', 'bravo'],
    ['jd', 'alpha'],
    ['taobao', 'bravo'],
    ['taobao', 'bravo'],
    ['pdd', 'bravo'],
  ] as const) {
    const createdAt = new Date(start - (rows.length + 1) * 60_000);
    rows.push(await seedAccount(s, { platform, account_name: name, created_at: createdAt }));
  }
  const items = await optionsOf(s);
  expect(expectedOrders(rows)).toContainEqual(items);

  // Within one platform the order is fixed: name first, then id for equal names.
  const taobao = await optionsOf(s, 'taobao');
  const bravos = rows
    .filter((row) => row.platform === 'taobao' && row.account_name === 'bravo')
    .map((row) => row.id)
    .sort();
  const alpha = rows.find((row) => row.platform === 'taobao' && row.account_name === 'alpha')!;
  const charlie = rows.find((row) => row.platform === 'taobao' && row.account_name === 'charlie')!;
  expect(ids(taobao)).toEqual([alpha.id, ...bravos, charlie.id]);
  expect(items.filter((item) => item.platform === 'taobao')).toEqual(taobao);

  // Each platform is one contiguous block.
  const blocks = items
    .map((item) => item.platform)
    .filter((platform, i, all) => i === 0 || all[i - 1] !== platform);
  expect([...blocks].sort()).toEqual(['jd', 'pdd', 'taobao']);
});

it('[B1-22o][D10-243] 不分页：一次返回本 app 的全部账号', async () => {
  const s = await setup(h, { grants: [PID] });
  const rows: AccountRow[] = [];
  for (let i = 0; i < 60; i++) {
    const name = `acct${String(i).padStart(3, '0')}`;
    rows.push(await seedAccount(s, { platform: 'jd', account_name: name }));
  }
  const response = await s.options();
  const items = await accepted(response);
  expect(items).toEqual(rows.map(optionOf));
  expect(response.json()).not.toHaveProperty('data.next_cursor');
  expect(response.json()).not.toHaveProperty('data.total');
});

it('[B1-22o][D10-243] platform 过滤：只回该平台；该平台没有账号时为空列表', async () => {
  const s = await setup(h, { grants: [ACCOUNT_AUTH] });
  const taobao = await seedAccount(s, { platform: 'taobao', account_name: 'alpha' });
  const jd = [
    await seedAccount(s, { platform: 'jd', account_name: 'alpha' }),
    await seedAccount(s, { platform: 'jd', account_name: 'bravo' }),
  ];
  const pdd = await seedAccount(s, { platform: 'pdd', account_name: 'alpha', status: 'paused' });
  const before = await snapshot(s);

  expect(await optionsOf(s, 'taobao')).toEqual([optionOf(taobao)]);
  expect(await optionsOf(s, 'jd')).toEqual(jd.map(optionOf));
  expect(await optionsOf(s, 'pdd')).toEqual([optionOf(pdd)]);
  for (const platform of PLATFORM_ENUM.filter((p) => !['taobao', 'jd', 'pdd'].includes(p))) {
    expect(await optionsOf(s, platform), platform).toEqual([]);
  }
  const all = [taobao.id, ...jd.map((row) => row.id), pdd.id];
  expect(ids(await optionsOf(s)).sort()).toEqual(all.sort());
  expect(await snapshot(s)).toEqual(before);
});

for (const platform of ['', 'TAOBAO', 'tmall', 'taobao ', 'unknown', '1']) {
  it(`[B1-22o][D10-243] platform=${JSON.stringify(platform)} 不在平台枚举：20001 data.fields=[platform]，不给数据`, async () => {
    const s = await setup(h, { grants: [PID, ACCOUNT_AUTH] });
    await seedAccount(s, { platform: 'taobao', account_name: 'alpha' });
    const before = await snapshot(s);
    await rejected(await s.options(platform), 20001, { fields: ['platform'] });
    expect(await snapshot(s)).toEqual(before);
  });
}

it('[B1-22o][D10-243] 与 GET /admin/v1/union-accounts 同一账号的三个字段取值一致', async () => {
  const s = await setup(h, { grants: [PID, ACCOUNT_AUTH] });
  await seedAccount(s, { platform: 'taobao', account_name: 'alpha' });
  await seedAccount(s, { platform: 'jd', account_name: '凑狸京东联盟', auth_status: 'expired' });
  await seedAccount(s, { platform: 'pdd', account_name: 'charlie', status: 'paused' });
  const options = await optionsOf(s);
  const listed = await s.list();
  expect(listed.statusCode).toBe(200);
  const accounts = listed.json<{ data: { items: Option[] } }>().data.items;
  const project = (items: readonly Option[]) =>
    items
      .map((item) => ({
        union_account_id: item.union_account_id,
        platform: item.platform,
        account_name: item.account_name,
      }))
      .sort((a, b) => (a.union_account_id < b.union_account_id ? -1 : 1));
  expect(project(options)).toEqual(project(accounts));
  expect(options).toHaveLength(3);
});
