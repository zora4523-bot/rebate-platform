import { createHash, randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { sql } from 'kysely';
import {
  IDEMPOTENCY,
  type Idempotency,
  type TokenPrincipal,
} from '../../../../apps/api/src/modules/platform/index.ts';
import type { Response } from '../../identity/sms-codes/http-kit.ts';
import { withHttp, type HttpFixture, type HttpSuite } from '../rate-limit/http-kit.ts';
import { ROOT, apiRequire } from '../rate-limit/kit.ts';

export const SHARES = '/v1/shares';
export const CONVERT = '/v1/links/convert';
export const SHARE = { platform: 'jd', product_key: 'jd:i_100012043978' };
export const CONVERSION = {
  platform: 'jd',
  product_key: 'jd:i_100012043978',
  scene: 'h5',
  installed: 'unknown',
};

interface Request {
  id: string;
  body: unknown;
  headers: Record<string, string>;
  principal: TokenPrincipal;
}
type Handler = (req: Request) => unknown;

/**
 * Idempotency-Key for a case-local label: a uuid derived from the label alone, so the same label
 * is the same key (a replay) and every label meets contracts IdempotencyKey (8–64 chars of
 * [A-Za-z0-9_-]; a short label such as `share_0` alone would be refused with 20001).
 */
export function idempotencyKey(label: string): string {
  const hex = createHash('sha256').update(`B1-15x:${label}`).digest('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

export interface ShareFixture extends HttpFixture {
  /** POST /v1/shares, signed, with the Idempotency-Key derived from the label. */
  share(label: string): Promise<Response>;
  /** POST /v1/links/convert, signed, with the Idempotency-Key derived from the label. */
  convert(label: string): Promise<Response>;
  /** Share bodies the fixture handler ran (idempotency misses past every gate). */
  created(): number;
  /** Upserts a config_items row of this app (couli_app has no DELETE on config_items). */
  config(key: string, value: unknown): Promise<void>;
}

/**
 * http-kit's AppModule fixture, with the real createShare route (path, guards, route schema and
 * idempotency wiring of SharesController) kept and only its handler body swapped for a fixture
 * that goes through idempotency like the convert fixture: stage ⑬ of an idempotent operation is
 * the post-miss hook, so the share use case itself (union API, products) is out of the picture.
 */
export async function withShares(
  suite: HttpSuite,
  values: Record<string, unknown>,
  run: (f: ShareFixture) => Promise<void>,
) {
  const common = (await import(pathToFileURL(apiRequire.resolve('@nestjs/common')).href)) as {
    HttpException: new (body: unknown, status: number) => Error;
  };
  const { SharesController } = (await import(
    new URL('apps/api/src/modules/linking/http/public/shares.controller.ts', ROOT).href
  )) as { SharesController: { prototype: Record<'create', Handler> } };
  const proto = SharesController.prototype;
  const real = proto.create;
  let idem: Idempotency | undefined;
  let created = 0;
  proto.create = withMetadataOf(real, async (req) => {
    const command = {
      appId: req.principal.app_id,
      actor: { userId: req.principal.uid, deviceId: null, phoneHmac: null },
      method: 'POST' as const,
      path: SHARES,
      key: req.headers['idempotency-key'],
      body: req.body,
      traceId: req.id,
    };
    const response = await idem!.execute(command, async () => {
      created++;
      return {
        status: 200,
        envelope: { code: 0, msg: '', data: { fixture: 'share' }, trace_id: req.id },
      };
    });
    if (response.status !== 200)
      throw new common.HttpException(JSON.parse(response.body) as unknown, response.status);
    return JSON.parse(response.body) as unknown;
  });
  try {
    await withHttp(suite, values, async (f) => {
      idem = f.app.get<Idempotency>(IDEMPOTENCY);
      // createShare is x-auth phone: stage ⑧ (before ⑬) needs a bound phone.
      await sql`UPDATE app.users SET phone_hmac = ${randomBytes(32).toString('hex')}
        WHERE app_id = ${f.id} AND id = ${f.uid}`.execute(suite.kit.db);
      await run({
        ...f,
        share: (label) => f.post(SHARES, SHARE, { 'idempotency-key': idempotencyKey(label) }),
        convert: (label) =>
          f.post(CONVERT, CONVERSION, { 'idempotency-key': idempotencyKey(label) }),
        created: () => created,
        config: async (key, value) => {
          await sql`INSERT INTO app.config_items (app_id, key, value, updated_by)
            VALUES (${f.id}, ${key}, ${JSON.stringify(value)}::jsonb, 'share-rate-limit-rule-test')
            ON CONFLICT (app_id, key) DO UPDATE SET value = EXCLUDED.value`.execute(suite.kit.db);
        },
      });
    });
  } finally {
    proto.create = real;
  }
}

/** Copies every Reflect metadata entry of the real handler onto the fixture (as http-kit does). */
function withMetadataOf(real: Handler, fixture: Handler): Handler {
  const metadata = Reflect as unknown as {
    getMetadataKeys(target: object): unknown[];
    getMetadata(key: unknown, target: object): unknown;
    defineMetadata(key: unknown, value: unknown, target: object): void;
  };
  for (const key of metadata.getMetadataKeys(real)) {
    metadata.defineMetadata(key, metadata.getMetadata(key, real), fixture);
  }
  return fixture;
}
