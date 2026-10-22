import { Controller, Post, Req } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { AppModule } from '../../../../app.module.ts';
import { createHttpApp } from '../../../../bootstrap.ts';
import {
  FixedClock,
  createRootLogger,
  loadConfig,
  type SingleUploadRequest,
} from '../../../platform/index.ts';
import { PopupAssetPartsRejection, readPopupAssetParts } from './popup-asset-parts.ts';

const BOUNDARY = 'popup-unit-boundary';

class PartsProbe {
  async read(request: SingleUploadRequest): Promise<object> {
    try {
      const parts = await readPopupAssetParts(request);
      return { kind: parts.kind ?? null, size: parts.file?.byteLength ?? null };
    } catch (error) {
      if (error instanceof PopupAssetPartsRejection) {
        return { status: error.statusCode, field: error.field };
      }
      // The plugin's own client errors reach the global filter unchanged (400 / 413 there).
      const code = (error as { code?: unknown } | null)?.code;
      if (error instanceof Error && error.name === 'FastifyError' && typeof code === 'string') {
        return { plugin: code };
      }
      return { error: error instanceof Error ? error.name : 'unknown' };
    }
  }
}
{
  const prototype = PartsProbe.prototype;
  const read = Object.getOwnPropertyDescriptor(prototype, 'read')!;
  Req()(prototype, 'read', 0);
  Post()(prototype, 'read', read);
  Controller('__popup_parts')(PartsProbe);
}

let app: NestFastifyApplication | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  vi.restoreAllMocks();
});

/** The admin entry (real multipart limits), with `parts` wrapped without its arguments. */
async function start(): Promise<NestFastifyApplication> {
  const original = AppModule.forEntry.bind(AppModule);
  vi.spyOn(AppModule, 'forEntry').mockImplementationOnce((options) => {
    const module = original(options);
    return { ...module, controllers: [...(module.controllers ?? []), PartsProbe] };
  });
  app = await createHttpApp('admin', {
    config: loadConfig({ APP_ENV: 'test' }),
    clock: new FixedClock('2026-10-22T00:00:00Z'),
    logger: createRootLogger({ level: 'silent', entry: 'admin', appEnv: 'test' }),
  });
  const server = app.getHttpAdapter().getInstance() as unknown as {
    addHook(name: 'onRequest', hook: (request: { parts: () => unknown }) => Promise<void>): void;
  };
  server.addHook('onRequest', async (request) => {
    const parts = request.parts.bind(request);
    request.parts = () => parts();
  });
  await app.init();
  return app;
}

type Part = { name: string; bytes: Buffer; filename?: string };

function body(parts: readonly Part[]): Buffer {
  return Buffer.concat([
    ...parts.flatMap((part) => [
      Buffer.from(
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${part.name}"` +
          (part.filename === undefined ? '' : `; filename="${part.filename}"`) +
          '\r\n' +
          (part.filename === undefined ? '' : 'Content-Type: application/octet-stream\r\n') +
          '\r\n',
      ),
      part.bytes,
      Buffer.from('\r\n'),
    ]),
    Buffer.from(`--${BOUNDARY}--\r\n`),
  ]);
}

const kind = (value = 'lottie'): Part => ({ name: 'kind', bytes: Buffer.from(value) });
const file = (bytes = Buffer.from('{"v":"5"}')): Part => ({
  name: 'file',
  bytes,
  filename: 'a.json',
});

async function post(target: NestFastifyApplication, payload: Buffer): Promise<unknown> {
  const response = await target.inject({
    method: 'POST',
    url: '/__popup_parts',
    headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
    payload,
  });
  return JSON.parse(response.body);
}

it('[AC-F1-09r] kind and file are read in either order under the admin entry limits', async () => {
  const target = await start();
  expect(await post(target, body([kind(), file()]))).toEqual({ kind: 'lottie', size: 9 });
  expect(await post(target, body([file(), kind('image')]))).toEqual({ kind: 'image', size: 9 });
  expect(await post(target, body([file()]))).toEqual({ kind: null, size: 9 });
  expect(await post(target, body([kind('')]))).toEqual({ kind: '', size: null });
});

it('[AC-F1-09r] extra, repeated or foreign parts are a bad upload, never a server error', async () => {
  const target = await start();
  for (const parts of [
    [kind(), file(), file()],
    [kind(), kind(), file()],
    [kind(), { name: 'other', bytes: Buffer.from('1') }],
    [{ ...file(), name: 'image' }],
    [{ name: 'file', bytes: Buffer.from('1') }],
  ]) {
    const answer = await post(target, body(parts));
    const label = JSON.stringify(parts.map((p) => p.name));
    expect(answer, label).not.toHaveProperty('error');
    expect(answer, label).not.toHaveProperty('size');
    expect(
      [
        { status: 400, field: 'file' },
        { plugin: 'FST_PARTS_LIMIT' },
        { plugin: 'FST_FIELDS_LIMIT' },
        { plugin: 'FST_FILES_LIMIT' },
      ],
      label,
    ).toContainEqual(answer);
  }
});
