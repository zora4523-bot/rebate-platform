import { expect, it } from 'vitest';
import { expectPng, expectSvg, library, platform } from './kit.ts';

it('[AC-B1-01zf#1] platform 导出五个边界常量', async () => {
  expect(await platform()).toMatchObject({
    QR_TEXT_MAX_BYTES: 1024,
    QR_SIZE_MIN: 64,
    QR_SIZE_MAX: 2048,
    QR_MARGIN_MIN: 0,
    QR_MARGIN_MAX: 8,
  });
});

it('[AC-B1-01zf#2] SVG 默认 M / 512 / 2，且为完整二维码文档', async () => {
  const { renderQrCodeSvg } = await platform();
  const text = 'https://example.test/preview/demo';
  const svg = await renderQrCodeSvg(text);
  expectSvg(svg, 512, library.create(text, { errorCorrectionLevel: 'M' }).modules.size + 4);
  expect(svg).toBe(
    await library.toString(text, { type: 'svg', errorCorrectionLevel: 'M', width: 512, margin: 2 }),
  );
  expect(await renderQrCodeSvg(text, {})).toBe(svg);
});

it('[AC-B1-01zf#3] PNG 默认尺寸 512，空选项与显式默认值相同', async () => {
  const { renderQrCodePng } = await platform();
  const png = await renderQrCodePng('preview');
  expectPng(png, 512);
  expect((await renderQrCodePng('preview', {})).equals(png)).toBe(true);
  expect(
    (await renderQrCodePng('preview', { size: 512, margin: 2, errorCorrection: 'M' })).equals(png),
  ).toBe(true);
});

it.each(['L', 'M', 'Q', 'H'] as const)(
  '[AC-B1-01zf#4] 纠错等级 %s 原样用于 SVG、PNG 及最小尺寸计算',
  async (errorCorrection) => {
    const { renderQrCodeSvg, renderQrCodePng, minimumQrCodeSize } = await platform();
    const text = 'https://example.test/preview/' + 'abcd'.repeat(30);
    const options = Object.freeze({ errorCorrection, size: 256, margin: 3 });
    const expectedOptions = { errorCorrectionLevel: errorCorrection, width: 256, margin: 3 };
    const minimum = library.create(text, expectedOptions).modules.size + 6;
    expect(minimumQrCodeSize(text, options)).toBe(minimum);
    const svg = await renderQrCodeSvg(text, options);
    expectSvg(svg, 256, minimum);
    expect(svg).toBe(await library.toString(text, { ...expectedOptions, type: 'svg' }));
    const png = await renderQrCodePng(text, options);
    expectPng(png, 256);
    expect(png.equals(await library.toBuffer(text, { ...expectedOptions, type: 'png' }))).toBe(
      true,
    );
  },
);

it.each([
  { size: 64, margin: 0 },
  { size: 128, margin: 8 },
  { size: 2048, margin: 2 },
])('[AC-B1-01zf#5] size=$size / margin=$margin 的边界合法且两种图片宽高准确', async (options) => {
  const { renderQrCodeSvg, renderQrCodePng } = await platform();
  expectSvg(await renderQrCodeSvg('abc', options), options.size, 21 + 2 * options.margin);
  const png = await renderQrCodePng('abc', options);
  expectPng(png, options.size);
  expect(
    png.equals(
      await library.toBuffer('abc', {
        type: 'png',
        errorCorrectionLevel: 'M',
        width: options.size,
        margin: options.margin,
      }),
    ),
  ).toBe(true);
});

it.each([0, 2, 8])('[AC-B1-01zf#6] margin=%s 时尺寸恰为内容最小值可渲染', async (margin) => {
  const { renderQrCodeSvg, renderQrCodePng, minimumQrCodeSize } = await platform();
  const text = 'a'.repeat(1000);
  const size = library.create(text, { errorCorrectionLevel: 'H' }).modules.size + 2 * margin;
  expect(size).toBeGreaterThan(64);
  expect(minimumQrCodeSize(text, { errorCorrection: 'H', margin })).toBe(size);
  const options = { errorCorrection: 'H' as const, size, margin };
  expectSvg(await renderQrCodeSvg(text, options), size, size);
  expectPng(await renderQrCodePng(text, options), size);
});

it('[AC-B1-01zf#7] minimumQrCodeSize 默认 M 与 margin 2，返回模块数而非默认像素数', async () => {
  const { minimumQrCodeSize } = await platform();
  expect(minimumQrCodeSize('abc')).toBe(25);
  expect(minimumQrCodeSize('abc', { size: 2048 })).toBe(25);
});

it.each(['a'.repeat(1024), '中'.repeat(341) + 'a', '😀'.repeat(256)])(
  '[AC-B1-01zf#8] 正好 1024 个 UTF-8 字节可编码（含中文与四字节字符） %j',
  async (text) => {
    const { renderQrCodeSvg, renderQrCodePng } = await platform();
    expect(Buffer.byteLength(text, 'utf8')).toBe(1024);
    const modules = library.create(text, { errorCorrectionLevel: 'M' }).modules.size;
    expectSvg(await renderQrCodeSvg(text), 512, modules + 4);
    expectPng(await renderQrCodePng(text), 512);
  },
);

it('[AC-B1-01zf#9] 前后空白不裁剪，SVG 与 PNG 编码原文', async () => {
  const { renderQrCodeSvg, renderQrCodePng, minimumQrCodeSize } = await platform();
  const text = ' \t首页预览\n ';
  const options = { errorCorrectionLevel: 'M' as const, width: 512, margin: 2 };
  const svg = await renderQrCodeSvg(text);
  expect(svg).toBe(await library.toString(text, { ...options, type: 'svg' }));
  expect(svg).not.toBe(await renderQrCodeSvg(text.trim()));
  const png = await renderQrCodePng(text);
  expect(png.equals(await library.toBuffer(text, { ...options, type: 'png' }))).toBe(true);
  expect(png.equals(await renderQrCodePng(text.trim()))).toBe(false);
  expect(minimumQrCodeSize(text)).toBe(library.create(text, options).modules.size + 4);
});

it('[AC-B1-01zf#10] 相同输入与选项输出字节相同，交错调用不残留选项状态', async () => {
  const { renderQrCodeSvg, renderQrCodePng } = await platform();
  const options = Object.freeze({ size: 128, margin: 0, errorCorrection: 'H' as const });
  const svg = await renderQrCodeSvg('确定性', options);
  const png = await renderQrCodePng('确定性', options);
  await renderQrCodeSvg('other', { size: 64, margin: 8, errorCorrection: 'L' });
  await renderQrCodePng('other', { size: 64, margin: 8, errorCorrection: 'L' });
  expect(await renderQrCodeSvg('确定性', options)).toBe(svg);
  expect((await renderQrCodePng('确定性', options)).equals(png)).toBe(true);
  expect(options).toEqual({ size: 128, margin: 0, errorCorrection: 'H' });
});
