import { expect, it } from 'vitest';
import { inspectHjyIgnoreEvidence } from '../../../../apps/api/src/modules/union/domain/hjy-ignore-evidence.ts';
import { JPEG, PNG, chunk } from './image-fixtures.ts';

// Valid ancillary text chunk before IEND reaches the exact byte boundary without a corrupt image.
function sizedPng(size: number): Buffer {
  return Buffer.concat([
    PNG.subarray(0, -12),
    chunk(
      'tEXt',
      Buffer.concat([Buffer.from('Comment\0'), Buffer.alloc(size - PNG.length - 20, 65)]),
    ),
    PNG.subarray(-12),
  ]);
}

it.each([
  ['PNG', PNG, 'image/png'],
  ['JPEG', JPEG, 'image/jpeg'],
] as const)('[AC-B1-22h#41] 花卷云截图接受真实 %s 字节', (_name, bytes, contentType) => {
  expect(inspectHjyIgnoreEvidence(bytes)).toEqual({ valid: true, contentType });
});

it('[AC-B1-22h#42] 截图恰好 5 MiB 合法，超出一个字节拒绝', () => {
  const maximum = sizedPng(5 * 1024 * 1024);
  const oversized = sizedPng(5 * 1024 * 1024 + 1);
  expect(maximum).toHaveLength(5 * 1024 * 1024);
  expect(oversized).toHaveLength(5 * 1024 * 1024 + 1);
  expect(inspectHjyIgnoreEvidence(maximum)).toEqual({ valid: true, contentType: 'image/png' });
  expect(inspectHjyIgnoreEvidence(oversized)).toEqual({ valid: false });
});

it.each([
  ['GIF', Buffer.from('GIF89a')],
  ['PDF', Buffer.from('%PDF-1.7')],
  ['SVG', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')],
  ['empty', Buffer.alloc(0)],
] as const)('[AC-B1-22h#43] 非 PNG/JPEG 的 %s 不被当作截图', (_name, bytes) => {
  expect(inspectHjyIgnoreEvidence(bytes)).toEqual({ valid: false });
});
