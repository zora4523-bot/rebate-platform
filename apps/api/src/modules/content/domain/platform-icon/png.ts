// PNG inspection (F1-06n ruling 3): chunk structure and IHDR are checked by hand first, so an
// out-of-range edge length is rejected before any pixel is inflated; only then pngjs decodes the
// pixels to verify that all four corners are fully transparent. The file is kept byte for byte.
import { crc32 } from 'node:zlib';
import pngjs from 'pngjs';
import { PNG_MAX_EDGE, PNG_MIN_EDGE } from './policy.ts';
import { invalid } from './rejection.ts';

export const PNG_SIGNATURE: readonly number[] = [137, 80, 78, 71, 13, 10, 26, 10];

const COLOR_TYPES_WITH_ALPHA = new Set([4, 6]);

interface Header {
  readonly width: number;
  readonly height: number;
  readonly colorType: number;
  readonly transparencyChunk: boolean;
}

/** Walks the chunk list: IHDR first, valid CRCs, IEND last, nothing after it. */
function readHeader(png: Buffer): Header {
  let offset = PNG_SIGNATURE.length;
  let header: { width: number; height: number; colorType: number } | null = null;
  let transparencyChunk = false;
  let ended = false;
  while (offset < png.length) {
    if (ended) invalid('data after IEND');
    if (offset + 12 > png.length) invalid('truncated chunk header');
    const length = png.readUInt32BE(offset);
    if (length > 0x7fffffff || offset + 12 + length > png.length) invalid('truncated chunk');
    const type = png.toString('latin1', offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(type)) invalid('bad chunk type');
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (
      crc32(png.subarray(offset + 4, offset + 8 + length)) !== png.readUInt32BE(offset + 8 + length)
    ) {
      invalid(`bad CRC in ${type}`);
    }
    if (header === null) {
      if (type !== 'IHDR' || length !== 13) invalid('IHDR must come first');
      const width = data.readUInt32BE(0);
      const height = data.readUInt32BE(4);
      // Bound the edges before decoding anything (decompression bomb guard).
      for (const edge of [width, height]) {
        if (edge < PNG_MIN_EDGE || edge > PNG_MAX_EDGE) invalid('edge length out of range');
      }
      header = { width, height, colorType: data[9]! };
    } else if (type === 'IHDR') {
      invalid('duplicate IHDR');
    } else if (type === 'tRNS') {
      transparencyChunk = true;
    } else if (type === 'IEND') {
      ended = true;
    }
    offset += 12 + length;
  }
  if (header === null || !ended) invalid('missing IHDR or IEND');
  return { ...header, transparencyChunk };
}

export function inspectPng(input: Uint8Array): void {
  const png = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const header = readHeader(png);
  if (!COLOR_TYPES_WITH_ALPHA.has(header.colorType) && !header.transparencyChunk) {
    invalid('no alpha channel or tRNS');
  }
  let decoded: { width: number; height: number; data: Buffer };
  try {
    // Property access at call time (not a destructured import) keeps the decoder replaceable.
    decoded = pngjs.PNG.sync.read(png);
  } catch {
    invalid('PNG decode failed');
  }
  const { width, height, data } = decoded;
  if (width !== header.width || height !== header.height || data.length !== width * height * 4) {
    invalid('decoded size mismatch');
  }
  for (const pixel of [0, width - 1, (height - 1) * width, height * width - 1]) {
    if (data[pixel * 4 + 3] !== 0) invalid('corner is not fully transparent');
  }
}
