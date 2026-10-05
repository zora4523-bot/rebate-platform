import { createDb, destroyDb } from '@couli/db';
import { sql } from 'kysely';
import { fixture, REQUEST } from './fixture.ts';

// Isolated test-only child; credentials are for the disposable test DB, received over IPC.
// Plain Node loading also detects an accidental runtime dependency on Nest/dist.
interface Start {
  readonly url: string;
  readonly name: string;
  readonly adminId: string;
  readonly appId: string;
}

function receive(): Promise<unknown> {
  return new Promise((resolve) => process.once('message', resolve));
}

const start = (await receive()) as Start;
const db = createDb({ connectionString: start.url, applicationName: start.name });
try {
  const f = await fixture(db);
  let releaseCode: (() => void) | undefined;
  const codeGate = new Promise<void>((resolve) => {
    releaseCode = resolve;
  });
  let releaseAudit: (() => void) | undefined;
  const auditGate = new Promise<void>((resolve) => {
    releaseAudit = resolve;
  });
  // Register before ready so a release sent while waiting on the DB lock is not lost.
  process.on('message', (message) => {
    if (message === 'confirm') releaseCode!();
    if (message === 'commit') releaseAudit!();
  });
  const bootstrap = f.create({
    newAdminId: () => start.adminId,
    audit: (transaction) => {
      const writer = f.deps.audit(transaction);
      return {
        append: async (event) => {
          const account = await transaction
            .selectFrom('admin_users')
            .select('id')
            .where('id', '=', start.adminId)
            .executeTakeFirst();
          const backend = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(
            transaction,
          );
          // Account is visible in this transaction; parent verifies it is not yet committed.
          process.send!({
            kind: 'in-tx',
            adminId: account?.id,
            transaction: transaction.isTransaction,
            pid: backend.rows[0]!.pid,
          });
          await auditGate;
          await writer.append(event);
        },
      };
    },
    terminal: {
      ...f.deps.terminal,
      readCode: async () => {
        process.send!({ kind: 'prompt' });
        await codeGate;
        return '287082';
      },
    },
  });
  process.send!({ kind: 'ready' });
  await receive();
  const result = await bootstrap.run({
    appId: start.appId,
    loginName: `${REQUEST.loginName}-${start.name}`,
  });
  process.send!({ kind: 'result', exitCode: result.exitCode });
} catch (error) {
  process.send!({
    kind: 'failure',
    message: error instanceof Error ? error.message : String(error),
  });
} finally {
  await destroyDb(db);
  process.disconnect();
}
