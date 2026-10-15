import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { expect, vi } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { loadConfig } from '../../../../apps/api/src/modules/platform/config/index.ts';
import { createRootLogger } from '../../../../apps/api/src/modules/platform/logging/index.ts';
import type {
  readSingleUpload,
  SingleUploadRequest,
} from '../../../../apps/api/src/modules/platform/http/single-upload.ts';
import { TRACE, envelopeValidator, type Response } from '../errors/kit.ts';

export { TRACE, envelopeValidator };
export const BODY_LIMIT = 1_048_576;
export const FILENAME = 'private-upload-filename.png';
export const PRIVATE_CONTENT = 'private-upload-content';
const BOUNDARY = 'couli-f1-06s-boundary';
export const CONTENT_TYPE = `multipart/form-data; boundary=${BOUNDARY}`;
export const BYTES = Buffer.concat([
  Buffer.from([0, 255, 128, 13, 10]),
  Buffer.from(PRIVATE_CONTENT),
]);

interface Part {
  name: string;
  bytes: Buffer;
  filename?: string;
  mimetype?: string;
}

export function filePart(bytes = BYTES, name = 'file'): Part {
  return { name, bytes, filename: FILENAME, mimetype: 'image/png' };
}

/** Build actual wire bytes, including a valid empty multipart body; no FormData or plugin mock. */
export function multipart(parts: readonly Part[]): Buffer {
  return Buffer.concat([
    ...parts.flatMap((part) => [
      Buffer.from(
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${part.name}"` +
          (part.filename === undefined ? '' : `; filename="${part.filename}"`) +
          '\r\n' +
          (part.mimetype === undefined ? '' : `Content-Type: ${part.mimetype}\r\n`) +
          '\r\n',
      ),
      part.bytes,
      Buffer.from('\r\n'),
    ]),
    Buffer.from(`--${BOUNDARY}--\r\n`),
  ]);
}

export function request(
  payload: Buffer,
  options: { contentType?: string; guarded?: boolean; chunked?: boolean } = {},
) {
  return {
    method: 'POST' as const,
    url: options.guarded === true ? '/__multipart_probe/guarded' : '/__multipart_probe/read',
    headers: {
      'x-trace-id': TRACE,
      'content-type': options.contentType ?? CONTENT_TYPE,
      ...(options.chunked === true ? { 'transfer-encoding': 'chunked' } : {}),
    },
    payload:
      options.chunked === true
        ? Readable.from([payload.subarray(0, 97), payload.subarray(97)])
        : payload,
  };
}

interface HttpApp {
  init(): Promise<unknown>;
  close(): Promise<unknown>;
  inject(input: ReturnType<typeof request>): Promise<Response>;
}
type Entry = 'api' | 'stream' | 'admin';
type Constructor = abstract new (...args: never[]) => unknown;
type Decorator = (target: object, key: string, descriptor: PropertyDescriptor) => void;
interface ProbeRequest extends SingleUploadRequest {
  readonly body?: unknown;
}
interface NestCommon {
  Controller(prefix: string): (target: Constructor) => void;
  Post(path: string): Decorator;
  Req(): (target: object, key: string, index: number) => void;
  UseGuards(guard: {
    canActivate(context: { switchToHttp(): { getRequest(): ProbeRequest } }): boolean;
  }): Decorator;
  HttpException: new (body: object, status: number) => Error;
}

export function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function withApp(entry: Entry, check: (app: HttpApp) => Promise<void>): Promise<void> {
  // Computed imports keep decorated Nest sources outside test/tsconfig's erasable-only build.
  const platform = (await import(
    new URL('../../../../apps/api/src/modules/platform/index.ts', import.meta.url).href
  )) as { readSingleUpload: typeof readSingleUpload };
  expect(typeof platform.readSingleUpload).toBe('function');
  const apiRequire = createRequire(new URL('../../../../apps/api/package.json', import.meta.url));
  const common = (await import(
    pathToFileURL(apiRequire.resolve('@nestjs/common')).href
  )) as NestCommon;
  class Probe {
    async read(req: ProbeRequest): Promise<object> {
      const bodyWasUndefined = req.body === undefined;
      const upload = await platform.readSingleUpload(req);
      return {
        filename: upload.filename,
        mimetype: upload.mimetype,
        base64: Buffer.from(upload.bytes).toString('base64'),
        byteLength: upload.bytes.byteLength,
        sha256: digest(upload.bytes),
        bodyWasUndefined,
      };
    }
    async guarded(req: ProbeRequest): Promise<object> {
      return this.read(req);
    }
  }
  for (const method of ['read', 'guarded'] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(Probe.prototype, method);
    if (descriptor === undefined) throw new Error(`Missing probe method ${method}`);
    common.Req()(Probe.prototype, method, 0);
    common.Post(method)(Probe.prototype, method, descriptor);
    if (method === 'guarded') {
      common.UseGuards({
        canActivate(context): never {
          const req = context.switchToHttp().getRequest();
          throw new common.HttpException(
            {
              code: 10403,
              msg: 'probe guard refused',
              trace_id: req.id,
              data: {
                bodyWasUndefined: req.body === undefined,
                streamEnded: req.raw.readableEnded,
              },
            },
            403,
          );
        },
      })(Probe.prototype, method, descriptor);
    }
  }
  common.Controller('__multipart_probe')(Probe);
  const { AppModule } = (await import(
    new URL('../../../../apps/api/src/app.module.ts', import.meta.url).href
  )) as { AppModule: { forEntry(options: unknown): Record<string, unknown> } };
  const { createHttpApp } = (await import(
    new URL('../../../../apps/api/src/bootstrap.ts', import.meta.url).href
  )) as { createHttpApp(entry: Entry, overrides: object): Promise<HttpApp> };
  const original = AppModule.forEntry.bind(AppModule);
  const spy = vi.spyOn(AppModule, 'forEntry').mockImplementationOnce((options) => {
    const module = original(options);
    return { ...module, controllers: [...((module['controllers'] ?? []) as unknown[]), Probe] };
  });
  let app: HttpApp | undefined;
  try {
    app = await createHttpApp(entry, {
      config: loadConfig({ APP_ENV: 'test' }),
      clock: new FixedClock('2026-10-15T00:00:00Z'),
      logger: createRootLogger({ level: 'silent', entry, appEnv: 'test' }),
    });
    await app.init();
    await check(app);
  } finally {
    spy.mockRestore();
    await app?.close();
  }
}

export function expectUpload(response: Response, bytes = BYTES): void {
  // Nest POST defaults to 201; this probe does not prescribe the business route's status.
  expect(response.statusCode).toBe(201);
  expect(JSON.parse(response.body)).toEqual({
    filename: FILENAME,
    mimetype: 'image/png',
    base64: bytes.toString('base64'),
    byteLength: bytes.byteLength,
    sha256: digest(bytes),
    bodyWasUndefined: true,
  });
  expect(response.headers['x-trace-id']).toBe(TRACE);
}

export function expectError(
  response: Response,
  validate: Awaited<ReturnType<typeof envelopeValidator>>,
  statusCode: number,
  field: 'file' | 'body',
): void {
  expect(response.statusCode).toBe(statusCode);
  const body: unknown = JSON.parse(response.body);
  expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
  expect(body).toEqual({
    code: 20001,
    msg: expect.any(String),
    data: { fields: [field] },
    trace_id: TRACE,
  });
  expect((body as { msg: string }).msg.length).toBeGreaterThan(0);
  expect(response.headers['x-trace-id']).toBe(TRACE);
  expect(response.body).not.toContain(FILENAME);
  expect(response.body).not.toContain(PRIVATE_CONTENT);
}
