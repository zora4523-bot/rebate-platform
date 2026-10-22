import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { expect, vi } from 'vitest';
import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import {
  MEDIA_STORE,
  type MemoryMediaStore,
} from '../../../../apps/api/src/modules/platform/media/index.ts';
import { createValidatorCompiler } from '../../../../apps/api/src/modules/platform/validation/index.ts';
import { grant, seed } from '../../admin/accounts/kit.ts';
import { fixture, signedIn, type Harness, type Response } from '../../admin/auth/kit.ts';
import { CONTENT_TYPE, filePart, multipart } from '../../platform/multipart/http-kit.ts';
import { contract } from '../pages-admin/kit.ts';
import { lottie } from './fixtures.ts';

export { contract, snapshot } from '../pages-admin/kit.ts';
export const ROUTE = '/admin/v1/pages/popup-assets';
// Includes a path prefix and trailing slash: reference checks must use the configured base.
export const MEDIA_BASE = 'https://media.popup.test/media/';
export type Asset = Schema<'AdminPopupAssetLottie'> | Schema<'AdminPopupAssetImage'>;

interface Server {
  hasRoute(input: { method: 'POST'; url: string }): boolean;
  addHook(
    name: 'onRequest',
    hook: (request: { url: string; raw: IncomingMessage; parts(): unknown }) => Promise<void>,
  ): void;
}

export async function setup(h: Harness) {
  const f = await fixture(h, { env: { MEDIA_PUBLIC_BASE_URL: MEDIA_BASE } });
  const server = f.app.getHttpAdapter().getInstance() as unknown as Server;
  // Every HTTP case requires the real route, including negative cases. Planned fallback must fail.
  expect(
    server.hasRoute({ method: 'POST', url: ROUTE }),
    'adminUploadPopupAsset is registered',
  ).toBe(true);
  const reads = { parts: 0, stream: 0 };
  server.addHook('onRequest', async (req) => {
    if (req.url !== ROUTE) return;
    const parts = req.parts.bind(req);
    req.parts = () => {
      reads.parts += 1;
      return parts();
    };
    const read = req.raw.read.bind(req.raw);
    vi.spyOn(req.raw, 'read').mockImplementation((size?: number) => {
      const chunk: unknown = read(size);
      if (chunk !== null) reads.stream += 1;
      return chunk;
    });
  });
  const appId = `f1_09r_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
  const owner = await seed(h, appId, { isSuper: true });
  const actor = await seed(h, appId);
  await grant(h, actor, owner, ['content.page']);
  const session = await signedIn(f, actor);
  return {
    ...f,
    appId,
    owner,
    actor,
    token: session.admin_token,
    media: f.app.get<MemoryMediaStore>(MEDIA_STORE),
    reads,
  };
}
export type Setup = Awaited<ReturnType<typeof setup>>;

export function upload(
  f: Pick<Setup, 'app' | 'token'>,
  bytes = lottie(),
  options: {
    kind?: string | null;
    token?: string | null;
    filename?: string;
    mimetype?: string;
    fileFirst?: boolean;
    body?: Buffer;
  } = {},
) {
  const kind = options.kind === undefined ? 'lottie' : options.kind;
  const fields = kind === null ? [] : [{ name: 'kind', bytes: Buffer.from(kind) }];
  const file = {
    ...filePart(Buffer.from(bytes)),
    filename: options.filename ?? 'private-popup.png',
    mimetype: options.mimetype ?? 'image/png',
  };
  const body =
    options.body ?? multipart(options.fileFirst === true ? [file, ...fields] : [...fields, file]);
  const token = options.token === undefined ? f.token : options.token;
  const app = f.app as unknown as {
    inject(input: {
      method: 'POST';
      url: string;
      headers: Record<string, string>;
      payload: Buffer;
      remoteAddress: string;
    }): Promise<Response>;
  };
  return app.inject({
    method: 'POST',
    url: ROUTE,
    payload: body,
    headers: {
      'content-type': CONTENT_TYPE,
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    remoteAddress: '127.0.0.1',
  });
}

type Validator = ReturnType<ReturnType<typeof createValidatorCompiler>>;
let validators: Promise<Map<string, Validator>> | undefined;
async function validate(response: Response) {
  validators ??= (async () => {
    const operation = (await contract()).paths[ROUTE]!['post']!;
    const compile = createValidatorCompiler();
    return new Map(
      ['200', '413', '4XX', '5XX'].map((status) => [
        status,
        compile({
          schema: operation.responses[status]!.content['application/json']!.schema,
          httpPart: 'body',
        }),
      ]),
    );
  })();
  const status =
    response.statusCode === 413
      ? '413'
      : response.statusCode < 400
        ? '200'
        : response.statusCode < 500
          ? '4XX'
          : '5XX';
  const check = (await validators).get(status)!;
  expect(check(response.json()), JSON.stringify(check.errors)).toBe(true);
}
export async function success(response: Response): Promise<Asset> {
  expect(response.statusCode, JSON.stringify(response.json())).toBe(200);
  expect(response.json()).toMatchObject({ code: 0 });
  await validate(response);
  return response.json<{ data: Asset }>().data;
}
export async function rejected(
  response: Response,
  code: number,
  data?: object,
  status = code === 10001 ? 401 : code === 10403 ? 403 : code === 50001 ? 500 : 400,
) {
  expect(response.statusCode, JSON.stringify(response.json())).toBe(status);
  expect(response.json()).toMatchObject({ code });
  if (data !== undefined) expect(response.json().data).toEqual(data);
  await validate(response);
}
