import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { inspectPopupAsset, POPUP_IMAGE_MAX_BYTES, POPUP_LOTTIE_MAX_BYTES } from './popup-asset.ts';

const BASE = { v: '5.7.4', fr: 25, ip: 0, op: 50, w: 600, h: 800, layers: [] };
const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const lottie = (patch: Record<string, unknown> = {}) => json({ ...BASE, ...patch });
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const PNG_HEAD = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const JPEG_HEAD = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);

it('[AC-F1-09r] a 2 s Lottie passes with its size, duration and digest; bytes are a copy', () => {
  const input = lottie();
  const result = inspectPopupAsset('lottie', input);
  expect(result).toEqual({
    ok: true,
    format: 'json',
    sha256: sha(input),
    bytes: input,
    width: 600,
    height: 800,
    durationMs: 2000,
  });
  if (!result.ok) throw new Error('expected ok');
  expect(result.bytes).not.toBe(input);
});

it('[AC-F1-09r] fractional frame rates use the exact duration', () => {
  expect(inspectPopupAsset('lottie', lottie({ fr: 29.97, op: 89 }))).toMatchObject({
    ok: true,
    durationMs: 2970,
  });
  expect(inspectPopupAsset('lottie', lottie({ fr: 29.97, op: 90 }))).toEqual({
    ok: false,
    reason: 'too_long',
  });
});

it('[AC-F1-09r] shape failures are format: v not a string, w / h not positive int32, bad assets', () => {
  for (const patch of [
    { v: 5 },
    { w: 2_147_483_648 },
    { h: 0 },
    { assets: {} },
    { assets: ['image_0.png'] },
    { layers: null },
  ]) {
    expect(inspectPopupAsset('lottie', lottie(patch)), JSON.stringify(patch)).toEqual({
      ok: false,
      reason: 'format',
    });
  }
  // A key serialised away (undefined) is missing.
  expect(inspectPopupAsset('lottie', json({ ...BASE, layers: undefined }))).toEqual({
    ok: false,
    reason: 'format',
  });
});

it('[AC-F1-09r] references: only a present p that is not a data URI is external', () => {
  expect(
    inspectPopupAsset('lottie', lottie({ assets: [{ p: 'DATA:image/png;base64,AA' }] })),
  ).toMatchObject({ ok: true });
  expect(
    inspectPopupAsset('lottie', lottie({ assets: [{ u: 'https://x.test/', p: 'data:,' }] })),
  ).toMatchObject({ ok: true });
  for (const p of ['', 'a.png', 'ftp://x.test/a.png', 3]) {
    expect(inspectPopupAsset('lottie', lottie({ assets: [{ p }] })), String(p)).toEqual({
      ok: false,
      reason: 'external_ref',
    });
  }
});

it('[AC-F1-09r] a UTF-8 BOM is tolerated; the limit counts bytes, not characters', () => {
  const body = lottie();
  const bom = Uint8Array.from([0xef, 0xbb, 0xbf, ...body]);
  expect(inspectPopupAsset('lottie', bom)).toMatchObject({ ok: true, sha256: sha(bom) });
  const padded = new Uint8Array(POPUP_LOTTIE_MAX_BYTES + 1).fill(0x20);
  padded.set(body);
  expect(inspectPopupAsset('lottie', padded)).toEqual({ ok: false, reason: 'too_large' });
});

it('[AC-F1-09r] images: PNG / JPEG by signature up to the limit; anything else is format', () => {
  expect(inspectPopupAsset('image', PNG_HEAD)).toMatchObject({ ok: true, format: 'png' });
  expect(inspectPopupAsset('image', JPEG_HEAD)).toMatchObject({ ok: true, format: 'jpg' });
  expect(inspectPopupAsset('image', PNG_HEAD.subarray(0, 7))).toEqual({
    ok: false,
    reason: 'format',
  });
  expect(inspectPopupAsset('image', lottie())).toEqual({ ok: false, reason: 'format' });
  const big = new Uint8Array(POPUP_IMAGE_MAX_BYTES + 1);
  big.set(PNG_HEAD);
  expect(inspectPopupAsset('image', big)).toEqual({ ok: false, reason: 'too_large' });
});
