// B1-22d / BR-ID-24 ③ and 细则「后台告警手机号与重新授权会话」(D10-152, D10-159, D10-176),
// SPEC_REF 48e55e6: start, poll and the console callback of a station-owner OAuth renewal.
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import {
  ACCESS_CONTEXT,
  ACTIONS,
  DAY_MS,
  OAUTH_ESTIMATE_DAYS,
  REASON,
  REFRESH_CONTEXT,
  SESSION_TTL_MS,
  accepted,
  accountRow,
  audits,
  called,
  credentials,
  daysCode,
  decrypt,
  expectNoSecrets,
  fakeAccess,
  fakeRefresh,
  listed,
  ms,
  okCode,
  polled,
  rejected,
  seedAccount,
  seedCredential,
  sessionRow,
  sessions,
  setJdMode,
  setup,
  sha256,
  signIn,
  snapshot,
  started,
  type ReauthResult,
  type Scenario,
} from './kit.ts';

const h = useHarness();

/** A taobao account expired by a failed probe, with a current credential. */
async function expiredTaobao(s: Scenario) {
  const row = await seedAccount(s, {
    platform: 'taobao',
    auth_status: 'expired',
    auth_expires_at: new Date('2026-12-30T00:00:00.000Z'),
    alert_stage: 'expired',
    last_probe_ok: false,
    last_probe_error: 'synthetic-auth-invalid',
  });
  await seedCredential(s, row.id, 'fixture-old-site-token');
  return row;
}

it('[B1-22d][BR-ID-24 ③] 发起新建一个 pending 会话：state 只存哈希、10 分钟有效，写发起审计，账号与凭据不动', async () => {
  const s = await setup(h);
  const row = await expiredTaobao(s);
  const before = await snapshot(s);
  const session = await started(s, row.id, { reason: REASON });
  const now = s.f.clock.now();

  expect(new URL(session.auth_url).protocol).toBe('https:');
  expect(ms(session.expires_at)).toBe(now.getTime() + SESSION_TTL_MS);
  const stored = await sessionRow(s, session.session_id);
  expect(stored).toMatchObject({
    app_id: s.appId,
    union_account_id: row.id,
    created_by: s.a.id,
    status: 'pending',
    used_at: null,
    error: null,
    finished_at: null,
  });
  expect(Buffer.from(stored.state_hash).equals(sha256(session.state))).toBe(true);
  expect(ms(stored.created_at)).toBe(now.getTime());
  expect(ms(stored.expires_at)).toBe(now.getTime() + SESSION_TTL_MS);
  expectNoSecrets(await sessions(s), [session.state]);

  const after = await snapshot(s);
  expect(after.accounts).toEqual(before.accounts);
  expect(after.credentials).toEqual(before.credentials);
  expect(after.audits).toHaveLength(1);
  expect(after.audits[0]).toMatchObject({
    app_id: s.appId,
    admin_id: s.a.id,
    action: ACTIONS.start,
  });
  expect(ms(after.audits[0]!.at)).toBe(now.getTime());
  expect(after.audits[0]!.target).toContain(row.id);
  expect(after.audits[0]!.after).toMatchObject({ reason: REASON });
  expectNoSecrets(after.audits, [session.state, session.auth_url]);
});

it('[B1-22d][BR-ID-24 细则] 可以提前重新授权：空请求体也行，每次发起各建一个会话，旧会话留着到期', async () => {
  const s = await setup(h);
  const row = await seedAccount(s, { platform: 'taobao' });
  const first = await started(s, row.id, {});
  const second = await started(s, row.id);
  expect(second.session_id).not.toBe(first.session_id);
  expect(second.state).not.toBe(first.state);
  const rows = await sessions(s);
  expect(rows.map((r) => [r.id, r.status])).toEqual([
    [first.session_id, 'pending'],
    [second.session_id, 'pending'],
  ]);
  expect((await audits(s)).map((a) => a.action)).toEqual([ACTIONS.start, ACTIONS.start]);
});

it('[B1-22d][BR-ID-24 细则] 原因选填，给了必须 1–200 字；不合格为 20001 [reason]，什么都不写', async () => {
  const s = await setup(h);
  const row = await seedAccount(s, { platform: 'taobao' });
  const before = await snapshot(s);
  for (const reason of ['', 'x'.repeat(201), 42]) {
    await rejected(await s.start(row.id, { reason }), 'start', 20001, { fields: ['reason'] });
    expect(await snapshot(s)).toEqual(before);
  }
  await started(s, row.id, { reason: '续'.repeat(200) });
  expect(await sessions(s)).toHaveLength(1);
});

it('[B1-22d][D10-159][D10-176] 非 oauth 账号不能发起：none 为 20001 [union_account_id]，manual 另带 reason=manual_mode', async () => {
  const none = await setup(h);
  const pdd = await seedAccount(none, { platform: 'pdd', auth_expires_at: null });
  const jdNone = await seedAccount(none, { platform: 'jd', auth_expires_at: null });
  const before = await snapshot(none);
  for (const id of [pdd.id, jdNone.id, randomUUID()]) {
    await rejected(await none.start(id, {}), 'start', 20001, { fields: ['union_account_id'] });
  }
  expect(await snapshot(none)).toEqual(before);

  const manual = await setup(h);
  await setJdMode(manual, 'private_position');
  const jd = await seedAccount(manual, { platform: 'jd' });
  const unchanged = await snapshot(manual);
  await rejected(await manual.start(jd.id, { reason: REASON }), 'start', 20001, {
    fields: ['union_account_id'],
    reason: 'manual_mode',
  });
  expect(await snapshot(manual)).toEqual(unchanged);
});

it('[B1-22d][BR-ID-24 细则] 会话结果：刚发起为 pending；未知会话、别的账号的会话、未知账号分别 20001', async () => {
  const s = await setup(h);
  const row = await seedAccount(s, { platform: 'taobao' });
  const sibling = await seedAccount(s, { platform: 'taobao' });
  const session = await started(s, row.id);
  const pending = await polled(s, row.id, session.session_id);
  expect(pending).toEqual({
    session_id: session.session_id,
    union_account_id: row.id,
    status: 'pending',
    error: null,
    expires_at: pending.expires_at,
    finished_at: null,
  });
  expect(ms(pending.expires_at)).toBe(ms(session.expires_at));

  await rejected(await s.result(row.id, randomUUID()), 'result', 20001, {
    fields: ['session_id'],
  });
  await rejected(await s.result(sibling.id, session.session_id), 'result', 20001, {
    fields: ['session_id'],
  });
  await rejected(await s.result(randomUUID(), session.session_id), 'result', 20001, {
    fields: ['union_account_id'],
  });
});

it('[B1-22d][BR-ID-24 细则] 10 分钟内没有回调的会话轮询时变 expired，之后的回调照原样答 expired、不换授权', async () => {
  const s = await setup(h);
  const row = await expiredTaobao(s);
  const session = await started(s, row.id);
  const before = await snapshot(s);
  s.f.clock.advanceMs(SESSION_TTL_MS);
  const expired = await polled(s, row.id, session.session_id);
  expect(expired.status).toBe('expired');
  expect(expired.error).toBeNull();
  expect(ms(expired.finished_at)).toBe(s.f.clock.now().getTime());
  expect((await sessionRow(s, session.session_id)).status).toBe('expired');

  expect(await called(s, { state: session.state, code: okCode('too-late') })).toEqual(expired);
  const after = await snapshot(s);
  expect(after.accounts).toEqual(before.accounts);
  expect(after.credentials).toEqual(before.credentials);
  expect(after.audits).toEqual(before.audits);
});

it('[B1-22d][BR-ID-24 细则] 过期后直接回调（未轮询）也答 expired，不换授权', async () => {
  const s = await setup(h);
  const row = await expiredTaobao(s);
  const session = await started(s, row.id);
  const before = await snapshot(s);
  s.f.clock.advanceMs(SESSION_TTL_MS + 1);
  const answer = await called(s, { state: session.state, code: okCode('late') });
  expect(answer).toMatchObject({
    session_id: session.session_id,
    union_account_id: row.id,
    status: 'expired',
  });
  expect(ms(answer.finished_at)).toBe(s.f.clock.now().getTime());
  const after = await snapshot(s);
  expect(after.credentials).toEqual(before.credentials);
  expect(after.accounts).toEqual(before.accounts);
});

it('[B1-22d][BR-ID-24 ③] 回调成功：凭据加密轮换，到期按授权时刻 + 90 天估算，续期人是发起人，写审计，结果与轮询一致', async () => {
  const s = await setup(h);
  const row = await expiredTaobao(s);
  const session = await started(s, row.id, { reason: REASON });
  s.f.clock.advanceMs(90_000);
  const now = s.f.clock.now().getTime();
  const done = await called(s, { state: session.state, code: okCode('renewed') });
  expect(done).toEqual({
    session_id: session.session_id,
    union_account_id: row.id,
    status: 'succeeded',
    error: null,
    expires_at: done.expires_at,
    finished_at: done.finished_at,
  });
  expect(ms(done.expires_at)).toBe(ms(session.expires_at));
  expect(ms(done.finished_at)).toBe(now);
  expect(await polled(s, row.id, session.session_id)).toEqual(done);

  const account = await accountRow(s, row.id);
  const expiry = now + OAUTH_ESTIMATE_DAYS * DAY_MS;
  expect(ms(account.auth_expires_at)).toBe(expiry);
  expect(account).toMatchObject({
    auth_expires_estimated: true,
    auth_status: 'active',
    alert_stage: 'none',
    auth_renewed_by: s.a.id,
  });
  expect(ms(account.auth_renewed_at)).toBe(now);

  const rows = await credentials(s, row.id);
  expect(rows).toHaveLength(2);
  expect(rows.filter((r) => r.is_current)).toHaveLength(1);
  const current = rows.find((r) => r.is_current)!;
  expect(decrypt(s, current.access_token_cipher, ACCESS_CONTEXT)).toBe(fakeAccess('renewed'));
  expect(decrypt(s, current.refresh_token_cipher, REFRESH_CONTEXT)).toBe(fakeRefresh('renewed'));
  expect(ms(current.expires_at)).toBe(expiry);
  const old = rows.find((r) => !r.is_current)!;
  expect(decrypt(s, old.access_token_cipher, ACCESS_CONTEXT)).toBe('fixture-old-site-token');

  const renewed = (await audits(s)).filter((a) => a.action === ACTIONS.renewed);
  expect(renewed).toHaveLength(1);
  expect(renewed[0]).toMatchObject({ app_id: s.appId, admin_id: s.a.id });
  expect(renewed[0]!.target).toContain(row.id);
  expect(ms(renewed[0]!.at)).toBe(now);

  const listedRow = (await listed(s)).find((item) => item.union_account_id === row.id)!;
  expect(listedRow).toMatchObject({
    auth_expires_estimated: true,
    auth_status: 'active',
    auth_renewed_by: s.a.id,
    reauth_mode: 'oauth',
  });
  expect(ms(listedRow.auth_expires_at)).toBe(expiry);
});

it('[B1-22d][BR-ID-24 ③] 联盟给了到期时间就照它记，不标估算', async () => {
  const s = await setup(h);
  const row = await expiredTaobao(s);
  const session = await started(s, row.id);
  const now = s.f.clock.now().getTime();
  const done = await called(s, { state: session.state, code: daysCode(120, 'dated') });
  expect(done.status).toBe('succeeded');
  const account = await accountRow(s, row.id);
  expect(ms(account.auth_expires_at)).toBe(now + 120 * DAY_MS);
  expect(account.auth_expires_estimated).toBe(false);
  const listedRow = (await listed(s)).find((item) => item.union_account_id === row.id)!;
  expect(listedRow.auth_expires_estimated).toBe(false);
  expect(ms(listedRow.auth_expires_at)).toBe(now + 120 * DAY_MS);
});

it('[B1-22d][BR-ID-24 ③] 联盟回了 error：会话 failed 并记下原因，账号与凭据不变，不写续期审计', async () => {
  const s = await setup(h);
  const row = await expiredTaobao(s);
  const session = await started(s, row.id);
  const before = await snapshot(s);
  const failed = await called(s, { state: session.state, error: 'access_denied' });
  expect(failed).toMatchObject({
    session_id: session.session_id,
    union_account_id: row.id,
    status: 'failed',
    error: 'access_denied',
  });
  expect(ms(failed.finished_at)).toBe(s.f.clock.now().getTime());
  const after = await snapshot(s);
  expect(after.accounts).toEqual(before.accounts);
  expect(after.credentials).toEqual(before.credentials);
  expect(after.audits.filter((a) => a.action === ACTIONS.renewed)).toEqual([]);
  expect(await polled(s, row.id, session.session_id)).toEqual(failed);
});

it('[B1-22d][BR-ID-24 ③] 换授权失败：会话 failed，原因不含授权码与联盟错误原文，账号与凭据不变', async () => {
  const s = await setup(h);
  const row = await expiredTaobao(s);
  const session = await started(s, row.id);
  const before = await snapshot(s);
  const code = `fixture-rejected-grant-${randomUUID()}`;
  const response = await s.callback({ state: session.state, code });
  const failed = await accepted<ReauthResult>(response, 'callback');
  expect(failed.status).toBe('failed');
  expect(failed.error).toEqual(expect.any(String));
  expectNoSecrets([response.json(), await sessions(s), await audits(s), s.f.lines], [code]);
  const after = await snapshot(s);
  expect(after.accounts).toEqual(before.accounts);
  expect(after.credentials).toEqual(before.credentials);
});

it('[B1-22d][BR-ID-24 细则] state 单次使用：成功后再回调照原样答 succeeded，不再换授权、不再写审计', async () => {
  const s = await setup(h);
  const row = await expiredTaobao(s);
  const session = await started(s, row.id);
  const done = await called(s, { state: session.state, code: okCode('once') });
  expect(done.status).toBe('succeeded');
  const after = await snapshot(s);
  s.f.clock.advanceMs(30_000);
  for (const body of [
    { state: session.state, code: okCode('twice') },
    { state: session.state, error: 'access_denied' },
  ]) {
    expect(await called(s, body)).toEqual(done);
  }
  expect(await snapshot(s)).toEqual(after);
});

it('[B1-22d][D10-176] 回调请求体：code 与 error 恰好一个，否则 20001 [code]；state 缺失或未知为 20001 [state]', async () => {
  const s = await setup(h);
  const row = await expiredTaobao(s);
  const session = await started(s, row.id);
  const before = await snapshot(s);
  const cases: [unknown, string][] = [
    [{ state: session.state }, 'code'],
    [{ state: session.state, code: okCode('both'), error: 'access_denied' }, 'code'],
    [{ code: okCode('stateless') }, 'state'],
    [{ state: '', code: okCode('empty-state') }, 'state'],
    [{ state: `unknown-${randomUUID()}`, code: okCode('unknown') }, 'state'],
  ];
  for (const [body, field] of cases) {
    await rejected(await s.callback(body), 'callback', 20001, { fields: [field] });
    expect(await snapshot(s), JSON.stringify(body)).toEqual(before);
  }
  const done = await called(s, { state: session.state, code: okCode('valid') });
  expect(done.status).toBe('succeeded');
});

it('[B1-22d][D10-176] 别的后台账号拿不到这个会话：同 app 他人与别的 app 都是 20001 [state]，会话仍可由发起人完成', async () => {
  const s = await setup(h);
  const colleague = await signIn(h, s.f, s.appId);
  const stranger = await setup(h);
  const row = await expiredTaobao(s);
  const session = await started(s, row.id);
  const before = await snapshot(s);
  for (const admin of [colleague, stranger]) {
    await rejected(
      await admin.callback({ state: session.state, code: okCode('hijack') }),
      'callback',
      20001,
      { fields: ['state'] },
    );
  }
  expect(await snapshot(s)).toEqual(before);
  expect((await snapshot(stranger)).credentials).toEqual([]);
  const done = await called(s, { state: session.state, code: okCode('owner') });
  expect(done.status).toBe('succeeded');
  expect((await accountRow(s, row.id)).auth_renewed_by).toBe(s.a.id);
});

it('[B1-22d][BR-ID-24] 授权码、state、令牌不进响应（auth_url 除外）、日志、审计与会话表', async () => {
  const s = await setup(h);
  const row = await expiredTaobao(s);
  const session = await started(s, row.id, { reason: REASON });
  const label = `secret-${randomUUID()}`;
  const code = okCode(label);
  const responses = [
    await s.callback({ state: session.state, code }),
    await s.result(row.id, session.session_id),
    await s.list(),
  ];
  for (const response of responses) expect(response.statusCode).toBe(200);
  const secrets = [session.state, code, fakeAccess(label), fakeRefresh(label)];
  expectNoSecrets(
    responses.map((response) => response.json()),
    secrets,
  );
  expectNoSecrets(s.f.lines, secrets);
  expectNoSecrets(await audits(s), secrets);
  expectNoSecrets(await sessions(s), secrets);
  expectNoSecrets(await credentials(s), [fakeAccess(label), fakeRefresh(label)]);
});
