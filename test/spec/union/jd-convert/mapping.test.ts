import { expect, it } from 'vitest';
import { response, unionFailure } from '../jd-core/kit.ts';
import { jsonText, num } from '../jd-orders/kit.ts';
import { clickUrl, ctx, identity, keys, reply, req, success, wire } from './kit.ts';

// 成功时内层 200，data.clickURL 是推广链接，data.jCommand 可有可无且不进结果。
const command = '合成口令文本';

const badClickUrls: readonly (readonly [string, unknown])[] = [
  ['空串', ''],
  ['null', null],
  ['数字', num('123')],
  ['布尔', true],
  ['对象', { url: clickUrl }],
  ['数组', [clickUrl]],
  ['ftp', 'ftp://union-click.jd.com/synth01'],
  ['javascript', 'javascript:synthetic'],
  ['App scheme', 'openapp.jdmobile://synthetic'],
  ['协议相对', '//union-click.jd.com/synth01'],
  ['无协议', 'union-click.jd.com/synth01'],
  ['前导空格', ` ${clickUrl}`],
];

const brokenInner: readonly (readonly [string, string])[] = [
  ['没有 data', jsonText({ code: num('200'), message: 'success' })],
  ['data 是 null', success(null)],
  ['data 是空对象', success({})],
  ['data 是字符串', success(clickUrl)],
  ['data 是数组', success([{ clickURL: clickUrl }])],
];

it('[AC-B1-04zd#21] 结果是 { kind: url, url: clickURL }：jCommand 不进结果，其他字段不外带', async () => {
  const h = wire(reply(success({ clickURL: clickUrl, jCommand: command, note: 'synthetic' })));
  await expect(h.adapter.convert(req, identity, ctx)).resolves.toEqual({
    kind: 'url',
    url: clickUrl,
  });
});

it('[AC-B1-04zd#22] 没有 jCommand 也能转链', async () => {
  const h = wire(reply(success({ clickURL: clickUrl })));
  await expect(h.adapter.convert(req, identity, ctx)).resolves.toEqual({
    kind: 'url',
    url: clickUrl,
  });
});

it('[AC-B1-04zd#23] http:// 的 clickURL 同样接受', async () => {
  const url = 'http://union-click.jd.com/synth01';
  const h = wire(reply(success({ clickURL: url })));
  await expect(h.adapter.convert(req, identity, ctx)).resolves.toEqual({ kind: 'url', url });
});

it.each(badClickUrls)(
  '[AC-B1-04zd#24] clickURL 是%s → upstream_unavailable，不回退原链接',
  async (_name, clickURL) => {
    const h = wire(reply(success({ clickURL, jCommand: command })));
    await unionFailure(() => h.adapter.convert(req, identity, ctx), 'upstream_unavailable');
    expect(h.transport).toHaveBeenCalledTimes(1);
  },
);

it('[AC-B1-04zd#25] 只有 jCommand 没有 clickURL → upstream_unavailable，不用口令顶替', async () => {
  const h = wire(reply(success({ jCommand: command })));
  await unionFailure(() => h.adapter.convert(req, identity, ctx), 'upstream_unavailable');
});

it.each(brokenInner)('[AC-B1-04zd#26] 内层 %s → upstream_unavailable', async (_name, text) => {
  const h = wire(reply(text));
  await unionFailure(() => h.adapter.convert(req, identity, ctx), 'upstream_unavailable');
});

it('[AC-B1-04zd#27] 结果键是 getResult：别的结果键 → upstream_unavailable', async () => {
  const h = wire(response({ [keys.envelope]: { code: '0', queryResult: success() } }));
  await unionFailure(() => h.adapter.convert(req, identity, ctx), 'upstream_unavailable');
});

it('[AC-B1-04zd#28] 外层键是 promotion.common.get 的：别的外层键 → upstream_unavailable', async () => {
  const goods = 'jd_union_open_goods_query_responce';
  const h = wire(response({ [goods]: { code: '0', [keys.resultKey]: success() } }));
  await unionFailure(() => h.adapter.convert(req, identity, ctx), 'upstream_unavailable');
});
