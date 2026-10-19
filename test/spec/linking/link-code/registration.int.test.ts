import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { createLinkRegistration } from '../../../../apps/api/src/modules/linking/index.ts';
import { caller } from '../register/kit.ts';
import { built, capture, codeDb, databaseFixture, registration, row } from './kit.ts';

const database = databaseFixture(createTestDatabase);

it.each(['jd', 'pdd'] as const)(
  '[AC-B1-08s#5] %s 登记从注入随机源发号、持久化；缺省发号也是六位 base36',
  async (platform) => {
    const db = await codeDb(database());
    const f = registration(database(), platform);
    f.linkCode.mockReturnValue(platform === 'jd' ? '00000a' : 'zzzzz9');
    const first = await built(f.register);
    expect((await row(db, first.linkId)).lk).toBe(platform === 'jd' ? '00000a' : 'zzzzz9');
    expect(f.linkCode).toHaveBeenCalledTimes(1);
    expect(f.configValue).toHaveBeenCalledWith('register-app', `attr.click_code.${platform}`);
    const { linkCode: _draw, ...defaults } = f.options;
    void _draw;
    const second = await built(() => createLinkRegistration(defaults).register(f.request));
    expect((await row(db, second.linkId)).lk).toMatch(/^[0-9a-z]{6}$/);
  },
);

it.each(['jd', 'pdd'] as const)(
  '[AC-B1-08s#6] %s 开关只认 JSON true，关闭时不抽号、不补发旧行',
  async (platform) => {
    const db = await codeDb(database());
    const f = registration(database(), platform);
    for (const value of ['on', 'true', 1, false, null, undefined]) {
      if (value === undefined) f.settings.delete(`attr.click_code.${platform}`);
      else f.settings.set(`attr.click_code.${platform}`, value);
      const link = await built(f.register);
      expect((await row(db, link.linkId)).lk).toBeNull();
      expect(f.linkCode).not.toHaveBeenCalled();
    }
  },
);

it('[AC-B1-08s#7] 游客和淘宝即使开关 true 也不发号，其他平台开关不能打开京东', async () => {
  const db = await codeDb(database());
  const guest = registration(database());
  guest.options.callerContext.current = async () => caller({ userId: null });
  const tb = registration(database(), 'taobao');
  const other = registration(database());
  other.settings.delete('attr.click_code.jd');
  other.settings.set('attr.click_code.pdd', true);
  for (const f of [guest, tb, other]) {
    const result = await built(f.register);
    expect((await row(db, result.linkId)).lk).toBeNull();
    expect(f.linkCode).not.toHaveBeenCalled();
  }
});

it('[AC-B1-08s#8] 读取 click_code 配置失败原样抛出，不登记、不悄悄转成关闭', async () => {
  const db = await codeDb(database());
  const f = registration(database());
  const fault = new Error('synthetic settings unavailable');
  f.configValue.mockRejectedValue(fault);
  expect(await capture(f.register)).toEqual({ ok: false, error: fault });
  expect(f.linkCode).not.toHaveBeenCalled();
  expect(
    await db
      .selectFrom('links')
      .select('link_id')
      .where('product_key', '=', f.request.ref.productKey)
      .execute(),
  ).toEqual([]);
});
