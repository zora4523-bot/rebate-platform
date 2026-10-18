// No database, sockets or Nest application startup. Take the real AppModule read factory from
// its provider metadata, then call createPageAudienceFacts with a scripted in-memory PG driver.
// A hand-written hasParent callback alone would stay green while production forgot the wiring.
import type { DB } from '@couli/db';
import { Kysely, PostgresDialect, type PostgresPool } from 'kysely';
import { expect, it, vi } from 'vitest';
import { createPageAudienceFacts } from '../../../../apps/api/src/modules/content/application/page-audience.ts';
import { assembledReads } from './assembly-kit.ts';

const APP = 'f109j_assembly';
const USER = '019a0000-0000-7000-8000-000000000001';
const PARENT = '019a0000-0000-7000-8000-000000000002';

function driver() {
  const control: { parent: string | null; absent: boolean; failure: Error | null } = {
    parent: null,
    absent: false,
    failure: null,
  };
  const queries: { sql: string; parameters: readonly unknown[] }[] = [];
  const client = {
    release() {},
    async query(sql: string, parameters: readonly unknown[] = []) {
      queries.push({ sql, parameters });
      // Only parent reads are expected: other fact ports are explicitly supplied by the test.
      expect(sql).toMatch(/^select\b/i);
      expect(sql).toContain('"users"');
      expect(sql).toContain('"parent_id"');
      if (control.failure !== null) throw control.failure;
      const rows = control.absent ? [] : [{ parent_id: control.parent, parent_bound_at: null }];
      return { command: 'SELECT', rowCount: rows.length, rows };
    },
  };
  const pool = { connect: async () => client, end: async () => undefined, options: {} };
  const db = new Kysely<DB>({
    dialect: new PostgresDialect({ pool: pool as unknown as PostgresPool }),
  }).withSchema('app');
  return { db, control, queries };
}

it.each([true, false])(
  '[AC-F1-09j#9] 装配后的 hasParent 返回 %s 原样进入 AudienceFacts',
  async (hasParent) => {
    const f = driver();
    f.control.parent = hasParent ? PARENT : null;
    try {
      const assembled = await assembledReads(f.db);
      const logger = { warn: vi.fn() };
      const unionBindingStatus = vi.fn(async () => 'active');
      const orderCount = vi.fn(async () => 2);
      const facts = createPageAudienceFacts({
        reads: { ...assembled, unionBindingStatus, orderCount },
        logger,
      });
      expect(await facts.facts(APP, USER)).toEqual({
        hasParent,
        unionAuthorized: true,
        hasOrder: true,
      });
      expect(f.queries).toHaveLength(1);
      expect(f.queries[0]!.parameters).toContain(APP);
      expect(f.queries[0]!.parameters).toContain(USER);
      expect(unionBindingStatus).toHaveBeenCalledTimes(2);
      expect(orderCount).toHaveBeenCalledExactlyOnceWith(APP, USER);
      expect(logger.warn).not.toHaveBeenCalled();
    } finally {
      await f.db.destroy();
    }
  },
);

it('[AC-F1-09j#10] 直调 facts 时上级读口抛错只令 hasParent=null，另两项继续且 warn 一次', async () => {
  const f = driver();
  f.control.failure = new Error('synthetic parent read unavailable');
  try {
    const assembled = await assembledReads(f.db);
    const logger = { warn: vi.fn() };
    const unionBindingStatus = vi.fn(async () => 'active');
    const orderCount = vi.fn(async () => 1);
    const facts = createPageAudienceFacts({
      reads: { ...assembled, unionBindingStatus, orderCount },
      logger,
    });
    expect(await facts.facts(APP, USER)).toEqual({
      hasParent: null,
      unionAuthorized: true,
      hasOrder: true,
    });
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        event: 'content_page_audience_unavailable',
        app_id: APP,
        fact: 'has_parent',
        err: 'synthetic parent read unavailable',
      }),
      expect.any(String),
    );
    expect(f.queries).toHaveLength(1);
    expect(unionBindingStatus).toHaveBeenCalledTimes(2);
    expect(orderCount).toHaveBeenCalledExactlyOnceWith(APP, USER);
    f.control.failure = null;
    f.control.parent = PARENT;
    expect((await facts.facts(APP, USER)).hasParent).toBe(true);
    expect(f.queries).toHaveLength(2);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  } finally {
    await f.db.destroy();
  }
});

it('[AC-F1-09j#11] relationOf 无行返回 null 时按无上级，不能当未知或记录失败', async () => {
  const f = driver();
  f.control.absent = true;
  try {
    const reads = await assembledReads(f.db);
    const logger = { warn: vi.fn() };
    const facts = createPageAudienceFacts({ reads, logger });
    expect(await facts.facts(APP, USER, new Set(['hasParent']))).toEqual({
      hasParent: false,
      unionAuthorized: null,
      hasOrder: null,
    });
    expect(f.queries).toHaveLength(1);
    expect(logger.warn).not.toHaveBeenCalled();
    // A later row must be visible through the very same assembled read port.
    f.control.absent = false;
    f.control.parent = PARENT;
    expect((await facts.facts(APP, USER, new Set(['hasParent']))).hasParent).toBe(true);
    expect(f.queries).toHaveLength(2);
  } finally {
    await f.db.destroy();
  }
});

it('[AC-F1-09j#12] needed 不含 hasParent 不查上级，后续需要时仅查一次', async () => {
  const f = driver();
  f.control.parent = PARENT;
  try {
    const assembled = await assembledReads(f.db);
    const orderCount = vi.fn(async () => 0);
    const unionBindingStatus = vi.fn(async () => 'unbound');
    const logger = { warn: vi.fn() };
    const facts = createPageAudienceFacts({
      reads: { ...assembled, orderCount, unionBindingStatus },
      logger,
    });
    expect(await facts.facts(APP, USER, new Set(['hasOrder']))).toEqual({
      hasParent: null,
      unionAuthorized: null,
      hasOrder: false,
    });
    expect(f.queries).toHaveLength(0);
    expect(unionBindingStatus).not.toHaveBeenCalled();
    expect(orderCount).toHaveBeenCalledTimes(1);
    expect(await facts.facts(APP, USER, new Set(['hasParent']))).toEqual({
      hasParent: true,
      unionAuthorized: null,
      hasOrder: null,
    });
    expect(f.queries).toHaveLength(1);
    expect(orderCount).toHaveBeenCalledTimes(1);
    expect(unionBindingStatus).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  } finally {
    await f.db.destroy();
  }
});
