import { createHash } from 'node:crypto';
import { pino } from 'pino';
import { expect, it, vi } from 'vitest';
import {
  MediaStoreUnavailableError,
  type AuditInput,
  type MediaStore,
} from '../../platform/index.ts';
import {
  PopupAssetFieldsError,
  PopupAssetRejectedError,
  PopupAssetUploader,
  type PopupAssetParts,
} from './popup-asset-uploader.ts';

const ACTOR = { appId: 'app', adminId: 'admin-1', ip: '127.0.0.1' };
const BASE = 'https://media.example.invalid/m/';
const LOTTIE = new TextEncoder().encode(
  JSON.stringify({ v: '5', fr: 30, ip: 0, op: 60, w: 750, h: 1000, layers: [], nm: 'secret' }),
);
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function fake(options: { base?: string | undefined; put?: MediaStore['put'] } = {}) {
  const events: string[] = [];
  const audits: AuditInput[] = [];
  const lines: string[] = [];
  const put = vi.fn<MediaStore['put']>(
    options.put ??
      (() => {
        events.push('put');
        return Promise.resolve({ url: 'unused' });
      }),
  );
  const uploader = new PopupAssetUploader({
    media: { put },
    audit: {
      append: (input) => {
        events.push('audit');
        audits.push(input);
        return Promise.resolve();
      },
    },
    mediaPublicBaseUrl: 'base' in options ? options.base : BASE,
    logger: pino({ level: 'info' }, { write: (line: string) => void lines.push(line) }),
  });
  return { uploader, put, events, audits, lines };
}

const read = (parts: PopupAssetParts) => () => Promise.resolve(parts);

it('[AC-F1-09r] a Lottie is stored under its digest, then audited with kind / sha256 / bytes', async () => {
  const { uploader, put, events, audits, lines } = fake();
  const result = await uploader.upload(ACTOR, read({ kind: 'lottie', file: LOTTIE }));
  const sha256 = sha(LOTTIE);
  expect(result).toEqual({
    url: `${BASE}${sha256}.json`,
    sha256,
    bytes: LOTTIE.length,
    width: 750,
    height: 1000,
    duration_ms: 2000,
  });
  expect(events).toEqual(['put', 'audit']);
  expect(put).toHaveBeenCalledWith({
    sha256,
    bytes: expect.any(Uint8Array),
    contentType: 'application/json',
  });
  expect(audits).toEqual([
    {
      appId: 'app',
      actor: 'admin-1',
      action: 'page_popup_asset_upload',
      target: sha256,
      before: null,
      after: { kind: 'lottie', sha256, bytes: LOTTIE.length },
      ip: '127.0.0.1',
    },
  ]);
  expect(lines.join('')).toContain(sha256);
  expect(lines.join('')).not.toContain('secret');
});

it('[AC-F1-09r] a PNG answers url / sha256 / bytes only and is stored as image/png', async () => {
  const { uploader, put } = fake();
  const sha256 = sha(PNG);
  expect(await uploader.upload(ACTOR, read({ kind: 'image', file: PNG }))).toEqual({
    url: `${BASE}${sha256}.png`,
    sha256,
    bytes: PNG.length,
  });
  expect(put.mock.calls[0]![0].contentType).toBe('image/png');
});

it('[AC-F1-09r] kind is checked before the file; rejections write nothing', async () => {
  for (const kind of [undefined, '', 'LOTTIE', 'video', ['lottie']]) {
    const { uploader, events } = fake();
    await expect(uploader.upload(ACTOR, read({ kind, file: LOTTIE }))).rejects.toEqual(
      new PopupAssetFieldsError(['kind']),
    );
    expect(events).toEqual([]);
  }
  const { uploader, events } = fake();
  await expect(uploader.upload(ACTOR, read({ kind: 'image', file: undefined }))).rejects.toEqual(
    new PopupAssetFieldsError(['file']),
  );
  const rejected = uploader.upload(ACTOR, read({ kind: 'image', file: LOTTIE }));
  await expect(rejected).rejects.toBeInstanceOf(PopupAssetRejectedError);
  await expect(rejected).rejects.toMatchObject({ reason: 'format' });
  expect(events).toEqual([]);
});

it('[AC-F1-09r] no media base or a failing put is a server error without an audit row', async () => {
  const none = fake({ base: undefined });
  await expect(
    none.uploader.upload(ACTOR, read({ kind: 'image', file: PNG })),
  ).rejects.toBeInstanceOf(MediaStoreUnavailableError);
  expect(none.events).toEqual([]);
  const failing = fake({ put: () => Promise.reject(new Error('down')) });
  await expect(failing.uploader.upload(ACTOR, read({ kind: 'image', file: PNG }))).rejects.toThrow(
    'down',
  );
  expect(failing.audits).toEqual([]);
});
