import type { DB } from '@couli/db';
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type QueryResult,
} from 'kysely';

/** 内存驱动只接收编译后的 SQL，不连库；只有 INSERT RETURNING 才提供合成行 id。 */
export function archiveDb(results: readonly (bigint | Error)[]) {
  const statements: CompiledQuery[] = [];
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createIntrospector: (kysely) => new PostgresIntrospector(kysely),
      createQueryCompiler: () => new PostgresQueryCompiler(),
      createDriver: () => ({
        init: async () => undefined,
        acquireConnection: async () => ({
          async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
            const result = results[statements.length];
            statements.push(query);
            if (result instanceof Error) throw result;
            if (result === undefined) throw new Error('unexpected synthetic archive query');
            const returning = /returning\s+"id"/i.test(query.sql);
            return {
              rows: (returning ? [{ id: result }] : []) as R[],
              numAffectedRows: 1n,
            };
          },
          async *streamQuery() {
            throw new Error('NotImplemented: synthetic archive stream');
          },
        }),
        releaseConnection: async () => undefined,
        destroy: async () => undefined,
        beginTransaction: async () => undefined,
        commitTransaction: async () => undefined,
        rollbackTransaction: async () => undefined,
      }),
    },
  });
  return { db, statements };
}
