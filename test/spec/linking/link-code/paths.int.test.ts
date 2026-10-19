import { createTestDatabase } from '@couli/db/testing';
import { expect, it, vi } from 'vitest';
import {
  createLinkConvert,
  createLinkOpenOwner,
  createLinkRegistration,
  createTaobaoLinkOpen,
} from '../../../../apps/api/src/modules/linking/index.ts';
import type { JdPddIdentity } from '../../../../apps/api/src/modules/linking/application/link-open-conversion.ts';
import { fixture as convertFixture } from '../convert/kit.ts';
import { setup } from '../open-taobao/kit.ts';
import { reprice } from '../open-requote/kit.ts';
import { ownerFixture, sourceLink } from '../open-owner/kit.ts';
import { USER_A, USER_B } from '../register/kit.ts';
import { built, codeDb, databaseFixture, registration, row, type CodeOptions } from './kit.ts';

const database = databaseFixture(createTestDatabase);

it.each(['jd', 'pdd'] as const)(
  '[AC-B1-08s#19] %s 他人非分享和本人分享重新登记各自新 lk；不复制原码',
  async (platform) => {
    const db = await codeDb(database());
    for (const scene of ['detail', 'share'] as const) {
      const original = await built(() => sourceLink(database(), { scene }, {}, platform));
      const originalCode = (await row(db, original.link_id)).lk;
      expect(originalCode).toMatch(/^[0-9a-z]{6}$/);
      const f = ownerFixture(database(), { userId: scene === 'share' ? USER_A : USER_B });
      const expectedCode = `own${platform === 'jd' ? 'j' : 'p'}${scene === 'share' ? '01' : '02'}`;
      const linkCode = vi.fn(() => expectedCode);
      const options = { ...f.options, linkCode, logger: { error: vi.fn() } };
      const result = await built(() =>
        createLinkOpenOwner(options).open({ linkId: original.link_id }),
      );
      expect(result.new_link_id).not.toBeNull();
      expect((await row(db, result.new_link_id!)).lk).toBe(expectedCode);
      expect(linkCode).toHaveBeenCalledTimes(1);
      expect((await row(db, original.link_id)).lk).toBe(originalCode);
    }
  },
);

it.each(['jd', 'pdd'] as const)(
  '[AC-B1-08s#20] %s convert 新登记时发号并把同一个 lk 注入真实转链；幂等重放不重抽',
  async (platform) => {
    const db = await codeDb(database());
    const f = await built(() => convertFixture(database(), platform));
    f.f.config.set(`attr.click_code.${platform}`, true);
    const linkCode = vi.fn(() => 'conv01');
    const options = { ...f.options, linkCode, logger: { ...f.options.logger, error: vi.fn() } };
    const service = await built(() => createLinkConvert(options));
    const request = f.request({ item_ref: f.issue() });
    const result = await built(() => service.convert(request));
    expect(result.envelope.code).toBe(0);
    const data = result.envelope.data as { link_id: string };
    expect((await row(db, data.link_id)).lk).toBe('conv01');
    const identity = f.convert.mock.calls[0]![1] as JdPddIdentity;
    if (platform === 'jd') expect(identity.subUnionId).toBe('n_demo0001_conv01');
    else expect(identity.custom_parameters).toMatchObject({ lk: 'conv01' });
    expect(await built(() => service.convert(request))).toEqual(result);
    expect(linkCode).toHaveBeenCalledTimes(1);
    expect(f.convert).toHaveBeenCalledTimes(1);
  },
);

it.each(['jd', 'pdd'] as const)(
  '[AC-B1-08s#21] %s 改价 pending 新登记用新 lk、旧行 NULL 不补发；重放不再登记',
  async (platform) => {
    const db = await codeDb(database());
    const f = await built(() => setup(database(), 'detail', platform));
    await f.bind('active');
    expect((await row(db, f.row.link_id)).lk).toBeNull();
    f.f.config.set(`attr.click_code.${platform}`, true);
    f.f.clock.advanceMs(1000);
    reprice(f.f, 3090n);
    const linkCode = vi.fn(() => 'pend01');
    const options = { ...f.options, linkCode, logger: { ...f.options.logger, error: vi.fn() } };
    const service = await built(() => createTaobaoLinkOpen(options));
    const request = f.request();
    const result = await built(() => service.open(request));
    expect(result.envelope.code).toBe(0);
    const data = result.envelope.data as { new_link_id: string };
    expect(data.new_link_id).toEqual(expect.any(String));
    expect((await row(db, data.new_link_id)).lk).toBe('pend01');
    expect((await row(db, f.row.link_id)).lk).toBeNull();
    const identity = f.convert.mock.calls[0]![1] as JdPddIdentity;
    if (platform === 'jd') expect(identity.subUnionId).toBe('n_demo0001_pend01');
    else expect(identity.custom_parameters).toMatchObject({ lk: 'pend01' });
    expect(await built(() => service.open(request))).toEqual(result);
    expect(linkCode).toHaveBeenCalledTimes(1);
  },
);

it('[AC-B1-08s#22] 游客 link 被认领是 UPDATE，启用开关也不能补发 lk', async () => {
  const db = await codeDb(database());
  const f = registration(database());
  const options = {
    ...f.options,
    callerContext: {
      current: async () => ({ appId: 'register-app', userId: null, deviceId: null }),
    },
  };
  const old = await built(() => createLinkRegistration(options).register(f.request));
  const owner = ownerFixture(database(), { userId: USER_A });
  const patched: typeof owner.options & CodeOptions = { ...owner.options, linkCode: f.linkCode };
  await built(() => createLinkOpenOwner(patched).open({ linkId: old.linkId }));
  expect(await row(db, old.linkId)).toMatchObject({ user_id: USER_A, lk: null });
  expect(f.linkCode).not.toHaveBeenCalled();
});
