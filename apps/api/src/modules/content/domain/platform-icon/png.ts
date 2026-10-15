// PNG inspection (F1-06n ruling 3): chunk structure and IHDR are checked by hand first, so an
// out-of-range edge length is rejected before any pixel is inflated; only then pngjs decodes the
// pixels to verify that all four corners are fully transparent. The file is kept byte for byte.
// Interlaced images: pngjs inflates them without an output cap, so the image data is first
// inflated here with a cap computed from IHDR (Adam7 pass sizes); a larger stream is rejected.
// 16-bit images: alpha is read at its original depth (no 8-bit rescale rounding a 1 down to 0).
import { crc32, inflateSync } from 'node:zlib';
import pngjs from 'pngjs';
import { PNG_MAX_EDGE, PNG_MIN_EDGE } from './policy.ts';
import { invalid } from './rejection.ts';

export const PNG_SIGNATURE: readonly number[] = [137, 80, 78, 71, 13, 10, 26, 10];

const COLOR_TYPES_WITH_ALPHA = new Set([4, 6]);

/** Samples per pixel by colour type (PNG spec table 11.1); other types are invalid. */
const CHANNELS = new Map([
  [0, 1],
  [2, 3],
  [3, 1],
  [4, 2],
  [6, 4],
]);

/** Adam7 passes: [x start, y start, x step, y step]. */
const ADAM7: readonly (readonly [number, number, number, number])[] = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
];

interface Header {
  readonly width: number;
  readonly height: number;
  readonly colorType: number;
  readonly bitDepth: number;
  readonly interlaced: boolean;
  readonly transparencyChunk: boolean;
  /** Concatenated IDAT payloads (the zlib stream). */
  readonly imageData: Buffer;
}

/** Exact inflated size of the filtered image data (filter byte plus packed samples per row). */
export function inflatedSize(
  width: number,
  height: number,
  bitsPerPixel: number,
  interlaced: boolean,
): number {
  const passes: readonly (readonly [number, number, number, number])[] = interlaced
    ? ADAM7
    : [[0, 0, 1, 1]];
  let total = 0;
  for (const [x0, y0, dx, dy] of passes) {
    const passWidth = width > x0 ? Math.ceil((width - x0) / dx) : 0;
    const passHeight = height > y0 ? Math.ceil((height - y0) / dy) : 0;
    if (passWidth === 0 || passHeight === 0) continue;
    total += passHeight * (1 + Math.ceil((passWidth * bitsPerPixel) / 8));
  }
  return total;
}

/** Walks the chunk list: IHDR first, valid CRCs, IEND last, nothing after it. */
function readHeader(png: Buffer): Header {
  let offset = PNG_SIGNATURE.length;
  let header: {
    width: number;
    height: number;
    colorType: number;
    bitDepth: number;
    interlaced: boolean;
  } | null = null;
  let transparencyChunk = false;
  const idat: Buffer[] = [];
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
      const interlace = data[12]!;
      if (interlace !== 0 && interlace !== 1) invalid('unknown interlace method');
      header = {
        width,
        height,
        bitDepth: data[8]!,
        colorType: data[9]!,
        interlaced: interlace === 1,
      };
    } else if (type === 'IHDR') {
      invalid('duplicate IHDR');
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'tRNS') {
      transparencyChunk = true;
    } else if (type === 'IEND') {
      ended = true;
    }
    offset += 12 + length;
  }
  if (header === null || !ended) invalid('missing IHDR or IEND');
  return { ...header, transparencyChunk, imageData: Buffer.concat(idat) };
}

export function inspectPng(input: Uint8Array): void {
  const png = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const header = readHeader(png);
  if (!COLOR_TYPES_WITH_ALPHA.has(header.colorType) && !header.transparencyChunk) {
    invalid('no alpha channel or tRNS');
  }
  if (header.interlaced) {
    // pngjs inflates interlaced data uncapped; prove the stream stays within its exact size first.
    const channels = CHANNELS.get(header.colorType);
    if (channels === undefined || ![1, 2, 4, 8, 16].includes(header.bitDepth)) {
      invalid('bad colour type or bit depth');
    }
    const limit = inflatedSize(header.width, header.height, channels * header.bitDepth, true);
    try {
      inflateSync(header.imageData, { maxOutputLength: limit });
    } catch {
      invalid('interlaced image data inflates beyond its size or is corrupt');
    }
  }
  let decoded: { width: number; height: number; data: Uint8Array | Uint16Array };
  try {
    // Property access at call time (not a destructured import) keeps the decoder replaceable.
    // skipRescale: 16-bit samples stay 16-bit, so alpha is compared at its original depth.
    decoded = pngjs.PNG.sync.read(png, { skipRescale: true }) as {
      width: number;
      height: number;
      data: Uint8Array | Uint16Array;
    };
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
