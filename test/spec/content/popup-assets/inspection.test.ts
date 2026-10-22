import { expect, it } from 'vitest';
import { inspectPopupAsset } from '../../../../apps/api/src/modules/content/domain/popup-asset.ts';
import {
  digest,
  INVALID_IMAGES,
  INVALID_LOTTIE,
  JPEG,
  lottie,
  PNG,
  U_ONLY_LOTTIE,
} from './fixtures.ts';

it.each([180 * 1024, 300_001, 307_200])(
  '[AC-F1-09r#1] Lottie %i 字节通过：300 KiB 含边界、按 op-ip 计算、保留原始内容摘要',
  (size) => {
    const input = lottie({}, size);
    const result = inspectPopupAsset('lottie', input);
    expect(result).toMatchObject({
      ok: true,
      format: 'json',
      sha256: digest(input),
      width: 750,
      height: 1000,
      durationMs: 2400,
    });
    if (!result.ok) throw new Error('expected valid Lottie');
    expect(Buffer.from(result.bytes)).toEqual(input);
  },
);

it.each(INVALID_LOTTIE)('[AC-F1-09r#2] Lottie 拒收 $name → $reason', ({ bytes, reason }) => {
  expect(inspectPopupAsset('lottie', bytes)).toEqual({ ok: false, reason });
});

it.each([
  { name: '3000 ms', patch: { op: 120 }, durationMs: 3000 },
  { name: '四舍五入而非截断', patch: { fr: 60, ip: 0, op: 1 }, durationMs: 17 },
  {
    name: '2.4004 秒四舍五入而非向上取整',
    patch: { fr: 10_000, ip: 10_000, op: 34_004 },
    durationMs: 2400,
  },
  {
    name: '内嵌图片',
    patch: { assets: [{ p: `data:image/png;base64,${PNG.toString('base64')}` }] },
    durationMs: 2400,
  },
  {
    name: '无图片的合成资源',
    patch: { assets: [{ id: 'precomp', layers: [] }] },
    durationMs: 2400,
  },
])('[AC-F1-09r#3] $name 可接收', ({ patch, durationMs }) => {
  expect(inspectPopupAsset('lottie', lottie(patch))).toMatchObject({ ok: true, durationMs });
});

it('[AC-F1-09r#4] 非法 UTF-8 即使替换字符后能解析 JSON 也按 format 拒收', () => {
  const input = Buffer.concat([
    lottie().subarray(0, -1),
    Buffer.from(',"nm":"'),
    Buffer.from([0xc3, 0x28]),
    Buffer.from('"}'),
  ]);
  expect(inspectPopupAsset('lottie', input)).toEqual({ ok: false, reason: 'format' });
});

it.each([
  { name: 'size 优先于 format', bytes: Buffer.alloc(307_201), reason: 'too_large' },
  {
    name: 'format 优先于时长与引用',
    bytes: lottie({ v: false, op: 150, assets: [{ p: 'a.png' }] }),
    reason: 'format',
  },
  {
    name: '时长优先于引用',
    bytes: lottie({ op: 150, assets: [{ p: 'a.png' }] }),
    reason: 'too_long',
  },
])('[AC-F1-09r#5] 首个拒收原因：$name', ({ bytes, reason }) => {
  expect(inspectPopupAsset('lottie', bytes)).toEqual({ ok: false, reason });
});

it.each([
  { bytes: PNG, format: 'png' },
  { bytes: JPEG, format: 'jpg' },
])('[AC-F1-09r#6] 图片 $format 按魔数接收并保留原始字节与摘要', ({ bytes, format }) => {
  const result = inspectPopupAsset('image', bytes);
  expect(result).toMatchObject({ ok: true, format, sha256: digest(bytes) });
  if (!result.ok) throw new Error('expected valid image');
  expect(Buffer.from(result.bytes)).toEqual(bytes);
});

it.each(INVALID_IMAGES)('[AC-F1-09r#7] 图片 $name 拒收 format', ({ bytes }) => {
  expect(inspectPopupAsset('image', bytes)).toEqual({ ok: false, reason: 'format' });
});

it.each([1_000_000, 1_048_577])('[AC-F1-09r#8] 图片 %i 字节的独立文件大小边界', (size) => {
  const input = Buffer.concat([PNG, Buffer.alloc(size - PNG.length)]);
  const result = inspectPopupAsset('image', input);
  if (size === 1_000_000)
    expect(result).toMatchObject({ ok: true, format: 'png', sha256: digest(input) });
  else expect(result).toEqual({ ok: false, reason: 'too_large' });
});

it('[AC-F1-09r#9] 只读取 Uint8Array 视图范围，摘要不含前后缓冲区', () => {
  const input = lottie();
  const backing = Buffer.concat([Buffer.from('not-json'), input, Buffer.from('trailer')]);
  const view = new Uint8Array(backing.buffer, backing.byteOffset + 8, input.length);
  expect(inspectPopupAsset('lottie', view)).toMatchObject({
    ok: true,
    sha256: digest(input),
    durationMs: 2400,
  });
});

it.each(['', 'images/'])(
  '[AC-F1-09r#30] 内嵌图片 p 为 data URI 时 u=%j 不影响接收',
  (u) => {
    const input = lottie({
      assets: [{ u, p: `data:image/png;base64,${PNG.toString('base64')}` }],
    });
    expect(inspectPopupAsset('lottie', input)).toMatchObject({
      ok: true,
      durationMs: 2400,
      sha256: digest(input),
    });
  },
);

it.each([
  { name: '恰为 3 秒', op: 40_000 },
  { name: '2.9996 秒四舍五入为 3000 ms', op: 39_996 },
])('[AC-F1-09r#31] $name 通过，先判精确时长再四舍五入', ({ op }) => {
  expect(inspectPopupAsset('lottie', lottie({ fr: 10_000, ip: 10_000, op }))).toMatchObject({
    ok: true,
    durationMs: 3000,
  });
});

it('[AC-F1-09r#32] 3.0004 秒即使四舍五入为 3000 ms 仍拒收 too_long', () => {
  expect(
    inspectPopupAsset('lottie', lottie({ fr: 10_000, ip: 10_000, op: 40_004 })),
  ).toEqual({ ok: false, reason: 'too_long' });
});

it.each(U_ONLY_LOTTIE)('[AC-F1-09r#35] $name 可接收', ({ bytes }) => {
  expect(inspectPopupAsset('lottie', bytes)).toMatchObject({ ok: true, durationMs: 2400 });
});
