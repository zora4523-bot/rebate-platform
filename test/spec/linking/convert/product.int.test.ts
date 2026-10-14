import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { databaseFixture, fixture, service, success } from './kit.ts';

const database = databaseFixture(createTestDatabase);

it.each(['jd', 'pdd', 'taobao'] as const)(
  '[AC-B1-06i#1] %s 有效 item_ref：登记本人 H5 link、复核、convert 日志与同事务 attempt',
  async (platform) => {
    const f = await fixture(database(), platform);
    const itemRef = f.issue();
    const convert = service(f);
    const data = await success(await convert.convert(f.request({ item_ref: itemRef })), f);
    const [row] = await f.links();
    expect(row).toMatchObject({ product_key: f.ref.productKey, raw_item_id: f.ref.rawItemId });
    expect(f.verify).toHaveBeenCalledWith({
      itemRef,
      appId: f.appId,
      productKey: f.ref.productKey,
    });
    expect(f.raw).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: f.appId,
        productKey: f.ref.productKey,
        requestRef: expect.objectContaining({ source: 'item_ref', rawItemId: f.ref.rawItemId }),
      }),
    );
    expect(f.f.fetch).toHaveBeenCalled();
    expect(data).toMatchObject({ requote_failed: false, availability: 'ok' });
    if (platform === 'taobao') {
      expect(f.convert).not.toHaveBeenCalled();
      expect(data.jump.primary).toMatchObject({
        type: 'sdk',
        sdk: { provider: 'baichuan', open_by: 'code', item_id: f.ref.rawItemId },
      });
    } else {
      expect(f.convert).toHaveBeenCalledTimes(1);
      const identity = f.convert.mock.calls[0]![1];
      expect(identity.claims).toMatchObject({
        appId: f.appId,
        userId: 'demo0001',
        promotionSlot: 'mm_101_201_301',
      });
      expect(f.f.fetch.mock.invocationCallOrder[0]).toBeLessThan(
        f.convert.mock.invocationCallOrder[0]!,
      );
    }
    expect(JSON.stringify(await f.logs())).not.toContain(itemRef);
    expect(JSON.stringify(f.warn.mock.calls)).not.toContain(itemRef);
  },
  60_000,
);

it.each(['missing', 'invalid', 'undecryptable', 'foreign_app'] as const)(
  '[AC-B1-06i#2] item_ref %s 被忽略，从 product_refs 取原串，仍成功登记转链',
  async (kind) => {
    const f = await fixture(database());
    const cipher = f.issue({ rawItemId: 'synthetic-untrusted-raw' });
    const dot = cipher.lastIndexOf('.');
    const prefix = cipher.slice(0, dot);
    const bytes = Buffer.from(cipher.slice(dot + 1), 'base64url');
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
    const itemRef =
      kind === 'missing'
        ? undefined
        : kind === 'invalid'
          ? `${prefix}.${bytes.toString('base64url')}`
          : kind === 'undecryptable'
            ? 'synthetic-not-a-cipher'
            : f.issue({
                appId: 'synthetic_foreign',
                productKey: 'jd:i_foreign',
                rawItemId: 'synthetic-foreign-raw',
              });
    const convert = service(f);
    await success(
      await convert.convert(f.request(itemRef === undefined ? {} : { item_ref: itemRef })),
      f,
    );
    expect((await f.links())[0]!.raw_item_id).toBe(f.ref.rawItemId);
    expect(f.raw).toHaveBeenCalledWith(expect.objectContaining({ requestRef: null }));
    expect(f.convert).toHaveBeenCalledTimes(1);
  },
  60_000,
);

it('[AC-B1-06i#3] 同 app 签名有效但 product_key 不一致：20001，登记前拒绝', async () => {
  const f = await fixture(database());
  const convert = service(f);
  const result = await convert.convert(
    f.request({ item_ref: f.issue({ productKey: 'jd:i_other' }) }),
  );
  expect(result).toMatchObject({ status: 400, envelope: { code: 20001 } });
  expect(await f.links()).toEqual([]);
  expect(await f.attempts()).toEqual([]);
  expect(f.convert).not.toHaveBeenCalled();
  expect(f.urlParser.parseUrl).not.toHaveBeenCalled();
}, 60_000);

it('[AC-B1-06i#4] item_ref 原串优先于字典，用户归属仍取调用者', async () => {
  const f = await fixture(database(), 'taobao');
  const rawItemId = '00098765';
  const convert = service(f);
  const data = await success(
    await convert.convert(f.request({ item_ref: f.issue({ rawItemId }) })),
    f,
  );
  expect((await f.links())[0]).toMatchObject({ raw_item_id: rawItemId, user_id: f.a });
  expect(data.jump.primary).toMatchObject({ sdk: { item_id: rawItemId } });
  expect(f.getItem).toHaveBeenCalledWith(
    expect.objectContaining({ platform: 'taobao', item_id: rawItemId }),
    expect.anything(),
  );
}, 60_000);
