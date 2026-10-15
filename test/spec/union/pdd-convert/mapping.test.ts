import { expect, it } from 'vitest';
import type {
  ConvertResult,
  PddAuthorityUrl,
} from '../../../../apps/api/src/modules/union/index.ts';
import {
  authorityReply,
  browser,
  convertReply,
  ctx,
  identity,
  mobile,
  mobileShort,
  req,
  schema,
  setup,
} from './kit.ts';

it('[AC-B1-04h-MAP#1] 主 URL 取 mobile_url，probe 附加字段逐一映射且不互相覆盖', async () => {
  const row = {
    mobile_url: mobile,
    mobile_short_url: mobileShort,
    schema_url: schema,
    tz_schema_url: 'pinduoduo://synthetic-tz',
    url: browser,
    short_url: 'https://synthetic-browser.invalid/short',
    we_app_web_view_url: 'https://synthetic-webview.invalid/landing',
    we_app_web_view_short_url: 'https://synthetic-webview.invalid/short',
  };
  const { adapter } = setup(convertReply(row));
  const result: ConvertResult = await adapter.convert(req, identity, ctx);
  expect(result).toEqual({
    kind: 'url',
    url: mobile,
    schema_url: schema,
    tz_schema_url: row.tz_schema_url,
    mobile_short_url: mobileShort,
    browser_url: browser,
    short_url: row.short_url,
    we_app_web_view_url: row.we_app_web_view_url,
    we_app_web_view_short_url: row.we_app_web_view_short_url,
  });
});

it('[AC-B1-04h-MAP#2] mobile_url 缺失时使用 mobile_short_url，仍不取 scheme 或浏览器链接', async () => {
  const { adapter } = setup(
    convertReply({ mobile_short_url: mobileShort, schema_url: schema, url: browser }),
  );
  await expect(adapter.convert(req, identity, ctx)).resolves.toMatchObject({
    kind: 'url',
    url: mobileShort,
  });
});

it('[AC-B1-04h-MAP#3] 可选字段缺失时仍可转链，不伪造 probe 外字段', async () => {
  const { adapter } = setup(convertReply());
  const result = await adapter.convert(req, identity, ctx);
  expect(result).toEqual({ kind: 'url', url: mobile });
  expect(result).not.toHaveProperty('we_app_info');
  expect(result).not.toHaveProperty('weixin_short_link');
});

// 任务允许在 upstream_unavailable / invalid_dto 中选定一个；这里统一要求前者：
// 上游成功信封未给出可用跳转地址，不把错误的响应算成调用者 DTO 错误。
it.each([
  { schema_url: schema, url: browser },
  { mobile_url: 'http://synthetic-mobile.invalid/plain' },
  { mobile_url: schema },
  { mobile_short_url: 'javascript:synthetic' },
])('[AC-B1-04h-MAP#4] 缺失或非 HTTPS 主地址拒绝：%j', async (row) => {
  const { adapter } = setup(convertReply(row));
  await expect(adapter.convert(req, identity, ctx)).rejects.toMatchObject({
    code: 'upstream_unavailable',
    platform: 'pdd',
  });
});

it.each([
  {},
  { goods_promotion_url_generate_response: {} },
  { goods_promotion_url_generate_response: { goods_promotion_url_list: [] } },
  { goods_promotion_url_generate_response: { goods_promotion_url_list: null } },
  { goods_promotion_url_generate_response: { goods_promotion_url_list: [null] } },
])('[AC-B1-04h-MAP#5] 缺失或损坏的转链信封报领域错误：%j', async (reply) => {
  const { adapter } = setup(reply);
  await expect(adapter.convert(req, identity, ctx)).rejects.toMatchObject({
    code: 'upstream_unavailable',
    platform: 'pdd',
  });
});

it.each([1, 0, 2, -1, '1', true, null, undefined])(
  '[AC-B1-04h-MAP#6] authority_query_response.bind 只有整数 1 才授权：%j',
  async (bind) => {
    const { adapter } = setup({ authority_query_response: { bind } });
    await expect(adapter.queryPddAuthority(identity, ctx)).resolves.toEqual({
      authorized: bind === 1,
    });
  },
);

it('[AC-B1-04h-MAP#7] 备案链接解包 rp 信封，分别支持 probe 的 scheme 与短链两种响应', async () => {
  const cases: { row: Record<string, unknown>; expected: PddAuthorityUrl }[] = [
    {
      row: { mobile_url: mobile, schema_url: schema, url: browser },
      expected: { url: mobile, schema_url: schema, browser_url: browser },
    },
    {
      row: {
        mobile_url: mobile,
        mobile_short_url: mobileShort,
        url: browser,
        short_url: 'https://synthetic-browser.invalid/short',
      },
      expected: {
        url: mobile,
        mobile_short_url: mobileShort,
        browser_url: browser,
        short_url: 'https://synthetic-browser.invalid/short',
      },
    },
  ];
  for (const { row, expected } of cases) {
    const { adapter } = setup(authorityReply(row));
    const result: PddAuthorityUrl = await adapter.pddAuthorityUrl(identity, ctx);
    expect(result).toEqual(expected);
    expect(adapter).not.toHaveProperty('bindPublisher');
  }
});

it.each([
  {},
  { rp_promotion_url_generate_response: { url_list: [] } },
  authorityReply({ schema_url: schema }),
  authorityReply({ mobile_url: 'http://synthetic-mobile.invalid/plain' }),
])('[AC-B1-04h-MAP#8] 备案链接没有可用 HTTPS 地址时不能伪造授权链接：%j', async (reply) => {
  const { adapter } = setup(reply);
  await expect(adapter.pddAuthorityUrl(identity, ctx)).rejects.toMatchObject({
    code: 'upstream_unavailable',
    platform: 'pdd',
  });
});

it('[AC-B1-04h-MAP#9] 未备案 50001/60001 是 upstream_rejected，错误保留 sub_code', async () => {
  const h = setup({ error_response: { error_code: 50001, sub_code: 60001 } });
  await expect(h.adapter.convert(req, identity, ctx)).rejects.toMatchObject({
    code: 'upstream_rejected',
    platform: 'pdd',
    message: expect.stringContaining('60001'),
  });
  expect(h.transport).toHaveBeenCalledTimes(1);
});
