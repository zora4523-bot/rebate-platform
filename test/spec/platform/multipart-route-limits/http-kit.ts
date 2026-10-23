import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { expect, vi } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { loadConfig } from '../../../../apps/api/src/modules/platform/config/index.ts';
import { AdminOperationGuard } from '../../../../apps/api/src/modules/platform/http/admin-guard.ts';
import {
  REQUEST_CHECKS,
  type RequestCheck,
} from '../../../../apps/api/src/modules/platform/http/request-checks.ts';
import type { SingleUploadRequest } from '../../../../apps/api/src/modules/platform/http/single-upload.ts';
import { createRootLogger } from '../../../../apps/api/src/modules/platform/logging/index.ts';
import { MemoryMediaStore } from '../../../../apps/api/src/modules/platform/media/index.ts';
import { CONTENT_TYPE, TRACE, envelopeValidator, multipart } from '../multipart/http-kit.ts';
import type { Response } from '../errors/kit.ts';

export const POPUP = '/admin/v1/pages/popup-assets';
export const ICON = '/admin/v1/platform-icons/demo/uploads';
export const MEDIA_BASE = 'https://multipart-route.test/media';
export const kindPart = { name: 'kind', bytes: Buffer.from('lottie') };
export type Part = Parameters<typeof multipart>[0][number];
type Method = 'POST' | 'PUT';
type Constructor = abstract new (...args: never[]) => unknown;
type Decorator = (target: object, key: string, descriptor: PropertyDescriptor) => void;
interface Common {
  Controller(path: string): (target: Constructor) => void;
  Post(path: string): Decorator;
  Put(path: string): Decorator;
  Req(): (target: object, key: string, index: number) => void;
}
interface HttpApp {
  init(): Promise<unknown>;
  close(): Promise<unknown>;
  inject(request: {
    method: Method;
    url: string;
    headers: Record<string, string>;
    payload: Buffer | Readable;
  }): Promise<Response>;
}

/** A consumer with no content helper or limits of its own: only bootstrap can grant two parts. */
async function probeController(common: Common): Promise<Constructor> {
  class Probe {
    async read(request: SingleUploadRequest): Promise<object> {
      const parts: object[] = [];
      for await (const part of request.parts()) {
        parts.push(
          part.type === 'file'
            ? { type: 'file', name: part.fieldname, bytes: (await part.toBuffer()).byteLength }
            : { type: 'field', name: part.fieldname, value: part.value },
        );
      }
      return {
        parts,
        bodyWasUndefined:
          !Object.hasOwn(request, 'body') ||
          (request as SingleUploadRequest & { body?: unknown }).body === undefined,
      };
    }
  }
  // Separate methods let Nest register the same consumer on several real route templates.
  for (const [index, method, path] of [
    ['popup', 'POST', POPUP],
    ['icon', 'POST', '/admin/v1/platform-icons/:key/uploads'],
    ['other', 'POST', '/admin/v1/unlisted-uploads'],
    ['neighbor', 'POST', `${POPUP}/extra`],
    ['putPopup', 'PUT', POPUP],
  ] as const) {
    Object.defineProperty(Probe.prototype, index, {
      value: function (this: Probe, request: SingleUploadRequest) {
        return this.read(request);
      },
      configurable: true,
    });
    const descriptor = Object.getOwnPropertyDescriptor(Probe.prototype, index)!;
    common.Req()(Probe.prototype, index, 0);
    (method === 'POST' ? common.Post(path) : common.Put(path))(Probe.prototype, index, descriptor);
  }
  common.Controller('')(Probe);
  return Probe;
}

/** Real bootstrap/plugin/filter; memory-only auth, audit and media ports, no database or socket. */
export async function withApp(
  mode: 'probe' | 'content',
  check: (app: HttpApp) => Promise<void>,
): Promise<void> {
  const apiRequire = createRequire(new URL('../../../../apps/api/package.json', import.meta.url));
  const common = (await import(pathToFileURL(apiRequire.resolve('@nestjs/common')).href)) as Common;
  // Computed imports keep decorated Nest sources outside test/tsconfig's erasable-only build.
  const { AppModule } = (await import(
    new URL('../../../../apps/api/src/app.module.ts', import.meta.url).href
  )) as { AppModule: { forEntry(options: unknown): object } };
  const { createHttpApp } = (await import(
    new URL('../../../../apps/api/src/bootstrap.ts', import.meta.url).href
  )) as { createHttpApp(entry: 'admin', overrides: object): Promise<HttpApp> };
  const { createAdminRequestCheck } = (await import(
    new URL('../../../../apps/api/src/modules/admin/application/admin-check.ts', import.meta.url)
      .href
  )) as { createAdminRequestCheck(deps: object): RequestCheck };
  const { ADMIN_HTTP_POLICY } = (await import(
    new URL('../../../../apps/api/src/modules/admin/application/tokens.ts', import.meta.url).href
  )) as { ADMIN_HTTP_POLICY: symbol };
  const { PopupAssetUploader } = (await import(
    new URL(
      '../../../../apps/api/src/modules/content/application/popup-asset-uploader.ts',
      import.meta.url,
    ).href
  )) as { PopupAssetUploader: new (options: object) => unknown };
  const clock = new FixedClock('2026-10-23T00:00:00Z');
  const logger = createRootLogger({ level: 'silent', entry: 'admin', appEnv: 'test' });
  const actor = {
    appId: 'multipart-app',
    adminId: 'multipart-admin',
    isSuper: true,
    loginName: 'test',
  };
  const adminCheck = createAdminRequestCheck({
    clock,
    allows: () => true,
    tokens: { verify: async () => ({ ...actor, sessionId: 'multipart-session' }) },
    sessions: () => ({
      read: async () => ({
        ...actor,
        expiresAtMs: clock.now().getTime() + 60_000,
        lastSeenMs: clock.now().getTime(),
      }),
      touch: async () => true,
    }),
    accounts: () => ({
      byId: async () => ({
        id: actor.adminId,
        appId: actor.appId,
        status: 'active',
        isSuper: true,
        lockedUntil: null,
      }),
    }),
  });
  const guard: AdminOperationGuard = { run: async (_input, business) => business(actor) };
  const uploader = new PopupAssetUploader({
    media: new MemoryMediaStore(MEDIA_BASE),
    audit: { append: async () => undefined },
    mediaPublicBaseUrl: MEDIA_BASE,
    logger,
  });
  const controller =
    mode === 'probe'
      ? await probeController(common)
      : (
          (await import(
            new URL(
              '../../../../apps/api/src/modules/content/http/admin/popup-assets.controller.ts',
              import.meta.url,
            ).href
          )) as { AdminPopupAssetsController: Constructor }
        ).AdminPopupAssetsController;
  const spy = vi.spyOn(AppModule, 'forEntry').mockImplementationOnce(() => ({
    module: AppModule,
    controllers: [controller],
    providers: [
      { provide: REQUEST_CHECKS, useValue: { checks: [adminCheck], bufferWhen: () => false } },
      { provide: ADMIN_HTTP_POLICY, useValue: { corsOrigin: null, allows: () => true } },
      { provide: AdminOperationGuard, useValue: guard },
      { provide: PopupAssetUploader, useValue: uploader },
    ],
  }));
  let app: HttpApp | undefined;
  try {
    app = await createHttpApp('admin', { config: loadConfig({ APP_ENV: 'test' }), clock, logger });
    await app.init();
    await check(app);
  } finally {
    spy.mockRestore();
    await app?.close();
  }
}

export function upload(
  app: HttpApp,
  url: string,
  parts: readonly Part[],
  options: { method?: Method; chunked?: boolean } = {},
): Promise<Response> {
  const bytes = multipart(parts);
  return app.inject({
    method: options.method ?? 'POST',
    url,
    headers: {
      'content-type': CONTENT_TYPE,
      'x-trace-id': TRACE,
      authorization: 'Bearer test.test.test',
      ...(options.chunked === true ? { 'transfer-encoding': 'chunked' } : {}),
    },
    payload:
      options.chunked === true ? Readable.from([bytes.subarray(0, 97), bytes.subarray(97)]) : bytes,
  });
}

let validator: ReturnType<typeof envelopeValidator> | undefined;

export async function rejection(
  response: Response,
  label: string,
  field: 'file' | 'body' | 'kind' = 'file',
): Promise<void> {
  validator ??= envelopeValidator();
  const validate = await validator;
  const body: unknown = JSON.parse(response.body);
  expect.soft(response.statusCode, label).toBe(field === 'body' ? 413 : 400);
  expect.soft(validate(body), `${label}: ${JSON.stringify(validate.errors)}`).toBe(true);
  expect.soft(body, label).toEqual({
    code: 20001,
    msg: expect.any(String),
    data: { fields: [field] },
    trace_id: TRACE,
  });
  expect.soft(response.headers['x-trace-id'], label).toBe(TRACE);
}
