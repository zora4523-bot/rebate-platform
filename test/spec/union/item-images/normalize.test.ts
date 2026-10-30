import { expect, it } from 'vitest';
import { normalizeItemImages } from '../../../../apps/api/src/modules/union/domain/item-images.ts';
import { IMAGE_FIELDS, MAX_IMAGES, MAX_URL_LENGTH } from './kit.ts';

// 合成地址，不对应任何平台的图片服务。
const host = 'https://img.synthetic.invalid';
const url = (n: number): string => `${host}/goods/${String(n)}.jpg`;
/** A valid https URL of exactly `length` characters. */
function sized(length: number): string {
  const prefix = `${host}/p/`;
  return `${prefix}${'a'.repeat(length - prefix.length)}`;
}

const invalid: readonly [string, unknown][] = [
  ['http', 'http://img.synthetic.invalid/goods/1.jpg'],
  ['协议相对', '//img.synthetic.invalid/goods/1.jpg'],
  ['绝对路径', '/goods/1.jpg'],
  ['相对路径', 'goods/1.jpg'],
  ['data:', 'data:image/png;base64,iVBORw0KGgo='],
  ['javascript:', 'javascript:alert(1)'],
  ['ftp', 'ftp://img.synthetic.invalid/goods/1.jpg'],
  ['没有主机', 'https://'],
  ['少了 //', 'https:img.synthetic.invalid/goods/1.jpg'],
  ['空串', ''],
  ['前导空格', ` ${url(1)}`],
  ['尾随空格', `${url(1)} `],
  ['中间空格', `${host}/goods/a b.jpg`],
  ['制表符', `${host}/goods/a\tb.jpg`],
  ['换行', `${host}/goods/a\nb.jpg`],
  ['回车', `${host}/goods/a\rb.jpg`],
  ['NUL', `${host}/goods/a\u0000b.jpg`],
  ['DEL', `${host}/goods/a\u007fb.jpg`],
  ['C1 控制字符', `${host}/goods/a\u009bb.jpg`],
  ['全角空格', `${host}/goods/a　b.jpg`],
  ['超过 2048', sized(MAX_URL_LENGTH + 1)],
  ['数字', 42],
  ['布尔', true],
  ['null', null],
  ['对象', { href: url(1) }],
  ['数组', [url(1)]],
];

function fieldKeys(value: object): string[] {
  return Object.keys(value).sort();
}

it('[AC-B1-22s-NORM#1] 合格的 https 主图与多图原样保留，多图按上游顺序，主图不并入也不剔除', () => {
  expect(
    normalizeItemImages({ main_image_url: url(0), image_urls: [url(3), url(1), url(2)] }),
  ).toEqual({ main_image_url: url(0), image_urls: [url(3), url(1), url(2)] });
  expect(normalizeItemImages({ main_image_url: url(0), image_urls: [url(1), url(0)] })).toEqual({
    main_image_url: url(0),
    image_urls: [url(1), url(0)],
  });
  const query = `${host}/goods/1.jpg?w=750&fmt=webp#hd`;
  expect(normalizeItemImages({ main_image_url: query, image_urls: [query] })).toEqual({
    main_image_url: query,
    image_urls: [query],
  });
});

it.each(invalid)('[AC-B1-22s-NORM#2] 非法地址（%s）丢弃、不报错，其余条目保留', (_label, bad) => {
  const main = normalizeItemImages({ main_image_url: bad, image_urls: [url(1)] });
  expect(main).toEqual({ image_urls: [url(1)] });
  expect(Object.hasOwn(main, 'main_image_url')).toBe(false);
  const only = normalizeItemImages({ image_urls: [bad] });
  expect(fieldKeys(only)).toEqual([]);
  expect(
    normalizeItemImages({ main_image_url: url(0), image_urls: [url(1), bad, url(2)] }),
  ).toEqual({ main_image_url: url(0), image_urls: [url(1), url(2)] });
});

it('[AC-B1-22s-NORM#3] 地址长度恰 2048 收下，2049 丢弃', () => {
  const edge = sized(MAX_URL_LENGTH);
  const over = sized(MAX_URL_LENGTH + 1);
  expect(edge).toHaveLength(MAX_URL_LENGTH);
  expect(over).toHaveLength(MAX_URL_LENGTH + 1);
  expect(normalizeItemImages({ main_image_url: edge, image_urls: [edge, over, url(1)] })).toEqual({
    main_image_url: edge,
    image_urls: [edge, url(1)],
  });
  expect(fieldKeys(normalizeItemImages({ main_image_url: over, image_urls: [over] }))).toEqual([]);
});

it('[AC-B1-22s-NORM#4] 多图按原字符串去重，保留首次出现的位置', () => {
  expect(
    normalizeItemImages({ image_urls: [url(2), url(1), url(2), url(3), url(1), url(3)] }),
  ).toEqual({ image_urls: [url(2), url(1), url(3)] });
  // 只按字符串相等去重：大小写不同的路径是两张图。
  const upper = `${host}/goods/A.jpg`;
  const lower = `${host}/goods/a.jpg`;
  expect(normalizeItemImages({ image_urls: [upper, lower, upper] })).toEqual({
    image_urls: [upper, lower],
  });
});

it('[AC-B1-22s-NORM#5] 多图至多 9 张：先丢弃非法与重复再按上游顺序截断', () => {
  const twelve = Array.from({ length: 12 }, (_, index) => url(index + 1));
  expect(normalizeItemImages({ image_urls: twelve })).toEqual({
    image_urls: twelve.slice(0, MAX_IMAGES),
  });
  const nine = twelve.slice(0, MAX_IMAGES);
  expect(normalizeItemImages({ image_urls: nine })).toEqual({ image_urls: nine });
  const ten = twelve.slice(0, MAX_IMAGES + 1);
  expect(normalizeItemImages({ image_urls: ten }).image_urls).toEqual(nine);
  // 非法与重复条目不占名额。
  const noisy = [
    'http://img.synthetic.invalid/goods/0.jpg',
    url(1),
    url(1),
    '',
    null,
    ...twelve.slice(1),
  ];
  expect(normalizeItemImages({ image_urls: noisy })).toEqual({ image_urls: nine });
});

it('[AC-B1-22s-NORM#6] 全部丢弃或没给时字段缺省：不给空数组，也不留值为 undefined 的键', () => {
  const cases: readonly Parameters<typeof normalizeItemImages>[0][] = [
    {},
    { main_image_url: undefined, image_urls: undefined },
    { image_urls: [] },
    { image_urls: ['http://img.synthetic.invalid/goods/1.jpg', '', 42] },
    { image_urls: url(1) },
    { image_urls: { 0: url(1), length: 1 } },
    { image_urls: null },
    { main_image_url: null, image_urls: [null] },
  ];
  for (const input of cases) {
    const result = normalizeItemImages(input);
    expect(fieldKeys(result)).toEqual([]);
    expect(result).toEqual({});
  }
  const mainOnly = normalizeItemImages({ main_image_url: url(0), image_urls: [] });
  expect(mainOnly).toEqual({ main_image_url: url(0) });
  expect(fieldKeys(mainOnly)).toEqual(['main_image_url']);
});

it('[AC-B1-22s-NORM#7] 只输出两个图片字段；主图不从多图补，输入不被修改', () => {
  const images = Object.freeze([url(1), url(1), 'javascript:void(0)', url(2)]);
  const input = Object.freeze({ image_urls: images });
  const result = normalizeItemImages(input);
  expect(result).toEqual({ image_urls: [url(1), url(2)] });
  expect(Object.hasOwn(result, 'main_image_url')).toBe(false);
  expect(images).toEqual([url(1), url(1), 'javascript:void(0)', url(2)]);
  const extra = normalizeItemImages({
    main_image_url: url(0),
    image_urls: [url(1)],
    ...{ title: '合成标题', description: '合成描述' },
  } as Parameters<typeof normalizeItemImages>[0]);
  expect(fieldKeys(extra)).toEqual([...IMAGE_FIELDS].sort());
});
