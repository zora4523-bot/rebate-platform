// B1-27i · the registrant's download of a wecom_session copy (08 BR-ID-40 细则「企业微信会话交付的下载」;
// contract adminDownloadUserDataExport; task §9 ② ③). The first call (ready, under the request's
// row lock) generates a one-time password, re-encrypts the sealed file with it into a new object
// key, returns the password only in that response and records the delivery (delivered); later calls
// sign a new link to the same file with password=null; regenerate=true re-encrypts a new file with a
// new password and voids the previous one, due_at / expires_at unchanged. Every link is signed anew,
// valid min(5 minutes, expires_at), with Cache-Control: no-store; every call that returns one writes
// one user_data_copy_download audit record (admin, user, request, regenerate) before answering (a
// failing audit write gives no link and changes nothing), and the first call's delivery is
// recorded apart from later calls. The password and the link are never in an audit record, a log
// line or the database.
import { expect, it } from 'vitest';
import { useHarness, type Response } from '../../admin/auth/kit.ts';
import {
  allAudits,
  auditsSince,
  copy,
  copyRow,
  download,
  downloadAudits,
  expectDeliveryRecorded,
  expectLinkTo,
  expectOpens,
  expectRefusesPassword,
  expectRegenerateRecorded,
  granted,
  holder,
  holdRow,
  lockWaiters,
  ms,
  rowText,
  setup,
  signatureOf,
  stepUp,
  stored,
  user,
  DAY_MS,
  DOWNLOAD_ACTION,
  LINK_MS,
  MINUTE_MS,
  type Download,
} from './kit.ts';
import { validate } from './schema.ts';

const h = useHarness();

it('[AC-B1-27i#13] 第一次下载：生成口令（只在本次响应）、用它加密出新对象键上的交付文件、记交付；链接 5 分钟、no-store', async () => {
  const s = await setup(h);
  const target = await user(s);
  const registrant = await holder(s);
  const { row, entries } = await copy(s, target, registrant.who.id);
  const token = await stepUp(s, registrant.who, registrant.token);
  const now = s.clock.now().getTime();

  const data = await granted(
    await download(s, target.id, row.id, { as: registrant, stepUp: token }),
  );
  expect(typeof data.password, '第一次下载必须返回口令').toBe('string');
  expect(data.status).toBe('delivered');
  expect(ms(data.expires_at)).toBe(row.expires_at!.getTime());
  expect(ms(data.url_expires_at)).toBe(now + LINK_MS);

  const after = await copyRow(s, row.id);
  expect(after).toMatchObject({
    id: row.id,
    delivery: 'wecom_session',
    status: 'delivered',
    requested_by: registrant.who.id,
  });
  expect(ms(after.delivered_at)).toBe(now);
  expect(ms(after.generated_at)).toBe(ms(row.generated_at));
  expect(ms(after.expires_at)).toBe(ms(row.expires_at));
  expect(ms(after.due_at)).toBe(ms(row.due_at));
  expect(after.object_key, '交付文件写到新的对象键').not.toBe(row.object_key);

  expectLinkTo(s, data.url, after.object_key);
  expect(s.store.verify(data.url, new Date(now + LINK_MS)), '链接到 url_expires_at 失效').toBe(
    false,
  );
  expectOpens(s, after.object_key, data.password!, entries);
  expectRefusesPassword(s, after.object_key, `${data.password!}X`);
});

it('[AC-B1-27i#14] 之后的下载：password=null、同一个文件、每次现签新链接；状态与交付时刻不变', async () => {
  const s = await setup(h);
  const target = await user(s);
  const registrant = await holder(s);
  const { row, entries } = await copy(s, target, registrant.who.id);
  const first = await granted(await download(s, target.id, row.id, { as: registrant }));
  const delivered = await copyRow(s, row.id);
  const bytes = Buffer.from(s.store.get(delivered.object_key!)!.bytes);
  const puts = s.put.mock.calls.length;

  for (let call = 0; call < 2; call += 1) {
    const token = await stepUp(s, registrant.who, registrant.token);
    const now = s.clock.now().getTime();
    const later = await granted(
      await download(s, target.id, row.id, { as: registrant, stepUp: token }),
    );
    expect(later.password).toBeNull();
    expect(later.status).toBe('delivered');
    expect(later.url).not.toBe(first.url);
    expect(ms(later.url_expires_at)).toBe(now + LINK_MS);
    expectLinkTo(s, later.url, delivered.object_key);
  }
  expect(await copyRow(s, row.id)).toMatchObject({
    status: 'delivered',
    object_key: delivered.object_key,
    delivered_at: delivered.delivered_at,
    expires_at: delivered.expires_at,
  });
  expect(s.put.mock.calls.length, '之后的下载不再生成文件').toBe(puts);
  expect(Buffer.from(s.store.get(delivered.object_key!)!.bytes).equals(bytes)).toBe(true);
  expectOpens(s, delivered.object_key, first.password!, entries);
});

it('[AC-B1-27i#15] 链接有效期 min(5 分钟, expires_at)：剩不到 5 分钟时第一次与之后的链接都截到 expires_at', async () => {
  const s = await setup(h);
  const target = await user(s);
  const registrant = await holder(s);
  const token = await stepUp(s, registrant.who, registrant.token);
  const expiresAt = new Date(s.clock.now().getTime() + 3 * MINUTE_MS);
  const { row } = await copy(s, target, registrant.who.id, {
    generatedAt: new Date(expiresAt.getTime() - DAY_MS),
    expiresAt,
  });
  const first = await granted(
    await download(s, target.id, row.id, { as: registrant, stepUp: token }),
  );
  expect(typeof first.password).toBe('string');
  expect(ms(first.url_expires_at)).toBe(expiresAt.getTime());
  const later = await granted(await download(s, target.id, row.id, { as: registrant }));
  expect(later.password).toBeNull();
  expect(ms(later.url_expires_at)).toBe(expiresAt.getTime());
  for (const link of [first, later]) {
    expect(s.store.verify(link.url, new Date(expiresAt.getTime() - 1))).toBe(true);
    expect(s.store.verify(link.url, expiresAt)).toBe(false);
  }
});

it('[AC-B1-27i#16] regenerate：新口令加密出新文件、原文件作废，截止时刻与过期时刻不变；之后的下载指向新文件', async () => {
  const s = await setup(h);
  const target = await user(s);
  const registrant = await holder(s);
  const { row, entries } = await copy(s, target, registrant.who.id);
  const first = await granted(await download(s, target.id, row.id, { as: registrant }));
  const before = await copyRow(s, row.id);

  const regenerated = await granted(
    await download(s, target.id, row.id, { as: registrant, body: { regenerate: true } }),
  );
  expect(typeof regenerated.password, 'regenerate 必须返回新口令').toBe('string');
  expect(regenerated.password).not.toBe(first.password);
  expect(regenerated.status).toBe('delivered');
  expect(ms(regenerated.expires_at)).toBe(ms(row.expires_at));

  const after = await copyRow(s, row.id);
  expect(after.status).toBe('delivered');
  expect(after.object_key).not.toBe(before.object_key);
  expect(s.store.get(before.object_key!), '原文件作废').toBeUndefined();
  expect(ms(after.due_at)).toBe(ms(row.due_at));
  expect(ms(after.expires_at)).toBe(ms(row.expires_at));
  expectLinkTo(s, regenerated.url, after.object_key);
  expectOpens(s, after.object_key, regenerated.password!, entries);
  expectRefusesPassword(s, after.object_key, first.password!);

  const later = await granted(await download(s, target.id, row.id, { as: registrant }));
  expect(later.password).toBeNull();
  expectLinkTo(s, later.url, after.object_key);
});

it('[AC-B1-27i#17] 每次返回链接各写一条 user_data_copy_download 审计（登记人、用户、请求、regenerate），第一次另记企业微信会话交付；口令与链接不进审计、日志与库', async () => {
  const s = await setup(h);
  const target = await user(s);
  const registrant = await holder(s);
  const { row } = await copy(s, target, registrant.who.id);

  const start = await allAudits(s);
  const first = await granted(await download(s, target.id, row.id, { as: registrant }));
  const firstRows = await auditsSince(s, start);
  expect(firstRows.filter((entry) => entry.action === DOWNLOAD_ACTION)).toHaveLength(1);

  const middle = await allAudits(s);
  const second = await granted(await download(s, target.id, row.id, { as: registrant }));
  const secondRows = await auditsSince(s, middle);

  const late = await allAudits(s);
  const regenerated = await granted(
    await download(s, target.id, row.id, { as: registrant, body: { regenerate: true } }),
  );
  const regeneratedRows = await auditsSince(s, late);
  // The step from ready to delivered must be told apart from a re-signed link.
  expectDeliveryRecorded(registrant.who.id, row.id, firstRows, [secondRows, regeneratedRows]);

  const rows = await downloadAudits(s);
  expect(rows).toHaveLength(3);
  for (const entry of rows) {
    expect(entry).toMatchObject({
      app_id: s.appId,
      admin_id: registrant.who.id,
      action: DOWNLOAD_ACTION,
    });
    const text = rowText(entry);
    expect(text).toContain(target.id);
    expect(text).toContain(row.id);
  }
  expectRegenerateRecorded(rows, [false, false, true]);

  const everywhere = await stored(s, target);
  for (const link of [first, second, regenerated]) {
    expect(everywhere).not.toContain(link.url);
    expect(everywhere).not.toContain(signatureOf(link.url));
  }
  for (const password of [first.password, regenerated.password]) {
    expect(typeof password).toBe('string');
    expect(everywhere).not.toContain(password!);
  }
});

it('[AC-B1-27i#18] 两次第一次下载并发：两次都等在请求行的锁上，放开后只有一次生成口令与交付文件，另一次 password=null，两条链接指向同一个文件', async () => {
  const s = await setup(h);
  const target = await user(s);
  const registrant = await holder(s);
  const { row, entries } = await copy(s, target, registrant.who.id);
  const tokens = [
    await stepUp(s, registrant.who, registrant.token),
    await stepUp(s, registrant.who, registrant.token),
  ];
  // The test holds the row: neither call may read it as ready and go on before the other has
  // committed (a plain read would let both generate a password and the later write win).
  const held = await holdRow(s, row.id);
  const calls: Promise<Response>[] = [];
  try {
    for (const [index, token] of tokens.entries()) {
      calls.push(download(s, target.id, row.id, { as: registrant, stepUp: token }));
      await lockWaiters(s, held.pid, index + 1, calls);
    }
  } finally {
    await held.release();
  }
  const answers = await Promise.all(calls);
  const links: Download[] = [];
  for (const answer of answers) links.push(await granted(answer));
  const passwords = links.map((link) => link.password).filter((value) => value !== null);
  expect(passwords, '恰好一次生成口令').toHaveLength(1);
  expect(s.put, '恰好生成一个交付文件').toHaveBeenCalledTimes(1);

  const after = await copyRow(s, row.id);
  expect(after.status).toBe('delivered');
  for (const link of links) expectLinkTo(s, link.url, after.object_key);
  expectOpens(s, after.object_key, passwords[0]!, entries);
  expect(await downloadAudits(s)).toHaveLength(2);
});

it('[AC-B1-27i#28] 下载审计写不进去：5xx、不出链接与口令；第一次的请求仍为 ready，之后的下载与 regenerate 不换文件', async () => {
  const failing = { on: true };
  const db = h.db.withPlugin({
    transformQuery({ node }) {
      if (failing.on && node.kind !== 'SelectQueryNode') {
        const text = rowText(node);
        if (text.includes('audit_logs') && text.includes(DOWNLOAD_ACTION)) {
          throw new Error('synthetic audit write failure');
        }
      }
      return node;
    },
    async transformResult({ result }) {
      return result;
    },
  });
  const s = await setup({ ...h, db });
  const target = await user(s);
  const registrant = await holder(s);
  const { row, entries } = await copy(s, target, registrant.who.id);
  const noLink = async (response: Response) => {
    expect(response.statusCode, JSON.stringify(response.json())).toBeGreaterThanOrEqual(500);
    expect(response.json().code).not.toBe(0);
    expect(rowText(response.json())).not.toMatch(/"(url|password)"/);
    await validate(response, 'admin');
  };

  await noLink(await download(s, target.id, row.id, { as: registrant }));
  expect(await copyRow(s, row.id), '审计失败时不记交付').toEqual(row);
  expect(await downloadAudits(s)).toEqual([]);

  failing.on = false;
  const first = await granted(await download(s, target.id, row.id, { as: registrant }));
  expect(typeof first.password).toBe('string');
  const delivered = await copyRow(s, row.id);
  expect(delivered.status).toBe('delivered');

  failing.on = true;
  for (const body of [{}, { regenerate: true }]) {
    await noLink(await download(s, target.id, row.id, { as: registrant, body }));
  }
  expect(await copyRow(s, row.id)).toEqual(delivered);
  expectOpens(s, delivered.object_key, first.password!, entries);
  expect(await downloadAudits(s)).toHaveLength(1);
});
