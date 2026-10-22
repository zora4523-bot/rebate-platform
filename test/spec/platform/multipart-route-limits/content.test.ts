import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { digest, lottie } from '../../content/popup-assets/fixtures.ts';
import { BODY_LIMIT, TRACE, filePart } from '../multipart/http-kit.ts';
import { MEDIA_BASE, POPUP, kindPart, rejection, upload, withApp } from './http-kit.ts';

// Behavior and removal of the workaround are one acceptance condition: the old controller can
// already upload, but must fail this test because it still reaches into the plugin's internals.
it('[AC-F1-09t#2] content 删除内部钩子及临时 TODO 后仍接受两部分，缺 kind 和超限保持契约错误', async () => {
  await withApp('content', async (app) => {
    const bytes = lottie();
    const file = filePart(Buffer.from(bytes));
    for (const parts of [
      [kindPart, file],
      [file, kindPart],
    ]) {
      const response = await upload(app, POPUP, parts);
      expect.soft(response.statusCode, 'real popup controller').toBe(200);
      expect.soft(JSON.parse(response.body)).toEqual({
        code: 0,
        msg: '',
        trace_id: TRACE,
        data: {
          url: `${MEDIA_BASE}/${digest(bytes)}.json`,
          sha256: digest(bytes),
          bytes: bytes.length,
          width: 750,
          height: 1000,
          duration_ms: 2400,
        },
      });
      expect.soft(response.headers['x-trace-id']).toBe(TRACE);
    }
    await rejection(await upload(app, POPUP, [file]), 'missing kind', 'kind');
    for (const parts of [
      [kindPart, { name: 'other', bytes: Buffer.from('extra') }, file],
      [kindPart, kindPart, file],
      [kindPart, file, file],
      [file, kindPart, { name: 'other', bytes: Buffer.from('extra') }],
    ]) {
      await rejection(await upload(app, POPUP, parts), 'extra popup field/file/part');
    }
    for (const chunked of [false, true]) {
      await rejection(
        await upload(app, POPUP, [kindPart, filePart(Buffer.alloc(BODY_LIMIT))], { chunked }),
        `whole body including boundaries, chunked=${chunked}`,
        'body',
      );
    }
  });

  // Read-only scan of ALL production content source, so moving/renaming the workaround within
  // the module cannot satisfy the migration. No dependency on a replacement helper's filename.
  const root = new URL('../../../../apps/api/src/modules/content/', import.meta.url);
  const files = readdirSync(root, { recursive: true, encoding: 'utf8' }).filter(
    (name) => name.endsWith('.ts') && !name.endsWith('.test.ts'),
  );
  expect(files.length).toBeGreaterThan(0);
  for (const name of files) {
    const source = readFileSync(new URL(name, root), 'utf8');
    expect
      .soft(source, `no private multipart hook: ${name}`)
      .not.toMatch(
        /multipartHandler|@fastify\/multipart\/(?:lib|index)|getOwnPropertySymbols|Reflect\s*\.\s*ownKeys/,
      );
    expect
      .soft(source, `remove temporary route-limit TODO: ${name}`)
      .not.toMatch(/TODO\(规划\/11 §3\.2\):[^\n]*(?:multipart|per-route)/i);
  }
  // Also inspect the bootstrap/platform source: moving the same private-symbol trick there is
  // not a public-API implementation of the ruling.
  const platform = new URL('../../../../apps/api/src/modules/platform/http/', import.meta.url);
  const platformFiles = readdirSync(platform, { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => new URL(name, platform));
  platformFiles.push(new URL('../../../../apps/api/src/bootstrap.ts', import.meta.url));
  for (const file of platformFiles) {
    expect
      .soft(readFileSync(file, 'utf8'), fileURLToPath(file))
      .not.toMatch(
        /multipartHandler|@fastify\/multipart\/(?:lib|index)|getOwnPropertySymbols|Reflect\s*\.\s*ownKeys/,
      );
  }
});
