// F1-09f: pages / page_versions on the primary handle (content is their single writer). Login
// names are joined from admin_users at read time (P5: the tables keep admin uuids, a renamed admin
// shows the new name). render_count / error_count are only read (R10). Times are always written
// explicitly from the injected Clock, never left to the columns' now() defaults.
// F1-09p: the reads apply a due scheduled publish on the fly (Y6, the injected Clock's now), the
// scheduler's login name joined like updated_by; a write transaction enqueues the due job on its
// own connection (JobQueue send with trx).
import type { DB } from '@couli/db';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { AuditPort, Clock, JobQueue } from '../../platform/index.ts';
import { newPageVersionStatus, pageVersionChange } from '../domain/pages/version-status.ts';
import {
  type PageSlot,
  effectivePage,
  effectiveVersion,
  slotOf,
} from '../domain/pages/schedule.ts';
import type {
  PageConfigReads,
  PageConfigStore,
  PageConfigTx,
  PageVersionSummary,
  PageVersionView,
  PageView,
} from '../application/page-config-admin.ts';

const UNION_HOST_BLOCK = 'external_page.union_host_block';

/** F1-09p Y11: the due job of a scheduled publish (platform/queue/catalog.ts, worker only). */
export const PAGE_SCHEDULE_QUEUE = 'page-schedule';
export const PAGE_SCHEDULE_JOB = 'content.page_schedule_due';

/** A view's slot: the scheduler's login name (null when the admin row cannot be joined). */
function viewSlot(row: {
  readonly scheduled_version: number | null;
  readonly scheduled_gray_percent: number | null;
  readonly scheduled_at: Date | null;
  readonly scheduled_by: string | null;
}): PageSlot<string | null> | null {
  if (
    row.scheduled_version === null ||
    row.scheduled_gray_percent === null ||
    row.scheduled_at === null
  ) {
    return null;
  }
  return {
    version: row.scheduled_version,
    grayPercent: row.scheduled_gray_percent,
    at: row.scheduled_at,
    by: row.scheduled_by,
  };
}

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

function count(value: bigint | number | string): number {
  return Number(value);
}

function reads(db: Kysely<DB>, clock: Clock): PageConfigReads {
  const app = db.withSchema('app');

  const pageQuery = (appId: string) =>
    app
      .selectFrom('pages as p')
      .leftJoin('admin_users as u', 'u.id', 'p.updated_by_admin_id')
      .leftJoin('admin_users as su', 'su.id', 'p.scheduled_by_admin_id')
      .select((eb) => [
        'p.page_key',
        'p.current_version',
        'p.gray_version',
        'p.gray_percent',
        'p.revision',
        'p.updated_at',
        'u.login_name as updated_by',
        'p.scheduled_version',
        'p.scheduled_gray_percent',
        'p.scheduled_at',
        'su.login_name as scheduled_by',
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
  const pageView = (row: NonNullable<PageResult>, now: Date): PageView => {
    const page = effectivePage(
      {
        currentVersion: row.current_version,
        grayVersion: row.gray_version,
        grayPercent: row.gray_percent,
        revision: row.revision,
        updatedBy: row.updated_by ?? null,
        updatedAt: row.updated_at,
        slot: viewSlot({ ...row, scheduled_by: row.scheduled_by ?? null }),
      },
      now,
    );
    return {
      page_key: row.page_key,
      current_version: page.currentVersion,
      gray_version: page.grayVersion,
      gray_percent: page.grayVersion === null ? 0 : page.grayPercent,
      revision: page.revision,
      latest_version: row.latest_version === null ? null : Number(row.latest_version),
      updated_by: page.updatedBy,
      updated_at: iso(page.updatedAt),
      scheduled:
        page.slot === null
          ? null
          : {
              version: page.slot.version,
              gray_percent: page.slot.grayPercent,
              publish_at: page.slot.at.toISOString(),
              scheduled_by: page.slot.by,
            },
    };
  };

  const versionQuery = (appId: string, key: string) =>
    app
      .selectFrom('page_versions as v')
      .innerJoin('admin_users as c', 'c.id', 'v.created_by_admin_id')
      .leftJoin('admin_users as pu', 'pu.id', 'v.publisher')
      .leftJoin('pages as p', (join) =>
        join.onRef('p.app_id', '=', 'v.app_id').onRef('p.page_key', '=', 'v.page_key'),
      )
      .leftJoin('admin_users as su', 'su.id', 'p.scheduled_by_admin_id')
      .select([
        'p.scheduled_version',
        'p.scheduled_gray_percent',
        'p.scheduled_at',
        'su.login_name as scheduled_by',
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
  const summary = (row: VersionResult, now: Date): PageVersionSummary => {
    const slot = viewSlot({
      scheduled_version: row.scheduled_version ?? null,
      scheduled_gray_percent: row.scheduled_gray_percent ?? null,
      scheduled_at: row.scheduled_at ?? null,
      scheduled_by: row.scheduled_by ?? null,
    });
    const version = effectiveVersion(
      {
        version: row.version,
        status: row.status,
        publishAt: row.publish_at,
        publisher: row.publisher ?? null,
      },
      slot,
      now,
    );
    return {
      version: row.version,
      status: version.status as PageVersionSummary['status'],
      render_count: count(row.render_count),
      error_count: count(row.error_count),
      publish_at: iso(version.publishAt),
      publisher: version.publisher,
      created_by: row.created_by,
      created_at: iso(row.created_at)!,
    };
  };

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
      const now = clock.now();
      return { items: items.map((row) => pageView(row, now)), total: Number(total.n) };
    },

    async page(appId, key) {
      const row = await pageQuery(appId).where('p.page_key', '=', key).executeTakeFirst();
      return row === undefined ? undefined : pageView(row, clock.now());
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
      const now = clock.now();
      return { items: items.map((row) => summary(row, now)), total: Number(total.n) };
    },

    async version(appId, key, version) {
      const row = await versionQuery(appId, key)
        .select('v.sections')
        .where('v.version', '=', version)
        .executeTakeFirst();
      if (row === undefined) return undefined;
      const view: PageVersionView = {
        page_key: row.page_key,
        ...summary(row, clock.now()),
        sections: row.sections as PageVersionView['sections'],
      };
      return view;
    },
  };
}

function writeTx(
  trx: Transaction<DB>,
  audit: AuditPort,
  clock: Clock,
  queue: JobQueue | undefined,
): PageConfigTx {
  const app = trx.withSchema('app');
  return {
    ...reads(trx, clock),

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
        .select([
          'current_version',
          'gray_version',
          'gray_percent',
          'revision',
          'scheduled_version',
          'scheduled_gray_percent',
          'scheduled_at',
          'scheduled_by_admin_id',
        ])
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
            slot: slotOf({
              version: row.scheduled_version,
              grayPercent: row.scheduled_gray_percent,
              at: row.scheduled_at,
              by: row.scheduled_by_admin_id,
            }),
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
          status: newPageVersionStatus(),
          created_by_admin_id: input.adminId,
          created_at: input.at,
        })
        .execute();
    },

    async setVersionStatus(appId, key, version, change, stamp) {
      // The store writes no change the generated table refuses, whatever the caller passed in.
      const { from, to } = pageVersionChange(change.from, change.event);
      if (to !== change.to) {
        throw new Error('page version: change.to differs from the generated transition');
      }
      if ((to === 'published') !== (stamp !== null)) {
        throw new Error('page version: publish_at / publisher go with the change to published');
      }
      const result = await app
        .updateTable('page_versions')
        .set(
          stamp === null
            ? { status: to }
            : { status: to, publish_at: stamp.at, publisher: stamp.publisher },
        )
        .where('app_id', '=', appId)
        .where('page_key', '=', key)
        .where('version', '=', version)
        .where('status', '=', from)
        .executeTakeFirst();
      return result.numUpdatedRows === 1n;
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

    async updatePage(appId, key, pointers, revision, adminId, at, slot) {
      await app
        .updateTable('pages')
        .set({
          current_version: pointers.currentVersion,
          gray_version: pointers.grayVersion,
          gray_percent: pointers.grayPercent,
          revision,
          updated_by_admin_id: adminId,
          updated_at: at,
          ...(slot === undefined
            ? {}
            : {
                scheduled_version: slot?.version ?? null,
                scheduled_gray_percent: slot?.grayPercent ?? null,
                scheduled_at: slot?.at ?? null,
                scheduled_by_admin_id: slot?.by ?? null,
              }),
        })
        .where('app_id', '=', appId)
        .where('page_key', '=', key)
        .execute();
    },

    audit: (input) => audit.append(input),

    async enqueueScheduleDue(appId, key, delaySeconds) {
      if (queue === undefined) throw new Error('content: scheduled publish needs the job queue');
      // The transaction itself (not a withSchema view): the queue checks its isTransaction marker.
      await queue.send(
        PAGE_SCHEDULE_QUEUE,
        PAGE_SCHEDULE_JOB,
        { app_id: appId, page_key: key },
        { trx, delaySeconds },
      );
    },
  };
}

/**
 * Primary connection only; admin's audit port shares each write transaction. `clock` dates the
 * effective views (F1-09p); `queue` (absent: a scheduled publish fails) takes the due jobs.
 */
export function createKyselyPageConfigStore(
  db: Kysely<DB>,
  auditWriter: (trx: Kysely<DB>) => AuditPort,
  clock: Clock,
  queue?: JobQueue,
): PageConfigStore {
  return {
    ...reads(db, clock),
    transaction: (work) =>
      db.transaction().execute((trx) => work(writeTx(trx, auditWriter(trx), clock, queue))),
  };
}
