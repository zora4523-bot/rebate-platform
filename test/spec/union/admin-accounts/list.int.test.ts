// B1-22d / BR-ID-24 细则「后台联盟账号列表」「各平台 reauth_mode 的取法」, SPEC_REF 48e55e6.
import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import {
  ms,
  listed,
  PHONE,
  seedAccount,
  seedCredential,
  setJdMode,
  setPhones,
  setup,
  signIn,
  snapshot,
  expectNoSecrets,
} from './kit.ts';

const h = useHarness();

it('[B1-22d][BR-ID-24] 列表逐字段照存储返回，只含本 app，按平台再按账号名排序，不带提醒阶段与凭据', async () => {
  const s = await setup(h);
  const other = await setup(h);
  const renewed = await seedAccount(s, {
    platform: 'taobao',
    account_name: 'b-taobao',
    auth_expires_at: new Date('2027-01-07T02:00:00.000Z'),
    auth_expires_estimated: true,
    auth_status: 'expiring',
    auth_renewed_at: new Date('2026-10-08T02:00:00.000Z'),
    auth_renewed_by: s.a.id,
    alert_stage: 'd14',
    last_probe_at: new Date('2026-10-09T01:00:00.000Z'),
    last_probe_ok: false,
    last_probe_error: 'synthetic-probe-timeout',
  });
  const first = await seedAccount(s, { platform: 'taobao', account_name: 'a-taobao' });
  const pdd = await seedAccount(s, {
    platform: 'pdd',
    account_name: 'c-pdd',
    status: 'paused',
    sync_start_at: null,
    auth_expires_at: null,
    last_probe_at: null,
    last_probe_ok: null,
  });
  await seedCredential(s, renewed.id, 'fixture-current-site-token');
  await seedAccount(other, { platform: 'taobao', account_name: 'a-foreign' });

  const items = await listed(s);
  expect(items.map((item) => item.union_account_id).sort()).toEqual(
    [renewed.id, first.id, pdd.id].sort(),
  );
  const taobao = items.filter((item) => item.platform === 'taobao');
  expect(taobao.map((item) => item.account_name)).toEqual(['a-taobao', 'b-taobao']);
  const platforms = items.map((item) => item.platform);
  expect(platforms.indexOf('pdd') === 0 || platforms.indexOf('pdd') === 2).toBe(true);

  const row = items.find((item) => item.union_account_id === renewed.id)!;
  expect(Object.keys(row).sort()).toEqual(
    [
      'union_account_id',
      'platform',
      'account_name',
      'status',
      'sync_start_at',
      'auth_expires_at',
      'auth_expires_estimated',
      'auth_status',
      'auth_renewed_at',
      'auth_renewed_by',
      'last_probe_at',
      'last_probe_ok',
      'last_probe_error',
      'alert_phones_configured',
      'reauth_mode',
    ].sort(),
  );
  expect(row).toMatchObject({
    platform: 'taobao',
    account_name: 'b-taobao',
    status: 'active',
    auth_expires_estimated: true,
    auth_status: 'expiring',
    auth_renewed_by: s.a.id,
    last_probe_ok: false,
    last_probe_error: 'synthetic-probe-timeout',
    reauth_mode: 'oauth',
  });
  expect(ms(row.sync_start_at)).toBe(ms(renewed.sync_start_at));
  expect(ms(row.auth_expires_at)).toBe(ms(renewed.auth_expires_at));
  expect(ms(row.auth_renewed_at)).toBe(ms(renewed.auth_renewed_at));
  expect(ms(row.last_probe_at)).toBe(ms(renewed.last_probe_at));
  expect(row).not.toHaveProperty('alert_stage');
  expectNoSecrets(items, ['fixture-current-site-token']);

  const paused = items.find((item) => item.union_account_id === pdd.id)!;
  expect(paused).toMatchObject({
    status: 'paused',
    sync_start_at: null,
    auth_expires_at: null,
    auth_expires_estimated: false,
    auth_renewed_at: null,
    auth_renewed_by: null,
    last_probe_at: null,
    last_probe_ok: null,
    last_probe_error: null,
    reauth_mode: 'none',
  });
  expect((await listed(other)).map((item) => item.account_name)).toEqual(['a-foreign']);
});

it('[B1-22d][BR-ID-24][D10-164] reauth_mode：淘宝 oauth，拼多多 none，京东 private_position 为 manual、其余为 none', async () => {
  const s = await setup(h);
  const taobao = await seedAccount(s, { platform: 'taobao' });
  const pdd = await seedAccount(s, { platform: 'pdd', auth_expires_at: null });
  const jd = await seedAccount(s, { platform: 'jd' });
  const modes = async () =>
    Object.fromEntries((await listed(s)).map((item) => [item.union_account_id, item.reauth_mode]));

  expect(await modes()).toEqual({ [taobao.id]: 'oauth', [pdd.id]: 'none', [jd.id]: 'none' });

  const manual = await setup(h);
  await setJdMode(manual, 'private_position');
  const jdManual = await seedAccount(manual, { platform: 'jd', auth_expires_estimated: true });
  const items = await listed(manual);
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({
    union_account_id: jdManual.id,
    reauth_mode: 'manual',
    auth_expires_estimated: true,
  });

  for (const mode of ['sub_union_id', 'claim_only']) {
    const other = await setup(h);
    await setJdMode(other, mode);
    await seedAccount(other, { platform: 'jd' });
    expect((await listed(other)).map((item) => item.reauth_mode)).toEqual(['none']);
  }
});

it('[B1-22d][BR-ID-24 ②] alert_phones_configured：未配置或空组为 false，配置了号码为 true', async () => {
  // One app per configuration: the value is written before the app's first read (config cache).
  const cases: [readonly string[] | null, boolean][] = [
    [null, false],
    [[], false],
    [[PHONE], true],
    [[PHONE, '13900139000'], true],
  ];
  for (const [phones, configured] of cases) {
    const s = await setup(h);
    if (phones !== null) await setPhones(s, phones);
    await seedAccount(s, { platform: 'taobao' });
    await seedAccount(s, { platform: 'pdd', auth_expires_at: null });
    const items = await listed(s);
    expect(
      items.map((item) => item.alert_phones_configured),
      JSON.stringify(phones),
    ).toEqual([configured, configured]);
    expectNoSecrets(items, [PHONE, '13900139000', '138****8000']);
  }
});

it('[B1-22d][BR-ID-24] 查看列表只要 union.account_auth，不要二次验证，也不写任何东西', async () => {
  const s = await setup(h);
  await seedAccount(s, { platform: 'taobao' });
  const before = await snapshot(s);
  const items = await listed(s);
  expect(items).toHaveLength(1);
  expect(await snapshot(s)).toEqual(before);

  const superAdmin = await signIn(h, s.f, s.appId, { grants: [], isSuper: true });
  expect((await listed(superAdmin)).map((item) => item.union_account_id)).toEqual([
    items[0]!.union_account_id,
  ]);
  expect(await snapshot(s)).toEqual(before);
});
