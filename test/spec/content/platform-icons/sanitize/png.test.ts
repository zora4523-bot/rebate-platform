import { expect, it, vi } from 'vitest';
import { inspectPlatformIcon } from '../../../../../apps/api/src/modules/content/domain/platform-icon/index.ts';
import { options, success } from './kit.ts';
import { PNG, chunk, png, transparentRgbPng, withDimensions } from './png-fixtures.ts';

it.each([
  [512, 512, 6],
  [512, 512, 4],
  [4096, 512, 6],
  [512, 4096, 6],
])('[AC-F1-06v#8] accepts transparent PNG %i × %i with color type %i unchanged', (w, h, type) => {
  const input = png(w, h, type);
  const before = Uint8Array.from(input);
  const output = success(inspectPlatformIcon(input, options()), input, 'png');
  expect(output.sanitized).toBe(false);
  expect(Uint8Array.from(output.bytes)).toEqual(before);
  expect(Uint8Array.from(input)).toEqual(before);
});

it.each([
  [511, 512],
  [512, 511],
])('[AC-F1-06v#9] both PNG sides must reach 512: %i × %i', (w, h) => {
  expect(inspectPlatformIcon(png(w, h), options())).toEqual({
    ok: false,
    reason: 'icon_format_invalid',
  });
});

it.each([
  [4097, 512],
  [512, 4097],
  [0x7fffffff, 0x7fffffff],
])('[AC-F1-06v#10] rejects oversized IHDR %i × %i before pixel decoding', (w, h) => {
  const input = withDimensions(png(), w, h);
  const decode = vi.spyOn(PNG.sync, 'read');
  try {
    expect(inspectPlatformIcon(input, options())).toEqual({
      ok: false,
      reason: 'icon_format_invalid',
    });
    expect(decode).not.toHaveBeenCalled();
  } finally {
    decode.mockRestore();
  }
});

it.each([0, 1, 2, 3])(
  '[AC-F1-06v#11] rejects alpha-bearing PNG when corner %i is opaque',
  (corner) => {
    expect(inspectPlatformIcon(png(512, 512, 6, corner), options())).toEqual({
      ok: false,
      reason: 'icon_format_invalid',
    });
  },
);

it('[AC-F1-06v#12] corners must be fully transparent, not merely translucent', () => {
  const pixels = PNG.sync.read(png());
  pixels.data[3] = 1;
  const input = PNG.sync.write(pixels, { colorType: 6, inputColorType: 6 });
  expect(inspectPlatformIcon(input, options())).toEqual({
    ok: false,
    reason: 'icon_format_invalid',
  });
});

it.each([0, 2])('[AC-F1-06v#13] rejects PNG without alpha or tRNS, color type %i', (type) => {
  expect(inspectPlatformIcon(png(512, 512, type), options())).toEqual({
    ok: false,
    reason: 'icon_format_invalid',
  });
});

it('[AC-F1-06v#14] accepts RGB transparency provided by tRNS unchanged', () => {
  const input = transparentRgbPng();
  const decoded = PNG.sync.read(input);
  for (const index of [0, 511, 511 * 512, 512 * 512 - 1]) {
    expect(decoded.data[index * 4 + 3]).toBe(0);
  }
  const output = success(inspectPlatformIcon(input, options()), input, 'png');
  expect(Buffer.from(output.bytes)).toEqual(input);
  expect(output.sanitized).toBe(false);
});

it('[AC-F1-06v#15] a tRNS chunk does not excuse an opaque corner', () => {
  // A valid black transparent sample does not match the white corner pixels.
  const output = png(512, 512, 2);
  const withTrns = Buffer.concat([
    output.subarray(0, 33),
    chunk('tRNS', Buffer.alloc(6)),
    output.subarray(33),
  ]);
  expect(inspectPlatformIcon(withTrns, options())).toEqual({
    ok: false,
    reason: 'icon_format_invalid',
  });
});

it('[AC-F1-06v#16] PNG exactly at the configured byte limit succeeds, one byte over stops before decode', () => {
  const input = png();
  success(inspectPlatformIcon(input, options(input.length)), input, 'png');
  const decode = vi.spyOn(PNG.sync, 'read');
  try {
    expect(inspectPlatformIcon(input, options(input.length - 1))).toEqual({
      ok: false,
      reason: 'icon_too_large',
    });
    expect(decode).not.toHaveBeenCalled();
  } finally {
    decode.mockRestore();
  }
});

it.each(['signature only', 'truncated IDAT', 'bad CRC'])(
  '[AC-F1-06v#17] malformed PNG is format-invalid: %s',
  (kind) => {
    const original = png();
    const input =
      kind === 'signature only'
        ? original.subarray(0, 8)
        : kind === 'truncated IDAT'
          ? original.subarray(0, original.length - 20)
          : Buffer.from(original);
    if (kind === 'bad CRC') input[29] = input[29]! ^ 0xff;
    expect(inspectPlatformIcon(input, options())).toEqual({
      ok: false,
      reason: 'icon_format_invalid',
    });
  },
);
