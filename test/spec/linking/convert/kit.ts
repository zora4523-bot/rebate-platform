import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { components } from '../../../../packages/contracts-ts/src/index.ts';
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { expect, vi } from 'vitest';
import {
  createCatalog,
  createItemRefService,
  processItemRefCipher,
  type ItemRefClaims,
} from '../../../../apps/api/src/modules/catalog/index.ts';
import {
  createLinkConvert,
  type LinkConvertInput,
  type LinkConvertOptions,
} from '../../../../apps/api/src/modules/linking/application/link-convert.ts';
import { parseUrl } from '../../../../apps/api/src/modules/parsing/index.ts';
import type { HandlerResult } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';
import { setup, type Binding } from '../open-taobao/kit.ts';

export { databaseFixture } from '../open-pdd-auth/database.ts';
export type Body = components['schemas']['ConvertLinkRequest'];
export type Data = components['schemas']['ConvertLinkData'];

/** Existing open fixtures supply real registration, idempotency and demo conversion ports.
 * Their pre-existing link is excluded explicitly; convert must create its own H5 link.
 */
export async function fixture(
  db: Kysely<DB>,
  platform: 'jd' | 'pdd' | 'taobao' = 'jd',
  binding: Binding = 'active',
) {
  const old = await setup(db, 'detail', platform);
  await old.bind(binding);
  const { clock } = old.f;
  const products = createCatalog({ db, clock, warn: vi.fn() });
  const price = old.f.state.price;
  if (price.kind !== 'available') throw new Error('synthetic price fixture unavailable');
  const ref = {
    ...price.input.ref,
    rawFetchedAt: clock.now().toISOString(),
    receivedAt: clock.now().toISOString(),
  };
  await products.registerProductRef(ref, { parseEnabled: true, searchEnabled: true });
  const raw = vi.spyOn(products, 'takeRawItemId');
  const itemRefs = createItemRefService({ crypto: processItemRefCipher() });
  const verify = vi.spyOn(itemRefs, 'verify');
  const adapter = old.options.registry.get(platform);
  // The union DTO is synthetic. The demo adapter's conversion still runs unchanged.
  const getItem = vi.spyOn(adapter, 'getItem').mockImplementation(async () => ({
    ...price.input.item,
    quoted_at: clock.now().toISOString(),
  }));
  const resolveLink = old.resolveLink.mockResolvedValue({
    item:
      platform === 'taobao'
        ? { platform, item_id: ref.rawItemId }
        : platform === 'jd'
          ? { platform, itemId: ref.rawItemId }
          : { platform, goods_id: ref.productKey.slice(4), goods_sign: ref.rawItemId },
  });
  const urlParser = {
    parseUrl: vi.fn<LinkConvertOptions['urlParser']['parseUrl']>((url, context) =>
      parseUrl(
        {
          config: old.options.config,
          catalog: products,
          cards: old.options.catalog,
          clock,
          getGovernedAdapter: () => adapter,
          // Production's pattern table awaits samples; these domains are synthetic fixtures.
          linkPatterns: {
            version: 'synthetic-convert',
            rules: [
              {
                platform,
                category: 'product',
                hosts: [`${platform}.example.test`],
                path_patterns: ['/product/**'],
              },
            ],
          },
        },
        url,
        context,
      ),
    ),
  };
  const options: LinkConvertOptions = {
    ...old.options,
    products,
    itemRefs,
    quoter: { quote: old.f.quote },
    urlParser,
  };
  const issue = (patch: Partial<ItemRefClaims> = {}) =>
    itemRefs.issue({
      appId: old.appId,
      platform,
      productKey: ref.productKey,
      rawItemId: ref.rawItemId,
      fetchedAt: clock.now().toISOString(),
      ...patch,
    });
  const request = (body: Partial<Body> = {}, key = randomUUID()): LinkConvertInput => ({
    body: { platform, product_key: ref.productKey, scene: 'h5', ...body } as Body,
    client: 'ios',
    traceId: randomUUID(),
    idempotencyKey: key,
  });
  const links = () =>
    db
      .selectFrom('links')
      .selectAll()
      .where('app_id', '=', old.appId)
      .where('link_id', '!=', old.row.link_id)
      .orderBy('link_id')
      .execute();
  const logs = () =>
    db
      .selectFrom('link_logs')
      .selectAll()
      .where('app_id', '=', old.appId)
      .where('event', 'in', ['open', 'convert'])
      .orderBy('id')
      .execute();
  return {
    ...old,
    options,
    products,
    ref,
    raw,
    verify,
    getItem,
    resolveLink,
    urlParser,
    issue,
    request,
    links,
    logs,
  };
}

export type Fixture = Awaited<ReturnType<typeof fixture>>;
export function service(f: Fixture) {
  return createLinkConvert(f.options);
}

const root = new URL('../../../../', import.meta.url);
const requireApi = createRequire(new URL('apps/api/package.json', root));
let schemas: Promise<Record<string, JsonSchema>> | undefined;
export async function validate(value: unknown, name: 'ConvertLinkResponse' | 'ErrorEnvelope') {
  const parser = requireApi('@readme/openapi-parser') as {
    dereference(path: string): Promise<{ components: { schemas: Record<string, JsonSchema> } }>;
  };
  schemas ??= parser
    .dereference(fileURLToPath(new URL('contracts/openapi.yaml', root)))
    .then((doc) => doc.components.schemas);
  const check = createValidatorCompiler()({ schema: (await schemas)[name]!, httpPart: 'body' });
  expect(check(value), JSON.stringify(check.errors)).toBe(true);
}

export async function success(result: HandlerResult, f: Fixture) {
  expect(result).toMatchObject({ status: 200, envelope: { code: 0 } });
  await validate(result.envelope, 'ConvertLinkResponse');
  const data = result.envelope.data as Data;
  const rows = await f.links();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    link_id: data.link_id,
    app_id: f.appId,
    user_id: f.a,
    device_id: f.device,
    platform: f.platform,
    scene: 'h5',
    pid_scene: 'self_buy',
  });
  expect(rows[0]!.identity_snapshot).toMatchObject({ user_id: f.a, attr_code: 'demo0001' });
  expect(data.link_id).not.toBe(f.row.link_id);
  expect(await f.logs()).toEqual([
    expect.objectContaining({
      event: 'convert',
      result_code: 0,
      link_id: data.link_id,
      user_id: f.a,
      scene: 'h5',
      pid_scene: 'self_buy',
    }),
  ]);
  expect(await f.attempts()).toEqual([
    expect.objectContaining({
      attempt_id: data.attempt_id,
      link_id: data.link_id,
      user_id: f.a,
      app_id: f.appId,
    }),
  ]);
  const xids = await sql<{ log_xid: string; attempt_xid: string }>`
    SELECT l.xmin::text AS log_xid, a.xmin::text AS attempt_xid
    FROM app.link_logs l JOIN app.link_open_attempts a
      ON a.app_id = l.app_id AND a.link_id = l.link_id
    WHERE l.app_id = ${f.appId} AND l.event = 'convert'
      AND a.attempt_id = ${data.attempt_id}::uuid
  `.execute(f.db);
  expect(xids.rows).toHaveLength(1);
  expect(xids.rows[0]!.log_xid).toBe(xids.rows[0]!.attempt_xid);
  return data;
}

export async function failure(result: HandlerResult, f: Fixture, code: number, status: number) {
  expect(result).toMatchObject({ status, envelope: { code } });
  await validate(result.envelope, 'ErrorEnvelope');
  expect(await f.logs()).toEqual([
    expect.objectContaining({ event: 'convert', result_code: code }),
  ]);
  expect(await f.attempts()).toEqual([]);
  expect(result.envelope.data ?? {}).not.toHaveProperty('jump');
  expect(f.convert).not.toHaveBeenCalled();
}
