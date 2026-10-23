// The 花卷云 ignore screenshot of a PID activation (B1-22h; BR-ATTR-02 细则「后台修改与启用的裁定」,
// BR-ATTR-28; contract adminActivateUnionPid): PNG or JPEG only, at most 5 MiB. The type is judged
// from the bytes themselves, never from the client's declared Content-Type or filename:
//   - PNG: the 8-byte signature, IHDR as the first chunk, every chunk inside the buffer with a
//     matching CRC-32, ending with IEND and nothing after it;
//   - JPEG: SOI, well-formed marker segments up to a start of scan, and EOI as the last two bytes.
// The 5 MiB ceiling is independent of the HTTP body limit (the request may be refused earlier).
// Pure function: no Nest, no data access.
import { crc32 } from 'node:zlib';

export type HjyEvidenceCheck =
  | { readonly valid: true; readonly contentType: 'image/png' | 'image/jpeg' }
  | { readonly valid: false };

/** BR-ATTR-02 细则: at most 5 MB, read as 5 MiB. */
export const HJY_EVIDENCE_MAX_BYTES = 5 * 1024 * 1024;

const INVALID: HjyEvidenceCheck = Object.freeze({ valid: false });
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function uint32(bytes: Uint8Array, at: number): number {
  return (
    ((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0
  );
}

function chunkType(bytes: Uint8Array, at: number): string {
  return String.fromCharCode(bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!);
}

function isPng(bytes: Uint8Array): boolean {
  if (bytes.length < PNG_SIGNATURE.length) return false;
  for (let i = 0; i < PNG_SIGNATURE.length; i += 1) {
    if (bytes[i] !== PNG_SIGNATURE[i]) return false;
  }
  let at = PNG_SIGNATURE.length;
  let first = true;
  while (at + 12 <= bytes.length) {
    const length = uint32(bytes, at);
    const end = at + 12 + length;
    if (end > bytes.length) return false;
    const type = chunkType(bytes, at + 4);
    if (!/^[A-Za-z]{4}$/.test(type)) return false;
    if (first && (type !== 'IHDR' || length !== 13)) return false;
    first = false;
    const crc = uint32(bytes, at + 8 + length);
    if (crc32(bytes.subarray(at + 4, at + 8 + length)) !== crc) return false;
    at = end;
    if (type === 'IEND') return at === bytes.length;
  }
  return false;
}

function isJpeg(bytes: Uint8Array): boolean {
  const n = bytes.length;
  if (n < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return false;
  if (bytes[n - 2] !== 0xff || bytes[n - 1] !== 0xd9) return false;
  let at = 2;
  while (at < n) {
    if (bytes[at] !== 0xff) return false;
    // Fill bytes (0xFF) may precede a marker.
    while (at < n && bytes[at] === 0xff) at += 1;
    if (at >= n) return false;
    const marker = bytes[at]!;
    at += 1;
    if (marker === 0x00 || marker === 0xd8 || marker === 0xd9) return false;
    // Standalone markers (TEM, RSTn) carry no length.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (at + 2 > n) return false;
    const length = (bytes[at]! << 8) | bytes[at + 1]!;
    if (length < 2 || at + length > n) return false;
    at += length;
    // Start of scan: entropy-coded data follows up to the final EOI checked above.
    if (marker === 0xda) return at <= n - 2;
  }
  return false;
}

/** BR-ATTR-02: screenshot format and 5 MiB ceiling, independent of the HTTP body limit. */
export function inspectHjyIgnoreEvidence(bytes: Uint8Array): HjyEvidenceCheck {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) return INVALID;
  if (bytes.length > HJY_EVIDENCE_MAX_BYTES) return INVALID;
  if (isPng(bytes)) return { valid: true, contentType: 'image/png' };
  if (isJpeg(bytes)) return { valid: true, contentType: 'image/jpeg' };
  return INVALID;
}
