// B1-22r / orchestrator ruling D10-427 ①, SPEC_REF 37808a5: the optional reason of the
// station-owner re-authorization start (adminStartUnionReauthorization) and of the manual credential
// entry (adminPutUnionCredential) with a Unicode Cc control character is 20001 with
// data.fields=[reason]: no session, no credential, no account change, no audit row, and the union
// is not asked for an authorization address. Real admin HTTP (Fastify inject) + business-role PG
// through the B1-22d kit (the admin entry's local/test fake site OAuth).
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import {
  ACCESS_CONTEXT,
  ACTIONS,
  accepted,
  accountRow,
  audits,
  credentials,
  decrypt,
  expectNoSecrets,
  later,
  rejected,
  seedAccount,
  seedCredential,
  sessions,
  setJdMode,
  setup,
  snapshot,
  started,
  type Scenario,
  type UnionAccount,
} from '../admin-accounts/kit.ts';
import { NAMED_CONTROLS, VALID_REASONS, controlReasons, shown } from './kit.ts';

const h = useHarness();

/** A taobao (oauth) account expired by a failed probe, with a current credential. */
async function oauthAccount(s: Scenario) {
  const row = await seedAccount(s, {
    platform: 'taobao',
    auth_status: 'expired',
    alert_stage: 'expired',
    last_probe_ok: false,
    last_probe_error: 'synthetic-auth-invalid',
  });
  await seedCredential(s, row.id, 'fixture-old-site-token');
  return row;
}

/** A jd account in reauth_mode manual (attr.jd.user_key_mode = private_position). */
async function manualJd(s: Scenario) {
  await setJdMode(s, 'private_position');
  const row = await seedAccount(s, { platform: 'jd', auth_expires_estimated: true });
  await seedCredential(s, row.id, 'fixture-old-manual-key');
  return row;
}

const secretKey = () => `fixture-manual-key-${randomUUID()}`;

it('[B1-22r][D10-427 ①] 发起重新授权：reason 含 \\n \\t \\u0000 \\u007f → 20001 [reason]，不建会话、不写审计、不向联盟要授权地址', async () => {
  const s = await setup(h);
  const row = await oauthAccount(s);
  const before = await snapshot(s);
  for (const reason of controlReasons()) {
    const response = await s.start(row.id, { reason });
    await rejected(response, 'start', 20001, { fields: ['reason'] });
    expect(response.json()).not.toHaveProperty('data.auth_url');
    expect(await snapshot(s), shown(reason)).toEqual(before);
  }
  expect(await sessions(s)).toEqual([]);
});

it('[B1-22r][D10-427 ①] 发起重新授权：控制字符被拒之后，合法 reason（200 字、中文、空格）照常建会话并把原因记入审计', async () => {
  const s = await setup(h);
  const row = await oauthAccount(s);
  await rejected(await s.start(row.id, { reason: '续期\t' }), 'start', 20001, {
    fields: ['reason'],
  });
  expect(await sessions(s)).toEqual([]);
  for (const reason of VALID_REASONS) {
    const session = await started(s, row.id, { reason });
    expect(session.session_id, shown(reason)).toEqual(expect.any(String));
  }
  expect(await sessions(s)).toHaveLength(VALID_REASONS.length);
  const rows = (await audits(s)).filter((a) => a.action === ACTIONS.start);
  expect(rows).toHaveLength(VALID_REASONS.length);
  for (const [index, reason] of VALID_REASONS.entries()) {
    expect(rows[index]!.after, shown(reason)).toMatchObject({ reason });
  }
});

it('[B1-22r][D10-427 ①] manual 录入凭据：reason 含 \\n \\t \\u0000 \\u007f → 20001 [reason]，不存凭据、账号不变、不写审计，错误与日志不回显凭据', async () => {
  const s = await setup(h);
  const row = await manualJd(s);
  const before = await snapshot(s);
  const key = secretKey();
  const bodies: unknown[] = [];
  for (const reason of controlReasons()) {
    const response = await s.put(row.id, {
      credential: key,
      expires_at: later(s, 200).toISOString(),
      reason,
    });
    await rejected(response, 'credential', 20001, { fields: ['reason'] });
    bodies.push(response.json());
    expect(await snapshot(s), shown(reason)).toEqual(before);
  }
  expect(await credentials(s, row.id)).toHaveLength(1);
  expectNoSecrets([bodies, s.f.lines], [key]);
});

it('[B1-22r][D10-427 ①] manual 录入凭据：控制字符被拒之后，合法 reason 照常轮换凭据并把原因记入审计', async () => {
  const s = await setup(h);
  const row = await manualJd(s);
  for (const control of NAMED_CONTROLS) {
    await rejected(
      await s.put(row.id, { credential: secretKey(), reason: `更换 Key${control}` }),
      'credential',
      20001,
      { fields: ['reason'] },
    );
  }
  expect(await credentials(s, row.id)).toHaveLength(1);
  let last = '';
  for (const reason of VALID_REASONS) {
    last = secretKey();
    const data = await accepted<UnionAccount>(
      await s.put(row.id, { credential: last, reason }),
      'credential',
    );
    expect(data.reauth_mode, shown(reason)).toBe('manual');
  }
  const rows = await credentials(s, row.id);
  expect(rows).toHaveLength(1 + VALID_REASONS.length);
  const current = rows.filter((r) => r.is_current);
  expect(current).toHaveLength(1);
  expect(decrypt(s, current[0]!.access_token_cipher, ACCESS_CONTEXT)).toBe(last);
  const entries = (await audits(s)).filter((a) => a.action === ACTIONS.credential);
  expect(entries).toHaveLength(VALID_REASONS.length);
  for (const [index, reason] of VALID_REASONS.entries()) {
    expect(entries[index]!.after, shown(reason)).toMatchObject({ reason });
  }
  expect((await accountRow(s, row.id)).auth_renewed_by).toBe(s.a.id);
});
