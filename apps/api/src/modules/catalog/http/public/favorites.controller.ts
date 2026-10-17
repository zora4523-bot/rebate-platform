// B1-28c: the four favorites operations of contract CT-22b (规划/01 F-PROD-12; x-auth login):
// GET /v1/me/favorites (listFavorites), PUT / DELETE /v1/me/favorites/{platform}/{product_key}
// (addFavorite / removeFavorite, x-idempotent) and POST /v1/me/favorites/batch-delete
// (batchDeleteFavorites, x-idempotent). Only authentication, parameters and the call into the
// B1-28b use cases live here. Rule tests: test/spec/catalog/favorites-route/**.
//
// - The subject is the verified token only (app_id, uid, device_id); no header, query or body
//   field names a user. The route schema comes from the contract; the three writes have no query
//   parameter, so any query field is refused (20001) instead of being ignored.
// - Writes run in platform idempotency's standard mode (the use cases open their own
//   transactions); the stored response is written as is, so a replay equals the first answer.
// - A product key must parse against the platform dictionary and belong to the path's (or the
//   item's) platform, as the detail route checks (BR-PROD-03), else 20001 naming the field.
// - FavoriteError → 20001 with its data (reason favorites_full, or fields).
// Without a database (no favorites service or idempotency primitive) the routes fail closed
// (50001 by the global filter).
// Nest metadata is applied below without decorator syntax (same as ProductController).
import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  Inject,
  Optional,
  Post,
  Put,
  Req,
  Res,
} from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Schema } from '@couli/contracts-ts';
import { ProductKeyInvalid, splitProductKey } from '@couli/domain';
import {
  IDEMPOTENCY,
  contractRouteSchema,
  fieldsErrorEnvelope,
  tokenPrincipal,
  type HandlerResult,
  type Idempotency,
  type TokenPrincipal,
} from '../../../platform/index.ts';
import type { Catalog, PlatformRecord } from '../../domain/types.ts';
import { FavoriteError } from '../../favorites/errors.ts';
import type { FavoriteKey, FavoriteListItem, FavoritesService } from '../../favorites/types.ts';

/** Nest injection token of the favorites route ports (built by CatalogModule). */
export const FAVORITES_ROUTE = Symbol('CATALOG_FAVORITES_ROUTE');

/** What the favorites routes and the detail's `favorited` read. */
export interface FavoritesRoutePorts {
  readonly catalog: Pick<Catalog, 'listPlatforms'>;
  /** null in a process without a database: every favorites route fails closed. */
  readonly favorites: FavoritesService | null;
}

type FavoriteListResponse = Schema<'FavoriteListResponse'>;
type BatchDeleteBody = Schema<'BatchDeleteFavoritesRequest'>;
type FavoriteItem = Schema<'FavoriteListResponse'>['data']['items'][number];

interface FavoritesRequest {
  /** Trace id set by `genReqId`. */
  readonly id: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly params?: { readonly platform?: string; readonly product_key?: string };
  readonly query?: { readonly cursor?: string };
  readonly body?: unknown;
}

interface RawReply {
  code(statusCode: number): RawReply;
  type(contentType: string): RawReply;
  send(payload: string): unknown;
}

/** BR-TEXT-14 fallback texts; clients show error.20001 / error.20001.favorites_full. */
const INVALID_MSG = '填写内容有误，请检查';
const FULL_MSG = '收藏夹已满，请先删除一些';

/** The three writes declare no query parameter: any query field is a 20001. */
const NO_QUERY = { type: 'object', properties: {}, additionalProperties: false } as const;

/** Key prefix + platform check of BR-PROD-02 / 03 (same as the detail and price trend routes). */
function belongsTo(rows: readonly PlatformRecord[], platform: string, productKey: string): boolean {
  try {
    splitProductKey(
      productKey,
      rows.map((row) => ({
        platform: row.code,
        keyPrefix: row.key_prefix,
        parseEnabled: true,
        searchEnabled: true,
      })),
      platform,
    );
    return true;
  } catch (error: unknown) {
    if (error instanceof ProductKeyInvalid) return false;
    throw error;
  }
}

function invalidFields(fields: readonly string[], traceId: string): HttpException {
  const refused = fieldsErrorEnvelope(fields, traceId);
  return new HttpException({ ...refused.body, msg: INVALID_MSG }, refused.statusCode);
}

/** The 20001 envelope of a FavoriteError; undefined for any other failure. */
function favoriteRefusal(error: unknown, traceId: string): HandlerResult | undefined {
  if (!(error instanceof FavoriteError)) return undefined;
  const full = error.data.reason === 'favorites_full';
  return {
    status: 400,
    envelope: {
      code: 20001,
      msg: full ? FULL_MSG : INVALID_MSG,
      data: full ? { reason: 'favorites_full' } : { fields: [...(error.data.fields ?? [])] },
      trace_id: traceId,
    },
  };
}

function listItem(item: FavoriteListItem): FavoriteItem {
  return {
    // app.favorites.platform is checked against the platform dictionary when it is written.
    platform: item.platform as FavoriteItem['platform'],
    product_key: item.productKey,
    favorited_at: item.favoritedAt.toISOString(),
    invalid: item.invalid,
    product_card: item.invalid
      ? { title: item.productCard.title, image: item.productCard.image }
      : item.productCard,
  };
}

export class FavoritesController {
  readonly #ports: FavoritesRoutePorts;
  readonly #idempotency: Idempotency | undefined;

  constructor(ports: FavoritesRoutePorts, idempotency: Idempotency | undefined) {
    this.#ports = ports;
    this.#idempotency = idempotency;
  }

  #session(request: FavoritesRequest): {
    principal: TokenPrincipal;
    favorites: FavoritesService;
  } {
    const principal = tokenPrincipal(request);
    const favorites = this.#ports.favorites;
    if (favorites === null || principal === undefined) {
      throw new Error('catalog: favorites need the database and a verified token');
    }
    return { principal, favorites };
  }

  /** Runs one write under the request's Idempotency-Key and sends the (stored) response. */
  async #write(
    request: FavoritesRequest,
    reply: RawReply,
    method: 'PUT' | 'DELETE' | 'POST',
    path: string,
    body: unknown,
    principal: TokenPrincipal,
    work: () => Promise<HandlerResult>,
  ): Promise<void> {
    const idempotency = this.#idempotency;
    if (idempotency === undefined) {
      throw new Error('catalog: favorites writes need the idempotency primitive');
    }
    const key = request.headers['idempotency-key'];
    const result = await idempotency.execute(
      {
        appId: principal.app_id,
        actor: { userId: principal.uid, deviceId: principal.device_id, phoneHmac: null },
        method,
        path,
        key: typeof key === 'string' ? key : undefined,
        body,
        traceId: request.id,
      },
      async () => {
        try {
          return await work();
        } catch (error: unknown) {
          const refused = favoriteRefusal(error, request.id);
          if (refused === undefined) throw error;
          return refused;
        }
      },
    );
    reply.code(result.status).type('application/json; charset=utf-8').send(result.body);
  }

  /** Path parameters of PUT / DELETE, checked against the dictionary before any write. */
  async #target(request: FavoritesRequest): Promise<{ platform: string; productKey: string }> {
    const platform = request.params?.platform ?? '';
    const productKey = request.params?.product_key ?? '';
    const rows = await this.#ports.catalog.listPlatforms();
    if (!belongsTo(rows, platform, productKey)) throw invalidFields(['product_key'], request.id);
    return { platform, productKey };
  }

  async list(request: FavoritesRequest): Promise<FavoriteListResponse> {
    const { principal, favorites } = this.#session(request);
    try {
      const page = await favorites.listFavorites(
        { appId: principal.app_id, userId: principal.uid, deviceId: principal.device_id },
        request.query?.cursor ?? null,
      );
      return {
        code: 0,
        msg: '',
        data: { items: page.items.map(listItem), next_cursor: page.nextCursor },
        trace_id: request.id,
      };
    } catch (error: unknown) {
      const refused = favoriteRefusal(error, request.id);
      if (refused === undefined) throw error;
      throw new HttpException(refused.envelope, refused.status);
    }
  }

  async add(request: FavoritesRequest, reply: RawReply): Promise<void> {
    const { principal, favorites } = this.#session(request);
    const { platform, productKey } = await this.#target(request);
    const path = `/v1/me/favorites/${encodeURIComponent(platform)}/${encodeURIComponent(productKey)}`;
    await this.#write(request, reply, 'PUT', path, undefined, principal, async () => {
      const record = await favorites.addFavorite(
        principal.app_id,
        principal.uid,
        platform,
        productKey,
      );
      return {
        status: 200,
        envelope: {
          code: 0,
          msg: '',
          data: {
            platform: record.platform,
            product_key: record.productKey,
            favorited_at: record.favoritedAt.toISOString(),
          },
          trace_id: request.id,
        },
      };
    });
  }

  async remove(request: FavoritesRequest, reply: RawReply): Promise<void> {
    const { principal, favorites } = this.#session(request);
    const { platform, productKey } = await this.#target(request);
    const path = `/v1/me/favorites/${encodeURIComponent(platform)}/${encodeURIComponent(productKey)}`;
    await this.#write(request, reply, 'DELETE', path, undefined, principal, async () => {
      await favorites.removeFavorite(principal.app_id, principal.uid, platform, productKey);
      return { status: 200, envelope: { code: 0, msg: '', data: {}, trace_id: request.id } };
    });
  }

  async batchDelete(request: FavoritesRequest, reply: RawReply): Promise<void> {
    const { principal, favorites } = this.#session(request);
    const body = request.body as BatchDeleteBody;
    const rows = await this.#ports.catalog.listPlatforms();
    const fields = body.items.flatMap((item, index) =>
      belongsTo(rows, item.platform, item.product_key) ? [] : [`items.${index}.product_key`],
    );
    if (fields.length > 0) throw invalidFields(fields, request.id);
    const items: FavoriteKey[] = body.items.map((item) => ({
      platform: item.platform,
      productKey: item.product_key,
    }));
    await this.#write(
      request,
      reply,
      'POST',
      '/v1/me/favorites/batch-delete',
      body,
      principal,
      async () => {
        await favorites.removeFavorites(principal.app_id, principal.uid, items);
        return { status: 200, envelope: { code: 0, msg: '', data: {}, trace_id: request.id } };
      },
    );
  }
}

{
  const prototype = FavoritesController.prototype;
  const list = Object.getOwnPropertyDescriptor(prototype, 'list')!;
  const add = Object.getOwnPropertyDescriptor(prototype, 'add')!;
  const remove = Object.getOwnPropertyDescriptor(prototype, 'remove')!;
  const batchDelete = Object.getOwnPropertyDescriptor(prototype, 'batchDelete')!;
  Inject(FAVORITES_ROUTE)(FavoritesController, undefined, 0);
  Inject(IDEMPOTENCY)(FavoritesController, undefined, 1);
  Optional()(FavoritesController, undefined, 1);
  Req()(prototype, 'list', 0);
  Get('me/favorites')(prototype, 'list', list);
  RouteSchema(contractRouteSchema('listFavorites'))(prototype, 'list', list);
  Req()(prototype, 'add', 0);
  Res()(prototype, 'add', 1);
  Put('me/favorites/:platform/:product_key')(prototype, 'add', add);
  HttpCode(200)(prototype, 'add', add);
  RouteSchema({ ...contractRouteSchema('addFavorite'), querystring: NO_QUERY })(
    prototype,
    'add',
    add,
  );
  Req()(prototype, 'remove', 0);
  Res()(prototype, 'remove', 1);
  Delete('me/favorites/:platform/:product_key')(prototype, 'remove', remove);
  HttpCode(200)(prototype, 'remove', remove);
  RouteSchema({ ...contractRouteSchema('removeFavorite'), querystring: NO_QUERY })(
    prototype,
    'remove',
    remove,
  );
  Req()(prototype, 'batchDelete', 0);
  Res()(prototype, 'batchDelete', 1);
  Post('me/favorites/batch-delete')(prototype, 'batchDelete', batchDelete);
  HttpCode(200)(prototype, 'batchDelete', batchDelete);
  RouteSchema({ ...contractRouteSchema('batchDeleteFavorites'), querystring: NO_QUERY })(
    prototype,
    'batchDelete',
    batchDelete,
  );
  Controller('v1')(FavoritesController);
}
