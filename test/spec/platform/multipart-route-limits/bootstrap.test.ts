import { expect, it } from 'vitest';
import { BODY_LIMIT, BYTES, filePart } from '../multipart/http-kit.ts';
import { ICON, POPUP, kindPart, rejection, upload, withApp } from './http-kit.ts';

// One migration invariant: granting the exception and retaining the defaults must land together.
// Soft assertions execute the entire matrix against the old implementation, including negatives
// that already work. The old bootstrap fails on the ordinary kind + file consumer (HTTP 400).
it('[AC-F1-09t#1] bootstrap 只为 POST popup-assets 放宽到一文件一字段两分段，其余保持原上限', async () => {
  await withApp('probe', async (app) => {
    const field = { type: 'field', name: 'kind', value: 'lottie' };
    const file = { type: 'file', name: 'file', bytes: BYTES.length };
    for (const url of [POPUP, `${POPUP}?source=console`]) {
      for (const fileFirst of [false, true]) {
        const parts = fileFirst ? [filePart(), kindPart] : [kindPart, filePart()];
        const response = await upload(app, url, parts);
        expect.soft(response.statusCode, `${url}, fileFirst=${fileFirst}`).toBe(201);
        expect.soft(JSON.parse(response.body)).toEqual({
          parts: fileFirst ? [file, field] : [field, file],
          bodyWasUndefined: true,
        });
      }
    }

    // Two fields/files fit inside two parts: these isolate fields/files from the parts cap.
    // Three-part cases also exercise the parts cap. The public envelope stays the same
    // regardless of which overlapping plugin limit rejects first.
    for (const parts of [
      [kindPart, { name: 'other', bytes: Buffer.from('extra') }],
      [filePart(), filePart()],
      [kindPart, filePart(), { name: 'other', bytes: Buffer.from('extra') }],
      [kindPart, filePart(), filePart()],
    ]) {
      await rejection(await upload(app, POPUP, parts), `popup excess: ${parts.length} parts`);
    }

    // Raw plugin consumers deliberately do not use readSingleUpload: that helper would hide an
    // accidentally widened global configuration by rejecting the same extra part itself.
    const defaults = [
      { url: ICON, method: 'POST' as const },
      { url: '/admin/v1/unlisted-uploads', method: 'POST' as const },
      { url: `${POPUP}/extra`, method: 'POST' as const },
      { url: POPUP, method: 'PUT' as const },
    ];
    for (const route of defaults) {
      const valid = await upload(app, route.url, [filePart()], route);
      expect
        .soft(valid.statusCode, `${route.method} ${route.url}: one file`)
        .toBe(route.method === 'POST' ? 201 : 200);
      expect.soft(JSON.parse(valid.body)).toEqual({ parts: [file], bodyWasUndefined: true });
      for (const parts of [
        [kindPart],
        [kindPart, filePart()],
        [filePart(), kindPart],
        [filePart(), filePart()],
      ]) {
        await rejection(await upload(app, route.url, parts, route), `${route.method} ${route.url}`);
      }
    }

    // Per-request exception must not leak to the next request or another concurrent route.
    const [popup, icon] = await Promise.all([
      upload(app, POPUP, [kindPart, filePart()]),
      upload(app, ICON, [kindPart, filePart()]),
    ]);
    expect.soft(popup.statusCode, 'concurrent popup').toBe(201);
    await rejection(icon, 'concurrent icon');
    await rejection(await upload(app, ICON, [kindPart]), 'icon after popup');

    // The exception must retain fileSize=bodyLimit; exercise the plugin itself with a stream.
    for (const route of [POPUP, ICON]) {
      const allowed = await upload(app, route, [filePart(Buffer.alloc(BODY_LIMIT - 1024))]);
      expect.soft(allowed.statusCode, `${route}: below file cap`).toBe(201);
      expect.soft(JSON.parse(allowed.body)).toMatchObject({
        parts: [{ type: 'file', name: 'file', bytes: BODY_LIMIT - 1024 }],
      });
      await rejection(
        await upload(app, route, [filePart(Buffer.alloc(BODY_LIMIT + 1))], { chunked: true }),
        `${route}: file cap retained`,
        'body',
      );
    }
  });
});
