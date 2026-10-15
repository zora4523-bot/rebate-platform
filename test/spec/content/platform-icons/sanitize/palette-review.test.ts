import { deflateSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { inspectPlatformIcon } from '../../../../../apps/api/src/modules/content/domain/platform-icon/index.ts';
import { options, success } from './kit.ts';
import { PNG, chunk } from './png-fixtures.ts';

function palettePng(transparency: boolean): Buffer {
  // 8-bit palette indices: transparent background at index 0, visible red at index 1.
  const width = 512;
  const height = 512;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 3;
  // Each row starts with filter byte 0, followed by width palette indices.
  const scanlines = Buffer.alloc((width + 1) * height);
  scanlines[(width + 1) * 256 + 1 + 256] = 1;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('PLTE', Buffer.from([0, 0, 0, 255, 0, 0])),
    ...(transparency ? [chunk('tRNS', Buffer.from([0, 255]))] : []),
    chunk('IDAT', deflateSync(scanlines)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

it('[AC-F1-06v#52] accepts a palette PNG with tRNS and four transparent corners unchanged', () => {
  const input = palettePng(true);
  const decoded = PNG.sync.read(input);
  expect(input[25]).toBe(3);
  expect([decoded.width, decoded.height]).toEqual([512, 512]);
  for (const index of [0, 511, 511 * 512, 512 * 512 - 1]) {
    expect(decoded.data[index * 4 + 3]).toBe(0);
  }
  const center = (256 * 512 + 256) * 4;
  expect([...decoded.data.subarray(center, center + 4)]).toEqual([255, 0, 0, 255]);
  const before = Uint8Array.from(input);
  const output = success(inspectPlatformIcon(input, options()), input, 'png');
  expect(Uint8Array.from(output.bytes)).toEqual(before);
  expect(Uint8Array.from(input)).toEqual(before);
  expect(output.sanitized).toBe(false);
});

it('[AC-F1-06v#53] rejects a valid palette PNG without tRNS', () => {
  const input = palettePng(false);
  const decoded = PNG.sync.read(input);
  expect(input[25]).toBe(3);
  expect([decoded.width, decoded.height]).toEqual([512, 512]);
  for (const index of [0, 511, 511 * 512, 512 * 512 - 1]) {
    expect(decoded.data[index * 4 + 3]).toBe(255);
  }
  expect(inspectPlatformIcon(input, options())).toEqual({
    ok: false,
    reason: 'icon_format_invalid',
  });
});
