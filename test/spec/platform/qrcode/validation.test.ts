import { expect, it } from 'vitest';
import type { QrCodeOptions } from '../../../../apps/api/src/modules/platform/qrcode/index.ts';
import { expectQrError, library, platform } from './kit.ts';

const METHODS = ['renderQrCodeSvg', 'renderQrCodePng', 'minimumQrCodeSize'] as const;
const INVALID_OPTIONS: readonly [string, unknown][] = [
  ['size 小于下限', { size: 63 }],
  ['size 大于上限', { size: 2049 }],
  ['size 非整数', { size: 100.5 }],
  ['size 字符串', { size: '128' }],
  ['size null', { size: null }],
  ['size NaN', { size: NaN }],
  ['size Infinity', { size: Infinity }],
  ['margin 小于下限', { margin: -1 }],
  ['margin 大于上限', { margin: 9 }],
  ['margin 非整数', { margin: 0.5 }],
  ['margin 字符串', { margin: '2' }],
  ['margin null', { margin: null }],
  ['margin NaN', { margin: NaN }],
  ['margin Infinity', { margin: Infinity }],
  ['纠错等级 X', { errorCorrection: 'X' }],
  ['纠错等级小写', { errorCorrection: 'm' }],
  ['纠错等级长别名', { errorCorrection: 'medium' }],
  ['纠错等级数字', { errorCorrection: 0 }],
  ['纠错等级 null', { errorCorrection: null }],
];

for (const method of METHODS) {
  it.each(['', ' \t\r\n\u3000', null, undefined, 123, {}, ['abc']])(
    `[AC-B1-01zf#11] ${method} 拒绝空白及非字符串 %j`,
    async (text) => {
      const api = await platform();
      await expectQrError(() => api[method](text as string), 'empty_text');
    },
  );

  it.each(['a'.repeat(1025), '中'.repeat(341) + 'ab', '😀'.repeat(257)])(
    `[AC-B1-01zf#12] ${method} 拒绝 UTF-8 超限文本 %j`,
    async (text) => {
      const api = await platform();
      expect(Buffer.byteLength(text, 'utf8')).toBeGreaterThan(1024);
      await expectQrError(() => api[method](text), 'text_too_long');
    },
  );

  it.each(INVALID_OPTIONS)(`[AC-B1-01zf#13] ${method} 拒绝 %s`, async (_label, options) => {
    const api = await platform();
    await expectQrError(() => api[method]('abc', options as QrCodeOptions), 'invalid_option');
  });

  it(`[AC-B1-01zf#14] ${method} 校验顺序为空白、字节上限、选项`, async () => {
    const api = await platform();
    const options = { size: 0, margin: 9, errorCorrection: 'X' } as unknown as QrCodeOptions;
    await expectQrError(() => api[method](' '.repeat(1025), options), 'empty_text');
    await expectQrError(() => api[method]('a'.repeat(1025), options), 'text_too_long');
    await expectQrError(() => api[method]('abc', options), 'invalid_option');
  });

  it(`[AC-B1-01zf#15] ${method} 字节上限按原文计算，不预先 trim`, async () => {
    const api = await platform();
    const text = ' ' + 'a'.repeat(1024);
    await expectQrError(() => api[method](text), 'text_too_long');
  });
}

for (const method of ['renderQrCodeSvg', 'renderQrCodePng'] as const) {
  it.each([0, 2, 8])(
    `[AC-B1-01zf#16] ${method} margin=%s 时拒绝低于内容最小尺寸，不静默放大`,
    async (margin) => {
      const api = await platform();
      const text = 'a'.repeat(1000);
      const minimum = library.create(text, { errorCorrectionLevel: 'H' }).modules.size + 2 * margin;
      for (const size of [64, minimum - 1]) {
        const error = await expectQrError(
          () => api[method](text, { size, margin, errorCorrection: 'H' }),
          'invalid_option',
        );
        expect(error.message).toContain('below the minimum');
      }
    },
  );
}
