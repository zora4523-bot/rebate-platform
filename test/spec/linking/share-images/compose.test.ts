// B1-15z rule tests: the images of POST /v1/shares composed from one union detail (BR-ATTR-10 细则
// 「分享页与分享赚入口页」素材图, orchestrator ruling of 15:50), pure: main image first, deduplicated, at
// most 9, addresses unchanged, only the main image without a gallery, [] without either. Inputs
// are domain DTO fields (UnionItemDetail, B1-22s), never a platform payload. The property's runs
// and seed come only from @couli/testing (PROP_RUNS / PROP_SEED).
import { propParams, propRuns } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import { shareImages } from '../../../../apps/api/src/modules/linking/application/shares.ts';
import { MAX_IMAGES, sameImages } from './oracle.ts';

const MAIN = 'https://img.example.test/p/main.jpg';

function imageUrl(n: number): string {
  return `https://img.example.test/p/${String(n)}.jpg`;
}

function gallery(from: number, to: number): string[] {
  return Array.from({ length: to - from + 1 }, (_, n) => imageUrl(from + n));
}

function images(...urls: readonly string[]): { url: string }[] {
  return urls.map((url) => ({ url }));
}

it('[AC-B1-15z#1] 主图 + 多图：主图在前，多图按联盟返回的顺序跟在后面，每项只有 url', () => {
  const [one, two, three] = gallery(1, 3) as [string, string, string];
  expect(shareImages({ main_image_url: MAIN, image_urls: [three, one, two] })).toEqual(
    images(MAIN, three, one, two),
  );
});

it('[AC-B1-15z#1] 主图同时出现在多图里：只留一张，位置在最前', () => {
  const [one, two] = gallery(1, 2) as [string, string];
  expect(shareImages({ main_image_url: MAIN, image_urls: [one, MAIN, two] })).toEqual(
    images(MAIN, one, two),
  );
  expect(shareImages({ main_image_url: MAIN, image_urls: [one, two, MAIN] })).toEqual(
    images(MAIN, one, two),
  );
});

it('[AC-B1-15z#1] 多图内重复：去重，保留首次出现的位置', () => {
  const [one, two, three] = gallery(1, 3) as [string, string, string];
  expect(shareImages({ image_urls: [two, one, two, three, one] })).toEqual(images(two, one, three));
  expect(shareImages({ main_image_url: MAIN, image_urls: [two, two, one] })).toEqual(
    images(MAIN, two, one),
  );
});

it('[AC-B1-15z#1] 主图 + 9 张多图共 10 张：截到 9 张，主图保留，舍去多图最后一张', () => {
  const nine = gallery(1, 9);
  const result = shareImages({ main_image_url: MAIN, image_urls: nine });
  expect(result).toHaveLength(MAX_IMAGES);
  expect(result).toEqual(images(MAIN, ...nine.slice(0, 8)));
});

it('[AC-B1-15z#1] 重复的地址不占名额：先去重再截到 9 张', () => {
  const eight = gallery(1, 8);
  expect(shareImages({ main_image_url: MAIN, image_urls: [...eight, MAIN] })).toEqual(
    images(MAIN, ...eight),
  );
  const [first] = eight as [string];
  const noisy = [first, MAIN, first, ...gallery(2, 10), first];
  expect(shareImages({ main_image_url: MAIN, image_urls: noisy })).toEqual(images(MAIN, ...eight));
});

it('[AC-B1-15z#1] 只有主图：一张', () => {
  expect(shareImages({ main_image_url: MAIN })).toEqual(images(MAIN));
});

it('[AC-B1-15z#1] 只有多图：按多图的顺序给，不多不少；超过 9 张时只给前 9 张', () => {
  const [one, two] = gallery(1, 2) as [string, string];
  expect(shareImages({ image_urls: [two, one] })).toEqual(images(two, one));
  const ten = gallery(1, 10);
  expect(shareImages({ image_urls: ten })).toEqual(images(...ten.slice(0, MAX_IMAGES)));
});

it('[AC-B1-15z#1] 主图与多图都没有：[]', () => {
  expect(shareImages({})).toEqual([]);
});

it('[AC-B1-15z#1] 地址一字不改：大小写、编码、查询串、片段、结尾都原样，只差大小写或查询串的是不同地址', () => {
  const urls = [
    'https://IMG.Example.test/P/Photo.JPG',
    'https://img.example.test',
    'https://img.example.test/p/%E5%9B%BE.jpg?w=800&h=800#top',
    'https://img.example.test/p/图.jpg',
    'https://img.example.test/p/a.jpg?size=800x800&',
    'https://img.example.test/p/a.jpg',
    'https://img.example.test/p/A.jpg',
    'https://img.example.test/p/a.jpg?w=1',
    'https://img.example.test/p/a.jpg?w=2',
  ];
  const [main, ...rest] = urls as [string, ...string[]];
  expect(shareImages({ main_image_url: main, image_urls: rest })).toEqual(images(...urls));
});

it('[AC-B1-15z#1] 入参不被改动：联盟 DTO 的多图是冻结数组，组图后原样不变', () => {
  const [one, two] = gallery(1, 2) as [string, string];
  const item = Object.freeze({
    main_image_url: MAIN,
    image_urls: Object.freeze([two, MAIN, one]),
  });
  expect(shareImages(item)).toEqual(images(MAIN, two, one));
  expect(item.image_urls).toEqual([two, MAIN, one]);
});

// A small pool makes the main image reappear in the gallery and the gallery repeat itself often,
// and it still holds more than 9 different addresses.
const POOL: readonly string[] = gallery(1, 14);
const itemArb = fc.record(
  {
    main_image_url: fc.constantFrom(...POOL),
    image_urls: fc.array(fc.constantFrom(...POOL), { minLength: 1, maxLength: 24 }),
  },
  { requiredKeys: [] },
);

// The timeout grows with PROP_RUNS (10 000 locally, 100 000 in the long run).
const PROPERTY_TIMEOUT_MS: number = Math.max(30_000, Math.ceil(propRuns() * 0.3));

it(
  '[AC-B1-15z#1] 任意主图与多图组合：主图在首位，无重复，至多 9 张，只含联盟返回的地址，顺序取首次出现，名额没有被重复占掉',
  () => {
    expect(() =>
      fc.assert(
        fc.property(itemArb, (item) => sameImages(shareImages(item), item)),
        propParams(),
      ),
    ).not.toThrow();
  },
  PROPERTY_TIMEOUT_MS,
);
