// content/domain/platform-icon — upload inspection for replaceable platform icons (08 BR-TEXT-24
// 细则「上传与发布」, contract adminUploadPlatformIcon; F1-06n orchestrator rulings 3–6, 10).
// Pure: no database, no configuration, no clock — the size limit and the conversion deadline are
// passed in. The format is decided from the bytes alone; PNG is kept unchanged, SVG is converted
// faithfully (use expansion, style rewrite) and then whitelisted, or rejected as a whole.
import { createHash } from 'node:crypto';
import { PNG_SIGNATURE, inspectPng } from './png.ts';
import { IconRejection, type PlatformIconRejectReason } from './rejection.ts';
import { sanitizeSvg } from './svg.ts';

export type { PlatformIconRejectReason } from './rejection.ts';

export interface PlatformIconOptions {
  /** content.platform_icon.max_bytes: limit on the original upload, in bytes. */
  maxBytes: number;
  /** SVG conversion budget; remainingMs() ≤ 0 means expired. */
  deadline: { remainingMs(): number };
}

export type PlatformIconResult =
  | {
      ok: true;
      bytes: Uint8Array;
      sha256: string;
      format: 'svg' | 'png';
      sanitized: boolean;
    }
  | {
      ok: false;
      reason: PlatformIconRejectReason;
    };

const UTF8_BOM = [0xef, 0xbb, 0xbf];
const SVG_STARTS = ['<?xml', '<svg', '<!DOCTYPE', '<!--'];

function startsWith(input: Uint8Array, offset: number, bytes: readonly number[]): boolean {
  if (input.byteLength - offset < bytes.length) return false;
  return bytes.every((byte, index) => input[offset + index] === byte);
}

/** Byte sniffing only: PNG signature, or XML / `<svg` after an optional BOM and whitespace. */
function sniff(input: Uint8Array): 'png' | 'svg' | null {
  if (startsWith(input, 0, PNG_SIGNATURE)) return 'png';
  let offset = startsWith(input, 0, UTF8_BOM) ? UTF8_BOM.length : 0;
  while (offset < input.byteLength && [0x20, 0x09, 0x0a, 0x0d].includes(input[offset]!)) offset++;
  for (const start of SVG_STARTS) {
    const bytes = Array.from(start, (char) => char.charCodeAt(0));
    if (!startsWith(input, offset, bytes)) continue;
    if (start !== '<svg') return 'svg';
    // `<svg` must end the name (`<svg>`, `<svg ...`, `<svg/>`) or be a prefix (`<svg:svg`).
    const next = input[offset + bytes.length];
    if (next !== undefined && [0x20, 0x09, 0x0a, 0x0d, 0x3e, 0x2f, 0x3a].includes(next)) {
      return 'svg';
    }
  }
  return null;
}

export function inspectPlatformIcon(
  input: Uint8Array,
  options: PlatformIconOptions,
): PlatformIconResult {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0) {
    throw new RangeError('maxBytes must be a non-negative integer');
  }
  // The original size is checked before format, parsing and conversion.
  if (input.byteLength > options.maxBytes) return { ok: false, reason: 'icon_too_large' };
  const format = sniff(input);
  if (format === null) return { ok: false, reason: 'icon_format_invalid' };
  let bytes: Uint8Array;
  try {
    if (format === 'png') {
      inspectPng(input);
      bytes = Uint8Array.from(input);
    } else {
      bytes = sanitizeSvg(input, options.maxBytes, options.deadline);
    }
  } catch (error) {
    if (error instanceof IconRejection) return { ok: false, reason: error.reason };
    throw error;
  }
  return {
    ok: true,
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    format,
    sanitized: !Buffer.from(bytes).equals(
      Buffer.from(input.buffer, input.byteOffset, input.byteLength),
    ),
  };
}
