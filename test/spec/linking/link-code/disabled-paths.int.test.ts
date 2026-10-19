import { createTestDatabase } from '@couli/db/testing';
import { expect, it, vi } from 'vitest';
import {
  createLinkConvert,
  createLinkOpenOwner,
  createTaobaoLinkOpen,
  type LinkingConfigReader,
} from '../../../../apps/api/src/modules/linking/index.ts';
import { fixture as convertFixture } from '../convert/kit.ts';
import { ownerFixture, sourceLink } from '../open-owner/kit.ts';
import { reprice } from '../open-requote/kit.ts';
import { setup } from '../open-taobao/kit.ts';
import { USER_B } from '../register/kit.ts';
import { built, codeDb, databaseFixture, row } from './kit.ts';

const database = databaseFixture(createTestDatabase);

function settings(
  base: LinkingConfigReader,
  platform: string,
  value: 'on' | 'true' | undefined,
): LinkingConfigReader {
  return {
    configValue: (appId, key) =>
      key === `attr.click_code.${platform}`
        ? Promise.resolve(value === undefined ? null : { value, version: 1 })
        : base.configValue(appId, key),
  };
}

it.each(['jd', 'pdd'] as const)(
  '[AC-B1-08s#31] %s owner 新登记在字符串开关或缺失时保持 NULL，不抽号也不继承原码',
  async (platform) => {
    const db = await codeDb(database());
    const original = await built(() => sourceLink(database(), { scene: 'detail' }, {}, platform));
    expect((await row(db, original.link_id)).lk).toMatch(/^[0-9a-z]{6}$/);
    for (const value of ['on', 'true', undefined] as const) {
      const f = ownerFixture(database(), { userId: USER_B });
      const linkCode = vi.fn(() => 'unused');
      const options = {
        ...f.options,
        linkCode,
        config: settings(f.options.config, platform, value),
      };
      const result = await built(() =>
        createLinkOpenOwner(options).open({ linkId: original.link_id }),
      );
      expect(result.new_link_id).toEqual(expect.any(String));
      expect((await row(db, result.new_link_id!)).lk).toBeNull();
      expect(linkCode).not.toHaveBeenCalled();
    }
  },
);

it.each(['jd', 'pdd'] as const)(
  '[AC-B1-08s#32] %s convert 与 pending 新登记同样严格判断开关；不抽号',
  async (platform) => {
    const db = await codeDb(database());
    for (const value of ['on', 'true', undefined] as const) {
      const c = await built(() => convertFixture(database(), platform));
      const linkCode = vi.fn(() => 'unused');
      const converted = await built(() =>
        createLinkConvert({
          ...c.options,
          ...{ linkCode },
          config: settings(c.options.config, platform, value),
        }).convert(c.request({ item_ref: c.issue() })),
      );
      expect(converted.envelope.code).toBe(0);
      const convertedId = (converted.envelope.data as { link_id: string }).link_id;
      expect((await row(db, convertedId)).lk).toBeNull();
      const f = await built(() => setup(database(), 'detail', platform));
      await f.bind('active');
      f.f.clock.advanceMs(1000);
      reprice(f.f, 3090n);
      const opened = await built(() =>
        createTaobaoLinkOpen({
          ...f.options,
          ...{ linkCode },
          config: settings(f.options.config, platform, value),
        }).open(f.request()),
      );
      expect(opened.envelope.code).toBe(0);
      const newId = (opened.envelope.data as { new_link_id: string }).new_link_id;
      expect(newId).toEqual(expect.any(String));
      expect((await row(db, newId)).lk).toBeNull();
      expect(linkCode).not.toHaveBeenCalled();
    }
  },
);
