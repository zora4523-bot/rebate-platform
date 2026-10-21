import { expect, it } from 'vitest';
import {
  createLinkOpenConversion,
  type JdPddIdentity,
} from '../../../../apps/api/src/modules/linking/application/link-open-conversion.ts';
import { conversionFixture, demoInput } from '../open-jdpdd/kit.ts';
import { withOpenReads } from '../../../../apps/api/src/modules/linking/application/link-open-reads.ts';
import { built } from './kit.ts';

async function fixture(platform: 'jd' | 'pdd') {
  const f = conversionFixture(platform);
  f.settings.set(`attr.click_code.${platform}`, true);
  const original = await demoInput(f);
  const input = {
    ...original,
    owner: { ...original.owner, link: { ...original.owner.link, lk: 'a1b2c3' as string | null } },
  };
  const service = await built(() => createLinkOpenConversion(f.options));
  const convert = async () => {
    f.convert.mockClear();
    await built(() => service.convert(input));
    expect(f.convert).toHaveBeenCalledTimes(1);
    return f.convert.mock.calls[0]![1] as JdPddIdentity;
  };
  return { ...f, input, convert, service };
}

function withCode(identity: JdPddIdentity, platform: 'jd' | 'pdd', code = 'a1b2c3') {
  if (platform === 'jd') {
    expect(identity.subUnionId).toBe(`n_demo0001_${code}`);
    expect(identity).not.toHaveProperty('custom_parameters');
  } else {
    expect(JSON.stringify(identity.custom_parameters)).toBe(
      `{"app":"n","uid":"demo0001","sc":"self_buy","lk":"${code}"}`,
    );
    expect(
      Buffer.byteLength(JSON.stringify(identity.custom_parameters), 'utf8'),
    ).toBeLessThanOrEqual(64);
    expect(identity).not.toHaveProperty('subUnionId');
  }
}

it.each(['jd', 'pdd'] as const)(
  '[AC-B1-08s#16] %s 只注入本次 owner.link 的 lk，不再打未实现告警',
  async (platform) => {
    const f = await fixture(platform);
    withCode(await f.convert(), platform);
    f.input.owner.link.lk = 'z9y8x7';
    withCode(await f.convert(), platform, 'z9y8x7');
    expect(f.warn).not.toHaveBeenCalled();
  },
);

it.each(['jd', 'pdd'] as const)(
  '[AC-B1-08s#28] %s 事务内注入只用 prepare 预读的开关，不另占连接',
  async (platform) => {
    const f = await fixture(platform);
    const input = f.input;
    await built(() =>
      withOpenReads(
        async () => {
          await f.service.prepare({
            appId: input.owner.link.app_id,
            platform,
            callerUserId: input.owner.link.user_id,
            identities: [
              { userId: input.owner.link.user_id, pidScene: 'self_buy', noRebate: false },
            ],
          });
          f.options.config.configValue = async () => {
            throw new Error('second pooled read forbidden');
          };
        },
        async () => {
          withCode(await f.convert(), platform);
        },
      ),
    );
    expect(f.warn).not.toHaveBeenCalled();
  },
);

it.each(['jd', 'pdd'] as const)(
  '[AC-B1-08s#17] %s 开关即时关闭或非 JSON true、或 lk NULL，逐字节保持旧身份',
  async (platform) => {
    const f = await fixture(platform);
    // Positive control makes the missing feature fail before its negative boundary cases.
    withCode(await f.convert(), platform);
    for (const value of [false, 'on', 'true', 1, undefined]) {
      if (value === undefined) f.settings.delete(`attr.click_code.${platform}`);
      else f.settings.set(`attr.click_code.${platform}`, value);
      const identity = await f.convert();
      if (platform === 'jd') expect(identity.subUnionId).toBe('n_demo0001');
      else
        expect(JSON.stringify(identity.custom_parameters)).toBe(
          '{"app":"n","uid":"demo0001","sc":"self_buy"}',
        );
    }
    f.settings.set(`attr.click_code.${platform}`, true);
    f.input.owner.link.lk = null;
    const identity = await f.convert();
    if (platform === 'jd') expect(identity.subUnionId).toBe('n_demo0001');
    else
      expect(JSON.stringify(identity.custom_parameters)).toBe(
        '{"app":"n","uid":"demo0001","sc":"self_buy"}',
      );
  },
);

it.each(['jd', 'pdd'] as const)(
  '[AC-B1-08s#18] %s 开关与存量 lk 都存在时 no_rebate 不下发任何用户归因参数',
  async (platform) => {
    const f = await fixture(platform);
    withCode(await f.convert(), platform);
    f.input.noRebate = true;
    f.attrCode.mockClear();
    const identity = await f.convert();
    expect(identity).not.toHaveProperty('subUnionId');
    if (platform === 'pdd')
      expect(JSON.stringify(identity.custom_parameters)).toBe('{"app":"n","sc":"self_buy"}');
    else expect(identity).not.toHaveProperty('custom_parameters');
    expect(f.attrCode).not.toHaveBeenCalled();
  },
);
