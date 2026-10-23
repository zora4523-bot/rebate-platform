import { crc32, deflateSync } from 'node:zlib';

/** Synthetic one-pixel images: no platform recordings, file I/O or external requests. */
export function chunk(name: string, data: Buffer): Buffer {
  const payload = Buffer.concat([Buffer.from(name, 'ascii'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(payload));
  return Buffer.concat([length, payload, crc]);
}

export const PNG = Buffer.concat([
  Buffer.from('89504e470d0a1a0a', 'hex'),
  chunk('IHDR', Buffer.from('00000001000000010806000000', 'hex')),
  chunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0, 255]))),
  chunk('IEND', Buffer.alloc(0)),
]);

export const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwC/AB//2Q==',
  'base64',
);
