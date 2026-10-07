// platform/qrcode — QR code rendering primitive (B1-01zf). Encoding and rendering only: the deep
// link, the poster template, cache keys and OSS uploads belong to the poster and preview tasks
// (规划/01 F-SHARE-01; 规划/02 §11 poster queue; 规划/04 §3.2 page_preview_tokens). No clock, no
// logging, no database, no process.env. Library: qrcode 1.5.4 (MIT; B1-01ze).
import QRCode from 'qrcode';

export type QrErrorCorrection = 'L' | 'M' | 'Q' | 'H';

export interface QrCodeOptions {
  /** Error correction level, default 'M'. */
  readonly errorCorrection?: QrErrorCorrection;
  /** Edge length of the rendered image in pixels: integer in [64, 2048], default 512. */
  readonly size?: number;
  /** Quiet zone in modules: integer in [0, 8], default 2. */
  readonly margin?: number;
}

export type QrCodeErrorCode = 'empty_text' | 'text_too_long' | 'invalid_option' | 'encode_failed';

export class QrCodeError extends Error {
  readonly code: QrCodeErrorCode;
  constructor(code: QrCodeErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'QrCodeError';
    this.code = code;
  }
}

/** Longest text accepted, in UTF-8 bytes (a deep link is well under 200). */
export const QR_TEXT_MAX_BYTES = 1024;
export const QR_SIZE_MIN = 64;
export const QR_SIZE_MAX = 2048;
export const QR_MARGIN_MIN = 0;
export const QR_MARGIN_MAX = 8;

const LEVELS: ReadonlySet<string> = new Set(['L', 'M', 'Q', 'H']);

type Resolved = { errorCorrectionLevel: QrErrorCorrection; width: number; margin: number };

function resolve(text: string, options: QrCodeOptions | undefined): Resolved {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new QrCodeError('empty_text', 'the text to encode is empty');
  }
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > QR_TEXT_MAX_BYTES) {
    throw new QrCodeError(
      'text_too_long',
      `the text is ${bytes} UTF-8 bytes, more than ${QR_TEXT_MAX_BYTES}`,
    );
  }
  // An option left out takes its default; an explicit null (or any other wrong type) is refused.
  const level: unknown = options?.errorCorrection === undefined ? 'M' : options.errorCorrection;
  if (typeof level !== 'string' || !LEVELS.has(level)) {
    throw new QrCodeError('invalid_option', `errorCorrection must be L, M, Q or H`);
  }
  const size: unknown = options?.size === undefined ? 512 : options.size;
  if (
    typeof size !== 'number' ||
    !Number.isInteger(size) ||
    size < QR_SIZE_MIN ||
    size > QR_SIZE_MAX
  ) {
    throw new QrCodeError(
      'invalid_option',
      `size must be an integer in [${QR_SIZE_MIN}, ${QR_SIZE_MAX}]`,
    );
  }
  const margin: unknown = options?.margin === undefined ? 2 : options.margin;
  if (
    typeof margin !== 'number' ||
    !Number.isInteger(margin) ||
    margin < QR_MARGIN_MIN ||
    margin > QR_MARGIN_MAX
  ) {
    throw new QrCodeError(
      'invalid_option',
      `margin must be an integer in [${QR_MARGIN_MIN}, ${QR_MARGIN_MAX}]`,
    );
  }
  return { errorCorrectionLevel: level as QrErrorCorrection, width: size, margin };
}

/**
 * The smallest `size` that renders this symbol at one pixel per module: modules + 2 × margin. Below it
 * the library ignores `width` and the image comes out larger than asked (qrcode README, renderer
 * options), so the caller gets an error instead of an unexpected size.
 */
export function minimumQrCodeSize(text: string, options?: QrCodeOptions): number {
  const r = resolve(text, options);
  return moduleCount(text, r) + 2 * r.margin;
}

/** Modules per side of the symbol for this text and level; a library failure becomes encode_failed. */
function moduleCount(text: string, r: Resolved): number {
  try {
    return QRCode.create(text, { errorCorrectionLevel: r.errorCorrectionLevel }).modules.size;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new QrCodeError('encode_failed', `QR encoding failed: ${message}`, { cause });
  }
}

function resolveWithMinimum(text: string, options: QrCodeOptions | undefined): Resolved {
  const r = resolve(text, options);
  const modules = moduleCount(text, r);
  const minimum = modules + 2 * r.margin;
  if (r.width < minimum) {
    throw new QrCodeError(
      'invalid_option',
      `size ${r.width} is below the minimum ${minimum} for this content (${modules} modules + 2 × margin ${r.margin})`,
    );
  }
  return r;
}

async function encode<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new QrCodeError('encode_failed', `QR encoding failed: ${message}`, { cause });
  }
}

/** The QR code as a complete `<svg>` document: width and height equal `size`, the viewBox is in modules. */
export async function renderQrCodeSvg(text: string, options?: QrCodeOptions): Promise<string> {
  const r = resolveWithMinimum(text, options);
  return encode(() => QRCode.toString(text, { type: 'svg', ...r }));
}

/** The QR code as a PNG (`size` × `size` pixels). */
export async function renderQrCodePng(text: string, options?: QrCodeOptions): Promise<Buffer> {
  const r = resolveWithMinimum(text, options);
  // qrcode 1.5.4 sizes the PNG as floor(N × (width / N)) (N = modules + 2 × margin), which loses a
  // pixel to floating point for many (N, width) pairs (512 → 511). Only for those pairs, half a pixel
  // more makes the floor land on `size` (checked for every pair in range); the others render exactly
  // as the library does.
  const n = moduleCount(text, r) + 2 * r.margin;
  const width = Math.floor(n * (r.width / n)) === r.width ? r.width : r.width + 0.5;
  return encode(() => QRCode.toBuffer(text, { type: 'png', ...r, width }));
}
