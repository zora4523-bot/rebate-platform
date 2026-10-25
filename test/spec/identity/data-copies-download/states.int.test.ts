// B1-27i · which requests can be downloaded (08 BR-ID-40 细则「企业微信会话交付的下载」; contract
// adminDownloadUserDataExport; task §9 ②): only ready / delivered before expires_at. Any other
// status is 30417 with data.status; a ready / delivered request whose expires_at has come answers
// expired even though its status was not changed yet, and after expires_at nothing can be
// regenerated (30417 expired). A refused call gives no link and puts no file. The deletion cooling
// period does not stop delivery (BR-ID-40 细则「副本请求与注销状态」: 冷静期照常受理、照常交付).
import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import {
  copy,
  copyRow,
  deletion,
  download,
  expectLinkTo,
  expectOpens,
  granted,
  holder,
  ms,
  refused,
  setup,
  stepUp,
  user,
  DAY_MS,
  LINK_MS,
  MINUTE_MS,
  type CopyRow,
} from './kit.ts';

const h = useHarness();

/** The columns a refused download must leave as they were. */
const kept = (row: CopyRow) => ({
  object_key: row.object_key,
  delivered_at: row.delivered_at,
  expires_at: row.expires_at,
  due_at: row.due_at,
  requested_by: row.requested_by,
});

it.each(['pending', 'running', 'failed', 'expired', 'cancelled'] as const)(
  '[AC-B1-27i#9] 请求状态为 %s → 30417 data.status 为该状态（regenerate 同样），不出链接、不改请求',
  async (status) => {
    const s = await setup(h);
    const target = await user(s);
    const registrant = await holder(s);
    const { row } = await copy(s, target, registrant.who.id, { status });
    for (const body of [{}, { regenerate: true }]) {
      await refused(await download(s, target.id, row.id, { as: registrant, body }), 30417, {
        status,
      });
    }
    expect(await copyRow(s, row.id)).toEqual(row);
    expect(s.put).not.toHaveBeenCalled();
  },
);

it.each([
  { status: 'ready', offset: 0 },
  { status: 'ready', offset: -1 },
  { status: 'delivered', offset: 0 },
  { status: 'delivered', offset: -MINUTE_MS },
] as const)(
  '[AC-B1-27i#10] $status 且 expires_at 已到（距现在 $offset ms），服务端还没改状态 → 30417 data.status=expired',
  async ({ status, offset }) => {
    const s = await setup(h);
    const target = await user(s);
    const registrant = await holder(s);
    const tokens = [
      await stepUp(s, registrant.who, registrant.token),
      await stepUp(s, registrant.who, registrant.token),
    ];
    // The step-ups moved the clock: the instant is taken after them.
    const expiresAt = new Date(s.clock.now().getTime() + offset);
    const { row } = await copy(s, target, registrant.who.id, {
      status,
      generatedAt: new Date(expiresAt.getTime() - DAY_MS),
      expiresAt,
    });
    for (const [index, body] of [{}, { regenerate: true }].entries()) {
      await refused(
        await download(s, target.id, row.id, { as: registrant, stepUp: tokens[index]!, body }),
        30417,
        { status: 'expired' },
      );
    }
    expect(kept(await copyRow(s, row.id))).toEqual(kept(row));
    expect(s.put).not.toHaveBeenCalled();
  },
);

it('[AC-B1-27i#11] 离 expires_at 只剩 1 毫秒的 ready 请求照常下载，链接有效期截到 expires_at', async () => {
  const s = await setup(h);
  const target = await user(s);
  const registrant = await holder(s);
  const token = await stepUp(s, registrant.who, registrant.token);
  const expiresAt = new Date(s.clock.now().getTime() + 1);
  const { row } = await copy(s, target, registrant.who.id, {
    generatedAt: new Date(expiresAt.getTime() - DAY_MS),
    expiresAt,
  });
  const data = await granted(
    await download(s, target.id, row.id, { as: registrant, stepUp: token }),
  );
  expect(typeof data.password).toBe('string');
  expect(ms(data.url_expires_at)).toBe(expiresAt.getTime());
  expect(ms(data.expires_at)).toBe(expiresAt.getTime());
  expect((await copyRow(s, row.id)).status).toBe('delivered');
});

it('[AC-B1-27i#12] 已交付的请求过了 expires_at：再下载与 regenerate 都是 30417 expired，文件与口令不再换', async () => {
  const s = await setup(h);
  const target = await user(s);
  const registrant = await holder(s);
  const token = await stepUp(s, registrant.who, registrant.token);
  const expiresAt = new Date(s.clock.now().getTime() + 10 * MINUTE_MS);
  const { row } = await copy(s, target, registrant.who.id, {
    generatedAt: new Date(expiresAt.getTime() - DAY_MS),
    expiresAt,
  });
  const first = await granted(
    await download(s, target.id, row.id, { as: registrant, stepUp: token }),
  );
  expect(typeof first.password).toBe('string');
  const delivered = await copyRow(s, row.id);
  expect(delivered.status).toBe('delivered');
  const puts = s.put.mock.calls.length;

  s.clock.advanceMs(10 * MINUTE_MS);
  for (const body of [{ regenerate: true }, {}]) {
    await refused(await download(s, target.id, row.id, { as: registrant, body }), 30417, {
      status: 'expired',
    });
  }
  expect(kept(await copyRow(s, row.id))).toEqual(kept(delivered));
  expect(s.put.mock.calls.length).toBe(puts);
});

it('[AC-B1-27i#26] 用户在注销冷静期（cooling）：企业微信副本照常由登记人下载，第一次给口令与有效链接并记交付，之后照常重签', async () => {
  const s = await setup(h);
  const target = await user(s);
  await deletion(s, target, 'cooling');
  const registrant = await holder(s);
  const { row, entries } = await copy(s, target, registrant.who.id);
  const token = await stepUp(s, registrant.who, registrant.token);
  const now = s.clock.now().getTime();

  const first = await granted(
    await download(s, target.id, row.id, { as: registrant, stepUp: token }),
  );
  expect(typeof first.password, '冷静期照常交付，第一次下载给口令').toBe('string');
  expect(ms(first.url_expires_at)).toBe(now + LINK_MS);
  const after = await copyRow(s, row.id);
  expect(after.status).toBe('delivered');
  expect(ms(after.delivered_at)).toBe(now);
  expectLinkTo(s, first.url, after.object_key);
  expectOpens(s, after.object_key, first.password!, entries);

  const later = await granted(await download(s, target.id, row.id, { as: registrant }));
  expect(later.password).toBeNull();
  expectLinkTo(s, later.url, after.object_key);
});
