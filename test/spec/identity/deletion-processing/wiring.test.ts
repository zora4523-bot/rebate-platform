// B1-15g (brief §9.2 #1; §9.3 item 13 「装配：一轮先 processing 后 expiry；无库 token null」): the
// worker's deletion token, built from the options app.module really passes, over a compile-only
// Kysely that records every statement (SQL and parameters) and never connects. With no rows, one
// round reads only: first the processing scan of deletion_requests (status 'processing', not
// 'cooling'), then the cooling-period scans; no statement locks. Without a database the token
// still provides null.
import { afterEach, expect, it, vi } from 'vitest';
import {
  capturedWorkerOptions,
  compileOnlyDb,
  fieldCrypto,
  identity,
  ports,
  workerHarness,
  type CompiledStatement,
  type Runner,
} from './kit.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

/** The status-like string values a statement compares with: its parameters and quoted literals. */
function values(statement: CompiledStatement): string[] {
  const literals = [...statement.sql.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]!);
  const parameters = statement.parameters.filter(
    (value): value is string => typeof value === 'string',
  );
  return [...parameters, ...literals];
}

it('[AC-B1-15g#34] 装配：worker 有库时 deletionExpiryToken 的一轮先扫 processing、后扫 cooling，全程只读不加锁；无库时 token 仍为 null', async () => {
  const api = await identity();
  const p = await ports();
  const options = await capturedWorkerOptions(api, p);
  const statements: CompiledStatement[] = [];
  const db = compileOnlyDb(statements);
  const context = await workerHarness(
    p,
    api.IdentityDeletionExpiryModule.forWorker(options as never),
    'test',
    db,
    await fieldCrypto(),
  );
  try {
    const runner = context.get(api.deletionExpiryToken()) as Runner;
    expect(runner).toMatchObject({ runOnce: expect.any(Function) });
    await runner.runOnce();
    const onRequests = (statement: CompiledStatement) =>
      statement.sql.includes('"deletion_requests"');
    const processingScan = statements.findIndex(
      (statement) =>
        onRequests(statement) &&
        values(statement).includes('processing') &&
        !values(statement).includes('cooling'),
    );
    const coolingScan = statements.findIndex(
      (statement) => onRequests(statement) && values(statement).includes('cooling'),
    );
    expect(processingScan, 'no scan of processing requests in the round').toBeGreaterThanOrEqual(0);
    expect(coolingScan, 'the cooling-period expiry did not run').toBeGreaterThan(processingScan);
    for (const statement of statements) {
      expect(statement.sql).toMatch(/^select /i);
      expect(statement.sql).not.toMatch(/for update|for no key update|for share|advisory/i);
    }
  } finally {
    try {
      await context.close();
    } finally {
      await db.destroy();
    }
  }
  const bare = await workerHarness(
    p,
    api.IdentityDeletionExpiryModule.forWorker(options as never),
    'test',
  );
  try {
    expect(bare.get(api.deletionExpiryToken())).toBeNull();
  } finally {
    await bare.close();
  }
}, 30_000);
