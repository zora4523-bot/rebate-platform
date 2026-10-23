// B1-22d / BR-ID-24 ③ ④ and 细则「后台告警手机号与重新授权会话」「none 与 manual 平台的到期、探测与提醒」
// (D10-159 补充, D10-164, D10-196), SPEC_REF 48e55e6: manual entry of a station-owner credential.
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import {
  ACCESS_CONTEXT,
  ACTIONS,
  DAY_MS,
  KEY_VALIDITY_DAYS,
  accepted,
  accountRow,
  audits,
  credentials,
  decrypt,
  expectNoSecrets,
  later,
  listed,
  ms,
  rejected,
  seedAccount,
  seedCredential,
  sessions,
  setJdMode,
  setup,
  snapshot,
  type Scenario,
  type UnionAccount,
} from './kit.ts';

const h = useHarness();
const REASON = '京东推客授权 Key 到期前更换';

/** A jd account in reauth_mode manual (attr.jd.user_key_mode = private_position). */
async function manualJd(s: Scenario, patch: Parameters<typeof seedAccount>[1] = {}) {
  await setJdMode(s, 'private_position');
  const row = await seedAccount(s, { platform: 'jd', auth_expires_estimated: true, ...patch });
  await seedCredential(s, row.id, 'fixture-old-manual-key');
  return row;
}

const secretKey = () => `fixture-manual-key-${randomUUID()}`;

it('[B1-22d][D10-196] 录入新凭据并给到期时间：只加密存进 union_credentials 并轮换，账号按给定到期更新、不标估算，写审计', async () => {
  const s = await setup(h);
  const row = await manualJd(s, { row_version: 4 });
  const key = secretKey();
  const expiresAt = later(s, 200);
  const response = await s.put(row.id, {
    credential: key,
    expires_at: expiresAt.toISOString(),
    reason: REASON,
  });
  const now = s.f.clock.now().getTime();
  const data = await accepted<UnionAccount>(response, 'credential');
  expect(data).toMatchObject({
    union_account_id: row.id,
    platform: 'jd',
    account_name: row.account_name,
    status: 'active',
    auth_expires_estimated: false,
    auth_status: 'active',
    auth_renewed_by: s.a.id,
    last_probe_ok: true,
    last_probe_error: null,
    reauth_mode: 'manual',
    alert_phones_configured: false,
  });
  expect(ms(data.auth_expires_at)).toBe(expiresAt.getTime());
  expect(ms(data.auth_renewed_at)).toBe(now);
  expect(ms(data.last_probe_at)).toBe(ms(row.last_probe_at));
  expect(data).not.toHaveProperty('alert_stage');
  expect((await listed(s)).find((item) => item.union_account_id === row.id)).toEqual(data);

  const account = await accountRow(s, row.id);
  expect(account).toMatchObject({
    auth_expires_estimated: false,
    auth_status: 'active',
    alert_stage: 'none',
    auth_renewed_by: s.a.id,
  });
  expect(ms(account.auth_expires_at)).toBe(expiresAt.getTime());
  expect(account.row_version).toBeGreaterThan(4);

  const rows = await credentials(s, row.id);
  expect(rows).toHaveLength(2);
  const current = rows.filter((r) => r.is_current);
  expect(current).toHaveLength(1);
  expect(decrypt(s, current[0]!.access_token_cipher, ACCESS_CONTEXT)).toBe(key);
  expect(current[0]!.refresh_token_cipher).toBeNull();
  expect(ms(current[0]!.expires_at)).toBe(expiresAt.getTime());
  const old = rows.find((r) => !r.is_current)!;
  expect(decrypt(s, old.access_token_cipher, ACCESS_CONTEXT)).toBe('fixture-old-manual-key');

  const audit = (await audits(s)).filter((a) => a.action === ACTIONS.credential);
  expect(audit).toHaveLength(1);
  expect(audit[0]).toMatchObject({ app_id: s.appId, admin_id: s.a.id });
  expect(audit[0]!.target).toContain(row.id);
  expect(ms(audit[0]!.at)).toBe(now);
  expect(audit[0]!.after).toMatchObject({ reason: REASON });
  // The union is not called and no OAuth session is involved.
  expect(await sessions(s)).toEqual([]);

  expectNoSecrets([response.json(), await audits(s), s.f.lines, rows], [key]);
});

it(`[B1-22d][D10-196] 不给到期时间：按录入时刻 + 平台 Key 有效期（默认 ${KEY_VALIDITY_DAYS} 天）估算并标「估算」`, async () => {
  const s = await setup(h);
  const row = await manualJd(s, { auth_expires_estimated: false });
  const key = secretKey();
  const response = await s.put(row.id, { credential: key });
  const now = s.f.clock.now().getTime();
  const data = await accepted<UnionAccount>(response, 'credential');
  const expiry = now + KEY_VALIDITY_DAYS * DAY_MS;
  expect(data.auth_expires_estimated).toBe(true);
  expect(ms(data.auth_expires_at)).toBe(expiry);
  const account = await accountRow(s, row.id);
  expect(account.auth_expires_estimated).toBe(true);
  expect(ms(account.auth_expires_at)).toBe(expiry);
  expect(ms(account.auth_renewed_at)).toBe(now);
  const current = (await credentials(s, row.id)).filter((r) => r.is_current);
  expect(current).toHaveLength(1);
  expect(decrypt(s, current[0]!.access_token_cipher, ACCESS_CONTEXT)).toBe(key);
  expect(ms(current[0]!.expires_at)).toBe(expiry);
});

it('[B1-22d][BR-ID-24 ④] 因探测失效而 expired 的 manual 账号，录入后恢复 active、提醒阶段归零，探测结果留给下次巡检', async () => {
  const s = await setup(h);
  const row = await manualJd(s, {
    auth_status: 'expired',
    alert_stage: 'expired',
    auth_expires_at: later(s, 100),
    last_probe_at: new Date('2026-10-09T01:00:00.000Z'),
    last_probe_ok: false,
    last_probe_error: 'synthetic-key-revoked',
  });
  const data = await accepted<UnionAccount>(
    await s.put(row.id, { credential: secretKey(), expires_at: later(s, 300).toISOString() }),
    'credential',
  );
  expect(data).toMatchObject({
    auth_status: 'active',
    last_probe_ok: false,
    last_probe_error: 'synthetic-key-revoked',
  });
  const account = await accountRow(s, row.id);
  expect(account).toMatchObject({ auth_status: 'active', alert_stage: 'none' });
  expect(ms(account.last_probe_at)).toBe(ms(row.last_probe_at));
});

it('[B1-22d][D10-159] 只有 manual 账号能录入：oauth、none、未知账号都是 20001 [union_account_id]，什么都不写', async () => {
  const s = await setup(h);
  const taobao = await seedAccount(s, { platform: 'taobao' });
  const pdd = await seedAccount(s, { platform: 'pdd', auth_expires_at: null });
  const jdNone = await seedAccount(s, { platform: 'jd', auth_expires_at: null });
  const before = await snapshot(s);
  const key = secretKey();
  const responses: unknown[] = [];
  for (const id of [taobao.id, pdd.id, jdNone.id, randomUUID()]) {
    const response = await s.put(id, { credential: key, reason: REASON });
    await rejected(response, 'credential', 20001, { fields: ['union_account_id'] });
    responses.push(response.json());
  }
  expect(await snapshot(s)).toEqual(before);

  for (const mode of ['sub_union_id', 'claim_only']) {
    const other = await setup(h);
    await setJdMode(other, mode);
    const jd = await seedAccount(other, { platform: 'jd', auth_expires_at: null });
    const unchanged = await snapshot(other);
    const response = await other.put(jd.id, { credential: key });
    await rejected(response, 'credential', 20001, { fields: ['union_account_id'] });
    responses.push(response.json());
    expect(await snapshot(other)).toEqual(unchanged);
  }
  expectNoSecrets([responses, s.f.lines], [key]);
});

it('[B1-22d][D10-196] 请求体校验：凭据 1–512 字且首尾无空白、到期须晚于现在、原因 1–200 字；错误不回显凭据', async () => {
  const s = await setup(h);
  const row = await manualJd(s);
  const before = await snapshot(s);
  const key = secretKey();
  const cases: [Record<string, unknown>, string][] = [
    [{}, 'credential'],
    [{ credential: '' }, 'credential'],
    [{ credential: ` ${key}` }, 'credential'],
    [{ credential: `${key}\t` }, 'credential'],
    [{ credential: 'k'.repeat(513) }, 'credential'],
    [{ credential: 42 }, 'credential'],
    [{ credential: key, expires_at: s.f.clock.now().toISOString() }, 'expires_at'],
    [{ credential: key, expires_at: later(s, -1).toISOString() }, 'expires_at'],
    [{ credential: key, expires_at: 'not-a-date' }, 'expires_at'],
    [{ credential: key, reason: '' }, 'reason'],
    [{ credential: key, reason: 'x'.repeat(201) }, 'reason'],
  ];
  const bodies: unknown[] = [];
  for (const [body, field] of cases) {
    const response = await s.put(row.id, body);
    await rejected(response, 'credential', 20001, { fields: [field] });
    bodies.push(response.json());
    expect(await snapshot(s), JSON.stringify(Object.keys(body))).toEqual(before);
  }
  expectNoSecrets([bodies, s.f.lines], [key, 'k'.repeat(513)]);

  const longest = 'k'.repeat(512);
  const data = await accepted<UnionAccount>(
    await s.put(row.id, { credential: longest, reason: '换'.repeat(200) }),
    'credential',
  );
  expect(data.reauth_mode).toBe('manual');
  const current = (await credentials(s, row.id)).filter((r) => r.is_current);
  expect(decrypt(s, current[0]!.access_token_cipher, ACCESS_CONTEXT)).toBe(longest);
});

it('[B1-22d][D10-196] 再次录入照常轮换：始终只有一条当前凭据，每次各写一条审计', async () => {
  const s = await setup(h);
  const row = await manualJd(s);
  const first = secretKey();
  const second = secretKey();
  await accepted(await s.put(row.id, { credential: first }), 'credential');
  s.f.clock.advanceMs(DAY_MS);
  await accepted(await s.put(row.id, { credential: second }), 'credential');
  const rows = await credentials(s, row.id);
  expect(rows).toHaveLength(3);
  const current = rows.filter((r) => r.is_current);
  expect(current).toHaveLength(1);
  expect(decrypt(s, current[0]!.access_token_cipher, ACCESS_CONTEXT)).toBe(second);
  expect((await audits(s)).filter((a) => a.action === ACTIONS.credential)).toHaveLength(2);
  const account = await accountRow(s, row.id);
  expect(ms(account.auth_expires_at)).toBe(s.f.clock.now().getTime() + KEY_VALIDITY_DAYS * DAY_MS);
  expectNoSecrets([await audits(s), s.f.lines], [first, second]);
});
