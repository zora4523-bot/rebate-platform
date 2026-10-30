// B1-15w: app.share_materials (migration 0101, B1-15v; D10-426) — linking is its only writer.
// - insertShareMaterial: the one row of a share link, written by POST /v1/shares in the transaction
//   that registers the link (insert-only; a repeated generation of the same link is a no-op through
//   share_materials_pkey and ON CONFLICT DO NOTHING). app_id is always the link's own (B1-15v
//   review: links.app_id), share_url the converted short link, tpwd the Taobao token or null
//   (never ''). Images are never stored (BR-ATTR-10 细则「分享页与分享赚入口页」).
// - StoredSharePageMaterials: the share page's material provider (B1-15u SharePageMaterials port)
//   reading the row by (app_id, link_id); a link without a row keeps the D10-424 default (a Taobao
//   link's promo_url, no token). Read only; nothing is converted or made up.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { SharePageMaterials, type SharePageMaterial } from '../application/share-page.ts';
import type { LandingLink } from '../application/link-landing.ts';

/** links.link_id is a uuid column: any other value has no row and is never queried. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ShareMaterialRow {
  /** links.app_id of the share link. */
  readonly appId: string;
  readonly linkId: string;
  readonly shareUrl: string;
  readonly tpwd: string | null;
}

function isWebUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * Writes the share link's material row on the given executor (the registering transaction).
 * Refuses a value the table would never hold rather than storing it.
 */
export async function insertShareMaterial(
  executor: Kysely<DB>,
  row: ShareMaterialRow,
): Promise<void> {
  if (row.appId === '' || !UUID.test(row.linkId)) {
    throw new TypeError('linking: share material without its link');
  }
  if (row.shareUrl === '' || !isWebUrl(row.shareUrl)) {
    throw new TypeError('linking: share material without a web share_url');
  }
  if (row.tpwd === '') throw new TypeError('linking: share material token is empty');
  await executor
    .insertInto('share_materials')
    .values({
      app_id: row.appId,
      link_id: row.linkId,
      share_url: row.shareUrl,
      tpwd: row.tpwd,
    })
    .onConflict((oc) => oc.column('link_id').doNothing())
    .execute();
}

/**
 * The share page's material of a share link: its share_materials row (jump_url = share_url, the
 * row's token), read by the link's own app_id and link_id; without a row the D10-424 default of
 * the base class (Taobao promo_url fallback).
 */
export class StoredSharePageMaterials extends SharePageMaterials {
  readonly #db: Kysely<DB>;

  constructor(db: Kysely<DB>) {
    super();
    this.#db = db;
  }

  override async read(link: LandingLink): Promise<SharePageMaterial | null> {
    if (typeof link.link_id === 'string' && UUID.test(link.link_id)) {
      const row = await this.#db
        .selectFrom('share_materials')
        .select(['share_url', 'tpwd'])
        .where('app_id', '=', link.app_id)
        .where('link_id', '=', link.link_id)
        .executeTakeFirst();
      if (row !== undefined && row.share_url !== '' && isWebUrl(row.share_url)) {
        return { jumpUrl: row.share_url, tpwd: row.tpwd === '' ? null : row.tpwd };
      }
    }
    return super.read(link);
  }
}
