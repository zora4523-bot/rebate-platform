import { createHash } from 'node:crypto';
import { png } from '../platform-icons/sanitize/png-fixtures.ts';

export const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export const LOTTIE = { v: '5.12.2', fr: 30, ip: 30, op: 102, w: 750, h: 1000, layers: [] };
export const jsonBytes = (value: unknown) => Buffer.from(JSON.stringify(value));
export function lottie(patch: Record<string, unknown> = {}, size?: number): Buffer {
  const bytes = jsonBytes({ ...LOTTIE, ...patch });
  return size === undefined ? bytes : Buffer.concat([bytes, Buffer.alloc(size - bytes.length, 32)]);
}

// Synthetic 1 × 1 PNG and JPEG, no platform recordings or external downloads.
export const PNG = png(1, 1);
export const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwC/AB//2Q==',
  'base64',
);

export const INVALID_LOTTIE = [
  { name: '301 KiB', bytes: lottie({}, 301 * 1024), reason: 'too_large' },
  { name: '超过上限一字节', bytes: lottie({}, 307_201), reason: 'too_large' },
  { name: '非 JSON', bytes: Buffer.from('not json'), reason: 'format' },
  { name: '数组', bytes: jsonBytes([]), reason: 'format' },
  { name: 'null', bytes: jsonBytes(null), reason: 'format' },
  { name: '字符串', bytes: jsonBytes('lottie'), reason: 'format' },
  { name: 'zip / dotLottie', bytes: Buffer.from([0x50, 0x4b, 3, 4, 0, 0]), reason: 'format' },
  ...Object.keys(LOTTIE).map((key) => ({
    name: `缺少 ${key}`,
    bytes: jsonBytes(Object.fromEntries(Object.entries(LOTTIE).filter(([k]) => k !== key))),
    reason: 'format' as const,
  })),
  ...[
    { v: 5 },
    { fr: '30' },
    { fr: 0 },
    { fr: -1 },
    { ip: '30' },
    { op: null },
    { w: '750' },
    { h: false },
    { w: 0 },
    { h: -1 },
    { w: 1.5 },
    { layers: {} },
  ].map((patch) => ({
    name: `非法七键 ${JSON.stringify(patch)}`,
    bytes: lottie(patch),
    reason: 'format' as const,
  })),
  { name: '4 秒', bytes: lottie({ op: 150 }), reason: 'too_long' },
  { name: '3001 ms', bytes: lottie({ fr: 1000, ip: 0, op: 3001 }), reason: 'too_long' },
  { name: 'op 等于 ip', bytes: lottie({ op: 30 }), reason: 'too_long' },
  { name: 'op 小于 ip', bytes: lottie({ op: 29 }), reason: 'too_long' },
  { name: '舍入为 0 ms', bytes: lottie({ fr: 10000, ip: 0, op: 1 }), reason: 'too_long' },
  ...[
    'https://outside.test/a.png',
    'http://outside.test/a.png',
    '//outside.test/a.png',
    'img/a.png',
    '/a.png',
    '../a.png',
  ].map((value) => ({
    name: `外部引用 p=${value}`,
    bytes: lottie({ assets: [{ id: 'image_0', p: value }] }),
    reason: 'external_ref' as const,
  })),
] as const;

export const U_ONLY_LOTTIE = [
  'https://outside.test/a.png',
  'http://outside.test/a.png',
  '//outside.test/a.png',
  'img/a.png',
  '/a.png',
  '../a.png',
].map((u) => ({
  name: `无 p 的 asset 不算引用 u=${u}`,
  bytes: lottie({ assets: [{ id: 'image_0', u }] }),
}));

export const INVALID_IMAGES = [
  { name: 'GIF 冒充 PNG', bytes: Buffer.from('GIF89a') },
  { name: 'WebP 冒充 PNG', bytes: Buffer.from('RIFF\u0000\u0000\u0000\u0000WEBPVP8 ') },
  { name: 'JSON 冒充 PNG', bytes: lottie() },
  { name: 'SVG 冒充 PNG', bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>') },
  { name: '空文件', bytes: Buffer.alloc(0) },
] as const;
