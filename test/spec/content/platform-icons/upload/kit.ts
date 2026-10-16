import { createHash, randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { fileURLToPath } from 'node:url';
import { expect, vi } from 'vitest';
import type { Schema } from '../../../../../packages/contracts-ts/src/index.ts';
import {
  MEDIA_STORE,
  type MemoryMediaStore,
} from '../../../../../apps/api/src/modules/platform/media/index.ts';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../../apps/api/src/modules/platform/validation/index.ts';
import { seed, type Seed } from '../../../admin/accounts/kit.ts';
import {
  apiRequire,
  fixture,
  signedIn,
  type Harness,
  type HttpApp,
  type Response,
} from '../../../admin/auth/kit.ts';
import { CONTENT_TYPE, filePart, multipart } from '../../../platform/multipart/http-kit.ts';
import { BASE, LIST, type Key } from '../read/kit.ts';

export { BASE, type Key, type Version } from '../read/kit.ts';
export { snapshot, mark, saved, auditDelta, REGISTERED, SOURCE, DATE } from '../publish/kit.ts';
export { png } from '../sanitize/png-fixtures.ts';
export const OPERATIONS = ['uploads', 'versions'] as const;
export type Operation = (typeof OPERATIONS)[number];
export type Upload = Schema<'AdminPlatformIconUpload'>;
export const ROUTES = {
  uploads: `${LIST}/{key}/uploads`,
  versions: `${LIST}/{key}/versions`,
};
export const SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path fill="#f00" d="M0 0h512v512H0z"/></svg>',
);
export const UNSAFE_SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script><path fill="#f00" d="M0 0h512v512H0z"/></svg>',
);
export const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

interface Server {
  hasRoute(input: { method: 'POST'; url: string }): boolean;
  addHook(
    name: 'onRequest',
    hook: (request: { url: string; raw: IncomingMessage; parts(): unknown }) => Promise<void>,
  ): void;
}
export function hasRoute(app: HttpApp, op: Operation): boolean {
  return (app.getHttpAdapter().getInstance() as unknown as Server).hasRoute({
    method: 'POST',
    url: ROUTES[op].replace('{key}', ':key'),
  });
}

export async function setup(h: Harness) {
  const f = await fixture(h, { env: { MEDIA_PUBLIC_BASE_URL: BASE } });
  // Assert registration before any negative case: a planned-route fallback is not an implementation.
  for (const op of OPERATIONS) expect(hasRoute(f.app, op), ROUTES[op]).toBe(true);
  const reads = { parts: 0, stream: 0 };
  const server = f.app.getHttpAdapter().getInstance() as unknown as Server;
  server.addHook('onRequest', async (req) => {
    if (!req.url.startsWith(LIST) || !req.url.endsWith('/uploads')) return;
    const parts = req.parts.bind(req);
    req.parts = () => {
      reads.parts += 1;
      return parts();
    };
    // Observe read() without switching the stream into flowing mode ourselves.
    const read = req.raw.read.bind(req.raw);
    vi.spyOn(req.raw, 'read').mockImplementation((size?: number) => {
      const chunk: unknown = read(size);
      if (chunk !== null) reads.stream += 1;
      return chunk;
    });
  });
  const appId = `f1-06x-${randomUUID()}`;
  const actor = await seed(h, appId, { isSuper: true });
  const session = await signedIn(f, actor);
  const media = f.app.get<MemoryMediaStore>(MEDIA_STORE);
  return { ...f, appId, actor, token: session.admin_token, media, reads };
}
export type Setup = Awaited<ReturnType<typeof setup>>;

interface UploadApp {
  inject(input: {
    method: 'POST';
    url: string;
    payload: Buffer;
    headers: Record<string, string>;
    remoteAddress: string;
  }): Promise<Response>;
}
export function upload(
  f: Pick<Setup, 'app' | 'token'>,
  bytes: Buffer = SVG,
  key = 'jd',
  token: string | null = f.token,
  body = multipart([filePart(Buffer.from(bytes))]),
) {
  return (f.app as unknown as UploadApp).inject({
    method: 'POST',
    url: ROUTES.uploads.replace('{key}', key),
    headers: {
      'content-type': CONTENT_TYPE,
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    payload: body,
    remoteAddress: '127.0.0.1',
  });
}
export function create(
  f: Pick<Setup, 'app' | 'token'>,
  body: Record<string, unknown>,
  key = 'jd',
  token: string | null = f.token,
) {
  return f.app.inject({
    method: 'POST',
    url: ROUTES.versions.replace('{key}', key),
    headers: {
      'content-type': 'application/json',
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    payload: JSON.stringify(body),
    remoteAddress: '127.0.0.1',
  });
}

export interface ContractOperation {
  operationId: string;
  description: string;
  parameters?: { name: string }[];
  responses: Record<string, { content: Record<string, { schema: JsonSchema }> }>;
}
export async function contract() {
  const parser = apiRequire('@readme/openapi-parser') as {
    dereference(
      path: string,
      options: object,
    ): Promise<{
      paths: Record<string, { post: ContractOperation }>;
    }>;
  };
  return parser.dereference(
    fileURLToPath(new URL('../../../../../contracts/openapi.yaml', import.meta.url)),
    { resolve: { external: false } },
  );
}
type Validator = ReturnType<ReturnType<typeof createValidatorCompiler>>;
let validators: Promise<Map<string, Validator>> | undefined;
async function validate(response: Response, op: Operation) {
  validators ??= (async () => {
    const doc = await contract();
    const compile = createValidatorCompiler();
    const checks = new Map<string, Validator>();
    for (const operation of OPERATIONS) {
      for (const status of ['200', '4XX', '5XX']) {
        checks.set(
          `${operation}:${status}`,
          compile({
            schema:
              doc.paths[ROUTES[operation]]!.post.responses[status]!.content['application/json']!
                .schema,
            httpPart: 'body',
          }),
        );
      }
    }
    return checks;
  })();
  const status = response.statusCode < 400 ? '200' : response.statusCode < 500 ? '4XX' : '5XX';
  const check = (await validators).get(`${op}:${status}`)!;
  expect(check(response.json()), JSON.stringify(check.errors)).toBe(true);
}
export async function success<T = Upload>(response: Response, op: Operation): Promise<T> {
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ code: 0 });
  await validate(response, op);
  return response.json<{ data: T }>().data;
}
export async function rejected(
  response: Response,
  op: Operation,
  code: number,
  data?: object,
  status = code === 10001 ? 401 : code === 10403 ? 403 : code === 50001 ? 500 : 400,
) {
  expect(response.statusCode).toBe(status);
  expect(response.json()).toMatchObject({ code });
  if (data !== undefined) expect(response.json().data).toEqual(data);
  await validate(response, op);
}

/** Seed only the upload, using the same SELECT/INSERT-only application role as production. */
export async function pending(
  h: Harness,
  f: Pick<Setup, 'actor' | 'clock'>,
  options: { key?: Key; actor?: Seed; sanitized?: boolean; remainingMs?: number } = {},
) {
  const actor = options.actor ?? f.actor;
  const row = {
    id: randomUUID(),
    app_id: actor.appId,
    key: options.key ?? 'jd',
    sha256: digest(SVG),
    format: 'svg',
    bytes: SVG.length,
    sanitized: options.sanitized ?? false,
    created_by_admin_id: actor.id,
    created_at: new Date(f.clock.now().getTime() - 86_400_000),
    expires_at: new Date(f.clock.now().getTime() + (options.remainingMs ?? 86_400_000)),
  };
  await h.db.insertInto('platform_icon_uploads').values(row).execute();
  return row;
}
