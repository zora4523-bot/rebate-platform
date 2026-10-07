import { createRequire } from 'node:module';
import { expect } from 'vitest';
import type * as QrApi from '../../../../apps/api/src/modules/platform/qrcode/index.ts';
import type {
  QrCodeErrorCode,
  QrErrorCorrection,
} from '../../../../apps/api/src/modules/platform/qrcode/index.ts';

// Resolve the already installed API dependency; the spec package needs no new dependency.
interface LibraryOptions {
  errorCorrectionLevel: QrErrorCorrection;
  width?: number;
  margin?: number;
  type?: 'svg' | 'png';
}
interface QrLibrary {
  create(text: string, options: LibraryOptions): { modules: { size: number } };
  toString(text: string, options: LibraryOptions): Promise<string>;
  toBuffer(text: string, options: LibraryOptions): Promise<Buffer>;
}
export const library = createRequire(new URL('../../../../apps/api/package.json', import.meta.url))(
  'qrcode',
) as QrLibrary;

export async function platform(): Promise<typeof QrApi & Record<string, unknown>> {
  // The API has no package export map. Use its public platform entry, following the existing
  // platform/specs tests; a URL import keeps Nest decorators out of test/tsconfig compilation.
  const url = new URL('../../../../apps/api/src/modules/platform/index.ts', import.meta.url);
  return (await import(/* @vite-ignore */ url.href)) as typeof QrApi & Record<string, unknown>;
}

export function expectSvg(svg: string, size: number, modulesWithMargin: number): void {
  expect(svg).toMatch(/^<svg\s/);
  expect(svg.trimEnd()).toMatch(/<\/svg>$/);
  const root = svg.match(/^<svg\s[^>]*>/)?.[0] ?? '';
  expect(root).toContain('xmlns="http://www.w3.org/2000/svg"');
  expect(root).toContain(`width="${size}"`);
  expect(root).toContain(`height="${size}"`);
  expect(root).toContain(`viewBox="0 0 ${modulesWithMargin} ${modulesWithMargin}"`);
  expect(svg).toContain('<path');
}

export function expectPng(png: Buffer, size: number): void {
  expect(Buffer.isBuffer(png)).toBe(true);
  expect(png.length).toBeGreaterThanOrEqual(33);
  expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  expect(png.readUInt32BE(8)).toBe(13);
  expect(png.toString('ascii', 12, 16)).toBe('IHDR');
  expect(png.readUInt32BE(16)).toBe(size);
  expect(png.readUInt32BE(20)).toBe(size);
}

export async function expectQrError(run: () => unknown, code: QrCodeErrorCode): Promise<Error> {
  const api = await platform();
  let caught: unknown;
  try {
    await run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  expect(caught).toBeInstanceOf(api.QrCodeError);
  expect(caught).toMatchObject({ name: 'QrCodeError', code });
  return caught as Error;
}
