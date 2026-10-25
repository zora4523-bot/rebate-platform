// B1-12z · notify_templates reads and the conditional writes of the console's channel page
// (CT-24t). notification is the single writer of notify_templates (规划/02 §4.1).
//
// Every write of a code runs in one transaction:
//   1. UPDATE every row of (app_id, code) WHERE row_version = the expected version, setting
//      row_version + 1 (and the channels, for a switch); fewer rows than the code had when it was
//      read (0 when someone else wrote meanwhile) → nothing is kept, the caller answers 20902;
//   2. the variant row's registration columns, when the write has some;
//   3. the audit row, through admin's writer bound to the same transaction.
// The version check and the write are the same conditional UPDATE, so a write prepared before a
// test SMS went out never overwrites a change made while it was in flight.
//
// Pure module (no decorators, erasable syntax).
import type { DB } from '@couli/db';
import type { Kysely, Updateable } from 'kysely';
import type { AuditInput, AuditPort } from '../../platform/index.ts';
import type { TemplateRow } from './view.ts';

type TemplateUpdate = Updateable<DB['notify_templates']>;

const COLUMNS = [
  'code',
  'variant',
  'category',
  'channels',
  'row_version',
  'updated_at',
  'sms_sign_name',
  'sms_template_code',
  'sms_template_type',
  'sms_preview_text',
  'sms_pending_sign_name',
  'sms_pending_template_code',
  'sms_pending_template_type',
  'sms_pending_preview_text',
  'sms_test_status',
  'sms_tested_at',
] as const;

export interface CodeWrite {
  readonly appId: string;
  readonly code: string;
  /** The version the caller checked; the write applies only while every row still has it. */
  readonly expected: number;
  /** How many rows the code had when it was read. */
  readonly rowCount: number;
  /** New channels of every row (a switch). */
  readonly channels?: readonly string[];
  /** Registration columns of one variant row. */
  readonly variant?: { readonly name: string; readonly set: TemplateUpdate };
  readonly audit: Omit<AuditInput, 'appId'>;
}

export interface TemplateStore {
  /** Every row of the app, by code then variant. */
  appRows(appId: string): Promise<TemplateRow[]>;
  /** Every row of one code. */
  codeRows(appId: string, code: string): Promise<TemplateRow[]>;
  /** One conditional write; false when the code's version moved on (nothing written). */
  write(input: CodeWrite): Promise<boolean>;
}

/** Thrown inside the transaction to roll it back when the version moved on. */
class VersionMoved extends Error {}

export function createTemplateStore(deps: {
  readonly db: Kysely<DB>;
  /** admin's audit writer bound to a transaction handle. */
  readonly auditWriter: (trx: Kysely<DB>) => AuditPort;
}): TemplateStore {
  const db = deps.db.withSchema('app');
  return {
    async appRows(appId) {
      return db
        .selectFrom('notify_templates')
        .select(COLUMNS)
        .where('app_id', '=', appId)
        .orderBy('code')
        .orderBy('variant')
        .execute();
    },

    async codeRows(appId, code) {
      return db
        .selectFrom('notify_templates')
        .select(COLUMNS)
        .where('app_id', '=', appId)
        .where('code', '=', code)
        .orderBy('variant')
        .execute();
    },

    async write(input) {
      try {
        await db.transaction().execute(async (trx) => {
          const bumped = await trx
            .updateTable('notify_templates')
            .set({
              row_version: input.expected + 1,
              ...(input.channels === undefined ? {} : { channels: [...input.channels] }),
            })
            .where('app_id', '=', input.appId)
            .where('code', '=', input.code)
            .where('row_version', '=', input.expected)
            .executeTakeFirst();
          if (Number(bumped.numUpdatedRows) !== input.rowCount) throw new VersionMoved();
          if (input.variant !== undefined) {
            await trx
              .updateTable('notify_templates')
              .set(input.variant.set)
              .where('app_id', '=', input.appId)
              .where('code', '=', input.code)
              .where('variant', '=', input.variant.name)
              .execute();
          }
          await deps.auditWriter(trx).append({ appId: input.appId, ...input.audit });
        });
        return true;
      } catch (error) {
        if (error instanceof VersionMoved) return false;
        throw error;
      }
    },
  };
}
