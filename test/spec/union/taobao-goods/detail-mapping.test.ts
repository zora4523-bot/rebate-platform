import { expect, it } from 'vitest';
import {
  ctx,
  detailRow,
  detailSetup,
  instant,
  ITEM_ID,
  MAIN_IMAGE,
  numbersIn,
  ref,
  SELLER_ID_TEXT,
  SMALL_IMAGES,
} from './kit.ts';

it('[AC-B1-04l#4] 详情映射：商品标识、标题、取价时间、万分比佣金 → bp（不用 income_rate）', async () => {
  const { adapter } = detailSetup();
  const detail = await adapter.getItem(ref, ctx);
  expect(detail).toMatchObject({
    platform: 'taobao',
    item_id: ITEM_ID,
    title: '合成详情商品',
    quoted_at: instant,
    commission_rate_bp: 2050n,
  });
  expect(typeof detail.commission_rate_bp).toBe('bigint');
});

it('[AC-B1-04l#5] 主图取 pict_url、多图取 small_images 包装下的数组（white_image 不进多图）', async () => {
  const { adapter } = detailSetup();
  const detail = await adapter.getItem(ref, ctx);
  expect(detail.main_image_url).toBe(MAIN_IMAGE);
  expect(detail.image_urls).toEqual(SMALL_IMAGES);
});

it('[AC-B1-04l#6] 图片经 normalizeItemImages：非 https 主图不出现，多图去重、丢非法项、最多 9 张', async () => {
  const many: string[] = [];
  for (let index = 0; index < 12; index += 1) {
    many.push(`https://img.synthetic.invalid/bao/many-${index + 10}.jpg`);
  }
  const plainHttp = 'http://img.synthetic.invalid/bao/plain.jpg';
  const small = [many[0], plainHttp, many[0], 42, ...many.slice(1)];
  const basic = {
    pict_url: 'http://img.synthetic.invalid/bao/main.jpg',
    small_images: { string: small },
  };
  const { adapter } = detailSetup([detailRow({ basic })]);
  const detail = await adapter.getItem(ref, ctx);
  expect(detail).toMatchObject({ platform: 'taobao', item_id: ITEM_ID });
  expect(detail).not.toHaveProperty('main_image_url');
  expect(detail.image_urls).toEqual(many.slice(0, 9));
});

it('[AC-B1-04l#7] 上游没有图片时两个图片字段都不出现', async () => {
  const bare = { pict_url: undefined, small_images: undefined, white_image: undefined };
  const { adapter } = detailSetup([detailRow({ basic: bare })]);
  const detail = await adapter.getItem(ref, ctx);
  expect(detail).toMatchObject({ platform: 'taobao', item_id: ITEM_ID, title: '合成详情商品' });
  expect(detail).not.toHaveProperty('main_image_url');
  expect(detail).not.toHaveProperty('image_urls');
});

it('[AC-B1-04l#8] 一级类目进 category_l1_id（十进制字符串）/ category_l1_name', async () => {
  const { adapter } = detailSetup();
  const detail = await adapter.getItem(ref, ctx);
  expect(detail.category_l1_id).toBe('50008090');
  expect(detail.category_l1_name).toBe('合成一级类目');
});

it('[AC-B1-04l#9] 上游没有一级类目时两个类目字段都不出现', async () => {
  const bare = { level_one_category_id: undefined, level_one_category_name: undefined };
  const { adapter } = detailSetup([detailRow({ basic: bare })]);
  const detail = await adapter.getItem(ref, ctx);
  expect(detail).toMatchObject({ platform: 'taobao', item_id: ITEM_ID });
  expect(detail).not.toHaveProperty('category_l1_id');
  expect(detail).not.toHaveProperty('category_l1_name');
});

it('[AC-B1-04l#10] 超出安全整数的 seller_id 不变成 number：结果里没有任何 number 值', async () => {
  const { adapter } = detailSetup();
  const detail = await adapter.getItem(ref, ctx);
  expect(detail).toMatchObject({ platform: 'taobao', item_id: ITEM_ID });
  expect(numbersIn(detail)).toEqual([]);
  const seller: unknown = Reflect.get(detail, 'seller_id');
  if (seller !== undefined) expect(seller).toBe(SELLER_ID_TEXT);
});

it('[AC-B1-04l#11] results 下的包装键不写死：换任意包装名映射结果相同', async () => {
  const usual = detailSetup([detailRow()], {}, 'tbk_item_detail');
  const other = detailSetup([detailRow()], {}, 'synthetic_detail_wrapper');
  const first = await usual.adapter.getItem(ref, ctx);
  const second = await other.adapter.getItem(ref, ctx);
  expect(first).toMatchObject({ platform: 'taobao', item_id: ITEM_ID, title: '合成详情商品' });
  expect(second).toEqual(first);
});

it('[AC-B1-04l#12] 不把未登记的上游字段扩散进统一 DTO', async () => {
  const plain = await detailSetup().adapter.getItem(ref, ctx);
  const row = detailRow({
    top: { price_fen: 1, final_price_fen: 1, synthetic_unknown: 'synthetic' },
    basic: { commission_rate_bp: 9999, synthetic_basic: 'synthetic' },
  });
  const polluted = await detailSetup([row]).adapter.getItem(ref, ctx);
  expect(polluted).toEqual(plain);
  expect(polluted).not.toHaveProperty('synthetic_unknown');
  expect(polluted).not.toHaveProperty('synthetic_basic');
});
