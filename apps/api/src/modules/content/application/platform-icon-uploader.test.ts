import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { FixedClock, MediaStoreUnavailableError, type MediaStore } from '../../platform/index.ts';
import { PlatformIconFieldsError } from './platform-icon-reader.ts';
import {
  PLATFORM_ICON_MAX_BYTES_DEFAULT,
  PlatformIconUploader,
  PlatformIconUploadRejectedError,
  maxBytesOf,
  type PlatformIconUploadRow,
  type PlatformIconUploadStore,
} from './platform-icon-uploader.ts';

const AT = new Date('2026-10-16T00:00:00.000Z');
const ACTOR = { appId: 'app', adminId: 'admin-1', loginName: 'ops', ip: null };
const ID = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5c01';
const SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 2"><path fill="#f00" d="M0 0h2v2H0z"/></svg>',
);

function fake(
  options: { config?: unknown; base?: string | undefined; put?: MediaStore['put'] } = {},
) {
  const events: string[] = [];
  const rows: PlatformIconUploadRow[] = [];
  const store: PlatformIconUploadStore = {
    configValue: vi.fn(() => Promise.resolve(options.config)),
    insertUpload: vi.fn((row: PlatformIconUploadRow) => {
      events.push('insert');
      rows.push(row);
      return Promise.resolve();
    }),
  };
  const put = vi.fn<MediaStore['put']>(
    options.put ??
      (() => {
        events.push('put');
        return Promise.resolve({ url: 'unused' });
      }),
  );
  const uploader = new PlatformIconUploader({
    store,
    media: { put },
    clock: new FixedClock(AT),
    mediaPublicBaseUrl: 'base' in options ? options.base : 'https://media.example.invalid/',
    newId: () => ID,
    monotonicMs: () => 0,
  });
  return { uploader, store, put, events, rows };
}

const read = (bytes: Uint8Array) => () => Promise.resolve({ bytes });

it('[AC-F1-06x#1] stores the row first, then the media, and answers with a 24 h expiry', async () => {
  const { uploader, events, rows, put } = fake();
  const result = await uploader.upload(ACTOR, 'jd', read(SVG));
  expect(events).toEqual(['insert', 'put']);
  // The stored file is the converted / cleaned one, addressed by its own digest.
  const stored = put.mock.calls[0]![0].bytes;
  const sha256 = createHash('sha256').update(stored).digest('hex');
  expect(result).toEqual({
    upload_id: ID,
    url: `https://media.example.invalid/${sha256}.svg`,
    sha256,
    format: 'svg',
    bytes: stored.byteLength,
    sanitized: sha256 !== createHash('sha256').update(SVG).digest('hex'),
    expires_at: '2026-10-17T00:00:00.000Z',
  });
  expect(rows[0]).toMatchObject({ appId: 'app', key: 'jd', createdByAdminId: 'admin-1' });
  expect(rows[0]!.createdAt).toEqual(AT);
  expect(put.mock.calls[0]![0]).toMatchObject({ sha256, contentType: 'image/svg+xml' });
});

it('[AC-F1-06x#3] a failing put is a plain error after the row is stored', async () => {
  const { uploader, rows } = fake({ put: () => Promise.reject(new Error('outage')) });
  await expect(uploader.upload(ACTOR, 'jd', read(SVG))).rejects.toThrow('outage');
  expect(rows).toHaveLength(1);
});

it('[AC-F1-06x#4] a rejected file is 20001 with its reason and touches nothing', async () => {
  const { uploader, rows, put } = fake();
  await expect(uploader.upload(ACTOR, 'jd', read(Buffer.from('GIF89a')))).rejects.toMatchObject({
    reason: 'icon_format_invalid',
  });
  await expect(uploader.upload(ACTOR, 'jd', read(Buffer.from('GIF89a')))).rejects.toBeInstanceOf(
    PlatformIconUploadRejectedError,
  );
  expect(rows).toEqual([]);
  expect(put).not.toHaveBeenCalled();
});

it('[AC-F1-06x#5] the configured limit applies; absent means the default; malformed fails closed', async () => {
  const { uploader } = fake({ config: SVG.length - 1 });
  await expect(uploader.upload(ACTOR, 'jd', read(SVG))).rejects.toMatchObject({
    reason: 'icon_too_large',
  });
  expect(maxBytesOf(undefined)).toBe(PLATFORM_ICON_MAX_BYTES_DEFAULT);
  expect(maxBytesOf(1024)).toBe(1024);
  for (const bad of ['1024', 1.5, -1, null]) expect(() => maxBytesOf(bad)).toThrow();
});

it('[AC-F1-06x#8] an unknown key is 20001 [key] before the file is read', async () => {
  const { uploader } = fake();
  const reader = vi.fn(read(SVG));
  await expect(uploader.upload(ACTOR, 'JD', reader)).rejects.toBeInstanceOf(
    PlatformIconFieldsError,
  );
  expect(reader).not.toHaveBeenCalled();
});

it('[AC-F1-06x#10] without a media base url nothing is stored and the error is MediaStoreUnavailable', async () => {
  const { uploader, rows, put } = fake({ base: undefined });
  await expect(uploader.upload(ACTOR, 'jd', read(SVG))).rejects.toBeInstanceOf(
    MediaStoreUnavailableError,
  );
  expect(rows).toEqual([]);
  expect(put).not.toHaveBeenCalled();
});
