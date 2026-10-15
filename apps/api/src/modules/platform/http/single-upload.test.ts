import { Readable } from 'node:stream';
import { Controller, Post, Req } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { AppModule } from '../../../app.module.ts';
import { createHttpApp } from '../../../bootstrap.ts';
import { FixedClock, createRootLogger, loadConfig, readSingleUpload } from '../index.ts';
import type { SingleUploadRequest } from './single-upload.ts';
import { PlatformFastifyAdapter, uploadErrorEnvelope } from './global-errors.ts';
import { UploadRejection, uploadRejectionOf } from './single-upload.ts';

const TRACE = 'abcdefABCDEF01234567abcdefABCDEF';
const BOUNDARY = 'unit-boundary';
const LIMIT = 1_048_576;
const SECRET_NAME = 'secret-name-u7.png';

@Controller('__upload')
class UploadProbe {
  @Post()
  async read(@Req() request: SingleUploadRequest) {
    const upload = await readSingleUpload(request);
    return {
      filename: upload.filename,
      mimetype: upload.mimetype,
      size: upload.bytes.byteLength,
      head: Buffer.from(upload.bytes.subarray(0, 4)).toString('hex'),
    };
  }
}

let app: NestFastifyApplication | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  vi.restoreAllMocks();
});

async function start(entry: 'admin' | 'api'): Promise<NestFastifyApplication> {
  const original = AppModule.forEntry.bind(AppModule);
  vi.spyOn(AppModule, 'forEntry').mockImplementationOnce((options) => {
    const module = original(options);
    return { ...module, controllers: [...(module.controllers ?? []), UploadProbe] };
  });
  app = await createHttpApp(entry, {
    config: loadConfig({ APP_ENV: 'test' }),
    clock: new FixedClock('2026-10-15T00:00:00Z'),
    logger: createRootLogger({ level: 'silent', entry, appEnv: 'test' }),
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
          (part.filename === undefined ? '' : 'Content-Type: image/png\r\n') +
          '\r\n',
      ),
      part.bytes,
      Buffer.from('\r\n'),
    ]),
    Buffer.from(`--${BOUNDARY}--\r\n`),
  ]);
}

const file = (bytes = Buffer.from([137, 80, 78, 71, 1])): Part => ({
  name: 'file',
  bytes,
  filename: SECRET_NAME,
});

function post(
  target: NestFastifyApplication,
  payload: Buffer,
  options: { contentType?: string | undefined; chunked?: boolean } = {},
) {
  return target.inject({
    method: 'POST',
    url: '/__upload',
    headers: {
      'x-trace-id': TRACE,
      'content-type': options.contentType ?? `multipart/form-data; boundary=${BOUNDARY}`,
      ...(options.chunked === true ? { 'transfer-encoding': 'chunked' } : {}),
    },
    payload:
      options.chunked === true
        ? Readable.from([payload.subarray(0, 50), payload.subarray(50)])
        : payload,
  });
}

function expectRefused(
  response: { statusCode: number; body: string },
  statusCode: number,
  field: string,
): void {
  expect(response.statusCode).toBe(statusCode);
  expect(JSON.parse(response.body)).toEqual({
    code: 20001,
    msg: '参数校验失败',
    data: { fields: [field] },
    trace_id: TRACE,
  });
  expect(response.body).not.toContain(SECRET_NAME);
}

it('[AC-F1-06s] the admin entry reads one file named file with its name and MIME type', async () => {
  const target = await start('admin');
  const response = await post(target, body([file()]));
  expect(response.statusCode).toBe(201);
  expect(JSON.parse(response.body)).toEqual({
    filename: SECRET_NAME,
    mimetype: 'image/png',
    size: 5,
    head: '89504e47',
  });
});

it('[AC-F1-06s] bad uploads answer 400 / 20001 naming file', async () => {
  const target = await start('admin');
  for (const [payload, contentType] of [
    [body([]), undefined],
    [body([{ ...file(), name: 'image' }]), undefined],
    [body([file(), file()]), undefined],
    [body([file(), { name: 'x', bytes: Buffer.from('1') }]), undefined],
    [body([{ name: 'file', bytes: Buffer.from('1') }]), undefined],
    [Buffer.from('{}'), 'application/json'],
    // No boundary: busboy refuses the body itself.
    [body([file()]), 'multipart/form-data'],
    // A truncated body: the part never ends.
    [body([file()]).subarray(0, 120), undefined],
  ] as const) {
    expectRefused(await post(target, payload, { contentType }), 400, 'file');
  }
});

it('[AC-F1-06s] a file or a whole body above the limit answers 413 / 20001 naming body', async () => {
  const target = await start('admin');
  const overhead = body([file(Buffer.alloc(0))]).length;
  const exact = body([file(Buffer.alloc(LIMIT - overhead, 97))]);
  const above = body([file(Buffer.alloc(LIMIT - overhead + 1, 97))]);
  for (const chunked of [false, true]) {
    expect((await post(target, exact, { chunked })).statusCode).toBe(201);
    expectRefused(await post(target, above, { chunked }), 413, 'body');
    const huge = body([file(Buffer.alloc(LIMIT + 10, 97))]);
    expectRefused(await post(target, huge, { chunked }), 413, 'body');
  }
}, 30_000);

it('[AC-F1-06s] the api entry keeps refusing multipart bodies with 415', async () => {
  const target = await start('api');
  expectRefused(await post(target, body([file()])), 415, 'body');
});

/** The shape @fastify/error gives the plugin's errors. */
function fastifyError(code: string, statusCode: number): Error {
  return Object.assign(new Error(code), { name: 'FastifyError', code, statusCode });
}

it('[AC-F1-06s] the plugin client errors map to the upload envelope and survive the adapter', () => {
  const tooLarge = fastifyError('FST_REQ_FILE_TOO_LARGE', 413);
  const files = fastifyError('FST_FILES_LIMIT', 413);
  const other = fastifyError('FST_SOMETHING_ELSE', 418);
  expect(uploadErrorEnvelope(tooLarge, TRACE)).toEqual({
    statusCode: 413,
    body: { code: 20001, msg: '参数校验失败', data: { fields: ['body'] }, trace_id: TRACE },
  });
  expect(uploadErrorEnvelope(files, TRACE)?.statusCode).toBe(400);
  expect(uploadErrorEnvelope(new UploadRejection(400, 'file'), TRACE)?.body.data).toEqual({
    fields: ['file'],
  });
  expect(uploadRejectionOf(other)).toBeUndefined();
  expect(uploadRejectionOf(new Error('FST_FILES_LIMIT'))).toBeUndefined();
  const adapter = new PlatformFastifyAdapter();
  expect(adapter.mapException(tooLarge)).toBe(tooLarge);
  expect(adapter.mapException(files)).toBe(files);
  expect(adapter.mapException(other)).not.toBe(other);
});
