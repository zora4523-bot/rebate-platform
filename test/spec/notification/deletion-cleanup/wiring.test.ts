// F1-02zzk (brief §9.2 #3, §9.3 item 4; static, no database): the notification port of the
// DeletionCleanupPorts app.module passes to IdentityDeletionExpiryModule.forWorker is no longer the
// unavailable marker, and run on a compile-only Kysely transaction (records SQL and parameters,
// never connects) it only ever writes push_tokens, scopes every statement that names the user by
// the app as well, and never touches inbox_messages, notify_logs or notification_settings. The
// connected checks are assembly.int.test.ts.
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import {
  assembledCleanup,
  compileOnlyDb,
  notificationStep,
  ports,
  type CompiledStatement,
} from './kit.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

/** The table a writing statement writes, or null for a read. */
function writtenTable(statement: CompiledStatement): string | null {
  const match = /^\s*(?:delete\s+from|update|insert\s+into)\s+(?:"app"\.)?"([a-z_]+)"/i.exec(
    statement.sql,
  );
  return match === null ? null : match[1]!;
}

it('[AC-F1-02zzk#5] 装配：worker 交给 identity 的 notification 注销清理端口不再是 unavailable 标记；在调用方事务上只写 push_tokens，带 user_id 的语句同时限定 app_id，不碰站内信、发送记录与通知设置', async () => {
  const p = await ports();
  const assembled = await assembledCleanup(p);
  try {
    const step = notificationStep(assembled.ports);
    const statements: CompiledStatement[] = [];
    const db = compileOnlyDb(statements);
    const appId = `nd_wiring_${randomUUID().slice(0, 8)}`;
    const userId = randomUUID();
    try {
      await db.transaction().execute((trx) => step(trx, { appId, userId, at: p.clock.now() }));
    } finally {
      await db.destroy();
    }
    const onTokens = statements.filter((statement) => statement.sql.includes('"push_tokens"'));
    expect(onTokens.length, 'the port ran no statement on push_tokens').toBeGreaterThan(0);
    expect(
      onTokens.some(
        (statement) =>
          statement.parameters.includes(appId) && statement.parameters.includes(userId),
      ),
      'no push_tokens statement is scoped by both app_id and user_id',
    ).toBe(true);
    for (const statement of statements) {
      expect(statement.sql).not.toMatch(/"(inbox_messages|notify_logs|notification_settings)"/);
      const table = writtenTable(statement);
      expect([null, 'push_tokens'], `writes ${table}: ${statement.sql}`).toContain(table);
      expect(
        !statement.parameters.includes(userId) || statement.parameters.includes(appId),
        `names the user without the app: ${statement.sql}`,
      ).toBe(true);
    }
  } finally {
    await assembled.close();
  }
}, 30_000);
