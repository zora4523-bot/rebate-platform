// B1-27i · who may download a wecom_session copy (08 BR-ID-40 细则「企业微信会话交付的下载」; contract
// adminDownloadUserDataExport; task §9 ①): both user.data_export and pii.reveal_phone (lacking
// either → 10403 admin_permission_denied, also after the first download has delivered the file),
// a valid totp step-up on every call (10003 tier totp; a token used by a successful download
// cannot be used again), and only the registrant — another
// holder of both points, a super admin, an unknown export_id, an in_app_sms request, a request of
// another user or another app all get the same 20001 [export_id]; an unknown user_id or one of
// another app is 20001 [user_id]. A refused call gives no link, puts no file and changes nothing.
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { seed } from '../../admin/accounts/kit.ts';
import { useHarness } from '../../admin/auth/kit.ts';
import {
  copy,
  copyRow,
  download,
  downloadAudits,
  expectOpens,
  granted,
  holder,
  member,
  refused,
  revoke,
  setup,
  stepUp,
  superAdmin,
  user,
  PERMISSION,
  PII,
} from './kit.ts';

const h = useHarness();

it.each([
  { case: '只有 user.data_export', permissions: [PERMISSION] },
  { case: '只有 pii.reveal_phone', permissions: [PII] },
  { case: '两项都没有', permissions: [] as string[] },
])(
  '[AC-B1-27i#5] 登记人缺任一权限点（$case）→ 10403 admin_permission_denied，不出链接、不改请求',
  async ({ permissions }) => {
    const s = await setup(h);
    const target = await user(s);
    const caller = await member(s, permissions);
    const { row } = await copy(s, target, caller.who.id);
    for (const body of [{}, { regenerate: true }]) {
      await refused(await download(s, target.id, row.id, { as: caller, body }), 10403, {
        reason: 'admin_permission_denied',
      });
    }
    expect(await copyRow(s, row.id)).toEqual(row);
    expect(s.put).not.toHaveBeenCalled();
  },
);

it.each([
  { case: 'pii.reveal_phone', lost: PII },
  { case: 'user.data_export', lost: PERMISSION },
])(
  '[AC-B1-27i#27] 第一次下载之后登记人失去 $case：之后的下载与 regenerate 都是 10403 admin_permission_denied，不出链接、不写下载审计、不换文件',
  async ({ lost }) => {
    const s = await setup(h);
    const target = await user(s);
    const registrant = await holder(s);
    const { row, entries } = await copy(s, target, registrant.who.id);
    const first = await granted(await download(s, target.id, row.id, { as: registrant }));
    expect(typeof first.password).toBe('string');
    const delivered = await copyRow(s, row.id);
    expect(delivered.status).toBe('delivered');
    const recorded = await downloadAudits(s);
    const puts = s.put.mock.calls.length;

    await revoke(s, registrant, lost);
    for (const body of [{}, { regenerate: true }]) {
      await refused(await download(s, target.id, row.id, { as: registrant, body }), 10403, {
        reason: 'admin_permission_denied',
      });
    }
    expect(await copyRow(s, row.id)).toEqual(delivered);
    expect(await downloadAudits(s)).toEqual(recorded);
    expect(s.put.mock.calls.length).toBe(puts);
    expectOpens(s, delivered.object_key, first.password!, entries);
  },
);

it('[AC-B1-27i#6]每次下载都要 totp 档二次验证：不带、无效或已被一次成功下载用掉的 X-Step-Up-Token → 10003 tier=totp', async () => {
  const s = await setup(h);
  const target = await user(s);
  const registrant = await holder(s);
  const { row } = await copy(s, target, registrant.who.id);
  for (const step of [null, 'not-a-valid-step-up-token']) {
    await refused(await download(s, target.id, row.id, { as: registrant, stepUp: step }), 10003, {
      tier: 'totp',
    });
  }
  expect(await copyRow(s, row.id)).toEqual(row);
  expect(s.put).not.toHaveBeenCalled();

  // The same registrant with a valid token gets the file (the refusals above were the step-up's).
  const token = await stepUp(s, registrant.who, registrant.token);
  const first = await granted(
    await download(s, target.id, row.id, { as: registrant, stepUp: token }),
  );
  expect(typeof first.password).toBe('string');
  const delivered = await copyRow(s, row.id);
  expect(delivered.status).toBe('delivered');
  for (const body of [{}, { regenerate: true }]) {
    await refused(
      await download(s, target.id, row.id, { as: registrant, stepUp: token, body }),
      10003,
      { tier: 'totp' },
    );
  }
  expect(await copyRow(s, row.id)).toEqual(delivered);
});

it('[AC-B1-27i#7] 只给登记人：别的同时持两项权限点的账号、超级管理员 → 20001 [export_id]，与 export_id 不存在时同样回答', async () => {
  const s = await setup(h);
  const target = await user(s);
  const registrant = await holder(s);
  const { row } = await copy(s, target, registrant.who.id);
  const unknown = await download(s, target.id, randomUUID(), { as: registrant });
  await refused(unknown, 20001, { fields: ['export_id'] });
  for (const caller of [await holder(s), await superAdmin(s)]) {
    for (const body of [{}, { regenerate: true }]) {
      const response = await download(s, target.id, row.id, { as: caller, body });
      await refused(response, 20001, { fields: ['export_id'] });
      expect(response.json()).toEqual(unknown.json());
    }
  }
  expect(await copyRow(s, row.id)).toEqual(row);
  expect(s.put).not.toHaveBeenCalled();
  // The registrant still can: the refusals above were about the caller.
  const data = await granted(await download(s, target.id, row.id, { as: registrant }));
  expect(typeof data.password).toBe('string');
});

it('[AC-B1-27i#8] in_app_sms 路径的请求、别的用户的请求、别的 app 的请求 → 20001 [export_id]；未知 user_id 与别的 app 的用户 → 20001 [user_id]', async () => {
  const s = await setup(h);
  const target = await user(s);
  const neighbour = await user(s);
  const registrant = await holder(s);
  const inApp = await copy(s, target, registrant.who.id, { delivery: 'in_app_sms' });
  const theirs = await copy(s, neighbour, registrant.who.id);
  const otherApp = `rg_${'d'.repeat(8)}${s.appId.slice(-8)}`;
  const foreign = await user(s, { appId: otherApp });
  const foreignAdmin = await seed(s.h, otherApp);
  const elsewhere = await copy(s, foreign, foreignAdmin.id);
  const seeded = [inApp.row, theirs.row, elsewhere.row];

  const unknown = await download(s, target.id, randomUUID(), { as: registrant });
  await refused(unknown, 20001, { fields: ['export_id'] });
  for (const exportId of seeded.map((row) => row.id)) {
    const response = await download(s, target.id, exportId, { as: registrant });
    await refused(response, 20001, { fields: ['export_id'] });
    expect(response.json()).toEqual(unknown.json());
  }
  for (const userId of [randomUUID(), foreign.id]) {
    for (const exportId of [elsewhere.row.id, randomUUID()]) {
      await refused(await download(s, userId, exportId, { as: registrant }), 20001, {
        fields: ['user_id'],
      });
    }
  }
  for (const row of seeded) expect(await copyRow(s, row.id)).toEqual(row);
  expect(s.put).not.toHaveBeenCalled();
});
