// F1-09r / BR-TEXT-26 细则「素材与校验」: checks one home popup asset before it is stored
// (contract adminUploadPopupAsset; 编排裁定 9.2 2–3, D10-126).
//   - kind=lottie: at most 307 200 bytes (300 KB) → strict UTF-8 → one JSON object with v (string),
//     fr (number > 0), ip / op (numbers), w / h (positive int32) and layers (array); assets, when
//     present, an array of objects. Duration (op − ip) ÷ fr is compared exactly: not above 0, above
//     3 seconds, or rounding to 0 ms → too_long. An asset whose `p` is present and not a data URI is
//     an external reference (a web address, protocol-relative, absolute or relative path); `u` is
//     never looked at (Bodymovin's inlined images are `u: ""` with `p: "data:…"`), and an asset
//     without `p` (a precomposition) refers to no file. dotLottie (a zip) is not JSON → format.
//     First failing check wins: too_large → format → too_long → external_ref.
//   - kind=image: at most 1 000 000 bytes, then PNG or JPEG judged by the file signature only
//     (never the filename or the part's declared type) → too_large / format.
// The digest and the returned bytes cover the view's own range only (byteOffset / byteLength).
// Pure: no I/O, no clock.
import { createHash } from 'node:crypto';

export type PopupAssetKind = 'lottie' | 'image';
export type PopupAssetRejectReason = 'format' | 'too_large' | 'too_long' | 'external_ref';

export type PopupAssetResult =
  | { readonly ok: false; readonly reason: PopupAssetRejectReason }
  | {
      readonly ok: true;
      readonly format: 'json' | 'png' | 'jpg';
      readonly sha256: string;
      readonly bytes: Uint8Array;
      readonly width?: number;
      readonly height?: number;
      readonly durationMs?: number;
    };

/** 300 KB of BR-TEXT-26, in bytes (300 × 1024). */
export const POPUP_LOTTIE_MAX_BYTES = 307_200;
/** The fallback picture limit (编排裁定 9.2 2: 1 MB taken as 1 000 000 bytes). */
export const POPUP_IMAGE_MAX_BYTES = 1_000_000;
/** Longest accepted animation, in seconds. */
export const POPUP_LOTTIE_MAX_SECONDS = 3;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff] as const;

type Rejection = { readonly ok: false; readonly reason: PopupAssetRejectReason };

const reject = (reason: PopupAssetRejectReason): Rejection => ({ ok: false, reason });

function startsWith(input: Uint8Array, signature: readonly number[]): boolean {
  return input.length >= signature.length && signature.every((byte, i) => input[i] === byte);
}

function digestOf(input: Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/** A positive int32 (the response's width / height are int32). */
const isPositiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 2_147_483_647;

interface Lottie {
  readonly fr: number;
  readonly ip: number;
  readonly op: number;
  readonly w: number;
  readonly h: number;
  readonly assets: readonly Record<string, unknown>[];
}

/** The parsed document when it is a Lottie JSON object of the required shape; else undefined. */
function parseLottie(input: Uint8Array): Lottie | undefined {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(input);
  } catch {
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  const own = (key: string): unknown => (Object.hasOwn(value, key) ? value[key] : undefined);
  const v = own('v');
  const fr = own('fr');
  const ip = own('ip');
  const op = own('op');
  const w = own('w');
  const h = own('h');
  const layers = own('layers');
  const assets = own('assets');
  if (typeof v !== 'string') return undefined;
  if (!isNumber(fr) || fr <= 0 || !isNumber(ip) || !isNumber(op)) return undefined;
  if (!isPositiveInteger(w) || !isPositiveInteger(h) || !Array.isArray(layers)) return undefined;
  if (assets !== undefined && !(Array.isArray(assets) && assets.every(isRecord))) return undefined;
  return { fr, ip, op, w, h, assets: assets ?? [] };
}

/** A present `p` that is not a data URI names a file outside the document. */
function refersOutside(asset: Record<string, unknown>): boolean {
  if (!Object.hasOwn(asset, 'p')) return false;
  const p = asset['p'];
  return typeof p !== 'string' || !/^data:/i.test(p);
}

function inspectLottie(input: Uint8Array): PopupAssetResult {
  if (input.byteLength > POPUP_LOTTIE_MAX_BYTES) return reject('too_large');
  const lottie = parseLottie(input);
  if (lottie === undefined) return reject('format');
  const frames = lottie.op - lottie.ip;
  // Exact comparison before any rounding: 3.0004 s is too long although it rounds to 3000 ms.
  if (frames <= 0 || frames > POPUP_LOTTIE_MAX_SECONDS * lottie.fr) return reject('too_long');
  const durationMs = Math.round((frames * 1000) / lottie.fr);
  if (durationMs <= 0) return reject('too_long');
  if (lottie.assets.some(refersOutside)) return reject('external_ref');
  return {
    ok: true,
    format: 'json',
    sha256: digestOf(input),
    bytes: input.slice(),
    width: lottie.w,
    height: lottie.h,
    durationMs,
  };
}

function inspectImage(input: Uint8Array): PopupAssetResult {
  if (input.byteLength > POPUP_IMAGE_MAX_BYTES) return reject('too_large');
  const format = startsWith(input, PNG_SIGNATURE)
    ? 'png'
    : startsWith(input, JPEG_SIGNATURE)
      ? 'jpg'
      : undefined;
  if (format === undefined) return reject('format');
  return { ok: true, format, sha256: digestOf(input), bytes: input.slice() };
}

/** Checks one uploaded popup asset; the accepted result carries a copy of the bytes. */
export function inspectPopupAsset(kind: PopupAssetKind, input: Uint8Array): PopupAssetResult {
  return kind === 'lottie' ? inspectLottie(input) : inspectImage(input);
}
