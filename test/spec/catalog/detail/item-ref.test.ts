import { expect, it } from 'vitest';
import { APP_ID, PRODUCT_KEY, RAW_ID, fixture, item, productRef } from './kit.ts';

it.each([0, 1799, 1800])(
  '[AC-B1-05e#14] 有效 item_ref age=%s 秒原样返回且优先提供原串',
  async (age) => {
    const f = fixture();
    const itemRef = f.issue();
    f.clock.advanceMs(age * 1000);
    f.readProductRef.mockResolvedValue(productRef());
    const card = await f.get({ item_ref: itemRef });
    expect(card.item_ref).toBe(itemRef);
    expect(f.detail).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: APP_ID,
        productKey: PRODUCT_KEY,
        rawItemId: RAW_ID,
      }),
    );
    expect(f.rows).toHaveLength(1);
  },
);

it.each(['missing', 'malformed', 'tampered', 'foreign_app', 'expired'] as const)(
  '[AC-B1-05e#15] item_ref=%s 不报错，无有效存储引用时退回 product_key',
  async (kind) => {
    const f = fixture();
    let itemRef = f.issue();
    if (kind === 'malformed') itemRef = 'synthetic-invalid-ref';
    if (kind === 'tampered') {
      const index = Math.floor(itemRef.length / 2);
      itemRef =
        itemRef.slice(0, index) + (itemRef[index] === 'A' ? 'B' : 'A') + itemRef.slice(index + 1);
    }
    if (kind === 'foreign_app') {
      itemRef = f.issue({ appId: 'synthetic_other_app', productKey: 'tb:synthetic_other' });
    }
    if (kind === 'expired') f.clock.advanceMs(1_801_000);
    const card = await f.get(kind === 'missing' ? {} : { item_ref: itemRef });
    expect(card.product_key).toBe(PRODUCT_KEY);
    expect(card.item_ref).toEqual(expect.any(String));
    expect(card.item_ref).not.toBe(itemRef);
    expect(f.detail).toHaveBeenCalledWith(
      expect.objectContaining({ appId: APP_ID, productKey: PRODUCT_KEY }),
    );
    expect(f.detail.mock.calls[0]?.[0].rawItemId).toBeUndefined();
    expect(
      f.itemRefs.verify({ appId: APP_ID, productKey: PRODUCT_KEY, itemRef: card.item_ref }),
    ).toMatchObject({ rawItemId: RAW_ID });
  },
);

it('[AC-B1-05e#21] 原串中的空格和特殊字符不得清洗、转义或按稳定 ID 重建', async () => {
  const f = fixture();
  const raw = ' 000-synthetic+/% -synthetic001';
  const itemRef = f.issue({ rawItemId: raw });
  f.detail.mockResolvedValue(item({ item_id: raw }));
  const card = await f.get({ item_ref: itemRef });
  expect(card.item_ref).toBe(itemRef);
  expect(f.detail.mock.calls[0]?.[0].rawItemId).toBe(raw);
  expect(f.rows[0]?.ref.rawItemId).toBe(raw);
  expect(f.registerProductRef).toHaveBeenCalledWith(
    expect.objectContaining({ rawItemId: raw }),
    expect.anything(),
  );
});

it('[AC-B1-05e#16] 同 App 签名有效但 product_key 不匹配返回 20001，不读联盟', async () => {
  const f = fixture();
  const itemRef = f.issue({ productKey: 'tb:another_synthetic_product' });
  await expect(f.get({ item_ref: itemRef })).rejects.toMatchObject({ code: 20001 });
  expect(f.detail).not.toHaveBeenCalled();
  expect(f.rows).toEqual([]);
});

it.each([0, 1800, 1801])(
  '[AC-B1-05e#17] 无有效令牌时按 product_refs 的 %s 秒新鲜度选择原串',
  async (age) => {
    const f = fixture();
    const stored = productRef();
    f.readProductRef.mockResolvedValue(stored);
    f.clock.advanceMs(age * 1000);
    const card = await f.get({ item_ref: 'synthetic-invalid-ref' });
    expect(card.product_key).toBe(PRODUCT_KEY);
    expect(f.readProductRef).toHaveBeenCalledWith({
      appId: APP_ID,
      platform: 'taobao',
      productKey: PRODUCT_KEY,
    });
    expect(f.detail.mock.calls[0]?.[0].rawItemId).toBe(age <= 1800 ? stored.rawItemId : undefined);
  },
);
