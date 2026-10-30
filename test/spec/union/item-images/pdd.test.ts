import { expect, it } from 'vitest';
import { normalizeItemImages } from '../../../../apps/api/src/modules/union/domain/item-images.ts';
import { one, row, sources } from '../pdd-goods/kit.ts';
import { IMAGE_FIELDS } from './kit.ts';

// 合成值：规划/09 CAP-PDD-02 只是「文档已查、未实测」，这里放进上游报文的图片字段名只用来证明
// 适配器不读它们；值是合格的 https 地址（经 normalizeItemImages 清洗后非空），不是录制。
const host = 'https://img.synthetic.invalid';
const main = `${host}/pdd/main.jpg`;
const gallery = [`${host}/pdd/1.jpg`, `${host}/pdd/2.jpg`, `${host}/pdd/1.jpg`];
const upstreamImages = {
  goods_image_url: main,
  goods_thumbnail_url: `${host}/pdd/thumb.jpg`,
  goods_gallery_urls: gallery,
  // 与统一 DTO 同名的字段同样不得透传。
  main_image_url: main,
  image_urls: gallery,
};

it.each(sources)(
  '[AC-B1-22s-PDD#1] %s 实测前不映射图片：上游报文带合格的图片字段，DTO 里也没有图片字段',
  async (source) => {
    expect(normalizeItemImages({ main_image_url: main, image_urls: gallery })).toEqual({
      main_image_url: main,
      image_urls: [`${host}/pdd/1.jpg`, `${host}/pdd/2.jpg`],
    });
    const plain = await one(source, row());
    const withImages = await one(source, row(upstreamImages));
    expect(withImages).toEqual(plain);
    for (const field of [...IMAGE_FIELDS, ...Object.keys(upstreamImages)]) {
      expect(Object.hasOwn(withImages, field), field).toBe(false);
    }
    expect(Object.values(withImages)).not.toContain(main);
  },
);
