import { crc32 } from 'node:zlib';
import { requireApi } from './kit.ts';

interface Pixels {
  width: number;
  height: number;
  data: Buffer;
}

export const PNG = (
  requireApi('pngjs') as {
    PNG: {
      sync: {
        write(pixels: Pixels, options: { colorType: number; inputColorType: number }): Buffer;
        read(input: Buffer): Pixels;
      };
    };
  }
).PNG;

export function png(width = 512, height = 512, colorType = 6, opaqueCorner = -1): Buffer {
  const data = Buffer.alloc(width * height * 4);
  // Visible red artwork, surrounded by transparent black.
  const center = (Math.floor(height / 2) * width + Math.floor(width / 2)) * 4;
  data[center] = 255;
  data[center + 3] = 255;
  const corners = [0, width - 1, (height - 1) * width, height * width - 1];
  if (opaqueCorner >= 0) data[corners[opaqueCorner]! * 4 + 3] = 255;
  return PNG.sync.write({ width, height, data }, { colorType, inputColorType: 6 });
}

export function chunk(name: string, data: Buffer): Buffer {
  const typeAndData = Buffer.concat([Buffer.from(name, 'ascii'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

export function transparentRgbPng(): Buffer {
  // pngjs writes RGB but does not encode tRNS; add the legal transparent RGB sample (white).
  // With no alpha in the output, pngjs composites transparent pixels on white by default.
  const source = png(512, 512, 2);
  const transparent = Buffer.from([0, 255, 0, 255, 0, 255]);
  return Buffer.concat([source.subarray(0, 33), chunk('tRNS', transparent), source.subarray(33)]);
}

export function withDimensions(source: Buffer, width: number, height: number): Buffer {
  const ihdr = Buffer.from(source.subarray(16, 29));
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  return Buffer.concat([source.subarray(0, 8), chunk('IHDR', ihdr), source.subarray(33)]);
}
