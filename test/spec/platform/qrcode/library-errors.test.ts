import { expect, it, vi } from 'vitest';
import { expectQrError, library, platform } from './kit.ts';

// Use the API's installed CommonJS qrcode singleton. Each spy is restored even when the
// skeleton fails; no global mock can change the real-library rendering oracle in other files.
it.each(['renderQrCodeSvg', 'renderQrCodePng', 'minimumQrCodeSize'] as const)(
  '[AC-B1-01zf#17] %s 封装编码器异常为 encode_failed 并保留原始 cause',
  async (method) => {
    const original = new Error('synthetic QR encoder failure');
    const spy = vi.spyOn(library, 'create').mockImplementation(() => {
      throw original;
    });
    try {
      const api = await platform();
      const error = await expectQrError(() => api[method]('abc'), 'encode_failed');
      expect(error.cause).toBe(original);
    } finally {
      spy.mockRestore();
    }
  },
);

it('[AC-B1-01zf#18] SVG 渲染器拒绝时抛 QrCodeError 并保留原始 cause', async () => {
  const original = new Error('synthetic SVG renderer failure');
  const spy = vi.spyOn(library, 'toString').mockRejectedValue(original);
  try {
    const api = await platform();
    const error = await expectQrError(() => api.renderQrCodeSvg('abc'), 'encode_failed');
    expect(error.cause).toBe(original);
  } finally {
    spy.mockRestore();
  }
});

it('[AC-B1-01zf#19] PNG 渲染器拒绝时抛 QrCodeError 并保留原始 cause', async () => {
  const original = new Error('synthetic PNG renderer failure');
  const spy = vi.spyOn(library, 'toBuffer').mockRejectedValue(original);
  try {
    const api = await platform();
    const error = await expectQrError(() => api.renderQrCodePng('abc'), 'encode_failed');
    expect(error.cause).toBe(original);
  } finally {
    spy.mockRestore();
  }
});

it.each(['renderQrCodeSvg', 'renderQrCodePng', 'minimumQrCodeSize'] as const)(
  '[AC-B1-01zf#20] %s 在调用编码库前拒绝无效输入与选项',
  async (method) => {
    const spy = vi.spyOn(library, 'create').mockImplementation(() => {
      throw new Error('must not reach encoder');
    });
    try {
      const api = await platform();
      await expectQrError(() => api[method]('   '), 'empty_text');
      await expectQrError(() => api[method]('a'.repeat(1025)), 'text_too_long');
      await expectQrError(() => api[method]('abc', { size: 100.5 }), 'invalid_option');
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  },
);
