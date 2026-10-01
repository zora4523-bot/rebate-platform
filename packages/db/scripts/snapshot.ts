// Regenerates the two committed, generated views of the schema (conventions C8):
//   db/schema.sql               pg_dump --schema-only --no-owner --restrict-key=couli
//   packages/db/src/db.gen.ts   kysely-codegen types for schema `app`
//
//   node scripts/snapshot.ts           write both files
//   node scripts/snapshot.ts --check   regenerate to memory / verify, exit 1 on drift;
//                                      also checks the generated pg-boss migration
//
// The source is a throwaway database built exactly like the test template (bootstrap + all
// migrations, nothing else) on a one-shot PostgreSQL: TEST_PG_ADMIN_URL when set, otherwise
// Testcontainers. Never the dev stack. Needs a database, so it only runs outside the Codex
// sandbox (规划/11 §2.3).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parsePgUrl, pgUrl } from '../src/pg-url.ts';
import {
  acquireAdminPg,
  buildMigratedDatabase,
  DB_DIR,
  derivedRolePasswords,
  quoteIdent,
  randomHex,
  withClient,
  type AdminPg,
} from '../src/testing/provision.ts';
import { checkPgBossMigration } from './gen-pgboss-migration.ts';
import { cliArgs, fail, info, main } from './util.ts';

const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url));
const SCHEMA_FILE = path.join(DB_DIR, 'schema.sql');
const TYPES_FILE = path.join(PACKAGE_DIR, 'src', 'db.gen.ts');
const CODEGEN_BIN = path.join(PACKAGE_DIR, 'node_modules', '.bin', 'kysely-codegen');

const PG_DUMP_ARGS = ['--schema-only', '--no-owner', '--restrict-key=couli'];

/** Major version of `pg_dump` on PATH, or null when there is none. */
function pathPgDumpMajor(): number | null {
  const result = spawnSync('pg_dump', ['--version'], { encoding: 'utf8' });
  if (result.status !== 0) {
    return null;
  }
  // e.g. "pg_dump (PostgreSQL) 18.6 (Debian 18.6-1.pgdg13+1)"
  const match = /\(PostgreSQL\)\s+(\d+)/.exec(result.stdout);
  return match?.[1] === undefined ? null : Number(match[1]);
}

async function serverMajor(adminUrl: string): Promise<number> {
  return withClient(adminUrl, async (client) => {
    const result = await client.query<{ v: string }>(
      "SELECT current_setting('server_version_num') AS v",
    );
    return Math.floor(Number(result.rows[0]?.v ?? '0') / 10_000);
  });
}

/**
 * Dumps the schema of `database`. A pg_dump of another major version may format its output
 * differently, so the one on PATH is used only when it matches the server's major version
 * (the verify image ships postgresql-client-18); otherwise pg_dump runs inside the
 * Testcontainers PostgreSQL container started by this process.
 */
async function dumpSchema(admin: AdminPg, database: string): Promise<string> {
  const wanted = await serverMajor(admin.adminUrl);
  const onPath = pathPgDumpMajor();
  if (onPath === wanted) {
    const parts = parsePgUrl(admin.adminUrl);
    const result = spawnSync('pg_dump', [...PG_DUMP_ARGS, '--dbname', database], {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      env: {
        ...process.env,
        PGHOST: parts.host,
        PGPORT: String(parts.port),
        PGUSER: parts.user,
        PGPASSWORD: parts.password,
      },
    });
    if (result.status !== 0) {
      throw new Error(`pg_dump failed (exit ${String(result.status)}): ${result.stderr}`);
    }
    return result.stdout;
  }
  if (admin.exec !== null) {
    const result = await admin.exec([
      'pg_dump',
      '-U',
      'postgres',
      ...PG_DUMP_ARGS,
      '--dbname',
      database,
    ]);
    if (result.exitCode !== 0) {
      throw new Error(
        `pg_dump in the container failed (exit ${String(result.exitCode)}): ${result.stderr}`,
      );
    }
    return result.stdout;
  }
  fail(
    `需要主版本为 ${String(wanted)} 的 pg_dump，PATH 上的是 ${onPath === null ? '没有' : String(onPath)}。` +
      `请安装 postgresql-client-${String(wanted)}，或去掉 TEST_PG_ADMIN_URL 让脚本用 Testcontainers 起库（那样会在容器里执行 pg_dump）。`,
  );
}

/** Drops the two version comment lines so the snapshot does not change with patch releases. */
export function normalizeDump(dump: string): string {
  const lines = dump
    .split('\n')
    .filter((line) => !/^-- Dumped (from database|by pg_dump) version /.test(line));
  return `${lines.join('\n').replace(/\s+$/, '')}\n`;
}

function runCodegen(databaseUrl: string, extraArgs: string[]): { status: number; output: string } {
  const result = spawnSync(
    CODEGEN_BIN,
    [
      '--dialect',
      'postgres',
      '--default-schema',
      'app',
      '--include-pattern',
      'app.*',
      '--type-mapping',
      '{"int8":"ColumnType<bigint, bigint, bigint>"}',
      '--out-file',
      TYPES_FILE,
      ...extraArgs,
    ],
    {
      cwd: PACKAGE_DIR,
      encoding: 'utf8',
      // The URL goes through the environment so the password is not visible in `ps`.
      env: { ...process.env, DATABASE_URL: databaseUrl },
    },
  );
  // On a failed --verify the tool prints the diff and then a stack trace; keep the diff only.
  const lines = `${result.stdout}${result.stderr}`.split('\n');
  const trace = lines.findIndex((line) => line.includes('/kysely-codegen/dist/'));
  const output = (trace === -1 ? lines : lines.slice(0, trace)).join('\n').trim();
  return { status: result.status ?? 2, output };
}

/** First differing line of two texts, with a little context, for the drift message. */
function diffSummary(expected: string, actual: string): string {
  const a = expected.split('\n');
  const b = actual.split('\n');
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    if (a[i] !== b[i]) {
      return [
        `first difference at line ${String(i + 1)} (committed ${String(a.length)} lines, regenerated ${String(b.length)} lines)`,
        `  committed:   ${a[i] ?? '<end of file>'}`,
        `  regenerated: ${b[i] ?? '<end of file>'}`,
      ].join('\n');
    }
  }
  return 'no line differs (only trailing whitespace)';
}

if (import.meta.main) {
  await main(async () => {
    const args = cliArgs();
    const unknown = args.filter((arg) => arg !== '--check');
    if (unknown.length > 0) {
      fail(`未知参数：${unknown.join(' ')}。用法：snapshot.ts [--check]`);
    }
    const check = args.includes('--check');
    const problems: string[] = [];

    if (check) {
      const pgboss = checkPgBossMigration();
      if (pgboss !== null) {
        problems.push(`pg-boss 迁移：${pgboss}`);
      }
    }

    const admin = await acquireAdminPg();
    const database = `couli_snap_${randomHex(4)}`;
    try {
      const startedAt = Date.now();
      await buildMigratedDatabase(admin.adminUrl, database);
      info(
        `快照库 ${database} 已建好（${admin.source}，起库 ${String(admin.startMs)} ms，` +
          `建库加迁移 ${String(Date.now() - startedAt)} ms）。`,
      );

      const schemaSql = normalizeDump(await dumpSchema(admin, database));
      const migratorUrl = pgUrl(admin.adminUrl, {
        user: 'couli_migrator',
        password: derivedRolePasswords(admin.adminUrl).couli_migrator,
        database,
      });

      if (check) {
        const committed = existsSync(SCHEMA_FILE) ? readFileSync(SCHEMA_FILE, 'utf8') : '';
        if (committed !== schemaSql) {
          problems.push(`db/schema.sql 与迁移结果不一致：\n${diffSummary(committed, schemaSql)}`);
        }
        const verify = runCodegen(migratorUrl, ['--verify']);
        if (verify.status !== 0) {
          problems.push(`packages/db/src/db.gen.ts 与迁移结果不一致：\n${verify.output}`);
        }
      } else {
        writeFileSync(SCHEMA_FILE, schemaSql);
        info(`已写入 ${SCHEMA_FILE}`);
        const generated = runCodegen(migratorUrl, []);
        if (generated.status !== 0) {
          throw new Error(
            `kysely-codegen failed (exit ${String(generated.status)}): ${generated.output}`,
          );
        }
        info(`已写入 ${TYPES_FILE}`);
      }
    } finally {
      await withClient(admin.adminUrl, async (client) => {
        await client.query(`DROP DATABASE IF EXISTS ${quoteIdent(database)} WITH (FORCE)`);
      }).catch(() => {});
      await admin.stop();
    }

    if (problems.length > 0) {
      fail(
        `生成物有漂移：\n${problems.join('\n')}\n` +
          '处理办法：在沙箱外运行 pnpm db:snapshot 并提交生成物（规划/11 §2.3）。',
        1,
      );
    }
    info(check ? '检查通过：db/schema.sql、db.gen.ts、pg-boss 迁移都没有漂移。' : '快照完成。');
  });
}
