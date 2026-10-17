// F1-09f: pages / page_versions on the primary handle (content is their single writer). Login
// names are joined from admin_users at read time (P5: the tables keep admin uuids, a renamed admin
// shows the new name). render_count / error_count are only read (R10). Times are always written
// explicitly from the injected Clock, never left to the columns' now() defaults.
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import type { AuditPort } from '../../platform/index.ts';
import type {
  PageConfigReads,
  PageConfigStore,
  PageConfigTx,
  PageVersionSummary,
  PageVersionView,
  PageView,
} from '../application/page-config-admin.ts';

const UNION_HOST_BLOCK = 'external_page.union_host_block';

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

function count(value: bigint | number | string): number {
  return Number(value);
}

function reads(db: Kysely<DB>): PageConfigReads {
  const app = db.withSchema('app');

  const pageQuery = (appId: string) =>
    app
      .selectFrom('pages as p')
      .leftJoin('admin_users as u', 'u.id', 'p.updated_by_admin_id')
      .select((eb) => [
        'p.page_key',
        'p.current_version',
        'p.gray_version',
        'p.gray_percent',
        'p.revision',
        'p.updated_at',
        'u.login_name as updated_by',
        eb
          .selectFrom('page_versions as v')
          .select((v) => v.fn.max('v.version').as('m'))
          .whereRef('v.app_id', '=', 'p.app_id')
          .whereRef('v.page_key', '=', 'p.page_key')
          .as('latest_version'),
      ])
      .where('p.app_id', '=', appId)
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom('page_versions as s')
            .select(sql`1`.as('one'))
            .whereRef('s.app_id', '=', 'p.app_id')
            .whereRef('s.page_key', '=', 'p.page_key'),
        ),
      );

  type PageResult = Awaited<ReturnType<ReturnType<typeof pageQuery>['executeTakeFirst']>>;
  const pageView = (row: NonNullable<PageResult>): PageView => ({
    page_key: row.page_key,
    current_version: row.current_version,
    gray_version: row.gray_version,
    gray_percent: row.gray_version === null ? 0 : row.gray_percent,
    revision: row.revision,
    latest_version: row.latest_version === null ? null : Number(row.latest_version),
    updated_by: row.updated_by ?? null,
    updated_at: iso(row.updated_at),
  });

  const versionQuery = (appId: string, key: string) =>
    app
      .selectFrom('page_versions as v')
      .innerJoin('admin_users as c', 'c.id', 'v.created_by_admin_id')
      .leftJoin('admin_users as pu', 'pu.id', 'v.publisher')
      .select([
        'v.page_key',
        'v.version',
        'v.status',
        'v.render_count',
        'v.error_count',
        'v.publish_at',
        'pu.login_name as publisher',
        'c.login_name as created_by',
        'v.created_at',
      ])
      .where('v.app_id', '=', appId)
      .where('v.page_key', '=', key);

  type VersionResult = Awaited<ReturnType<ReturnType<typeof versionQuery>['execute']>>[number];
  const summary = (row: VersionResult): PageVersionSummary => ({
    version: row.version,
    status: row.status as PageVersionSummary['status'],
    render_count: count(row.render_count),
    error_count: count(row.error_count),
    publish_at: iso(row.publish_at),
    publisher: row.publisher ?? null,
    created_by: row.created_by,
    created_at: iso(row.created_at)!,
  });

  return {
    async pages(appId, offset, limit) {
      const [items, total] = await Promise.all([
        pageQuery(appId).orderBy('p.page_key').limit(limit).offset(offset).execute(),
        app
          .selectFrom('pages as p')
          .select((eb) => eb.fn.countAll<string>().as('n'))
          .where('p.app_id', '=', appId)
          .where((eb) =>
            eb.exists(
              eb
                .selectFrom('page_versions as s')
                .select(sql`1`.as('one'))
                .whereRef('s.app_id', '=', 'p.app_id')
                .whereRef('s.page_key', '=', 'p.page_key'),
            ),
          )
          .executeTakeFirstOrThrow(),
      ]);
      return { items: items.map(pageView), total: Number(total.n) };
    },

    async page(appId, key) {
      const row = await pageQuery(appId).where('p.page_key', '=', key).executeTakeFirst();
      return row === undefined ? undefined : pageView(row);
    },

    async versions(appId, key, offset, limit) {
      const [items, total] = await Promise.all([
        versionQuery(appId, key).orderBy('v.version', 'desc').limit(limit).offset(offset).execute(),
        app
          .selectFrom('page_versions')
          .select((eb) => eb.fn.countAll<string>().as('n'))
          .where('app_id', '=', appId)
          .where('page_key', '=', key)
          .executeTakeFirstOrThrow(),
      ]);
      return { items: items.map(summary), total: Number(total.n) };
    },

    async version(appId, key, version) {
      const row = await versionQuery(appId, key)
        .select('v.sections')
        .where('v.version', '=', version)
        .executeTakeFirst();
      if (row === undefined) return undefined;
      const view: PageVersionView = {
        page_key: row.page_key,
        ...summary(row),
        sections: row.sections as PageVersionView['sections'],
      };
      return view;
    },
  };
}

function writeTx(trx: Kysely<DB>, audit: AuditPort): PageConfigTx {
  const app = trx.withSchema('app');
  return {
    ...reads(trx),

    async unionHostBlock(appId) {
      const row = await app
        .selectFrom('config_items')
        .select('value')
        .where('app_id', '=', appId)
        .where('key', '=', UNION_HOST_BLOCK)
        .executeTakeFirst();
      return row === undefined ? undefined : (row.value as unknown);
    },

    async ensurePage(appId, key, at) {
      await app
        .insertInto('pages')
        .values({ app_id: appId, page_key: key, created_at: at, updated_at: at })
        .onConflict((oc) => oc.columns(['app_id', 'page_key']).doNothing())
        .execute();
    },

    async lock(appId, key) {
      const row = await app
        .selectFrom('pages')
        .select(['current_version', 'gray_version', 'gray_percent', 'revision'])
        .where('app_id', '=', appId)
        .where('page_key', '=', key)
        .forUpdate()
        .executeTakeFirst();
      return row === undefined
        ? undefined
        : {
            currentVersion: row.current_version,
            grayVersion: row.gray_version,
            grayPercent: row.gray_percent,
            revision: row.revision,
          };
    },

    async latestVersion(appId, key) {
      const row = await app
        .selectFrom('page_versions')
        .select((eb) => eb.fn.max('version').as('m'))
        .where('app_id', '=', appId)
        .where('page_key', '=', key)
        .executeTakeFirst();
      return row?.m === undefined || row.m === null ? null : Number(row.m);
    },

    async versionRow(appId, key, version) {
      return app
        .selectFrom('page_versions')
        .select(['version', 'status', 'sections'])
        .where('app_id', '=', appId)
        .where('page_key', '=', key)
        .where('version', '=', version)
        .executeTakeFirst();
    },

    async insertVersion(input) {
      await app
        .insertInto('page_versions')
        .values({
          app_id: input.appId,
          page_key: input.key,
          version: input.version,
          sections: sql`${JSON.stringify(input.sections)}::jsonb`,
          status: 'draft',
          created_by_admin_id: input.adminId,
          created_at: input.at,
        })
        .execute();
    },

    async markPublished(appId, key, version, publisher, at) {
      await app
        .updateTable('page_versions')
        .set({ status: 'published', publish_at: at, publisher })
        .where('app_id', '=', appId)
        .where('page_key', '=', key)
        .where('version', '=', version)
        .execute();
    },

    async markRolledBack(appId, key, version) {
      await app
        .updateTable('page_versions')
        .set({ status: 'rolled_back' })
        .where('app_id', '=', appId)
        .where('page_key', '=', key)
        .where('version', '=', version)
        .execute();
    },

    async successor(appId, key, except) {
      const row = await app
        .selectFrom('page_versions')
        .select('version')
        .where('app_id', '=', appId)
        .where('page_key', '=', key)
        .where('status', '=', 'published')
        .where('version', '<>', except)
        .orderBy('publish_at', 'desc')
        .orderBy('version', 'desc')
        .limit(1)
        .executeTakeFirst();
      return row?.version;
    },

    async updatePage(appId, key, pointers, revision, adminId, at) {
      await app
        .updateTable('pages')
        .set({
          current_version: pointers.currentVersion,
          gray_version: pointers.grayVersion,
          gray_percent: pointers.grayPercent,
          revision,
          updated_by_admin_id: adminId,
          updated_at: at,
        })
        .where('app_id', '=', appId)
        .where('page_key', '=', key)
        .execute();
    },

    audit: (input) => audit.append(input),
  };
}

/** Primary connection only; admin's audit port shares each write transaction. */
export function createKyselyPageConfigStore(
  db: Kysely<DB>,
  auditWriter: (trx: Kysely<DB>) => AuditPort,
): PageConfigStore {
  return {
    ...reads(db),
    transaction: (work) => db.transaction().execute((trx) => work(writeTx(trx, auditWriter(trx)))),
  };
}
