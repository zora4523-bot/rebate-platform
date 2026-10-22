import type { DB } from '@couli/db';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
} from 'kysely';
import { afterEach, expect, it, vi } from 'vitest';
import { FixedClock } from '../../platform/index.ts';
import type { PushDeliveryChannel } from '../ports/push-delivery.ts';
import { createPushSendCore, type PushSendInput, type PushSendOptions } from './push-send.ts';

const handles: Kysely<DB>[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((db) => db.destroy()));
});

const NOW = '2026-10-22T04:00:00.000Z';
const USER = '019a0000-0000-7000-8000-000000000001';

type Switches = { service_push: boolean; subscription_push: boolean; marketing_push: boolean };

interface Script {
  /** The inbox log already exists (record() is a no-op). */
  duplicate?: boolean;
  templateCategory?: string;
  /** Settings row answered by each successive settings read; the last one repeats. */
  settings?: readonly (Switches | undefined)[];
  tokens?: readonly Record<string, unknown>[];
  /** Stored push log state; null = no push log. */
  pushLog?: { status: string; row_version: number } | null;
  message?: Record<string, unknown> | null;
  resultFails?: boolean;
}

const OFF: Switches = { service_push: false, subscription_push: false, marketing_push: false };
const ON: Switches = { service_push: true, subscription_push: true, marketing_push: true };

const isClaim = (sql: string) =>
  sql.startsWith('update "app"."notify_logs" set "row_version" = "row_version" + $1');
const isSuppress = (sql: string) =>
  sql.startsWith('update "app"."notify_logs" set "status" = $1, "suppress_reason" = $2');
const isResult = (sql: string) =>
  sql.startsWith('update "app"."notify_logs" set "status" = $1, "sent_at" = $2');
const isLockLog = (sql: string) =>
  sql.startsWith('select "id", "status", "row_version" from "app"."notify_logs"');
const isTokens = (sql: string) => sql.includes('from "app"."push_tokens"');
const isSettings = (sql: string) => sql.includes('from "app"."notification_settings"');

// Real Kysely SQL compilation with an in-memory driver that answers by statement and keeps the
// push log's state (status, row_version) so conditional updates behave; no database.
async function fixture(script: Script = {}) {
  const driver = new DummyDriver();
  const connection = await driver.acquireConnection();
  const queries: CompiledQuery[] = [];
  const marker = (sql: string) => queries.push({ sql, parameters: [] } as unknown as CompiledQuery);
  const log =
    script.pushLog === null ? undefined : { status: 'queued', row_version: 0, ...script.pushLog };
  let settingsReads = 0;
  connection.executeQuery = async <R>(query: CompiledQuery) => {
    queries.push(query);
    const sql = query.sql;
    const p = query.parameters;
    let rows: unknown[] = [];
    if (sql.startsWith('insert into "app"."notify_logs"')) {
      const isInbox = p.includes('inbox');
      rows = isInbox && script.duplicate === true ? [] : [{ id: `log-${queries.length}` }];
    } else if (sql.startsWith('select "category" from "app"."notify_templates"')) {
      rows = script.templateCategory === undefined ? [] : [{ category: script.templateCategory }];
    } else if (isSettings(sql)) {
      const seq = script.settings ?? [undefined];
      const row = seq[Math.min(settingsReads, seq.length - 1)];
      settingsReads += 1;
      rows = row === undefined ? [] : [row];
    } else if (isTokens(sql)) {
      rows = [...(script.tokens ?? [])];
    } else if (isLockLog(sql)) {
      rows = log === undefined ? [] : [{ id: 'push-log', ...log }];
    } else if (sql.startsWith('select "m"."message_id", "m"."title", "m"."body"')) {
      rows =
        script.message === null
          ? []
          : [script.message ?? { message_id: 'inbox-log', title: '标题', body: '正文' }];
    } else if (isClaim(sql)) {
      if (log !== undefined && log.status === 'queued' && log.row_version === 0) {
        log.row_version = 1;
        rows = [{ id: p[3] }];
      }
    } else if (isSuppress(sql)) {
      if (log !== undefined && log.status === 'queued' && log.row_version === p.at(-1)) {
        log.status = 'suppressed';
        log.row_version += 1;
      }
    } else if (isResult(sql)) {
      if (script.resultFails === true) throw new Error('fixture result write failure');
      if (log !== undefined && log.status === 'queued' && log.row_version === p.at(-1)) {
        log.status = String(p[0]);
        log.row_version += 1;
      }
    }
    return { rows: rows as R[], numAffectedRows: 0n };
  };
  driver.acquireConnection = async () => connection;
  driver.beginTransaction = async () => void marker('own:BEGIN');
  driver.commitTransaction = async () => void marker('own:COMMIT');
  driver.rollbackTransaction = async () => void marker('own:ROLLBACK');
  const db = new Kysely<DB>({
    dialect: {
      createDriver: () => driver,
      createAdapter: () => new PostgresAdapter(),
      createIntrospector: (handle) => new PostgresIntrospector(handle),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  }).withSchema('app');
  handles.push(db);
  const clock = new FixedClock(NOW);
  const channel = {
    send: vi.fn<PushDeliveryChannel['send']>().mockResolvedValue({ status: 'accepted' }),
  };
  const sessionValidity = vi
    .fn<PushSendOptions['sessionValidity']>()
    .mockImplementation(async (_executor, query) => new Set(query.sids));
  const input: PushSendInput = {
    app_id: 'couli',
    user_id: USER,
    code: 'ORDER_TRACKED',
    variant: 'default',
    eventKey: 'event-a',
    title: '标题',
    body: '正文',
    route: { name: 'OrderDetail', params: { order_id: 'order-a' } },
    category: 'service',
  };
  const core = () => createPushSendCore({ clock, channel, sessionValidity });
  /** The production sequence: record() in the caller's transaction, then dispatch(db). */
  async function send() {
    const instance = core();
    await db.transaction().execute((trx) => instance.record(trx, input));
    return instance.dispatch(db, input);
  }
  const find = (prefix: string) => queries.filter((q) => q.sql.startsWith(prefix));
  const where = (pred: (sql: string) => boolean) => queries.filter((q) => pred(q.sql));
  const sqls = () => queries.map((q) => q.sql);
  return {
    db,
    queries,
    log,
    clock,
    channel,
    sessionValidity,
    input,
    core,
    send,
    find,
    where,
    sqls,
  };
}

function token(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    user_id: USER,
    bound_sid: `sid-${id}`,
    provider: 'mobpush',
    token: `device-reg-${id}`,
    frozen_until: null,
    revoked_at: null,
    ...overrides,
  };
}

it('[AC-B1-12o#15] record() of a duplicate event writes nothing more and never calls the channel', async () => {
  const f = await fixture({ duplicate: true });
  await f.db.transaction().execute((trx) => f.core().record(trx, f.input));
  expect(f.queries.filter((q) => !q.sql.startsWith('own:'))).toHaveLength(1);
  expect(f.queries[1]?.sql).toContain('on conflict ("app_id", "dedupe_key") do nothing');
  expect(f.where(isSettings)).toHaveLength(0);
  expect(f.channel.send).not.toHaveBeenCalled();
});

it('[AC-B1-12o#30] record() with the switch on writes inbox, inbox log and a queued push log (row_version 0); no token read, no channel', async () => {
  const f = await fixture({ settings: [ON], tokens: [token('a')] });
  await f.db.transaction().execute((trx) => f.core().record(trx, f.input));
  const logs = f.find('insert into "app"."notify_logs"');
  expect(logs).toHaveLength(2);
  expect(logs[1]?.parameters).toEqual(
    expect.arrayContaining(['push', 'event-a:push', 'queued', null, 0]),
  );
  expect(f.find('insert into "app"."inbox_messages"')).toHaveLength(1);
  expect(f.where(isSettings)).toHaveLength(1);
  expect(f.where(isTokens)).toHaveLength(0);
  expect(f.sessionValidity).not.toHaveBeenCalled();
  expect(f.channel.send).not.toHaveBeenCalled();
});

it('[AC-B1-12o#30] record() with the category switched off writes the push log suppressed(push_disabled), row_version 0', async () => {
  const f = await fixture({
    templateCategory: 'subscription',
    settings: [{ ...ON, subscription_push: false }],
    tokens: [token('a')],
  });
  await f.db.transaction().execute((trx) => f.core().record(trx, f.input));
  const logs = f.find('insert into "app"."notify_logs"');
  expect(logs[1]?.parameters).toEqual(
    expect.arrayContaining(['push', 'event-a:push', 'suppressed', 'push_disabled', 0]),
  );
  expect(f.find('insert into "app"."inbox_messages"')).toHaveLength(1);
  expect(f.where(isTokens)).toHaveLength(0);
  expect(f.channel.send).not.toHaveBeenCalled();
});

it('[AC-B1-12o#32] switch turned off after the event was recorded: dispatch suppresses the queued log under its row lock, claims nothing, locks no token (Codex r3 S1)', async () => {
  const f = await fixture({
    duplicate: true,
    settings: [{ ...ON, service_push: false }],
    tokens: [token('a')],
  });
  expect(await f.core().dispatch(f.db, f.input)).toBe('suppressed');
  expect(f.channel.send).not.toHaveBeenCalled();
  expect(f.where(isClaim)).toHaveLength(0);
  expect(f.where(isTokens)).toHaveLength(0);
  expect(f.where(isSuppress)[0]?.parameters).toEqual(
    expect.arrayContaining(['suppressed', 'push_disabled', null, 'push-log', 'queued', 0]),
  );
  expect(f.where(isLockLog)[0]?.sql).toMatch(/for update$/);
  expect(f.log).toMatchObject({ status: 'suppressed', row_version: 1 });
});

it('[AC-B1-12o#32] switch turned off between the committed claim and the delivery: suppressed over the claimed state, no channel call', async () => {
  const f = await fixture({ duplicate: true, settings: [undefined, OFF], tokens: [token('a')] });
  expect(await f.core().dispatch(f.db, f.input)).toBe('suppressed');
  expect(f.where(isClaim)).toHaveLength(1);
  expect(f.where(isSuppress)[0]?.parameters.at(-1)).toBe(1);
  // Tokens were checked before the claim only; the delivery stops at the switch.
  expect(f.where(isTokens)).toHaveLength(1);
  expect(f.channel.send).not.toHaveBeenCalled();
  expect(f.log).toMatchObject({ status: 'suppressed', row_version: 2 });
});

it('[AC-B1-12o#7] the payload is exactly message_id, title and body of the stored message; route stays in the inbox row', async () => {
  const f = await fixture({ tokens: [token('a')] });
  expect(await f.send()).toBe('success');
  const inbox = f.find('insert into "app"."inbox_messages"')[0];
  expect(inbox?.parameters).toContain(JSON.stringify(f.input.route));
  expect(f.channel.send).toHaveBeenCalledTimes(1);
  expect(f.channel.send.mock.calls[0]?.[1]).toStrictEqual({
    message_id: 'inbox-log',
    title: '标题',
    body: '正文',
  });
  const message = f.find('select "m"."message_id"')[0];
  expect(message?.sql).toContain('"m"."app_id" = $1');
  expect(message?.parameters).toEqual(['couli', 'event-a', 'inbox']);
  expect(f.where(isResult)[0]?.parameters).toEqual(
    expect.arrayContaining(['success', f.clock.now(), 'queued', 1]),
  );
});

it('[AC-B1-12o#9] frozen, revoked and invalid-session rows are skipped and unbound by the read (user_id, bound_sid)', async () => {
  const later = new Date(new Date(NOW).getTime() + 1);
  const f = await fixture({
    duplicate: true,
    tokens: [
      token('good'),
      token('frozen', { frozen_until: later }),
      token('thawed', { frozen_until: new Date(NOW) }),
      token('revoked', { revoked_at: new Date(NOW) }),
      token('stale'),
      token('unbound', { bound_sid: null }),
    ],
  });
  f.sessionValidity.mockImplementation(
    async (_executor, query) => new Set(query.sids.filter((sid) => sid !== 'sid-stale')),
  );
  expect(await f.core().dispatch(f.db, f.input)).toBe('success');
  expect(f.sessionValidity.mock.calls[0]?.[1]).toEqual({
    app_id: 'couli',
    user_id: USER,
    sids: ['sid-good', 'sid-thawed', 'sid-stale'],
  });
  expect(f.channel.send.mock.calls[0]?.[0]).toEqual([
    { provider: 'mobpush', token: 'device-reg-good' },
    { provider: 'mobpush', token: 'device-reg-thawed' },
  ]);
  // The in-memory driver keeps the rows bound, so the delivery's re-check unbinds them again.
  const unbinds = f.find('update "app"."push_tokens"');
  expect(unbinds.slice(0, 3).map((q) => q.parameters.slice(-3))).toEqual([
    ['couli', USER, 'sid-frozen'],
    ['couli', USER, 'sid-revoked'],
    ['couli', USER, 'sid-stale'],
  ]);
});

it('[AC-B1-12o#9] the recipient token rows are read FOR UPDATE in id order before every session check, and before the claim', async () => {
  const f = await fixture({ duplicate: true, tokens: [token('a')] });
  const lockedBeforeCheck: boolean[] = [];
  f.sessionValidity.mockImplementation(async (_executor, query) => {
    lockedBeforeCheck.push(f.sqls().at(-1)?.endsWith('order by "id" for update') === true);
    return new Set(query.sids);
  });
  expect(await f.core().dispatch(f.db, f.input)).toBe('success');
  const locks = f.where(isTokens);
  expect(locks).toHaveLength(2);
  for (const lock of locks) {
    expect(lock.sql).toContain('order by "id" for update');
    expect(lock.parameters).toEqual(['couli', USER]);
  }
  expect(lockedBeforeCheck).toEqual([true, true]);
  const sqls = f.sqls();
  expect(sqls.findIndex(isTokens)).toBeLessThan(sqls.findIndex(isClaim));
  expect(f.channel.send).toHaveBeenCalledTimes(1);
});

it('[AC-B1-12o#13] no usable registration records failed under the log lock without a claim; never suppressed, no channel call', async () => {
  const f = await fixture({ duplicate: true, tokens: [token('a', { revoked_at: new Date(NOW) })] });
  expect(await f.core().dispatch(f.db, f.input)).toBe('failed');
  expect(f.where(isClaim)).toHaveLength(0);
  expect(f.channel.send).not.toHaveBeenCalled();
  expect(f.where(isResult)[0]?.parameters).toEqual(expect.arrayContaining(['failed', 'queued', 0]));
  expect(f.where(isSuppress)).toHaveLength(0);
  expect(f.sqls().filter((s) => s.startsWith('own:'))).toEqual(['own:BEGIN', 'own:COMMIT']);
  expect(f.log).toMatchObject({ status: 'failed', row_version: 1 });
});

it('[AC-B1-12o#33] a session check failure before the claim rolls back and leaves the log unclaimed; a later dispatch sends once', async () => {
  const f = await fixture({ duplicate: true, tokens: [token('a')] });
  const failure = new Error('fixture validity read failure');
  f.sessionValidity.mockRejectedValueOnce(failure);
  await expect(f.core().dispatch(f.db, f.input)).rejects.toBe(failure);
  expect(f.where(isClaim)).toHaveLength(0);
  expect(f.sqls()).toContain('own:ROLLBACK');
  expect(f.log).toMatchObject({ status: 'queued', row_version: 0 });
  expect(f.channel.send).not.toHaveBeenCalled();
  expect(await f.core().dispatch(f.db, f.input)).toBe('success');
  expect(await f.core().dispatch(f.db, f.input)).toBe('skipped');
  expect(f.channel.send).toHaveBeenCalledTimes(1);
});

it('[AC-B1-12o#38] a channel error leaves the push log queued, row_version 1 (result unknown); no result write, no resend', async () => {
  const f = await fixture({ duplicate: true, tokens: [token('a')] });
  f.channel.send.mockRejectedValue(new Error('fixture channel failure'));
  expect(await f.core().dispatch(f.db, f.input)).toBe('unknown');
  expect(f.channel.send).toHaveBeenCalledTimes(1);
  expect(f.where(isResult)).toHaveLength(0);
  expect(f.log).toMatchObject({ status: 'queued', row_version: 1 });
  expect(await f.core().dispatch(f.db, f.input)).toBe('skipped');
  expect(f.channel.send).toHaveBeenCalledTimes(1);
});

it('[AC-B1-12o#37] a result write that fails is undone alone under a savepoint; a retry does not resend', async () => {
  const f = await fixture({ duplicate: true, tokens: [token('a')], resultFails: true });
  const core = f.core();
  expect(await core.dispatch(f.db, f.input)).toBe('unknown');
  const sqls = f.sqls();
  const savepoint = sqls.indexOf('SAVEPOINT push_send_result');
  expect(savepoint).toBeGreaterThan(sqls.findIndex(isClaim));
  expect(sqls.indexOf('ROLLBACK TO SAVEPOINT push_send_result')).toBeGreaterThan(savepoint);
  expect(sqls).not.toContain('RELEASE SAVEPOINT push_send_result');
  expect(f.log).toMatchObject({ status: 'queued', row_version: 1 });
  expect(await core.dispatch(f.db, f.input)).toBe('skipped');
  expect(f.channel.send).toHaveBeenCalledTimes(1);
});

it('[AC-B1-12o#7] dispatch() runs two own transactions on the root handle, issues no COMMIT/BEGIN of its own SQL, and commits the claim before re-locking tokens and calling the channel', async () => {
  const f = await fixture({ tokens: [token('a')] });
  let beforeCall: string[] = [];
  f.channel.send.mockImplementation(async () => {
    beforeCall = f.sqls();
    return { status: 'accepted' };
  });
  expect(await f.send()).toBe('success');
  const sqls = f.sqls();
  // record's caller transaction, then dispatch's decision and delivery transactions.
  expect(sqls.filter((s) => s.startsWith('own:'))).toEqual([
    'own:BEGIN',
    'own:COMMIT',
    'own:BEGIN',
    'own:COMMIT',
    'own:BEGIN',
    'own:COMMIT',
  ]);
  expect(sqls).not.toContain('COMMIT');
  expect(sqls.some((s) => s.startsWith('BEGIN'))).toBe(false);
  const claim = beforeCall.findIndex(isClaim);
  expect(claim).toBeGreaterThan(-1);
  const committed = beforeCall.indexOf('own:COMMIT', claim);
  expect(committed).toBeGreaterThan(claim);
  expect(beforeCall.slice(committed).some(isTokens)).toBe(true);
  expect(f.where(isClaim)[0]?.sql).toBe(
    'update "app"."notify_logs" set "row_version" = "row_version" + $1, "updated_at" = $2 ' +
      'where "app_id" = $3 and "id" = $4 and "status" = $5 and "row_version" = $6 returning "id"',
  );
  expect(f.where(isClaim)[0]?.parameters).toEqual([
    1,
    f.clock.now(),
    'couli',
    'push-log',
    'queued',
    0,
  ]);
  expect(f.queries.indexOf(f.where(isResult)[0]!)).toBeGreaterThanOrEqual(beforeCall.length);
});

it("[AC-B1-12o#36] dispatch() refuses a caller transaction: it never runs inside, commits or begins someone else's transaction", async () => {
  const f = await fixture({ tokens: [token('a')] });
  await f.db.transaction().execute(async (trx) => {
    await expect(f.core().dispatch(trx, f.input)).rejects.toThrow(/root handle/);
  });
  expect(f.channel.send).not.toHaveBeenCalled();
  expect(f.where(isLockLog)).toHaveLength(0);
});

it('[AC-B1-12o#15] the core exposes only record and dispatch: first send, resume and retry all reach the channel through dispatch', async () => {
  const f = await fixture({ tokens: [token('a')] });
  expect(Object.keys(f.core()).sort()).toEqual(['dispatch', 'record']);
  await f.db.transaction().execute((trx) => f.core().record(trx, f.input));
  expect(f.channel.send).not.toHaveBeenCalled();
  const first = await fixture({ duplicate: true, tokens: [token('a')] });
  await first.core().dispatch(first.db, first.input);
  const resumed = await fixture({ duplicate: true, tokens: [token('a')] });
  await resumed.send();
  const strip = (list: string[]) =>
    list.filter((s) => !s.startsWith('own:') && !s.startsWith('insert'));
  expect(strip(resumed.sqls())).toEqual(strip(first.sqls()));
  for (const g of [first, resumed]) {
    expect(g.channel.send).toHaveBeenCalledTimes(1);
    expect(g.log).toMatchObject({ status: 'success', row_version: 2 });
  }
});

it.each([
  { status: 'queued', row_version: 1 },
  { status: 'queued', row_version: 3 },
  { status: 'success', row_version: 2 },
  { status: 'failed', row_version: 2 },
  { status: 'suppressed', row_version: 0 },
  { status: 'suppressed', row_version: 1 },
])(
  '[AC-B1-12o#34] a retry never resends an attempted or finished push log ($status, row_version $row_version)',
  async (state) => {
    const f = await fixture({ duplicate: true, tokens: [token('a')], pushLog: state });
    expect(await f.core().dispatch(f.db, f.input)).toBe('skipped');
    expect(await f.send()).toBe('skipped');
    expect(f.channel.send).not.toHaveBeenCalled();
    expect(f.where(isClaim)).toHaveLength(0);
    expect(f.where(isSuppress)).toHaveLength(0);
    expect(f.where(isSettings)).toHaveLength(0);
    expect(f.where(isTokens)).toHaveLength(0);
    expect(f.log).toMatchObject(state);
  },
);

it('[AC-B1-12o#33] a recorded but never attempted push is resumed once with the stored message', async () => {
  const f = await fixture({
    duplicate: true,
    tokens: [token('a')],
    message: { message_id: 'inbox-log', title: '已存标题', body: '已存正文' },
  });
  await f.send();
  await f.send();
  expect(f.find('insert into "app"."inbox_messages"')).toHaveLength(0);
  expect(f.channel.send).toHaveBeenCalledTimes(1);
  expect(f.channel.send.mock.calls[0]?.[1]).toStrictEqual({
    message_id: 'inbox-log',
    title: '已存标题',
    body: '已存正文',
  });
  expect(f.log).toMatchObject({ status: 'success', row_version: 2 });
});

it('[AC-B1-12o#35] concurrent dispatches of one event: only the claim winner delivers and calls the channel', async () => {
  const f = await fixture({ duplicate: true, tokens: [token('a')] });
  const core = f.core();
  const outcomes = await Promise.all([
    core.dispatch(f.db, f.input),
    core.dispatch(f.db, f.input),
    core.dispatch(f.db, f.input),
  ]);
  expect(outcomes.filter((o) => o === 'success')).toHaveLength(1);
  expect(outcomes.filter((o) => o === 'skipped')).toHaveLength(2);
  expect(f.channel.send).toHaveBeenCalledTimes(1);
  expect(f.where(isResult)).toHaveLength(1);
});

it('[AC-B1-12o#41] no push log for the event (unknown event) does nothing', async () => {
  const f = await fixture({ pushLog: null, tokens: [token('a')] });
  expect(await f.core().dispatch(f.db, f.input)).toBe('skipped');
  expect(f.channel.send).not.toHaveBeenCalled();
  expect(f.where(isSettings)).toHaveLength(0);
});

it('[AC-B1-12o#5] every read is scoped by app_id; the template read also by code and variant', async () => {
  const f = await fixture({ tokens: [token('a')] });
  await f.send();
  const reads = f.queries.filter((q) => q.sql.startsWith('select'));
  expect(reads.length).toBeGreaterThan(0);
  for (const read of reads) expect(read.sql).toContain('"app_id" = $1');
  const template = f.find('select "category" from "app"."notify_templates"');
  // record, the decision and the delivery each read the category again.
  expect(template).toHaveLength(3);
  for (const read of template)
    expect(read.parameters).toEqual(['couli', 'ORDER_TRACKED', 'default']);
  expect(f.where(isLockLog)[0]?.parameters).toEqual(['couli', 'event-a:push', 'push']);
});
