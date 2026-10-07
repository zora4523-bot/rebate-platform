import { expect, it } from 'vitest';
import { expectPng, library, platform } from './kit.ts';

// library-errors.test.ts #17–#19 用 vi.spyOn 替换同一个 qrcode 模块对象的方法。
// 实现须默认导入 QRCode，并经 QRCode.create / QRCode.toString / QRCode.toBuffer 调用；
// 不要具名导入或预先解构这些函数，否则 spy 无法拦截，会造成误红。
const PREVIEW_LINKS = [100, 110, 122].map((bytes) => ({
  bytes,
  text: 'https://example.test/preview/'.padEnd(bytes, 'a'),
}));

it.each(PREVIEW_LINKS)(
  '[AC-B1-01zf#21] $bytes 字节预览链接的默认 PNG 严格为 512 × 512',
  async ({ bytes, text }) => {
    expect(Buffer.byteLength(text, 'utf8')).toBe(bytes);
    const { renderQrCodePng } = await platform();
    const png = await renderQrCodePng(text);
    expectPng(png, 512);
    expect((await renderQrCodePng(text, {})).equals(png)).toBe(true);
    expect(
      (await renderQrCodePng(text, { size: 512, margin: 2, errorCorrection: 'M' })).equals(png),
    ).toBe(true);
  },
);

for (const { bytes, text } of PREVIEW_LINKS) {
  it.each([64, 128, 512, 1000, 2048])(
    `[AC-B1-01zf#22] ${bytes} 字节预览链接在 size=%s 时 PNG 宽高严格等于请求值`,
    async (size) => {
      const { renderQrCodePng } = await platform();
      expectPng(await renderQrCodePng(text, { size }), size);
    },
  );
}

it.each(PREVIEW_LINKS)(
  '[AC-B1-01zf#23] $bytes 字节链接在库浮点取整出错的尺寸仍精确且确定',
  async ({ text }) => {
    const { minimumQrCodeSize, renderQrCodePng } = await platform();
    const minimum = minimumQrCodeSize(text);
    expect(minimum).toBe(library.create(text, { errorCorrectionLevel: 'M' }).modules.size + 4);
    // 只选择合法尺寸，并从小到大取三个反例，限制出图数量。
    const sizes = Array.from({ length: 2048 - 64 + 1 }, (_, index) => index + 64)
      .filter((size) => size >= minimum && Math.floor(minimum * (size / minimum)) !== size)
      .slice(0, 3);
    expect(sizes).toHaveLength(3);
    for (const size of sizes) {
      const raw = await library.toBuffer(text, {
        type: 'png',
        errorCorrectionLevel: 'M',
        width: size,
        margin: 2,
      });
      // 确认选中的是库实际少一像素的反例；修正后的输出不与库逐字节比对。
      expect(raw.readUInt32BE(16)).toBe(size - 1);
      expect(raw.readUInt32BE(20)).toBe(size - 1);
      const png = await renderQrCodePng(text, { size });
      expectPng(png, size);
      expect((await renderQrCodePng(text, { size })).equals(png)).toBe(true);
    }
  },
);

// 覆盖 render.test.ts 中所有与库逐字节比对的 PNG 输入（#4、#5、#9）。
// 这些组合必须由库直接生成正确尺寸，原有比对才不会妨碍针对尺寸误差的修正。
const BYTE_COMPARISON_CASES = [
  ...(['L', 'M', 'Q', 'H'] as const).map((errorCorrection) => ({
    source: `#4 ${errorCorrection}`,
    text: 'https://example.test/preview/' + 'abcd'.repeat(30),
    options: { errorCorrection, size: 256, margin: 3 },
  })),
  ...[
    { size: 64, margin: 0 },
    { size: 128, margin: 8 },
    { size: 2048, margin: 2 },
  ].map((options) => ({
    source: `#5 size=${options.size}`,
    text: 'abc',
    options: { ...options, errorCorrection: 'M' as const },
  })),
  {
    source: '#9 原文空白',
    text: ' \t首页预览\n ',
    options: { errorCorrection: 'M' as const, size: 512, margin: 2 },
  },
];

it.each(BYTE_COMPARISON_CASES)(
  '[AC-B1-01zf#24] 原有 $source 逐字节比对使用库尺寸正确的组合',
  async ({ text, options }) => {
    const minimum =
      library.create(text, { errorCorrectionLevel: options.errorCorrection }).modules.size +
      2 * options.margin;
    expect(Math.floor(minimum * (options.size / minimum))).toBe(options.size);
    expectPng(
      await library.toBuffer(text, {
        type: 'png',
        errorCorrectionLevel: options.errorCorrection,
        width: options.size,
        margin: options.margin,
      }),
      options.size,
    );
    // 同时检查平台出口，保证本轮骨架阶段此用例也因 NotImplemented 先红。
    const { renderQrCodePng } = await platform();
    expectPng(await renderQrCodePng(text, options), options.size);
  },
);
